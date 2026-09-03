import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadArms } from '../lib/arms.mjs';
import { loadPage } from '../lib/page.mjs';
import { checkReport, compare, formatComparison, formatCurrentState, formatSummary, readReport, reportName, summarize } from '../lib/report.mjs';
import { RunRefused, fetchPreflight, performRun, recordedMeasure } from '../tools/run.mjs';

// The recorded Reports are the second adapter: everything the Run does after Lighthouse returns
// (refusing, naming, summarising, writing) is asserted here without a tunnel or Chrome.
const REPORTS = new URL('../reports/', import.meta.url);
// The Run of 2026-08-21T17:26:57Z over ngrok is the reference: the Report whose numbers BACKLOG.md
// records. Every tunnel is a new Preview URL host, so nothing here assumes one host for all Reports.
const REFERENCE_FETCH_TIME = '2026-08-21T17:26:57.067Z';

const recorded = await Promise.all(
  (await readdir(REPORTS))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map(async (name) => ({ name, report: await readReport(new URL(name, REPORTS)) })),
);
// Located by content, not by file name: the names are what one assertion below is about.
const reference = recorded.find(({ report }) => report.fetchTime === REFERENCE_FETCH_TIME);
if (!reference) throw new Error(`the reference Report (fetchTime ${REFERENCE_FETCH_TIME}) is missing from reports/`);
const PREVIEW_URL = reference.report.requestedUrl;
const oldest = recorded.reduce((a, b) => (a.report.fetchTime < b.report.fetchTime ? a : b));

