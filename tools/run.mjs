#!/usr/bin/env node
// The Run: one Lighthouse measurement of the Preview URL at mobile form factor under simulated
// throttling, kept only when the Report is real.
//
//     node tools/run.mjs https://<name>.trycloudflare.com/
//
// Before Chrome launches, a pre-flight (fetchPreflight) names the Arm from the path (bench/arms.json),
// resolves the hostname directly at the configured DNS servers, fetches the document and reads it
// against the Arm's file on disk, and then warms the tunnel by fetching every asset the page
// references, so a hostname that has not
// propagated or a stale Measurement Server is refused in seconds rather than after a full
// Lighthouse pass, and the Run does not measure the tunnel waking up. The measurement carries ngrok's bypass header: free-tier
// ngrok answers browser user-agents with an interstitial unless it is present, and every other
// tunnel ignores it. The Report is then checked (lib/report.mjs) before it is saved under reports/,
// named by its own UTC fetchTime, and summarised. Three adapters satisfy `measure`: Lighthouse
// (lighthouseMeasure), two navigations of one browser (repeatMeasure, the Repeat Visit), and a
// recorded Report (recordedMeasure); two satisfy `preflight`: the real one and a no-op, which is
// how tests/run.mjs asserts everything after the measurement without a tunnel or Chrome.
import { exec, spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { ROOT_URL, armForPath, loadArms } from '../lib/arms.mjs';
import { loadPage, parsePage } from '../lib/page.mjs';
import { checkReport, compare, formatComparison, formatCurrentState, formatSummary, previewUrlProblem, reportName, summarize } from '../lib/report.mjs';

const REPORTS_DIR = fileURLToPath(new URL('../reports/', import.meta.url));
const BYPASS_HEADERS = { 'ngrok-skip-browser-warning': 'true' };
// Every setting a measurement is taken under, in one place. A Run reaches Chrome through the
// Lighthouse CLI and a Repeat Visit through Lighthouse's own API; two literals would drift the
// moment a flag were added to one and not the other, and a Repeat Visit measured under conditions
// its Run was not is a Report that lies quietly — `compare` reads the two side by side and could
// not tell. So the CLI's flags are derived from these, never written beside them.
const MEASUREMENT = {
  formFactor: 'mobile',
  screenEmulation: { mobile: true },
  onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
};

// The same settings as CLI flags, in the order a Run has always passed them. --extra-headers names
// a file the caller writes; BYPASS_HEADERS is what goes in it, and is what apiPass passes directly.
const measurementArgs = (headersFile) => [
  `--form-factor=${MEASUREMENT.formFactor}`,
  ...(MEASUREMENT.screenEmulation.mobile ? ['--screenEmulation.mobile'] : []),
  `--extra-headers=${headersFile}`,
  `--only-categories=${MEASUREMENT.onlyCategories.join(',')}`,
];

// A Run's whole command line, exported so it can be pinned: the assertion that the Run's path has
// not moved is worth more than the comment saying it must not.
export function passArgs({ cli, url, reportFile, headersFile, profile, extra = [] }) {
  return [
    cli,
    url,
    '--output=json',
    `--output-path=${reportFile}`,
    ...measurementArgs(headersFile),
    `--chrome-flags=--headless=new --no-sandbox --user-data-dir=${profile}`,
    '--quiet',
    ...extra,
  ];
}

// Asks the configured DNS servers directly (c-ares), bypassing the Windows cache that `curl` reads
// from — the cache that said "yes" on 2026-09-02 while the Run's Chrome was told "no such name".
// Bounded, so an unanswered query refuses in seconds.
const resolver = new dns.Resolver({ timeout: 3000, tries: 2 });

const dnsProblem = (hostname, code) =>
  `${hostname} does not resolve (${code}) at the configured DNS servers, asked directly rather than through the Windows cache: a fresh quick-tunnel hostname that has not propagated, or a resolver holding a poisoned answer — start a new tunnel rather than waiting out the TTL (measuring-runs, "A fresh hostname and DNS")`;

// The pre-flight: every reason to refuse before Chrome launches, or empty. The path names the Arm
// (bench/arms.json), one DNS query, one GET of the document read against the Arm's file on disk,
// and then the warming: a fresh quick tunnel answers its first request in ~1.4 s and the next in
// ~0.2 s, and a Run taken cold records the tunnel waking up as the page's LCP.
export async function fetchPreflight(url) {
  const { hostname, pathname, origin } = new URL(url);
  const table = await loadArms();
  const arm = armForPath(table, pathname);
  if (!arm) return [`${pathname} is not an Arm: bench/arms.json names ${table.arms.map((a) => a.path).join(', ')}`];
  if (!net.isIP(hostname)) {
    try {
      await resolver.resolve4(hostname);
    } catch (error) {
      return [dnsProblem(hostname, error.code ?? error.message)];
    }
  }
  let response;
  try {
    response = await fetch(url, { headers: BYPASS_HEADERS, redirect: 'manual' });
  } catch (error) {
    const code = error.cause?.code ?? error.code ?? error.message;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return [dnsProblem(hostname, code)];
    return [`could not reach ${url} (${code})`];
  }
  if (response.status !== 200) return [`the document at ${url} answered ${response.status}, not 200`];
  const servedHtml = await response.text();
  const served = parsePage(servedHtml, url);
  const expected = await loadPage(new URL(arm.file, ROOT_URL));
  if (served.title !== expected.title) {
    return [`the document at ${url} is not the Storefront's: its title is "${served.title}" against "${expected.title}"`];
  }
  const missing = expected.assets.filter((asset) => !served.assets.includes(asset));
  const extra = served.assets.filter((asset) => !expected.assets.includes(asset));
  if (missing.length || extra.length) {
    return [
      `the document at ${url} is not the Storefront on disk: it references ${extra.join(', ') || 'nothing'} where the page on disk references ${missing.join(', ') || 'nothing'} — an older Measurement Server still listening?`,
    ];
  }
  // An Arm differs from the control by a snippet the page model does not see as an asset, so the
  // Arm's bytes are compared whole: a misrouted server answering the control here would measure it.
  if (arm.delivery !== 'none' && servedHtml !== expected.html) {
    return [`the document at ${url} is not the Arm on disk (${arm.file}): the served bytes differ — an older Measurement Server still listening?`];
  }
  // Warm the paths the Run's Chrome will take, in parallel, the way the page loads: one GET is not
  // enough for a fresh quick tunnel (the Run of 2026-09-03T12:40:10Z followed one and still read a
  // 266 ms server-latency estimate). Same-origin only: the container is not ours to warm. Best
  // effort — a missing asset is the Run's to record.
  await Promise.all(
    expected.assets
      .map((asset) => new URL(asset, url))
      .filter((target) => target.origin === origin)
      .map((target) =>
        fetch(target, { headers: BYPASS_HEADERS })
          .then((r) => r.arrayBuffer())
          .catch(() => undefined),
      ),
  );
  return [];
}

export class RunRefused extends Error {
  constructor(reasons) {
    super(`Run refused:\n${reasons.map((reason) => `  - ${reason}`).join('\n')}`);
    this.name = 'RunRefused';
    this.reasons = reasons;
  }
}

// Perform a Run: refuse anything but a Preview URL, pre-flight (resolve, warm, read the document),
// measure, refuse an unreal Report, save, summarise. With `repeat`, the same procedure performs a
// Repeat Visit instead (CONTEXT.md): a different measurement, a different Report name, and each
// refuses the other's Report.
export async function performRun({ url, measure, reportsDir = REPORTS_DIR, preflight = fetchPreflight, repeat = false }) {
  const problem = previewUrlProblem(url);
  if (problem) throw new RunRefused([problem]);
  const refusals = await preflight(url);
  if (refusals.length) throw new RunRefused(refusals);
  const report = await (measure ?? (repeat ? repeatMeasure : lighthouseMeasure))(url);
  const reasons = checkReport(report, url, { repeat });
  if (reasons.length) throw new RunRefused(reasons);

  const directory = reportsDir instanceof URL ? fileURLToPath(reportsDir) : reportsDir;
  const target = path.join(directory, reportName(report, { repeat }));
  try {
    await writeFile(target, JSON.stringify(report, null, 2), { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`${target} already exists; a Report is never overwritten`);
    throw error;
  }
  return { path: target, summary: summarize(report, { repeat }) };
}

// One Lighthouse pass. `profile` is inert, and knowingly so: chrome-launcher pushes its own
// --user-data-dir ahead of anything in --chrome-flags and Chromium honours the first it is given, so
// the CLI always measures in a temporary profile of chrome-launcher's own naming. Nothing is lost —
// a Run is a first visit and wants a fresh profile — but it is also why the Repeat Visit could not
// stay on the CLI and drives Lighthouse's API instead (repeatMeasure). The flag is kept because
// removing it would move a Run's command line, which is pinned (passArgs), and would strand
// workDirectory's space guard below, which exists only because this path is space-joined into
// --chrome-flags.
async function lighthousePass({ cli, url, workDir, name, profile, extra = [] }) {
  const headersFile = path.join(workDir, 'headers.json');
  const reportFile = path.join(workDir, `${name}.json`);
  await writeFile(headersFile, JSON.stringify(BYPASS_HEADERS));
  const args = passArgs({ cli, url, reportFile, headersFile, profile, extra });
  const { code, stderr } = await finished(spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] }));
  let text = null;
  try {
    text = await readFile(reportFile, 'utf8');
  } catch {
    // No Report at all: the exit code and stderr say why.
  }
  if (text === null) {
    throw new Error(`Lighthouse exited with code ${code} and left no Report${stderr.trim() ? `:\n${stderr.trim()}` : ''}`);
  }
  // A non-zero exit after the Report was written is chrome-launcher failing to delete Chrome's
  // temporary profile (EPERM on Windows). The Report is complete; that noise is not a reason.
  return JSON.parse(text);
}

