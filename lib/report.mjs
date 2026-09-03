// A Report is the JSON a Run leaves behind. This module is everything the lab knows about one:
// whether it is real, what it is named, and what it says. It never talks to Lighthouse or a tunnel,
// so the recorded Reports under reports/ exercise all of it (tests/run.mjs).
import { readFile } from 'node:fs/promises';

import { slugOf } from './arms.mjs';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);
// Where a free-tier ngrok Preview URL lives. Only used to recognise the robots.txt artifact below,
// which is ngrok's: a Cloudflare quick tunnel has no interstitial and no artifact.
const NGROK_SUFFIXES = ['.ngrok-free.dev', '.ngrok-free.app', '.ngrok.app', '.ngrok.io', '.ngrok.dev'];

export async function readReport(fileUrl) {
  return JSON.parse(await readFile(fileUrl, 'utf8'));
}

const parseUrl = (url) => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};
const hostOf = (url) => parseUrl(url)?.host ?? null;
const networkRequests = (report) => report.audits?.['network-requests']?.details?.items ?? [];
// ngrok's interstitial pulls its fonts and styles from cdn.ngrok.com; the Storefront never does.
const isNgrokCdn = (host) => host === 'ngrok.com' || host?.endsWith('.ngrok.com');
// An audit's numericValue, never its displayValue: the display rounds to 10 ms and two Reports
// with different latencies print the same string.
const numeric = (report, id) => {
  const value = report.audits?.[id]?.numericValue;
  return typeof value === 'number' ? value : null;
};

// Lantern's server-latency estimate through a warm tunnel: 57 and 92 ms over Cloudflare, 18-86 ms
// over ngrok. The two Runs that measured a tunnel waking up read 267 and 304 ms, and the simulated
// LCP carried almost exactly that difference (2026-09-02: +203 ms LCP for +210 ms latency).
const WARM_SERVER_LATENCY_MS = 150;

// The LCP breakdown: a list whose table item carries four subparts keyed by `subpart` (`label` is
// display text), beside a node item describing the LCP element. A Report may carry no details.
function lcpBreakdown(report) {
  const items = report.audits?.['lcp-breakdown-insight']?.details?.items ?? [];
  const table = items.find((item) => item.type === 'table');
  const part = (subpart) => {
    const duration = table?.items?.find((item) => item.subpart === subpart)?.duration;
    return typeof duration === 'number' ? duration : null;
  };
  return {
    ttfb: part('timeToFirstByte'),
    loadDelay: part('resourceLoadDelay'),
    loadDuration: part('resourceLoadDuration'),
    renderDelay: part('elementRenderDelay'),
    node: items.find((item) => item.type === 'node') ?? null,
  };
}

const unescapeHtml = (text) =>
  text.replace(/&(amp|lt|gt|quot|#39);/g, (whole, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name]);

// No Lighthouse 13 audit names the LCP element's resource outright. The node's snippet carries the
// element's resolved src, HTML-escaped and sometimes cut short with an ellipsis; the request whose
// URL starts with that prefix is the Rung the browser loaded, when exactly one does.
function lcpResource(report, node) {
  const match = /src="([^"…]*)/.exec(node?.snippet ?? '');
  if (!match) return null;
  const prefix = unescapeHtml(match[1]);
  const candidates = networkRequests(report).filter((r) => typeof r.url === 'string' && r.url.startsWith(prefix));
  return candidates.length === 1 ? candidates[0] : null;
}

// Why a URL is not a Preview URL, or null when it is one. A Run is only valid against a public
// address because the throttling model assumes a real network hop.
export function previewUrlProblem(url) {
  const parsed = parseUrl(url);
  if (!parsed) return `"${url}" is not a URL`;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return `${url} is not a web address`;
  if (LOOPBACK.has(parsed.hostname)) {
    return `${url} is not a Preview URL: ${parsed.hostname} has no real network hop, and the throttling model assumes one`;
  }
  return null;
}