const scratchDirs = [];
const scratchDir = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'reports-'));
  scratchDirs.push(dir);
  return dir;
};
after(() => Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

// The pre-flight's second adapter: a Run performed here neither resolves nor warms anything.
const noPreflight = async () => [];

// Stand-ins for the Measurement Server behind a Preview URL, each answering one way. An IP
// literal skips the pre-flight's DNS step, which is the point: only the HTTP half is exercised.
const INDEX_URL = new URL('../index.html', import.meta.url);
const INDEX = await readFile(INDEX_URL, 'utf8');
const page = await loadPage(INDEX_URL);
const arms = await loadArms();
const armDocument = async (name) => readFile(new URL(arms.arms.find((arm) => arm.name === name).file, new URL('../', import.meta.url)), 'utf8');
const servers = [];
const serve = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/`;
};
const html = (body, status = 200) => (req, res) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
};
after(() => Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))));

// A naive run over free-tier ngrok: the tunnel answers every browser request with its interstitial
// (text/html on our own host) and the interstitial pulls fonts and styles from cdn.ngrok.com.
const interstitialReport = (report) => {
  const fake = structuredClone(report);
  fake.audits['network-requests'].details.items = [
    { url: PREVIEW_URL, statusCode: 200, mimeType: 'text/html', resourceType: 'Document', transferSize: 4100 },
    { url: 'https://cdn.ngrok.com/static/fonts/euclid-square/EuclidSquare-Regular-WebS.woff', statusCode: 200, mimeType: 'font/woff', resourceType: 'Font', transferSize: 350000 },
    { url: 'https://cdn.ngrok.com/static/css/error.css', statusCode: 200, mimeType: 'text/css', resourceType: 'Stylesheet', transferSize: 9000 },
    { url: `${PREVIEW_URL}favicon.ico`, statusCode: 200, mimeType: 'text/html', resourceType: 'Other', transferSize: 4100 },
  ];
  return fake;
};

const rehost = (report, origin) => {
  const fake = structuredClone(report);
  const swap = (url) => url.replace(PREVIEW_URL, origin);
  fake.requestedUrl = swap(fake.requestedUrl);
  fake.mainDocumentUrl = swap(fake.mainDocumentUrl);
  fake.finalDisplayedUrl = swap(fake.finalDisplayedUrl);
  for (const item of fake.audits['network-requests'].details.items) item.url = swap(item.url);
  return fake;
};

test('a Report is named for the Preview URL host and its own UTC moment of capture', () => {
  assert.equal(
    reportName({ requestedUrl: PREVIEW_URL, fetchTime: '2026-08-21T17:26:57.067Z' }),
    'pending-cozily-viscous.ngrok-free.dev-20260821T172657Z.json',
  );
});

test("a Report of an Arm carries the Arm's slug between the host and the moment", () => {
  assert.equal(
    reportName({ requestedUrl: 'https://pending-cozily-viscous.ngrok-free.dev/arm-gtm.html', fetchTime: '2026-08-21T17:26:57.067Z' }),
    'pending-cozily-viscous.ngrok-free.dev-arm-gtm-20260821T172657Z.json',
  );
  assert.equal(
    reportName({ requestedUrl: 'https://x.trycloudflare.com/arm-gtm-deferred.html', fetchTime: '2026-09-04T10:00:00.000Z' }),
    'x.trycloudflare.com-arm-gtm-deferred-20260904T100000Z.json',
  );
});

test('a Report of another Arm is not a Run of this Preview URL', () => {
  const fake = structuredClone(reference.report);
  fake.requestedUrl = `${PREVIEW_URL}arm-gtm.html`;
  fake.mainDocumentUrl = fake.requestedUrl;
  fake.finalDisplayedUrl = fake.requestedUrl;
  const reasons = checkReport(fake, PREVIEW_URL);
  assert.ok(reasons.some((r) => /wrong Arm/.test(r) && r.includes('/arm-gtm.html')), reasons.join('\n'));
  assert.deepEqual(checkReport(fake, fake.requestedUrl), [], 'against its own URL it is a real Run');
});

test('every recorded Report is a real Run of its own Preview URL', () => {
  assert.ok(recorded.length >= 14, 'the 14 recorded Reports are the second adapter');
  for (const { name, report } of recorded) {
    assert.deepEqual(checkReport(report, report.requestedUrl), [], name);
    assert.deepEqual(checkReport(report), [], `${name} without a Preview URL to compare against`);
  }
});

test('every recorded Report is named by its own UTC fetchTime, not the local clock', () => {
  for (const { name, report } of recorded) assert.equal(name, reportName(report));
});

test('a Report that measured the ngrok interstitial is refused, with the reasons named', () => {
  const reasons = checkReport(interstitialReport(reference.report), PREVIEW_URL);
  assert.ok(reasons.some((r) => r.includes('cdn.ngrok.com')), reasons.join('\n'));
  assert.ok(reasons.some((r) => /Storefront/.test(r) && /own/.test(r)), reasons.join('\n'));
});

test('a Report of some other host is not a Run of this Preview URL', () => {
  const reasons = checkReport(reference.report, 'https://other.ngrok-free.dev/');
  assert.equal(reasons.length, 1);
  assert.ok(reasons[0].includes('other.ngrok-free.dev'), reasons[0]);
});

test('a Report of localhost is not a Run, because the throttling model assumes a real network hop', () => {
  const reasons = checkReport(rehost(reference.report, 'http://localhost:8000/'));
  assert.equal(reasons.length, 1);
  assert.ok(reasons[0].includes('localhost'), reasons[0]);
});

test('a Report taken at desktop form factor or without simulated throttling is not a Run', () => {
  const desktop = structuredClone(reference.report);
  desktop.configSettings.formFactor = 'desktop';
  assert.ok(checkReport(desktop, PREVIEW_URL).some((r) => r.includes('desktop')));
  const devtools = structuredClone(reference.report);
  devtools.configSettings.throttlingMethod = 'devtools';
  assert.ok(checkReport(devtools, PREVIEW_URL).some((r) => r.includes('devtools')));
});

test('a Report with a runtime error or a non-200 document is refused', () => {
  const errored = structuredClone(reference.report);
  errored.runtimeError = { code: 'NO_FCP', message: 'The page did not paint any content.' };
  assert.ok(checkReport(errored, PREVIEW_URL).some((r) => r.includes('NO_FCP')));
  const gone = structuredClone(reference.report);
  gone.audits['network-requests'].details.items[0].statusCode = 404;
  assert.ok(checkReport(gone, PREVIEW_URL).some((r) => r.includes('404')));
});

test('a Report whose storage was kept, or whose Worker or caches survived, is refused', () => {
  // With storage kept, the Worker serves the document from caches: TTFB near zero, LCP collapses,
  // and nothing else in the Report could tell. Every real Run clears both before it navigates.
  const kept = structuredClone(reference.report);
  kept.configSettings.disableStorageReset = true;
  const reasons = checkReport(kept, PREVIEW_URL);
  assert.ok(reasons.some((r) => /storage/i.test(r) && /Worker/.test(r)), reasons.join('\n'));
  for (const type of ['service_workers', 'cache_storage']) {
    const survived = structuredClone(reference.report);
    survived.configSettings.clearStorageTypes = survived.configSettings.clearStorageTypes.filter((t) => t !== type);
    assert.ok(checkReport(survived, PREVIEW_URL).some((r) => r.includes(type)), `${type} must be cleared`);
  }
  const unset = structuredClone(reference.report);
  delete unset.configSettings.disableStorageReset;
  delete unset.configSettings.clearStorageTypes;
  assert.ok(checkReport(unset, PREVIEW_URL).length >= 2, 'unset settings are not trusted either');
});

test('the summary reads scores, metrics, requests, bytes, and the known artifacts of a Report', () => {
  const summary = summarize(reference.report);
  assert.equal(summary.url, PREVIEW_URL);
  assert.equal(summary.fetchTime, '2026-08-21T17:26:57.067Z');
  assert.equal(summary.channel, 'cli');
  assert.equal(summary.lighthouseVersion, '13.4.1');
  assert.deepEqual(summary.scores, { performance: 1, accessibility: 1, bestPractices: 1, seo: 0.92 });
  assert.ok(Math.abs(summary.metrics.fcp - 894.036) < 0.001);
  assert.ok(Math.abs(summary.metrics.lcp - 936.036) < 0.001);
  assert.equal(summary.metrics.tbt, 0);
  assert.equal(summary.metrics.cls, 0);
  assert.equal(summary.requests, 7);
  assert.equal(summary.transferBytes, 35886);
  assert.equal(summary.artifacts.length, 1);
  const [artifact] = summary.artifacts;
  assert.equal(artifact.audit, 'robots-txt');
  assert.equal(artifact.category, 'seo');
  assert.equal(artifact.scoreWithout, 1);
  assert.match(artifact.reason, /robots\.txt/);
});

test('a Report whose robots.txt was read as-is names no artifact', () => {
  assert.equal(oldest.report.audits['robots-txt'].score, 1);
  assert.deepEqual(summarize(oldest.report).artifacts, []);
});

test('the printed summary shows 0-100 scores, millisecond metrics, the artifact, and the Report name', () => {
  const text = formatSummary(summarize(reference.report));
  assert.match(text, /performance 100/);
  assert.match(text, /seo 92/);
  assert.match(text, /FCP 894 ms/);
  assert.match(text, /LCP 936 ms/);
  assert.match(text, /CLS 0\b/);
  assert.match(text, /7 requests/);
  assert.match(text, /35\.0 KB/);
  assert.match(text, /robots-txt/);
  assert.match(text, /100 without/);
  assert.ok(text.includes(reportName(reference.report)));
});

// Located by fetchTime, never by file name, like the reference above.
const byFetchTime = (prefix) => {
  const found = recorded.find(({ report }) => report.fetchTime.startsWith(prefix));
  if (!found) throw new Error(`no recorded Report with fetchTime ${prefix}`);
  return found.report;
};
const near = (actual, expected, name) => assert.ok(Math.abs(actual - expected) < 0.001, `${name}: ${actual} is not ${expected}`);

test('the summary splits LCP into the Page share and the Tunnel share', () => {
  // The reference Report's own lcp-breakdown-insight, network-server-latency and network-rtt.
  const { pageShare, tunnelShare } = summarize(reference.report);
  near(pageShare.loadDelay, 12.844, 'load delay');
  near(pageShare.renderDelay, 35.623, 'render delay');
  near(tunnelShare.ttfb, 104.865, 'TTFB');
  near(tunnelShare.loadDuration, 57.869, 'load duration');
  near(tunnelShare.serverLatency, 33.036, 'server latency');
  near(tunnelShare.rtt, 16.289, 'RTT');
});

test('the Page share names the Rung the LCP element loaded and its bytes', () => {
  const { pageShare } = summarize(reference.report);
  assert.ok(pageShare.lcpUrl.endsWith('/images/hero-768.webp'), pageShare.lcpUrl);
  // The Rung's own bytes (resourceSize), not the wire's: the same file transfers 6736-6747 bytes
  // depending on the tunnel's response headers, and headers are the tunnel's.
  assert.equal(pageShare.lcpBytes, 6654);
  // The oldest Report's Hero still came from Unsplash, and its snippet is HTML-escaped (&amp;).
  const first = summarize(oldest.report).pageShare;
  assert.ok(first.lcpUrl?.includes('images.unsplash.com'), String(first.lcpUrl));
  assert.ok(first.lcpBytes > 0);
});

// A Report of a GTM Arm: the control's requests plus what the container pulls in.
const withContainer = (report) => {
  const fake = structuredClone(report);
  fake.audits['network-requests'].details.items.push(
    { url: 'https://www.googletagmanager.com/gtm.js?id=GTM-PRVCQ335', statusCode: 200, mimeType: 'application/javascript', resourceType: 'Script', transferSize: 70000, resourceSize: 210000 },
    { url: 'https://www.googletagmanager.com/gtag/js?id=G-TEST', statusCode: 200, mimeType: 'application/javascript', resourceType: 'Script', transferSize: 1200, resourceSize: 3000 },
    { url: 'https://www.google-analytics.com/g/collect?v=2', statusCode: 204, mimeType: '', resourceType: 'XHR', transferSize: 300, resourceSize: 0 },
  );
  return fake;
};

test('the summary accounts for every third party by origin, and says none on the control', () => {
  const clean = summarize(reference.report).thirdParty;
  assert.deepEqual(clean, { requests: 0, transferBytes: 0, origins: {} });
  const tagged = summarize(withContainer(reference.report)).thirdParty;
  assert.equal(tagged.requests, 3);
  assert.equal(tagged.transferBytes, 71500);
  assert.deepEqual(Object.keys(tagged.origins), ['www.googletagmanager.com', 'www.google-analytics.com']);
  assert.deepEqual(tagged.origins['www.googletagmanager.com'], { requests: 2, transferBytes: 71200 });
  // The oldest Report's Hero came from Unsplash: a third party the account names, as it should.
  assert.ok('images.unsplash.com' in summarize(oldest.report).thirdParty.origins);
});

test('the printed summary carries the third parties on one line', () => {
  assert.match(formatSummary(summarize(reference.report)), /^  third parties: none$/m);
  const line = formatSummary(summarize(withContainer(reference.report))).split('\n').find((l) => l.startsWith('  third parties:'));
  assert.equal(line, '  third parties: 3 requests · 69.8 KB (www.googletagmanager.com, www.google-analytics.com)');
});

test('a comparison of two documents through one Preview URL says so', () => {
  const arm = structuredClone(reference.report);
  arm.requestedUrl = `${PREVIEW_URL}arm-gtm.html`;
  arm.mainDocumentUrl = arm.requestedUrl;
  arm.finalDisplayedUrl = arm.requestedUrl;
  const comparison = compare(reference.report, arm);
  assert.equal(comparison.samePreviewUrl, true);
  assert.equal(comparison.sameDocument, false);
  assert.match(formatComparison(comparison), /^Two Arms through one Preview URL: /);
  assert.equal(compare(reference.report, reference.report).sameDocument, true);
});

test('a Report is honest about a breakdown it does not carry', () => {
  const bare = structuredClone(reference.report);
  delete bare.audits['lcp-breakdown-insight'].details;
  delete bare.audits['network-server-latency'];
  const { pageShare, tunnelShare } = summarize(bare);
  assert.deepEqual(pageShare, { loadDelay: null, renderDelay: null, lcpUrl: null, lcpBytes: null });
  assert.equal(tunnelShare.ttfb, null);
  assert.equal(tunnelShare.serverLatency, null);
  near(tunnelShare.rtt, 16.289, 'RTT still read');
});

test("a Run that measured a cold tunnel names Lantern's server latency as a known artifact", () => {
  // Two Runs measured the tunnel waking up: 2026-08-24 (304 ms) and 2026-09-02T18:24 (267 ms).
  // Warm Cloudflare Runs read 57 and 92 ms; ngrok 18-86 ms.
  for (const [prefix, latency] of [
    ['2026-09-02T18:24:24', '267 ms'],
    ['2026-08-24T20:19:31', '304 ms'],
  ]) {
    const [artifact, ...rest] = summarize(byFetchTime(prefix)).artifacts;
    assert.deepEqual(rest, [], prefix);
    assert.equal(artifact.audit, 'network-server-latency');
    assert.equal(artifact.category, 'performance');
    assert.equal(artifact.scoreWithout, null);
    assert.ok(artifact.reason.includes(latency), artifact.reason);
    assert.match(artifact.reason, /tunnel/);
  }
  for (const prefix of ['2026-09-02T18:36:43', '2026-08-25T12:41:32']) {
    assert.deepEqual(summarize(byFetchTime(prefix)).artifacts, [], prefix);
  }
});

test('the printed summary shows both shares, and the cold-tunnel artifact without a score clause', () => {
  const warm = formatSummary(summarize(byFetchTime('2026-09-02T18:36:43')));
  assert.match(warm, /page share: load delay 10 ms · render delay 41 ms · LCP image 6\.5 KB \(hero-768\.webp\)/);
  assert.match(warm, /tunnel share: TTFB 133 ms · load duration 83 ms · server latency 57 ms · RTT 21 ms/);
  assert.doesNotMatch(warm, /known artifact/);
  const cold = formatSummary(summarize(byFetchTime('2026-09-02T18:24:24')));
  assert.match(cold, /known artifact: network-server-latency \(performance\) — .*267 ms/);
  assert.doesNotMatch(cold, /would be/);
});

// Two Runs side by side. Deltas read later minus earlier, in the order given.
const pair = (from, to) => compare(byFetchTime(from), byFetchTime(to));

test('a comparison reads the deltas of scores, metrics, requests, bytes and both shares', () => {
  const c = pair('2026-09-02T18:24:24', '2026-09-02T18:36:43');
  assert.equal(c.samePreviewUrl, false);
  near(c.minutesApart, 12.326, 'minutes apart');
  assert.deepEqual(c.delta.scores, { performance: 0, accessibility: 0, bestPractices: 0, seo: 0 });
  near(c.delta.metrics.lcp, -202.97, 'LCP');
  assert.equal(c.delta.metrics.tbt, 0);
  assert.equal(c.delta.requests, 0);
  assert.equal(c.delta.transferBytes, -22);
  near(c.delta.pageShare.loadDelay, -1.882, 'load delay');
  near(c.delta.pageShare.renderDelay, -7.544, 'render delay');
  assert.equal(c.delta.pageShare.lcpBytes, 0);
  near(c.delta.tunnelShare.serverLatency, -209.97, 'server latency');
  near(c.delta.tunnelShare.loadDuration, -231.96, 'load duration');
});

test("the tunnel's estimates covering the LCP difference make it the tunnel's", () => {
  // 2026-09-02: two tunnels, LCP -203 ms, server latency -210 ms, page share -10 ms.
  const crossed = pair('2026-09-02T18:24:24', '2026-09-02T18:36:43');
  assert.equal(crossed.verdict.kind, 'tunnel');
  assert.match(crossed.verdict.text, /tunnel moved -210 ms/);
  assert.match(crossed.verdict.text, /not the page's/);
  // 2026-08-24 -> 08-25: one tunnel, cold then warm. A Paired Run, sixteen hours apart.
  const warmed = pair('2026-08-24T20:19:31', '2026-08-25T12:41:32');
  assert.equal(warmed.samePreviewUrl, true);
  assert.equal(warmed.verdict.kind, 'tunnel');
  // The PWA: LCP -35 ms, exactly the server latency's -35 ms (92 -> 57); the page share -7 ms.
  assert.equal(pair('2026-08-25T12:41:32', '2026-09-02T18:36:43').verdict.kind, 'tunnel');
});

test('the first Run of a Chrome session carries a render delay no page made', () => {
  // 2026-09-03, two minutes apart through one tunnel, after one warming GET and then after a full
  // one: LCP -171 ms with server latency -207 ms, and render delay -83 ms (131 ms on the first Run,
  // 47 on the second, against 35-65 ms in every other Report). The tunnel covers it; the page share
  // moved by just under half, and no page did that.
  const today = pair('2026-09-03T12:40:10', '2026-09-03T12:42:08');
  assert.equal(today.samePreviewUrl, true);
  assert.equal(Math.round(today.delta.pageShare.renderDelay), -83);
  assert.equal(today.verdict.kind, 'tunnel');
  assert.match(today.verdict.text, /tunnel moved -207 ms/);
});

test('a Paired Run of an unchanged page a few minutes apart reads noise', () => {
  // 2026-09-03T12:42 -> 12:47, one warm tunnel, nothing changed: LCP -59 ms with the page share
  // +7 ms (+29 ms simulated) and the tunnel's estimates -1 ms. What a tunnel looks like when
  // nothing happened; a Win has to clear this.
  const { samePreviewUrl, minutesApart, verdict } = pair('2026-09-03T12:42:08', '2026-09-03T12:47:21');
  assert.equal(samePreviewUrl, true);
  near(minutesApart, 5.229, 'minutes apart');
  assert.equal(verdict.kind, 'noise');
  assert.match(verdict.text, /neither covers LCP -59 ms/);
});

test('a page share that cannot account for the LCP difference does not own it', () => {
  // 2026-09-02T18:36 -> 2026-09-03T12:42, two tunnels, the same page: LCP +95 ms with the tunnel's
  // estimates +1 ms and the page share +11 ms, under half of the difference. Nothing changed on
  // the page; the verdict must not say it did, whichever side is the larger.
  const { verdict } = pair('2026-09-02T18:36:43', '2026-09-03T12:42:08');
  assert.equal(verdict.kind, 'noise');
  assert.match(verdict.text, /neither covers LCP \+95 ms: the page share moved \+11 ms/);
});

test('both sides covering the LCP difference is said, not decided', () => {
  // Render delay +200 ms and server latency +200 ms against LCP +400 ms: each is half, so each
  // covers it, and nothing can be named. Against LCP +500 ms neither reaches half.
  const before = byFetchTime('2026-09-02T18:36:43');
  const after = structuredClone(before);
  const table = after.audits['lcp-breakdown-insight'].details.items.find((item) => item.type === 'table');
  table.items.find((item) => item.subpart === 'elementRenderDelay').duration += 200;
  after.audits['network-server-latency'].numericValue += 200;
  after.audits['largest-contentful-paint'].numericValue += 400;
  const both = compare(before, after).verdict;
  assert.equal(both.kind, 'both');
  assert.match(both.text, /both cover LCP \+400 ms/);
  assert.match(both.text, /repeat the pair/);
  after.audits['largest-contentful-paint'].numericValue += 100;
  assert.equal(compare(before, after).verdict.kind, 'noise');
});

test('the LCP image changing is named before anything is attributed', () => {
  // 2026-08-21T17:00 -> 17:08: the Hero moved from hero-768.jpg (22388 B) to hero-768.webp (6654 B)
  // and LCP from 1084 to 889 ms — the WebP Win, and the page's.
  const { verdict } = pair('2026-08-21T17:00:23', '2026-08-21T17:08:17');
  assert.equal(verdict.kind, 'image');
  assert.match(verdict.text, /hero-768\.jpg 22388 B -> hero-768\.webp 6654 B/);
  assert.match(verdict.text, /LCP -195 ms is the page's/);
});

test("a page share that covers the LCP difference, with the tunnel still, makes it the page share's", () => {
  const before = byFetchTime('2026-09-02T18:36:43');
  const after = structuredClone(before);
  const table = after.audits['lcp-breakdown-insight'].details.items.find((item) => item.type === 'table');
  table.items.find((item) => item.subpart === 'elementRenderDelay').duration += 100;
  after.audits['largest-contentful-paint'].numericValue += 100;
  const { verdict } = compare(before, after);
  assert.equal(verdict.kind, 'page');
  assert.match(verdict.text, /page share moved \+100 ms \(load delay \+0 ms, render delay \+100 ms\)/);
  assert.match(verdict.text, /the page share's/);
});

test('a page verdict on one pair is a reading of the shares, not a Win', () => {
  // 2026-09-02T18:36 -> 2026-09-03T12:47, two tunnels, the same page: LCP +35 ms, render delay
  // +17 ms (41 -> 58) on a page nothing touched. Render delay wanders across Runs of one page
  // (35-65 ms in the Reports, 130 ms on a session's first Chrome), so the verdict names the share
  // that moved and says that one pair is not a Win.
  const { verdict, delta } = pair('2026-09-02T18:36:43', '2026-09-03T12:47:21');
  assert.equal(verdict.kind, 'page');
  near(delta.pageShare.renderDelay, 17.063, 'render delay wander');
  assert.match(verdict.text, /one pair; a Win needs it on every repeat/);
});

test('a pair neither share explains is called noise, not a Win', () => {
  // 2026-08-21T17:13 -> 17:26 over one tunnel: LCP +56 ms while the page share fell 28 ms and the
  // tunnel's estimates rose 19 ms. Nothing moved in LCP's direction by as much as LCP did.
  const { verdict } = pair('2026-08-21T17:13:21', '2026-08-21T17:26:57');
  assert.equal(verdict.kind, 'noise');
  assert.match(verdict.text, /repeat the pair/);
});

test('a comparison of a Report without a breakdown says so instead of guessing', () => {
  const bare = structuredClone(reference.report);
  delete bare.audits['lcp-breakdown-insight'].details;
  assert.equal(compare(bare, reference.report).verdict.kind, 'unread');
});

test('the printed comparison names the pair, signs every delta, and ends with the verdict', () => {
  const text = formatComparison(pair('2026-09-02T18:24:24', '2026-09-02T18:36:43'));
  assert.match(text, /not a Paired Run/);
  assert.match(text, /LCP -203 ms/);
  assert.match(text, /\+0 requests · -0\.0 KB transferred/);
  assert.match(text, /server latency -210 ms/);
  assert.match(text, /LCP image \+0 B/);
  assert.match(text.split('\n').at(-1), /^  verdict: the tunnel moved/);
  const paired = formatComparison(pair('2026-08-24T20:19:31', '2026-08-25T12:41:32'));
  assert.match(paired, /^Paired Run of https:\/\/valued-washer-york-jvc\.trycloudflare\.com\//);
  assert.match(paired, /982 min apart/);
});

test('a Run writes its Report under the UTC name and returns the summary', async () => {
  const reportsDir = await scratchDir();
  const measure = recordedMeasure(new URL(reference.name, REPORTS));
  const { path: written, summary } = await performRun({ url: PREVIEW_URL, measure, reportsDir, preflight: noPreflight });
  assert.equal(path.basename(written), reportName(reference.report));
  assert.equal(path.dirname(written), reportsDir);
  assert.equal(JSON.parse(await readFile(written, 'utf8')).fetchTime, reference.report.fetchTime);
  assert.equal(summary.requests, 7);
  assert.deepEqual(await readdir(reportsDir), [reportName(reference.report)]);
});

test('a Run never overwrites a Report already on disk', async () => {
  const reportsDir = await scratchDir();
  const measure = recordedMeasure(new URL(reference.name, REPORTS));
  await performRun({ url: PREVIEW_URL, measure, reportsDir, preflight: noPreflight });
  await assert.rejects(performRun({ url: PREVIEW_URL, measure, reportsDir, preflight: noPreflight }), /already/);
});

test('a Run refuses an unreal Report and writes nothing', async () => {
  const reportsDir = await scratchDir();
  const measure = async () => interstitialReport(reference.report);
  await assert.rejects(
    performRun({ url: PREVIEW_URL, measure, reportsDir, preflight: noPreflight }),
    (error) => error instanceof RunRefused && error.reasons.some((r) => r.includes('cdn.ngrok.com')),
  );
  assert.deepEqual(await readdir(reportsDir), []);
});

test('a Run refuses a URL that is not a Preview URL before resolving, warming or measuring anything', async () => {
  const reportsDir = await scratchDir();
  let measured = 0;
  let preflighted = 0;
  const measure = async () => {
    measured += 1;
    return reference.report;
  };
  const preflight = async () => {
    preflighted += 1;
    return [];
  };
  for (const url of ['http://localhost:8000/', 'http://127.0.0.1:8000/', 'not a url']) {
    await assert.rejects(performRun({ url, measure, reportsDir, preflight }), RunRefused);
  }
  assert.equal(measured, 0);
  assert.equal(preflighted, 0);
  assert.deepEqual(await readdir(reportsDir), []);
});

test('a Run resolves and warms the Preview URL before it measures', async () => {
  const reportsDir = await scratchDir();
  const order = [];
  const preflight = async (url) => {
    order.push(`preflight ${url}`);
    return [];
  };
  const measure = async () => {
    order.push('measure');
    return reference.report;
  };
  await performRun({ url: PREVIEW_URL, measure, reportsDir, preflight });
  assert.deepEqual(order, [`preflight ${PREVIEW_URL}`, 'measure']);
});

test('a Run the pre-flight refuses measures nothing and writes nothing', async () => {
  const reportsDir = await scratchDir();
  let measured = 0;
  const measure = async () => {
    measured += 1;
    return reference.report;
  };
  const preflight = async () => ['the name does not resolve'];
  await assert.rejects(
    performRun({ url: PREVIEW_URL, measure, reportsDir, preflight }),
    (error) => error instanceof RunRefused && error.reasons.includes('the name does not resolve'),
  );
  assert.equal(measured, 0);
  assert.deepEqual(await readdir(reportsDir), []);
});

test("the pre-flight accepts the Storefront's own document", async () => {
  assert.deepEqual(await fetchPreflight(await serve(html(INDEX))), []);
});

test('the pre-flight accepts an Arm against its own document on disk, and warms its same-origin assets', async () => {
  const gtm = await armDocument('gtm');
  const requested = new Map();
  const origin = await serve((req, res) => {
    requested.set(req.url, (requested.get(req.url) ?? 0) + 1);
    if (req.url === '/arm-gtm.html') return html(gtm)(req, res);
    if (req.url === '/') return html(INDEX)(req, res);
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end('bytes');
  });
  assert.deepEqual(await fetchPreflight(`${origin}arm-gtm.html`), []);
  assert.equal(requested.get('/arm-gtm.html'), 1);
  for (const asset of page.assets) {
    assert.ok(requested.has(new URL(asset, origin).pathname), `${asset} was not warmed`);
  }
});

test('the pre-flight refuses an Arm URL that serves a different document than the Arm on disk', async () => {
  // An older Measurement Server without the Arm rows answers 404 (refused as "not 200"); a misrouted
  // one answers the control. The served bytes must be the Arm's file, byte for byte.
  const origin = await serve(html(INDEX));
  const [reason, ...rest] = await fetchPreflight(`${origin}arm-gtm.html`);
  assert.deepEqual(rest, []);
  assert.match(reason, /not the Arm on disk/);
  assert.ok(reason.includes('arm-gtm.html'), reason);
});

test('the pre-flight refuses a path the Arms table does not name, before any request', async () => {
  const requested = [];
  const origin = await serve((req, res) => {
    requested.push(req.url);
    html(INDEX)(req, res);
  });
  const [reason, ...rest] = await fetchPreflight(`${origin}nope.html`);
  assert.deepEqual(rest, []);
  assert.match(reason, /not an Arm/);
  assert.ok(reason.includes('/arm-gtm.html'), reason);
  assert.deepEqual(requested, []);
});

test('the pre-flight warms every asset the page references, not only the document', async () => {
  // One GET is not enough for a fresh quick tunnel: the Run of 2026-09-03T12:40:10Z followed one
  // and still read a 266 ms server-latency estimate, because Chrome's parallel requests took paths
  // the one request had not. The pre-flight fetches what the page will, the way the page does.
  const requested = new Map();
  const url = await serve((req, res) => {
    requested.set(req.url, (requested.get(req.url) ?? 0) + 1);
    if (req.url === '/') return html(INDEX)(req, res);
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end('bytes');
  });
  assert.deepEqual(await fetchPreflight(url), []);
  assert.ok(page.assets.length >= 10, `the page references ${page.assets.length} assets`);
  for (const asset of page.assets) {
    const path = new URL(asset, url).pathname;
    assert.ok(requested.has(path), `${path} was not warmed`);
  }
});

test('the pre-flight warms nothing behind a document that is not the Storefront\'s', async () => {
  const requested = [];
  const url = await serve((req, res) => {
    requested.push(req.url);
    html('<!doctype html><html><head><title>ngrok</title></head><body></body></html>')(req, res);
  });
  assert.equal((await fetchPreflight(url)).length, 1);
  assert.deepEqual(requested, ['/']);
});

test("the pre-flight refuses a document that is not the Storefront's, quoting the title it found", async () => {
  const url = await serve(html('<!doctype html><html><head><title>ngrok</title></head><body><p>Visit site</p></body></html>'));
  const [reason, ...rest] = await fetchPreflight(url);
  assert.deepEqual(rest, []);
  assert.match(reason, /not the Storefront/);
  assert.match(reason, /"ngrok"/);
  assert.ok(reason.includes(`"${page.title}"`), reason);
});

test('the pre-flight refuses a Measurement Server still serving an older Generation', async () => {
  const current = page.scripts[0].attrs.src;
  const older = current.replace(/v\d+/, 'v0');
  const stale = INDEX.replace(current, older);
  assert.notEqual(stale, INDEX);
  const [reason, ...rest] = await fetchPreflight(await serve(html(stale)));
  assert.deepEqual(rest, []);
  assert.ok(reason.includes(older), reason);
  assert.match(reason, /Measurement Server/);
});

test('the pre-flight refuses a document that did not answer 200', async () => {
  const [reason, ...rest] = await fetchPreflight(await serve(html('gone', 404)));
  assert.deepEqual(rest, []);
  assert.match(reason, /404/);
});

test('the pre-flight refuses a Preview URL nothing answers', async () => {
  const url = await serve(html(INDEX));
  await new Promise((resolve) => servers.pop().close(resolve));
  const [reason, ...rest] = await fetchPreflight(url);
  assert.deepEqual(rest, []);
  assert.match(reason, /could not reach/);
});

test('the pre-flight refuses a hostname the resolvers do not know, naming DNS and a new tunnel', async () => {
  // .invalid is reserved never to resolve (RFC 2606). Offline, the resolver fails another way and
  // the reason still names DNS, because the query is the step that failed.
  const [reason, ...rest] = await fetchPreflight('https://no-such-name-for-the-pre-flight.invalid/');
  assert.deepEqual(rest, []);
  assert.match(reason, /DNS/);
  assert.match(reason, /new tunnel/);
});

test('the command refuses a hostname the resolvers do not know before launching anything', () => {
  const command = fileURLToPath(new URL('../tools/run.mjs', import.meta.url));
  const started = Date.now();
  const refused = spawnSync(process.execPath, [command, 'https://no-such-name-for-the-pre-flight.invalid/'], { encoding: 'utf8' });
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /Run refused/);
  assert.match(refused.stderr, /DNS/);
  assert.ok(Date.now() - started < 15000, 'a refusal takes seconds; a Lighthouse pass takes a minute');
});

test('the command summarises a recorded Report without measuring anything, ending with the CLAUDE.md line', () => {
  const command = fileURLToPath(new URL('../tools/run.mjs', import.meta.url));
  const recordedFile = fileURLToPath(new URL(reference.name, REPORTS));
  const result = spawnSync(process.execPath, [command, recordedFile], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const summary = summarize(reference.report);
  assert.equal(result.stdout.trim(), `${formatSummary(summary)}\nCLAUDE.md: ${formatCurrentState(summary)}`);
});

test("a Report's current-state line is the figures CLAUDE.md quotes, in its words", () => {
  assert.equal(
    formatCurrentState(summarize(byFetchTime('2026-09-02T18:36:43'))),
    'performance 100 / accessibility 100 / best-practices 100 / SEO 100, FCP = LCP = 911 ms, TBT 0, CLS 0, 9 requests, 43.7 KB transferred',
  );
  assert.equal(
    formatCurrentState(summarize(reference.report)),
    'performance 100 / accessibility 100 / best-practices 100 / SEO 92, FCP 894 ms, LCP 936 ms, TBT 0, CLS 0, 7 requests, 35.0 KB transferred',
  );
});

test("CLAUDE.md's current state is the newest Report of the control, quoted in the line the command prints", async () => {
  // D12: the paragraph is pasted from `node tools/run.mjs reports/<newest control>.json`, never
  // composed. The control, because after a Bench the newest Report is usually an Arm's, and the
  // current state is the Storefront's. Whitespace is collapsed because the paragraph wraps.
  const claude = (await readFile(new URL('../CLAUDE.md', import.meta.url), 'utf8')).replace(/\s+/g, ' ');
  const cited = /Current state \(Run of (\S+Z)/.exec(claude);
  assert.ok(cited, 'CLAUDE.md cites no Run as its current state');
  const controls = recorded.filter(({ report }) => new URL(report.requestedUrl).pathname === '/');
  assert.ok(controls.length > 0);
  const newest = controls.reduce((a, b) => (a.report.fetchTime > b.report.fetchTime ? a : b)).report;
  assert.equal(cited[1], newest.fetchTime.replace(/\.\d+Z$/, 'Z'), 'CLAUDE.md cites a Run that is not the newest Report of the control');
  const line = formatCurrentState(summarize(newest));
  assert.ok(claude.includes(line), `CLAUDE.md does not quote the newest control Report's line verbatim:\n${line}`);
});

test('the command compares two recorded Reports without measuring anything', () => {
  const command = fileURLToPath(new URL('../tools/run.mjs', import.meta.url));
  const file = (prefix) => fileURLToPath(new URL(recorded.find(({ report }) => report.fetchTime.startsWith(prefix)).name, REPORTS));
  const [a, b] = [file('2026-09-02T18:24:24'), file('2026-09-02T18:36:43')];
  const result = spawnSync(process.execPath, [command, 'compare', a, b], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), formatComparison(pair('2026-09-02T18:24:24', '2026-09-02T18:36:43')));
  const short = spawnSync(process.execPath, [command, 'compare', a], { encoding: 'utf8' });
  assert.equal(short.status, 2);
  assert.match(short.stderr, /compare/);
});

test('the command prints usage without a Preview URL and the reasons when it refuses', () => {
  const command = fileURLToPath(new URL('../tools/run.mjs', import.meta.url));
  const usage = spawnSync(process.execPath, [command], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stdout + usage.stderr, /preview-url/);
  const refused = spawnSync(process.execPath, [command, 'http://localhost:8000/'], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /localhost/);
});
