#!/usr/bin/env node
// The Bench (CONTEXT.md): one session of Runs through one Preview URL, every Arm in turn for
// several rounds, read as each Arm's spread against the control's.
//
//     node tools/bench.mjs https://<name>.trycloudflare.com/ --rounds 3
//     node tools/bench.mjs read benches/<file>.json
//
// A warm-up Run of the control comes first, because the first Chrome of a session renders slower
// (render delay 131 ms against 47 ms two minutes later on 2026-09-03) and no page did that. Every
// Run is performRun (tools/run.mjs): pre-flighted, checked, saved under reports/, summarised. A
// refused Run stops the bench with its reason; the Reports so far stay. The record under benches/
// names the Reports; `read` recomputes the reading from them, so the record is the Reports and
// never the summary.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ROOT_URL, loadArms } from '../lib/arms.mjs';
import { formatBenchOfRecord, formatReading, reading } from '../lib/bench.mjs';
import { readReport, summarize } from '../lib/report.mjs';
import { RunRefused, performRun } from './run.mjs';

export const BENCHES_DIR = fileURLToPath(new URL('benches/', ROOT_URL));
export const REPORTS_DIR = fileURLToPath(new URL('reports/', ROOT_URL));

export async function performBench({ previewUrl, rounds = 3, table, run = performRun, now = () => new Date(), log = () => {} }) {
  const started = now().toISOString();
  const control = table.arms.find((arm) => arm.name === 'control');
  const plan = [{ arm: control, role: 'warm-up' }];
  for (let round = 1; round <= rounds; round += 1) {
    for (const arm of table.arms) plan.push({ arm, role: `round ${round}` });
  }
  const runs = [];
  for (const [index, { arm, role }] of plan.entries()) {
    const url = new URL(arm.path, previewUrl).href;
    log(`Bench: Run ${index + 1}/${plan.length}, ${arm.name} (${role}), ${url}`);
    const { path: saved, summary } = await run({ url });
    runs.push({ arm: arm.name, role, report: path.basename(saved), summary });
  }
  const record = {
    previewUrl,
    started,
    rounds,
    container: table.container,
    arms: table.arms,
    runs: runs.map(({ arm, role, report }) => ({ arm, role, report })),
    reading: reading({ container: table.container, arms: table.arms, runs }),
  };
  return record;
}

// `<host>-<UTC start>.json`, like a Report's name.
export function recordName(record) {
  const stamp = new Date(record.started).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${new URL(record.previewUrl).hostname}-${stamp}.json`;
}

export async function writeBench(record, dir = BENCHES_DIR) {
  const target = path.join(dir, recordName(record));
  await writeFile(target, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  return target;
}

export async function readBench(file, reportsDir = REPORTS_DIR) {
  const fileUrl = file instanceof URL ? file : pathToFileURL(path.resolve(file));
  const record = JSON.parse(await readFile(fileUrl, 'utf8'));
  const runs = [];
  for (const run of record.runs) {
    const report = await readReport(pathToFileURL(path.join(reportsDir, run.report)));
    runs.push({ ...run, summary: summarize(report) });
  }
  return { record, reading: reading({ container: record.container, arms: record.arms, runs }), file: path.basename(fileURLToPath(fileUrl)) };
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const usage = () => {
    console.error(
      'usage: node tools/bench.mjs <preview-url> [--rounds N]\n' +
        '       node tools/bench.mjs read benches/<file>.json\n\n' +
        'Performs a Bench: a warm-up Run of the control, then N rounds (default 3) of every Arm in\n' +
        'bench/arms.json through the one Preview URL; writes the record under benches/ and prints\n' +
        'the reading. Given a record instead, recomputes the reading from the Reports it names.',
    );
    process.exit(2);
  };
  const args = process.argv.slice(2);
  if (!args.length) usage();
  try {
    if (args[0] === 'read') {
      if (!args[1]) usage();
      const { record, reading: recomputed, file } = await readBench(args[1]);
      console.log(formatReading(recomputed, record));
      console.log(`CLAUDE.md: ${formatBenchOfRecord({ ...record, reading: recomputed }, file)}`);
    } else {
      const previewUrl = args[0];
      const at = args.findIndex((arg) => arg === '--rounds' || arg.startsWith('--rounds='));
      const rounds = at === -1 ? 3 : Number(args[at].includes('=') ? args[at].split('=')[1] : args[at + 1]);
      if (!Number.isInteger(rounds) || rounds < 1) usage();
      const table = await loadArms();
      const record = await performBench({ previewUrl, rounds, table, log: (line) => console.error(line) });
      const written = await writeBench(record);
      console.log(formatReading(record.reading, record));
      console.log(`CLAUDE.md: ${formatBenchOfRecord(record, path.basename(written))}`);
      console.log(`Saved ${path.relative(process.cwd(), written)}`);
    }
  } catch (error) {
    console.error(error instanceof RunRefused ? `Bench stopped. ${error.message}` : `Bench failed: ${error.message}`);
    process.exit(1);
  }
}
