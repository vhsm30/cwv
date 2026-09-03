// Lock-in for the Bench: the Arms table, the generated Arm documents, the reading, and the record.
// The Performance Contract keeps holding for index.html alone; everything an Arm adds is held here.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

import { ARMS_URL, ROOT_URL, armForPath, loadArms, slugOf, validateArms } from '../lib/arms.mjs';
import { parsePage } from '../lib/page.mjs';
import { afterLoadSnippet, buildArm, headSnippet, noscriptSnippet } from '../tools/build-arms.mjs';
import { MEASURES, formatBenchOfRecord, formatReading, median, reading } from '../lib/bench.mjs';
import { readReport, summarize } from '../lib/report.mjs';
import { RunRefused } from '../tools/run.mjs';
import { performBench, readBench, recordName, writeBench } from '../tools/bench.mjs';

const table = await loadArms();
const INDEX = await readFile(new URL('index.html', ROOT_URL), 'utf8');

test('the Arms table is well-formed: one control at /, root-level Arms, a GTM container', () => {
  assert.deepEqual(validateArms(table), []);
  assert.equal(table.container.id, 'GTM-PRVCQ335');
  assert.ok(table.container.holds.length > 0, 'the table says what the container holds');
  assert.deepEqual(table.arms.map((arm) => arm.name), ['control', 'gtm', 'gtm-deferred']);
});

test('the table refuses what would break the Bench', () => {
  const clone = () => structuredClone(table);
  const twice = clone();
  twice.arms.push({ ...twice.arms[1] });
  assert.ok(validateArms(twice).some((p) => /unique/.test(p)), validateArms(twice).join('\n'));
  const noControl = clone();
  noControl.arms[0].path = '/index.html';
  assert.ok(validateArms(noControl).some((p) => /control/.test(p)));
  const nested = clone();
  nested.arms[1].path = '/arms/gtm.html';
  nested.arms[1].file = 'arms/gtm.html';
  assert.ok(validateArms(nested).some((p) => /root-level/.test(p)));
  const drift = clone();
  drift.arms[1].file = 'other.html';
  assert.ok(validateArms(drift).some((p) => /file/.test(p)));
  const badId = clone();
  badId.container.id = 'UA-123';
  assert.ok(validateArms(badId).some((p) => /GTM-/.test(p)));
  const badDelivery = clone();
  badDelivery.arms[2].delivery = 'on-scroll';
  assert.ok(validateArms(badDelivery).some((p) => /delivery/.test(p)));
});

test('an Arm is found by its path, and a Report slug is the path without slash and extension', () => {
  assert.equal(armForPath(table, '/').name, 'control');
  assert.equal(armForPath(table, '/arm-gtm.html').name, 'gtm');
  assert.equal(armForPath(table, '/nope.html'), null);
  assert.equal(slugOf('/'), null);
  assert.equal(slugOf('/arm-gtm.html'), 'arm-gtm');
  assert.equal(slugOf('/arm-gtm-deferred.html'), 'arm-gtm-deferred');
});

test('the table on disk is the one the loader reads', async () => {
  assert.deepEqual(JSON.parse(await readFile(ARMS_URL, 'utf8')), table);
});

const control = parsePage(INDEX);
const armFile = (arm) => readFile(new URL(arm.file, ROOT_URL), 'utf8');
const gtmArm = table.arms.find((arm) => arm.name === 'gtm');
const deferredArm = table.arms.find((arm) => arm.name === 'gtm-deferred');

test('the control Arm is index.html itself', () => {
  assert.equal(buildArm(INDEX, table.arms[0], table.container), INDEX);
});

test('every Arm on disk is the generator applied to the control on disk', async () => {
  // A change to index.html demands `node tools/build-arms.mjs`, as a Master's change demands its
  // Rungs; a stale Arm would measure yesterday's control.
  for (const arm of table.arms) {
    if (arm.delivery === 'none') continue;
    assert.equal(await armFile(arm), buildArm(INDEX, arm, table.container), `${arm.file} is stale: run node tools/build-arms.mjs`);
  }
});

test('no Arm document exists beside the table', async () => {
  const onDisk = (await readdir(ROOT_URL)).filter((name) => /^arm-.*\.html$/.test(name)).sort();
  const declared = table.arms.filter((arm) => arm.delivery !== 'none').map((arm) => arm.file).sort();
  assert.deepEqual(onDisk, declared);
});

