// A Report is the JSON a Run leaves behind. This module is everything the lab knows about one:
// whether it is real, what it is named, and what it says. It never talks to Lighthouse or ngrok,
// so the recorded Reports under reports/ exercise all of it (tests/run.mjs).
import { readFile } from 'node:fs/promises';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);
// Where a free-tier Preview URL lives. Only used to recognise the robots.txt artifact below.
const TUNNEL_SUFFIXES = ['.ngrok-free.dev', '.ngrok-free.app', '.ngrok.app', '.ngrok.io', '.ngrok.dev'];

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
const isTunnelCdn = (host) => host === 'ngrok.com' || host?.endsWith('.ngrok.com');

// Why a URL is not a Preview URL, or null when it is one. A Run is only valid against the public
// ngrok address because the throttling model assumes a real network hop.
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
    const expected = hostOf(previewUrl);
    if (expected && host !== expected) {
      reasons.push(`the Report measured ${host ?? requested}, not the Preview URL ${expected}`);
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

  const requests = networkRequests(report);
  const document = requests.find((r) => r.resourceType === 'Document') ?? requests[0];
  if (!document) {
    reasons.push('the Report records no network requests at all');
  } else if (document.statusCode !== 200) {
    reasons.push(`the document answered ${document.statusCode}, not 200`);
  }

  const tunnelHosts = [...new Set(requests.map((r) => hostOf(r.url)).filter(isTunnelCdn))];
  if (tunnelHosts.length) {
    reasons.push(
      `requests went to ${tunnelHosts.join(', ')}: the page measured was ngrok's interstitial, not the Storefront (the ngrok-skip-browser-warning header was not honoured)`,
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

// `<host>-<UTC moment of capture>.json`, from the Report's own fetchTime rather than the clock
// of whoever saved it (the local clock is how the first 14 drifted three hours from UTC).
export function reportName(report) {
  const parsed = parseUrl(report.requestedUrl);
  if (!parsed) throw new Error(`the Report has no usable requestedUrl: ${report.requestedUrl}`);
  const moment = new Date(report.fetchTime);
  if (Number.isNaN(moment.getTime())) throw new Error(`the Report has no usable fetchTime: ${report.fetchTime}`);
  const stamp = moment.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${parsed.hostname}-${stamp}.json`;
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
  if (robots?.score === 0 && TUNNEL_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    artifacts.push({
      audit: 'robots-txt',
      category: 'seo',
      reason:
        "the ngrok bypass header does not reach Lighthouse's separate robots.txt fetch, which reads the interstitial instead; robots.txt itself is valid",
      scoreWithout: scoreWithout(report, 'seo', 'robots-txt'),
    });
  }
  return artifacts;
}

export function summarize(report) {
  const score = (id) => report.categories?.[id]?.score ?? null;
  const metric = (id) => report.audits?.[id]?.numericValue ?? null;
  const requests = networkRequests(report);
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
    artifacts: knownArtifacts(report),
  };
}

export function formatSummary(summary) {
  const pct = (score) => (typeof score === 'number' ? String(Math.round(score * 100)) : '-');
  const ms = (value) => (typeof value === 'number' ? `${Math.round(value)} ms` : '-');
  const { scores, metrics } = summary;
  const cls = typeof metrics.cls === 'number' ? String(Math.round(metrics.cls * 1000) / 1000) : '-';
  const lines = [
    `Run of ${summary.url} at ${summary.fetchTime} (Lighthouse ${summary.lighthouseVersion}, ${summary.channel})`,
    `  performance ${pct(scores.performance)} · accessibility ${pct(scores.accessibility)} · best-practices ${pct(scores.bestPractices)} · seo ${pct(scores.seo)}`,
    `  FCP ${ms(metrics.fcp)} · LCP ${ms(metrics.lcp)} · TBT ${ms(metrics.tbt)} · CLS ${cls}`,
    `  ${summary.requests} requests · ${(summary.transferBytes / 1024).toFixed(1)} KB transferred`,
  ];
  for (const artifact of summary.artifacts) {
    lines.push(
      `  known artifact: ${artifact.audit} (${artifact.category}) — ${artifact.reason}; ${artifact.category} would be ${pct(artifact.scoreWithout)} without it`,
    );
  }
  lines.push(`  Report: ${summary.name}`);
  return lines.join('\n');
}
