#!/usr/bin/env node
// The Run: one Lighthouse measurement of the Preview URL at mobile form factor under simulated
// throttling, kept only when the Report is real.
//
//     node tools/run.mjs https://<domain>.ngrok-free.dev/
//
// Free-tier ngrok answers browser user-agents with an interstitial, so the measurement carries the
// bypass header. The Report is then checked (lib/report.mjs) before it is saved under reports/,
// named by its own UTC fetchTime, and summarised. Two adapters satisfy `measure`: Lighthouse
// (lighthouseMeasure) and a recorded Report (recordedMeasure), which is how tests/run.mjs asserts
// everything after the measurement without ngrok or Chrome.
import { exec, spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { checkReport, formatSummary, previewUrlProblem, reportName, summarize } from '../lib/report.mjs';

const REPORTS_DIR = fileURLToPath(new URL('../reports/', import.meta.url));
const BYPASS_HEADERS = { 'ngrok-skip-browser-warning': 'true' };
const CATEGORIES = 'performance,accessibility,best-practices,seo';

export class RunRefused extends Error {
  constructor(reasons) {
    super(`Run refused:\n${reasons.map((reason) => `  - ${reason}`).join('\n')}`);
    this.name = 'RunRefused';
    this.reasons = reasons;
  }
}

// Perform a Run: refuse anything but a Preview URL, measure, refuse an unreal Report, save, summarise.
export async function performRun({ url, measure = lighthouseMeasure, reportsDir = REPORTS_DIR }) {
  const problem = previewUrlProblem(url);
  if (problem) throw new RunRefused([problem]);
  const report = await measure(url);
  const reasons = checkReport(report, url);
  if (reasons.length) throw new RunRefused(reasons);

  const directory = reportsDir instanceof URL ? fileURLToPath(reportsDir) : reportsDir;
  const target = path.join(directory, reportName(report));
  try {
    await writeFile(target, JSON.stringify(report, null, 2), { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`${target} already exists; a Report is never overwritten`);
    throw error;
  }
  return { path: target, summary: summarize(report) };
}

// The Lighthouse adapter: the CLI this machine has installed globally, run without a shell so the
// header file path and the Chrome flags need no quoting on any platform.
export async function lighthouseMeasure(url) {
  const cli = await lighthouseCli();
  const workDir = await mkdtemp(path.join(tmpdir(), 'run-'));
  try {
    const headersFile = path.join(workDir, 'headers.json');
    const reportFile = path.join(workDir, 'report.json');
    await writeFile(headersFile, JSON.stringify(BYPASS_HEADERS));
    const args = [
      cli,
      url,
      '--output=json',
      `--output-path=${reportFile}`,
      '--form-factor=mobile',
      '--screenEmulation.mobile',
      `--extra-headers=${headersFile}`,
      `--only-categories=${CATEGORIES}`,
      '--chrome-flags=--headless=new --no-sandbox',
      '--quiet',
    ];
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
  } finally {
    await rm(workDir, { recursive: true, force: true });
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
  const target = process.argv[2];
  if (!target) {
    console.error(
      'usage: node tools/run.mjs <preview-url>\n' +
        '       node tools/run.mjs <report.json>\n\n' +
        'Performs a Run of the Preview URL, refuses an unreal Report, saves the Report under\n' +
        'reports/ named by its UTC moment of capture, and prints the summary.\n' +
        'Given a recorded Report instead, prints its summary without measuring anything.',
    );
    process.exit(2);
  }
  try {
    if (target.endsWith('.json')) {
      const report = await recordedMeasure(pathToFileURL(path.resolve(target)))();
      console.log(formatSummary(summarize(report)));
    } else {
      const measure = (previewUrl) => {
        console.error(`Measuring ${previewUrl} at mobile form factor under simulated throttling...`);
        return lighthouseMeasure(previewUrl);
      };
      const { path: saved, summary } = await performRun({ url: target, measure });
      console.log(formatSummary(summary));
      console.log(`Saved ${path.relative(process.cwd(), saved)}`);
    }
  } catch (error) {
    console.error(error instanceof RunRefused ? error.message : `Run failed: ${error.message}`);
    process.exit(1);
  }
}