// Every reason a Report is not a real Run of the Preview URL; empty when it is one.
export function checkReport(report, previewUrl) {
  const reasons = [];
  if (report.runtimeError) {
    reasons.push(`Lighthouse stopped with ${report.runtimeError.code}: ${report.runtimeError.message}`);
  }

  const requested = report.requestedUrl;
  const host = hostOf(requested);
  const problem = previewUrlProblem(requested ?? '');
  if (problem) reasons.push(problem);
  if (previewUrl !== undefined) {
    const expected = parseUrl(previewUrl);
    if (expected && host !== expected.host) {
      reasons.push(`the Report measured ${host ?? requested}, not the Preview URL ${expected.host}`);
    } else if (expected && parseUrl(requested)?.pathname !== expected.pathname) {
      // One host serves every Arm; the path says which one the Run measured.
      reasons.push(`the Report measured ${parseUrl(requested)?.pathname}, not ${expected.pathname}: the wrong Arm`);
    }
  }
  const landed = hostOf(report.mainDocumentUrl ?? report.finalDisplayedUrl ?? requested);
  if (host && landed !== host) reasons.push(`the page redirected away to ${landed}`);

  const settings = report.configSettings ?? {};
  if (settings.formFactor !== 'mobile') {
    reasons.push(`the form factor was ${settings.formFactor ?? 'unset'}, not mobile`);
  }
  if (settings.throttlingMethod !== 'simulate') {
    reasons.push(`throttling was ${settings.throttlingMethod ?? 'unset'}, not simulated`);
  }
  // A Run is a first visit. With storage kept, the Worker serves the document from its caches
  // (TTFB near zero, LCP collapsed) and nothing else in the Report could tell; one
  // --disable-storage-reset would record that fake result. Both stores must be cleared first.
  if (settings.disableStorageReset !== false) {
    reasons.push(
      `storage reset was ${settings.disableStorageReset === undefined ? 'unset' : 'disabled'}, so a Worker from an earlier visit may have served the page`,
    );
  }
  const cleared = Array.isArray(settings.clearStorageTypes) ? settings.clearStorageTypes : [];
  for (const store of ['service_workers', 'cache_storage']) {
    if (!cleared.includes(store)) reasons.push(`${store} was not cleared before the Run, so a Worker may have served the page`);
  }

  const requests = networkRequests(report);
  const document = requests.find((r) => r.resourceType === 'Document') ?? requests[0];
  if (!document) {
    reasons.push('the Report records no network requests at all');
  } else if (document.statusCode !== 200) {
    reasons.push(`the document answered ${document.statusCode}, not 200`);
  }

  const ngrokHosts = [...new Set(requests.map((r) => hostOf(r.url)).filter(isNgrokCdn))];
  if (ngrokHosts.length) {
    reasons.push(
      `requests went to ${ngrokHosts.join(', ')}: the page measured was ngrok's interstitial, not the Storefront (the ngrok-skip-browser-warning header was not honoured)`,
    );
  }
  // A naive run answers every path on our own host with the interstitial's HTML, favicon included,
  // so "something of our own came back" means a same-origin response that is not HTML.
  const own = requests.filter(
    (r) => r !== document && hostOf(r.url) === host && !String(r.mimeType ?? '').startsWith('text/html'),
  );
  if (document && !own.length) {
    reasons.push(
      "nothing of the Storefront's own came back beyond the document (no script, image, or icon), so the page measured was not this one",
    );
  }
  return reasons;
}

// `<host>[-<Arm>]-<UTC moment of capture>.json`, from the Report's own fetchTime rather than the clock
// of whoever saved it (the local clock is how the first 14 drifted three hours from UTC).
export function reportName(report) {
  const parsed = parseUrl(report.requestedUrl);
  if (!parsed) throw new Error(`the Report has no usable requestedUrl: ${report.requestedUrl}`);
  const moment = new Date(report.fetchTime);
  if (Number.isNaN(moment.getTime())) throw new Error(`the Report has no usable fetchTime: ${report.fetchTime}`);
  const stamp = moment.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  // An Arm's Report carries the Arm between the host and the moment; the control's carries nothing.
  const slug = slugOf(parsed.pathname);
  return `${parsed.hostname}${slug ? `-${slug}` : ''}-${stamp}.json`;
}