test("the head Arm differs from the control by Google's two snippets and nothing else", async () => {
  const id = table.container.id;
  const html = await armFile(gtmArm);
  const stripped = html.replace(`\n  ${headSnippet(id)}`, '').replace(`\n  ${noscriptSnippet(id)}`, '');
  assert.equal(stripped, INDEX);
  // As high in the head as the charset rule allows: after <meta charset>, before everything else.
  const page = parsePage(html);
  const charset = page.elements('meta').find((tag) => 'charset' in tag.attrs);
  const viewport = page.elements('meta').find((tag) => tag.attrs.name === 'viewport');
  const snippetAt = html.indexOf(headSnippet(id));
  assert.ok(charset.end < snippetAt && snippetAt < viewport.start, 'the snippet sits between the charset meta and the viewport meta');
  assert.equal(page.scripts.length, 2, 'the inline snippet and the behaviour');
  assert.ok(page.scripts[0].inline.includes(id));
  assert.equal(page.scripts[0].inline.includes('j.async=true'), true, "Google's snippet loads gtm.js async");
  assert.deepEqual(page.assets, control.assets, 'the snippet names no asset the page model can see; the container is fetched by script');
  assert.equal(page.title, control.title);
  // The noscript iframe sits right after the body start tag.
  const body = page.elements('body')[0];
  assert.equal(html.indexOf(noscriptSnippet(id)), body.end + '\n  '.length);
});

test('the deferred Arm keeps the control\'s head byte for byte and adds one script before </body>', async () => {
  const id = table.container.id;
  const html = await armFile(deferredArm);
  const headEnd = INDEX.indexOf('</head>');
  assert.equal(html.slice(0, headEnd), INDEX.slice(0, headEnd));
  assert.equal(html.replace(`${afterLoadSnippet(id)}\n`, ''), INDEX);
  const page = parsePage(html);
  assert.equal(page.scripts.length, 2, 'the behaviour and the loader');
  assert.equal(page.scripts[0].attrs.src, control.scripts[0].attrs.src, 'the behaviour still comes first');
  const loader = page.scripts[1].inline;
  assert.ok(loader.includes("addEventListener('load'"), 'waits for load');
  assert.ok(loader.includes('requestIdleCallback'), 'then idles');
  assert.ok(loader.includes('timeout:1000'), 'with a one-second ceiling');
  assert.ok(loader.includes(`gtm.js?id=${id}`));
  assert.ok(loader.includes("'gtm.start'"), 'seeds dataLayer as the standard snippet does');
  assert.ok(!html.includes('ns.html'), 'no noscript iframe: there is no standard form to be verbatim about');
  assert.deepEqual(page.assets, control.assets);
});

test('the snippets name the container and its origin', () => {
  for (const snippet of [headSnippet('GTM-TEST123'), noscriptSnippet('GTM-TEST123'), afterLoadSnippet('GTM-TEST123')]) {
    assert.ok(snippet.includes('GTM-TEST123'));
    assert.ok(snippet.includes('https://www.googletagmanager.com/'));
  }
});

// A summary the way summarize() shapes one, with only what the reading reads.
const summaryOf = ({ tbt = 0, lcp = 950, fcp = 950, requests = 9, transferBytes = 44700, thirdParty = 0, origins = {}, loadDelay = 11, renderDelay = 50, serverLatency = 60, cold = false } = {}) => ({
  metrics: { tbt, lcp, fcp, cls: 0 },
  requests,
  transferBytes,
  thirdParty: { requests: Object.values(origins).reduce((n, o) => n + o.requests, 0), transferBytes: thirdParty, origins },
  pageShare: { loadDelay, renderDelay, lcpUrl: null, lcpBytes: 6654 },
  tunnelShare: { ttfb: 140, loadDuration: 80, serverLatency, rtt: 20 },
  artifacts: cold ? [{ audit: 'network-server-latency', category: 'performance', reason: 'cold', scoreWithout: null }] : [],
});
const gtmOrigins = { 'www.googletagmanager.com': { requests: 1, transferBytes: 70000 } };
const run = (arm, role, summary, report = `${arm}-${role}.json`) => ({ arm, role, report, summary });
const session = (rows) => reading({ container: table.container, arms: table.arms, runs: rows });

test('the median is the middle value, or the mean of the two middle values', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([7]), 7);
});

