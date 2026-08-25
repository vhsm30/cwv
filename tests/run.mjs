import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkReport, formatSummary, readReport, reportName, summarize } from '../lib/report.mjs';
import { RunRefused, performRun, recordedMeasure } from '../tools/run.mjs';

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

test('a Run writes its Report under the UTC name and returns the summary', async () => {
  const reportsDir = await scratchDir();
  const measure = recordedMeasure(new URL(reference.name, REPORTS));
  const { path: written, summary } = await performRun({ url: PREVIEW_URL, measure, reportsDir });
  assert.equal(path.basename(written), reportName(reference.report));
  assert.equal(path.dirname(written), reportsDir);
  assert.equal(JSON.parse(await readFile(written, 'utf8')).fetchTime, reference.report.fetchTime);
  assert.equal(summary.requests, 7);
  assert.deepEqual(await readdir(reportsDir), [reportName(reference.report)]);
});

test('a Run never overwrites a Report already on disk', async () => {
  const reportsDir = await scratchDir();
  const measure = recordedMeasure(new URL(reference.name, REPORTS));
  await performRun({ url: PREVIEW_URL, measure, reportsDir });
  await assert.rejects(performRun({ url: PREVIEW_URL, measure, reportsDir }), /already/);
});

test('a Run refuses an unreal Report and writes nothing', async () => {
  const reportsDir = await scratchDir();
  const measure = async () => interstitialReport(reference.report);
  await assert.rejects(
    performRun({ url: PREVIEW_URL, measure, reportsDir }),
    (error) => error instanceof RunRefused && error.reasons.some((r) => r.includes('cdn.ngrok.com')),
  );
  assert.deepEqual(await readdir(reportsDir), []);
});

test('a Run refuses a URL that is not a Preview URL before measuring anything', async () => {
  const reportsDir = await scratchDir();
  let measured = 0;
  const measure = async () => {
    measured += 1;
    return reference.report;
  };
  for (const url of ['http://localhost:8000/', 'http://127.0.0.1:8000/', 'not a url']) {
    await assert.rejects(performRun({ url, measure, reportsDir }), RunRefused);
  }
  assert.equal(measured, 0);
  assert.deepEqual(await readdir(reportsDir), []);
});

test('the command summarises a recorded Report without measuring anything', () => {
  const command = fileURLToPath(new URL('../tools/run.mjs', import.meta.url));
  const recordedFile = fileURLToPath(new URL(reference.name, REPORTS));
  const result = spawnSync(process.execPath, [command, recordedFile], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), formatSummary(summarize(reference.report)));
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