// A category score recomputed without one audit, the way Lighthouse computes it: the weighted mean
// of the scored audits, clamped to two decimals.
export function scoreWithout(report, categoryId, auditId) {
  const category = report.categories?.[categoryId];
  if (!category) return null;
  let weight = 0;
  let sum = 0;
  for (const ref of category.auditRefs ?? []) {
    const score = report.audits?.[ref.id]?.score;
    if (ref.id === auditId || !(ref.weight > 0) || typeof score !== 'number') continue;
    weight += ref.weight;
    sum += ref.weight * score;
  }
  return weight ? Math.round((sum / weight) * 100) / 100 : null;
}

// Known artifacts: audits that fail for a reason that is the tunnel's, not the page's.
function knownArtifacts(report) {
  const artifacts = [];
  const hostname = parseUrl(report.requestedUrl)?.hostname ?? '';
  const robots = report.audits?.['robots-txt'];
  if (robots?.score === 0 && NGROK_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    artifacts.push({
      audit: 'robots-txt',
      category: 'seo',
      reason:
        "the ngrok bypass header does not reach Lighthouse's separate robots.txt fetch, which reads the interstitial instead; robots.txt itself is valid",
      scoreWithout: scoreWithout(report, 'seo', 'robots-txt'),
    });
  }
  const latency = numeric(report, 'network-server-latency');
  if (latency !== null && latency > WARM_SERVER_LATENCY_MS) {
    artifacts.push({
      audit: 'network-server-latency',
      category: 'performance',
      reason: `Lantern's server-latency estimate is ${Math.round(latency)} ms against the 60–90 ms a warm tunnel reads, so the Run measured the tunnel waking up and LCP carries it; read the page share`,
      scoreWithout: null,
    });
  }
  return artifacts;
}

// Every request that went to a host other than the Preview URL's, by origin: what the tags pulled
// in. The control reads none; the oldest Report's Hero came from Unsplash and reads that.
function thirdPartyAccount(report) {
  const host = hostOf(report.requestedUrl);
  const origins = {};
  let requests = 0;
  let transferBytes = 0;
  for (const r of networkRequests(report)) {
    const origin = hostOf(r.url);
    if (!origin || origin === host) continue;
    const bytes = typeof r.transferSize === 'number' ? r.transferSize : 0;
    requests += 1;
    transferBytes += bytes;
    origins[origin] ??= { requests: 0, transferBytes: 0 };
    origins[origin].requests += 1;
    origins[origin].transferBytes += bytes;
  }
  return { requests, transferBytes, origins };
}

export function summarize(report) {
  const score = (id) => report.categories?.[id]?.score ?? null;
  const metric = (id) => report.audits?.[id]?.numericValue ?? null;
  const requests = networkRequests(report);
  const breakdown = lcpBreakdown(report);
  const lcp = lcpResource(report, breakdown.node);
  return {
    name: reportName(report),
    url: report.requestedUrl,
    fetchTime: report.fetchTime,
    channel: report.configSettings?.channel ?? null,
    lighthouseVersion: report.lighthouseVersion ?? null,
    scores: {
      performance: score('performance'),
      accessibility: score('accessibility'),
      bestPractices: score('best-practices'),
      seo: score('seo'),
    },
    metrics: {
      fcp: metric('first-contentful-paint'),
      lcp: metric('largest-contentful-paint'),
      tbt: metric('total-blocking-time'),
      cls: metric('cumulative-layout-shift'),
    },
    requests: requests.length,
    transferBytes: requests.reduce((total, r) => total + (r.transferSize ?? 0), 0),
    // What LCP owes to the page alone, and what it owes to the tunnel (CONTEXT.md, "Two Runs side
    // by side"). Load duration is the tunnel's: 83-88 ms warm against 315-332 ms cold for the same
    // Rung, while load delay and render delay hold across every tunnel.
    pageShare: {
      loadDelay: breakdown.loadDelay,
      renderDelay: breakdown.renderDelay,
      lcpUrl: lcp?.url ?? null,
      // The Rung's own bytes: the same file transfers 6736-6747 bytes depending on the tunnel's
      // response headers, and headers are the tunnel's.
      lcpBytes: typeof lcp?.resourceSize === 'number' ? lcp.resourceSize : null,
    },
    tunnelShare: {
      ttfb: breakdown.ttfb,
      loadDuration: breakdown.loadDuration,
      serverLatency: numeric(report, 'network-server-latency'),
      rtt: numeric(report, 'network-rtt'),
    },
    thirdParty: thirdPartyAccount(report),
    artifacts: knownArtifacts(report),
  };
}