test('the reading gives every Arm min, median and max per measure, warm-up excluded', () => {
  const r = session([
    run('control', 'warm-up', summaryOf({ tbt: 999, renderDelay: 131 })),
    run('control', 'round 1', summaryOf({ tbt: 0, lcp: 940 })),
    run('gtm', 'round 1', summaryOf({ tbt: 150, lcp: 990, origins: gtmOrigins, thirdParty: 70000 })),
    run('control', 'round 2', summaryOf({ tbt: 0, lcp: 960 })),
    run('gtm', 'round 2', summaryOf({ tbt: 170, lcp: 1010, origins: gtmOrigins, thirdParty: 70000 })),
    run('control', 'round 3', summaryOf({ tbt: 0, lcp: 950 })),
    run('gtm', 'round 3', summaryOf({ tbt: 160, lcp: 1000, origins: gtmOrigins, thirdParty: 70000 })),
  ]);
  assert.equal(r.rounds, 3);
  assert.deepEqual(MEASURES.map((m) => m.key), ['tbt', 'lcp', 'fcp', 'requests', 'transferBytes', 'thirdPartyBytes', 'loadDelay', 'renderDelay', 'serverLatency']);
  assert.equal(r.arms.control.n, 3, 'the warm-up is not a round');
  assert.deepEqual(r.arms.control.measures.tbt, { min: 0, median: 0, max: 0 });
  assert.deepEqual(r.arms.control.measures.lcp, { min: 940, median: 950, max: 960 });
  assert.deepEqual(r.arms.gtm.measures.tbt, { min: 150, median: 160, max: 170 });
  assert.deepEqual(r.arms.gtm.measures.thirdPartyBytes, { min: 70000, median: 70000, max: 70000 });
  assert.equal(r.costs.control, undefined, 'the control has no cost against itself');
});

test('a cost is real only when the Arm and the control do not overlap, in the direction of the cost', () => {
  const r = session([
    run('control', 'round 1', summaryOf({ tbt: 0, lcp: 900, fcp: 900 })),
    run('gtm', 'round 1', summaryOf({ tbt: 150, lcp: 960, fcp: 800, origins: gtmOrigins })),
    run('control', 'round 2', summaryOf({ tbt: 0, lcp: 1000, fcp: 950 })),
    run('gtm', 'round 2', summaryOf({ tbt: 170, lcp: 970, fcp: 810, origins: gtmOrigins })),
    run('control', 'round 3', summaryOf({ tbt: 0, lcp: 950, fcp: 1000 })),
    run('gtm', 'round 3', summaryOf({ tbt: 160, lcp: 980, fcp: 820, origins: gtmOrigins })),
  ]);
  assert.deepEqual(r.costs.gtm.tbt, { delta: 160, real: true });
  assert.deepEqual(r.costs.gtm.lcp, { delta: 20, real: false }, 'LCP 960-980 sits inside the control\'s 900-1000');
  assert.deepEqual(r.costs.gtm.fcp, { delta: -140, real: true }, 'a gain is real the same way');
  assert.deepEqual(r.costs.gtm.requests, { delta: 0, real: false }, 'no difference is never real');
});

test('the reading marks a cold-tunnel Run and an Arm Run whose container never loaded', () => {
  const r = session([
    run('control', 'round 1', summaryOf({ cold: true }), 'cold.json'),
    run('gtm', 'round 1', summaryOf({ tbt: 160, origins: gtmOrigins }), 'loaded.json'),
    run('gtm-deferred', 'round 1', summaryOf({ tbt: 0 }), 'not-loaded.json'),
  ]);
  assert.deepEqual(r.runs.map((x) => [x.report, x.marks]), [
    ['cold.json', ['cold tunnel']],
    ['loaded.json', []],
    ['not-loaded.json', ['container not loaded']],
  ]);
});

test('an Arm with no rounds reads null, not a crash', () => {
  const r = session([run('control', 'round 1', summaryOf())]);
  assert.equal(r.arms.gtm.n, 0);
  assert.equal(r.arms.gtm.measures.tbt, null);
  assert.equal(r.costs.gtm.tbt, null);
});