// A working directory whose path holds no space: --chrome-flags is one space-separated string, so
// a profile directory with a space in it would reach Chrome as two flags.
async function workDirectory(prefix) {
  const workDir = await mkdtemp(path.join(tmpdir(), prefix));
  if (/\s/.test(workDir)) {
    await rm(workDir, { recursive: true, force: true });
    throw new Error(`${workDir} has a space in its path, and Chrome flags are one space-separated string; set TEMP to a path without spaces`);
  }
  return workDir;
}

// The Lighthouse adapter: the CLI this machine has installed globally, run without a shell so the
// header file path and the Chrome flags need no quoting on any platform.
export async function lighthouseMeasure(url) {
  const cli = await lighthouseCli();
  const workDir = await workDirectory('run-');
  try {
    return await lighthousePass({ cli, url, workDir, name: 'report', profile: path.join(workDir, 'profile') });
  } finally {
    // Chrome may still hold the profile's files (EPERM on Windows — the same failure
    // chrome-launcher's own cleanup retries around). A complete Report must never be lost to a
    // cleanup failure, so this retries and then gives up quietly: the directory is under the OS
    // temp root and costs nothing to leave behind.
    await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  }
}

// Lighthouse's own modules, from the global install this machine already needs for a Run. Imported
// rather than spawned: the CLI cannot be told which Chrome profile to use, and the Repeat Visit is
// nothing without one.
async function globalModule(...segments) {
  let root;
  try {
    ({ stdout: root } = await promisify(exec)('npm root -g'));
  } catch (error) {
    throw new Error(`could not ask npm for its global root (${error.message}); Lighthouse 13.x must be installed globally`);
  }
  return import(pathToFileURL(path.join(root.trim(), ...segments)).href);
}