// A delta with its sign, rounded: "+12 ms", "-210 ms", "+0 B".
const signed = (value, unit = ' ms') =>
  typeof value === 'number' ? `${value < 0 ? '-' : '+'}${Math.round(Math.abs(value))}${unit}` : '-';
const fileOf = (url) => (typeof url === 'string' ? url.split('/').pop() : '-');

// A side owns an LCP difference when its own movement, in LCP's direction, covers at least this
// much of it. Half: the two sides are the only ones a Report names, and the rest of Lantern's
// simulation belongs to neither, so a side that accounts for less than half of the difference
// cannot be said to have made it. 2026-09-02T18:36 -> 2026-09-03T12:42 is the case: LCP +95 ms
// with the tunnel's estimates +1 ms and the page share +11 ms on an unchanged page — the larger
// of two small movements is not the cause. (Weighing the page share at the Run's 4x CPU slowdown
// was tried and is not what the Reports show: the PWA pair moved -35 ms for -35 ms of latency with
// a page share of -7 ms, and pairs where only the page share wandered show no multiple of it in
// LCP. Both sides are weighed as observed.)
const COVERS = 0.5;

// Whose the LCP difference is. One guard and one rule: an LCP image that changed is the page's
// before anything else; otherwise the side whose movement covers the LCP difference owns it,
// both covering is said rather than decided, and neither covering is noise. Both shares are
// observed sub-parts; the tunnel's estimates are what Lantern builds the simulated LCP from,
// which is why they, and not the observed TTFB, are what the rule weighs.
function verdict(a, b, delta) {
  const { loadDelay, renderDelay } = delta.pageShare;
  const { serverLatency, rtt } = delta.tunnelShare;
  const lcp = delta.metrics.lcp;
  const unread = [loadDelay, renderDelay, serverLatency, rtt, lcp, a.pageShare.lcpBytes, b.pageShare.lcpBytes].some((v) => v === null);
  if (unread) {
    return { kind: 'unread', text: 'a Report carries no LCP breakdown, server latency or LCP image, so nothing can be attributed' };
  }
  if (a.pageShare.lcpBytes !== b.pageShare.lcpBytes || fileOf(a.pageShare.lcpUrl) !== fileOf(b.pageShare.lcpUrl)) {
    return {
      kind: 'image',
      text: `the LCP image changed: ${fileOf(a.pageShare.lcpUrl)} ${a.pageShare.lcpBytes} B -> ${fileOf(b.pageShare.lcpUrl)} ${b.pageShare.lcpBytes} B, so LCP ${signed(lcp)} is the page's and load duration cannot be attributed`,
    };
  }
  const page = loadDelay + renderDelay;
  const tunnel = serverLatency + rtt;
  const sameSign = (x, y) => x === 0 || y === 0 || Math.sign(x) === Math.sign(y);
  const covers = (side) => lcp !== 0 && sameSign(side, lcp) && Math.abs(side) >= Math.abs(lcp) * COVERS;
  const pageDetail = `the page share moved ${signed(page)} (load delay ${signed(loadDelay)}, render delay ${signed(renderDelay)})`;
  const tunnelDetail = `the tunnel moved ${signed(tunnel)} (server latency ${signed(serverLatency)}, RTT ${signed(rtt)})`;
  const tunnelCovers = covers(tunnel);
  const pageCovers = covers(page);
  if (tunnelCovers && pageCovers) {
    return {
      kind: 'both',
      text: `both cover LCP ${signed(lcp)}: ${tunnelDetail}, and ${pageDetail}; repeat the pair before reading anything into it`,
    };
  }
  if (tunnelCovers) {
    return {
      kind: 'tunnel',
      text: `${tunnelDetail}, which covers LCP ${signed(lcp)}; ${pageDetail}: the difference is not the page's`,
    };
  }
  if (pageCovers) {
    return {
      kind: 'page',
      text: `${pageDetail}, which covers LCP ${signed(lcp)}; ${tunnelDetail}: the difference is the page share's, not the tunnel's — one pair; a Win needs it on every repeat`,
    };
  }
  return {
    kind: 'noise',
    text: `neither covers LCP ${signed(lcp)}: ${pageDetail}, and ${tunnelDetail}; repeat the pair before reading anything into it`,
  };
}