test('the printed reading is one line per measure and names what is real', () => {
  const r = session([
    run('control', 'round 1', summaryOf({ tbt: 0 })),
    run('gtm', 'round 1', summaryOf({ tbt: 150, origins: gtmOrigins, thirdParty: 70000, requests: 13, transferBytes: 114700 })),
    run('control', 'round 2', summaryOf({ tbt: 0 })),
    run('gtm', 'round 2', summaryOf({ tbt: 170, origins: gtmOrigins, thirdParty: 70000, requests: 13, transferBytes: 114700 })),
    run('control', 'round 3', summaryOf({ tbt: 0 })),
    run('gtm', 'round 3', summaryOf({ tbt: 160, origins: gtmOrigins, thirdParty: 70000, requests: 13, transferBytes: 114700 })),
  ]);
  const text = formatReading(r, { previewUrl: 'https://x.trycloudflare.com/', started: '2026-09-04T10:00:00.000Z', rounds: 3, container: table.container });
  const lines = text.split('\n');
  assert.equal(lines[0], `Bench of https://x.trycloudflare.com/ started 2026-09-04T10:00:00.000Z: 3 rounds, container GTM-PRVCQ335 (${table.container.holds})`);
  assert.equal(lines[1], '  runs: 6, marks: none');
  assert.equal(lines[2], '  TBT: control 0 / 0 / 0 ms (n 3) · gtm 150 / 160 / 170 ms (n 3), +160 ms real · gtm-deferred - (n 0)');
  assert.equal(lines[5], '  requests: control 9 / 9 / 9 (n 3) · gtm 13 / 13 / 13 (n 3), +4 real · gtm-deferred - (n 0)');
  assert.equal(lines[6], '  transferred: control 43.7 / 43.7 / 43.7 KB (n 3) · gtm 112.0 / 112.0 / 112.0 KB (n 3), +68.4 KB real · gtm-deferred - (n 0)');
  assert.equal(lines.length, 2 + MEASURES.length);
});

test('the bench of record is one line CLAUDE.md can quote', () => {
  const r = session([
    run('control', 'round 1', summaryOf({ tbt: 0, lcp: 940 })),
    run('gtm', 'round 1', summaryOf({ tbt: 150, lcp: 990, origins: gtmOrigins, thirdParty: 70000, requests: 13, transferBytes: 114700 })),
    run('control', 'round 2', summaryOf({ tbt: 0, lcp: 960 })),
    run('gtm', 'round 2', summaryOf({ tbt: 170, lcp: 1010, origins: gtmOrigins, thirdParty: 70000, requests: 13, transferBytes: 114700 })),
    run('control', 'round 3', summaryOf({ tbt: 0, lcp: 950 })),
    run('gtm', 'round 3', summaryOf({ tbt: 160, lcp: 1000, origins: gtmOrigins, thirdParty: 70000, requests: 13, transferBytes: 114700 })),
  ]);
  const record = { previewUrl: 'https://x.trycloudflare.com/', started: '2026-09-04T10:00:00.000Z', rounds: 3, container: table.container, arms: table.arms, runs: r.runs, reading: r };
  assert.equal(
    formatBenchOfRecord(record, 'x.trycloudflare.com-20260904T100000Z.json'),
    `Bench of record (benches/x.trycloudflare.com-20260904T100000Z.json, 2026-09-04T10:00:00Z, 3 rounds, GTM-PRVCQ335: ${table.container.holds}): control medians TBT 0 ms, LCP 950 ms, 9 requests, 43.7 KB; gtm: TBT +160 ms (real) · LCP +50 ms (real) · requests +4 (real) · transferred +68.4 KB (real) · third-party bytes +68.4 KB (real); gtm-deferred: no rounds`,
  );
});

const scratch = [];
const scratchDir = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bench-'));
  scratch.push(dir);
  return dir;
};
after(() => Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true }))));

// A recorded control Report stands in for every Run; the bench only reads the summary.
const REPORTS = new URL('reports/', ROOT_URL);
const recordedNames = (await readdir(REPORTS)).filter((name) => name.endsWith('.json')).sort();
const newestControlName = recordedNames.at(-1);
const newestControl = await readReport(new URL(newestControlName, REPORTS));
const fakeRun = (log) => async ({ url }) => {
  log.push(url);
  return { path: path.join('reports', `${log.length}.json`), summary: summarize(newestControl) };
};