// The options chrome-launcher is launched with, apart so they can be asserted without launching
// anything. Both halves matter: the profile must be named where chrome-launcher reads it, and it
// must NOT be named in chromeFlags, where Chromium would ignore it behind chrome-launcher's own.
export const browserOptions = (profile) => ({
  chromeFlags: ['--headless=new', '--no-sandbox'],
  userDataDir: profile,
});

// One headless Chrome, in a profile we name. chrome-launcher invents a temporary profile of its own
// unless it is given userDataDir — and it pushes that one FIRST, ahead of anything in chromeFlags,
// which is decisive: Chromium honours the first --user-data-dir it is given, not the last. A profile
// passed through --chrome-flags is therefore ignored in silence, which is how every Repeat Visit
// before 2026-09-04 measured a first visit twice.
async function launchBrowser(profile) {
  const chromeLauncher = await globalModule('lighthouse', 'node_modules', 'chrome-launcher', 'dist', 'chrome-launcher.js');
  // chrome-launcher opens its log files inside the profile before Chrome creates it.
  await mkdir(profile, { recursive: true });
  return chromeLauncher.launch(browserOptions(profile));
}

// One navigation of that browser, under the same MEASUREMENT a Run is taken under — the same object,
// not the same values written twice — so a Repeat Visit and a Run differ in the two things they are
// meant to differ in and nothing else: the browser is reused, and the second navigation keeps
// storage. Only `channel` reads differently — `node` rather than `cli` — and the summary prints it,
// because a Report should say how it was taken.
async function apiPass({ browser, url, settings = {} }) {
  const lighthouse = (await globalModule('lighthouse', 'core', 'index.js')).default;
  const { lhr } = await lighthouse(url, {
    port: browser.port,
    output: ['json'],
    extraHeaders: BYPASS_HEADERS,
    ...MEASUREMENT,
    ...settings,
  });
  return lhr;
}