// Two Runs side by side: every delta reads later minus earlier in the order given, and the
// verdict says whose the LCP difference is (CONTEXT.md, "Two Runs side by side").
export function compare(earlier, later) {
  const a = summarize(earlier);
  const b = summarize(later);
  const delta = (x, y) => (typeof x === 'number' && typeof y === 'number' ? y - x : null);
  const deltas = (x, y) => Object.fromEntries(Object.keys(x).map((key) => [key, delta(x[key], y[key])]));
  const differences = {
    scores: deltas(a.scores, b.scores),
    metrics: deltas(a.metrics, b.metrics),
    requests: delta(a.requests, b.requests),
    transferBytes: delta(a.transferBytes, b.transferBytes),
    pageShare: {
      loadDelay: delta(a.pageShare.loadDelay, b.pageShare.loadDelay),
      renderDelay: delta(a.pageShare.renderDelay, b.pageShare.renderDelay),
      lcpBytes: delta(a.pageShare.lcpBytes, b.pageShare.lcpBytes),
    },
    tunnelShare: deltas(a.tunnelShare, b.tunnelShare),
  };
  return {
    a,
    b,
    samePreviewUrl: hostOf(a.url) === hostOf(b.url),
    sameDocument: parseUrl(a.url)?.pathname === parseUrl(b.url)?.pathname,
    minutesApart: (new Date(b.fetchTime) - new Date(a.fetchTime)) / 60000,
    delta: differences,
    verdict: verdict(a, b, differences),
  };
}

export function formatComparison(comparison) {
  const { a, b, delta } = comparison;
  const minutes = `${Math.round(Math.abs(comparison.minutesApart))} min apart`;
  let head;
  if (!comparison.samePreviewUrl) {
    head = `Two Runs, not a Paired Run (two Preview URLs): ${a.url} at ${a.fetchTime} -> ${b.url} at ${b.fetchTime} (${minutes})`;
  } else if (!comparison.sameDocument) {
    head = `Two Arms through one Preview URL: ${a.url} at ${a.fetchTime} -> ${b.url} at ${b.fetchTime} (${minutes})`;
  } else {
    head = `Paired Run of ${a.url}: ${a.fetchTime} -> ${b.fetchTime} (${minutes})`;
  }
  const points = (value) => (typeof value === 'number' ? `${value < 0 ? '-' : '+'}${Math.round(Math.abs(value) * 100)}` : '-');
  const kb = (bytes) => (typeof bytes === 'number' ? `${bytes < 0 ? '-' : '+'}${(Math.abs(bytes) / 1024).toFixed(1)} KB` : '-');
  const { scores, metrics, pageShare, tunnelShare } = delta;
  const cls = typeof metrics.cls === 'number' ? `${metrics.cls < 0 ? '-' : '+'}${Math.round(Math.abs(metrics.cls) * 1000) / 1000}` : '-';
  return [
    head,
    `  performance ${points(scores.performance)} · accessibility ${points(scores.accessibility)} · best-practices ${points(scores.bestPractices)} · seo ${points(scores.seo)}`,
    `  FCP ${signed(metrics.fcp)} · LCP ${signed(metrics.lcp)} · TBT ${signed(metrics.tbt)} · CLS ${cls}`,
    `  ${signed(delta.requests, '')} requests · ${kb(delta.transferBytes)} transferred`,
    `  page share: load delay ${signed(pageShare.loadDelay)} · render delay ${signed(pageShare.renderDelay)} · LCP image ${signed(pageShare.lcpBytes, ' B')}`,
    `  tunnel share: TTFB ${signed(tunnelShare.ttfb)} · load duration ${signed(tunnelShare.loadDuration)} · server latency ${signed(tunnelShare.serverLatency)} · RTT ${signed(tunnelShare.rtt)}`,
    `  verdict: ${comparison.verdict.text}`,
  ].join('\n');
}