test('the bench Runs a warm-up of the control, then every Arm in turn per round, through one Preview URL', async () => {
  const urls = [];
  const record = await performBench({ previewUrl: 'https://x.trycloudflare.com/', rounds: 2, table, run: fakeRun(urls), now: () => new Date('2026-09-04T10:00:00Z') });
  assert.deepEqual(urls, [
    'https://x.trycloudflare.com/',
    'https://x.trycloudflare.com/', 'https://x.trycloudflare.com/arm-gtm.html', 'https://x.trycloudflare.com/arm-gtm-deferred.html',
    'https://x.trycloudflare.com/', 'https://x.trycloudflare.com/arm-gtm.html', 'https://x.trycloudflare.com/arm-gtm-deferred.html',
  ]);
  assert.equal(record.previewUrl, 'https://x.trycloudflare.com/');
  assert.equal(record.started, '2026-09-04T10:00:00.000Z');
  assert.equal(record.rounds, 2);
  assert.deepEqual(record.container, table.container);
  assert.deepEqual(record.arms, table.arms);
  assert.deepEqual(record.runs.map((r) => [r.arm, r.role, r.report]), [
    ['control', 'warm-up', '1.json'],
    ['control', 'round 1', '2.json'], ['gtm', 'round 1', '3.json'], ['gtm-deferred', 'round 1', '4.json'],
    ['control', 'round 2', '5.json'], ['gtm', 'round 2', '6.json'], ['gtm-deferred', 'round 2', '7.json'],
  ]);
  assert.equal(record.reading.arms.control.n, 2);
  assert.equal(recordName(record), 'x.trycloudflare.com-20260904T100000Z.json');
});

test('a refused Run stops the bench with its reason; no record is written', async () => {
  const urls = [];
  const run = async ({ url }) => {
    urls.push(url);
    if (urls.length === 3) throw new RunRefused(['the tunnel went away']);
    return { path: `reports/${urls.length}.json`, summary: summarize(newestControl) };
  };
  await assert.rejects(performBench({ previewUrl: 'https://x.trycloudflare.com/', rounds: 3, table, run }), (error) => error instanceof RunRefused && error.reasons.includes('the tunnel went away'));
  assert.equal(urls.length, 3);
});

test('the record is written under benches/ by host and moment, and read back from the Reports it names', async () => {
  const dir = await scratchDir();
  const record = await performBench({ previewUrl: 'https://x.trycloudflare.com/', rounds: 1, table, run: async () => ({ path: path.join('reports', newestControlName), summary: summarize(newestControl) }), now: () => new Date('2026-09-04T10:00:00Z') });
  const written = await writeBench(record, dir);
  assert.equal(path.basename(written), 'x.trycloudflare.com-20260904T100000Z.json');
  assert.deepEqual(JSON.parse(await readFile(written, 'utf8')), record);
  const { record: again, reading: recomputed, file } = await readBench(written);
  assert.deepEqual(again, record);
  assert.deepEqual(recomputed, record.reading, 'the reading recomputed from the Reports is the one recorded');
  assert.equal(file, 'x.trycloudflare.com-20260904T100000Z.json');
});

test('the command reads a record without measuring anything, ending with the CLAUDE.md line', async () => {
  const dir = await scratchDir();
  const record = await performBench({ previewUrl: 'https://x.trycloudflare.com/', rounds: 1, table, run: async () => ({ path: path.join('reports', newestControlName), summary: summarize(newestControl) }), now: () => new Date('2026-09-04T10:00:00Z') });
  const written = await writeBench(record, dir);
  const command = fileURLToPath(new URL('tools/bench.mjs', ROOT_URL));
  const result = spawnSync(process.execPath, [command, 'read', written], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const expected = `${formatReading(record.reading, record)}\nCLAUDE.md: ${formatBenchOfRecord(record, path.basename(written))}`;
  assert.equal(result.stdout.trim(), expected);
  const usage = spawnSync(process.execPath, [command], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /rounds/);
});

test("CLAUDE.md's bench of record is the newest record under benches/, quoted in the line the command prints", async () => {
  const names = (await readdir(new URL('benches/', ROOT_URL))).filter((name) => name.endsWith('.json')).sort();
  if (!names.length) return; // before the first live Bench there is nothing to quote
  const newest = names.at(-1);
  const { record } = await readBench(new URL(`benches/${newest}`, ROOT_URL));
  const claude = (await readFile(new URL('CLAUDE.md', ROOT_URL), 'utf8')).replace(/\s+/g, ' ');
  assert.ok(claude.includes(formatBenchOfRecord(record, newest)), `CLAUDE.md does not quote the newest bench of record:\n${formatBenchOfRecord(record, newest)}`);
});