// The Repeat Visit adapter: two navigations of one browser. The first is an ordinary
// storage-cleared navigation and its Report is thrown away — it is there to install the Worker. The
// second keeps storage, so the Worker the first installed serves what it kept, and that is the
// Report the Repeat Visit is.
export async function repeatMeasure(url, { pass = apiPass, launch = launchBrowser } = {}) {
  const workDir = await workDirectory('repeat-');
  const browser = await launch(path.join(workDir, 'profile'));
  try {
    await pass({ browser, url, settings: {} });
    return await pass({ browser, url, settings: { disableStorageReset: true } });
  } finally {
    // chrome-launcher's kill() returns void, so there is no promise to catch: a failure here is
    // synchronous, and it must not replace a finished Report with a cleanup error.
    try {
      browser.kill();
    } catch {
      // Chrome is already gone, or its profile files are still held. Neither is the Report's problem.
    }
    // Chrome may still hold the profile's files (EPERM on Windows), the more so because userDataDir
    // is ours: chrome-launcher's destroyTmp early-returns without closing its own log handles. A
    // complete Report must never be lost to a cleanup failure, so this retries and gives up quietly.
    await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  }
}

// The recorded-Report adapter: a Report already on disk stands in for the measurement.
export function recordedMeasure(fileUrl) {
  return async () => JSON.parse(await readFile(fileUrl, 'utf8'));
}

async function lighthouseCli() {
  let root;
  try {
    ({ stdout: root } = await promisify(exec)('npm root -g'));
  } catch (error) {
    throw new Error(`could not ask npm for its global root (${error.message}); Lighthouse 13.x must be installed globally`);
  }
  const cli = path.join(root.trim(), 'lighthouse', 'cli', 'index.js');
  try {
    await access(cli);
  } catch {
    throw new Error(`Lighthouse is not installed globally (${cli} is missing): npm install -g lighthouse`);
  }
  return cli;
}

function finished(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => (stdout += chunk));
    child.stderr?.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const usage = () => {
    console.error(
      'usage: node tools/run.mjs <preview-url>\n' +
        '       node tools/run.mjs repeat <preview-url>\n' +
        '       node tools/run.mjs <report.json>\n' +
        '       node tools/run.mjs compare <earlier.json> <later.json>\n\n' +
        'Performs a Run of the Preview URL, refuses an unreal Report, saves the Report under\n' +
        'reports/ named by its UTC moment of capture, and prints the summary.\n' +
        'With repeat, performs a Repeat Visit instead: two navigations of one browser,\n' +
        'the second with storage kept, so the Worker the first installed serves what it kept.\n' +
        'Given a recorded Report instead, prints its summary without measuring anything.\n' +
        'Given two, compares them: every delta later minus earlier, and whose the LCP difference is.',
    );
    process.exit(2);
  };
  const target = process.argv[2];
  if (!target) usage();
  const recorded = (file) => recordedMeasure(pathToFileURL(path.resolve(file)))();
  try {
    if (target === 'compare') {
      const [earlier, later] = process.argv.slice(3);
      if (!earlier || !later) usage();
      console.log(formatComparison(compare(await recorded(earlier), await recorded(later))));
    } else if (target === 'repeat') {
      const previewUrl = process.argv[3];
      if (!previewUrl) usage();
      const preflight = (asked) => {
        console.error(`Pre-flight: resolving ${new URL(asked).hostname} and warming ${asked}...`);
        return fetchPreflight(asked);
      };
      const measure = (asked) => {
        console.error(`Repeat Visit of ${asked}: one navigation to install the Worker, then one with storage kept, in the same browser...`);
        return repeatMeasure(asked);
      };
      const { path: saved, summary } = await performRun({ url: previewUrl, measure, preflight, repeat: true });
      console.log(formatSummary(summary));
      console.log(`Saved ${path.relative(process.cwd(), saved)}`);
    } else if (target.endsWith('.json')) {
      const summary = summarize(await recorded(target));
      console.log(formatSummary(summary));
      // Pasted into CLAUDE.md's current state, never composed: tests/run.mjs holds them equal.
      console.log(`CLAUDE.md: ${formatCurrentState(summary)}`);
    } else {
      const preflight = (previewUrl) => {
        console.error(`Pre-flight: resolving ${new URL(previewUrl).hostname} and warming ${previewUrl}...`);
        return fetchPreflight(previewUrl);
      };
      const measure = (previewUrl) => {
        console.error(`Measuring ${previewUrl} at mobile form factor under simulated throttling...`);
        return lighthouseMeasure(previewUrl);
      };
      const { path: saved, summary } = await performRun({ url: target, measure, preflight });
      console.log(formatSummary(summary));
      console.log(`Saved ${path.relative(process.cwd(), saved)}`);
    }
  } catch (error) {
    console.error(error instanceof RunRefused ? error.message : `Run failed: ${error.message}`);
    process.exit(1);
  }
}