const pct = (score) => (typeof score === 'number' ? String(Math.round(score * 100)) : '-');
const whole = (value) => (typeof value === 'number' ? String(Math.round(value)) : '-');
const ms = (value) => (typeof value === 'number' ? `${whole(value)} ms` : '-');
const kb = (bytes) => (typeof bytes === 'number' ? `${(bytes / 1024).toFixed(1)} KB` : '-');
const clsText = (cls) => (typeof cls === 'number' ? String(Math.round(cls * 1000) / 1000) : '-');

// The one line CLAUDE.md quotes as the current state, printed so it is pasted, never composed:
// tests/run.mjs ties CLAUDE.md to the newest Report through it.
export function formatCurrentState(summary) {
  const { scores, metrics } = summary;
  const paints = whole(metrics.fcp) === whole(metrics.lcp) ? `FCP = LCP = ${ms(metrics.lcp)}` : `FCP ${ms(metrics.fcp)}, LCP ${ms(metrics.lcp)}`;
  return (
    `performance ${pct(scores.performance)} / accessibility ${pct(scores.accessibility)} / best-practices ${pct(scores.bestPractices)} / SEO ${pct(scores.seo)}, ` +
    `${paints}, TBT ${whole(metrics.tbt)}, CLS ${clsText(metrics.cls)}, ${summary.requests} requests, ${kb(summary.transferBytes)} transferred`
  );
}

const thirdPartyText = ({ requests, transferBytes, origins }) =>
  requests ? `${requests} requests · ${kb(transferBytes)} (${Object.keys(origins).join(', ')})` : 'none';

export function formatSummary(summary) {
  const file = fileOf;
  const { scores, metrics, pageShare, tunnelShare } = summary;
  const cls = clsText(metrics.cls);
  const lines = [
    `Run of ${summary.url} at ${summary.fetchTime} (Lighthouse ${summary.lighthouseVersion}, ${summary.channel})`,
    `  performance ${pct(scores.performance)} · accessibility ${pct(scores.accessibility)} · best-practices ${pct(scores.bestPractices)} · seo ${pct(scores.seo)}`,
    `  FCP ${ms(metrics.fcp)} · LCP ${ms(metrics.lcp)} · TBT ${ms(metrics.tbt)} · CLS ${cls}`,
    `  ${summary.requests} requests · ${kb(summary.transferBytes)} transferred`,
    `  page share: load delay ${ms(pageShare.loadDelay)} · render delay ${ms(pageShare.renderDelay)} · LCP image ${kb(pageShare.lcpBytes)} (${file(pageShare.lcpUrl)})`,
    `  tunnel share: TTFB ${ms(tunnelShare.ttfb)} · load duration ${ms(tunnelShare.loadDuration)} · server latency ${ms(tunnelShare.serverLatency)} · RTT ${ms(tunnelShare.rtt)}`,
    `  third parties: ${thirdPartyText(summary.thirdParty)}`,
  ];
  for (const artifact of summary.artifacts) {
    const without = typeof artifact.scoreWithout === 'number' ? `; ${artifact.category} would be ${pct(artifact.scoreWithout)} without it` : '';
    lines.push(`  known artifact: ${artifact.audit} (${artifact.category}) — ${artifact.reason}${without}`);
  }
  lines.push(`  Report: ${summary.name}`);
  return lines.join('\n');
}
