// The reading of a Bench (CONTEXT.md): every Arm's spread per measure across the rounds, and each
// Arm's cost against the control, called real only when the two sets of Runs do not overlap. Pure
// functions over summaries (lib/report.mjs), so recorded Reports exercise all of it.
import { CONTAINER_HOST } from './arms.mjs';

export const MEASURES = [
  { key: 'tbt', label: 'TBT', unit: 'ms', of: (s) => s.metrics.tbt },
  { key: 'lcp', label: 'LCP', unit: 'ms', of: (s) => s.metrics.lcp },
  { key: 'fcp', label: 'FCP', unit: 'ms', of: (s) => s.metrics.fcp },
  { key: 'requests', label: 'requests', unit: '', of: (s) => s.requests },
  { key: 'transferBytes', label: 'transferred', unit: 'KB', of: (s) => s.transferBytes },
  { key: 'thirdPartyBytes', label: 'third-party bytes', unit: 'KB', of: (s) => s.thirdParty.transferBytes },
  { key: 'loadDelay', label: 'load delay', unit: 'ms', of: (s) => s.pageShare.loadDelay },
  { key: 'renderDelay', label: 'render delay', unit: 'ms', of: (s) => s.pageShare.renderDelay },
  { key: 'serverLatency', label: 'server latency', unit: 'ms', of: (s) => s.tunnelShare.serverLatency },
];

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const spread = (values) => (values.length ? { min: Math.min(...values), median: median(values), max: Math.max(...values) } : null);

// The difference of medians, real when every Arm value lies beyond every control value in the
// direction of the difference. No threshold: the control's own spread is the floor.
const cost = (control, arm) => {
  if (!control.length || !arm.length) return null;
  const delta = median(arm) - median(control);
  const real = delta > 0 ? Math.min(...arm) > Math.max(...control) : delta < 0 ? Math.max(...arm) < Math.min(...control) : false;
  return { delta, real };
};

const marksOf = (arm, summary) => {
  const marks = [];
  if (summary.artifacts.some((artifact) => artifact.audit === 'network-server-latency')) marks.push('cold tunnel');
  if (arm.delivery !== 'none' && !(CONTAINER_HOST in summary.thirdParty.origins)) marks.push('container not loaded');
  return marks;
};

export function reading({ arms, runs }) {
  const byName = Object.fromEntries(arms.map((arm) => [arm.name, arm]));
  const rounds = runs.filter((run) => run.role !== 'warm-up');
  const values = (name, measure) =>
    rounds
      .filter((run) => run.arm === name)
      .map((run) => measure.of(run.summary))
      .filter((value) => typeof value === 'number');
  const armReadings = {};
  for (const arm of arms) {
    armReadings[arm.name] = {
      n: rounds.filter((run) => run.arm === arm.name).length,
      measures: Object.fromEntries(MEASURES.map((measure) => [measure.key, spread(values(arm.name, measure))])),
    };
  }
  const costs = {};
  for (const arm of arms) {
    if (arm.name === 'control') continue;
    costs[arm.name] = Object.fromEntries(MEASURES.map((measure) => [measure.key, cost(values('control', measure), values(arm.name, measure))]));
  }
  return {
    rounds: new Set(rounds.map((run) => run.role)).size,
    arms: armReadings,
    costs,
    runs: runs.map(({ arm, role, report, summary }) => ({ arm, role, report, marks: marksOf(byName[arm], summary) })),
  };
}

const value = (v, unit) => (unit === 'KB' ? (v / 1024).toFixed(1) : String(Math.round(v)));
const withUnit = (text, unit) => (unit ? `${text} ${unit}` : text);
const signedValue = (v, unit) => withUnit(`${v < 0 ? '-' : '+'}${value(Math.abs(v), unit)}`, unit);
const spreadText = (s, unit) => (s ? withUnit(`${value(s.min, unit)} / ${value(s.median, unit)} / ${value(s.max, unit)}`, unit) : '-');
const costText = (c, unit) => (c ? `, ${signedValue(c.delta, unit)} ${c.real ? 'real' : 'within the wander'}` : '');

export function formatReading(r, { previewUrl, started, rounds, container }) {
  const marks = r.runs.filter((run) => run.marks.length).map((run) => `${run.report} (${run.marks.join(', ')})`);
  const lines = [
    `Bench of ${previewUrl} started ${started}: ${rounds} rounds, container ${container.id} (${container.holds})`,
    `  runs: ${r.runs.length}, marks: ${marks.length ? marks.join('; ') : 'none'}`,
  ];
  for (const measure of MEASURES) {
    const parts = Object.entries(r.arms).map(([name, arm]) => {
      const s = arm.measures[measure.key];
      const c = name === 'control' ? null : r.costs[name]?.[measure.key];
      return `${name} ${spreadText(s, measure.unit)} (n ${arm.n})${costText(c, measure.unit)}`;
    });
    lines.push(`  ${measure.label}: ${parts.join(' · ')}`);
  }
  return lines.join('\n');
}

// The one line CLAUDE.md quotes as the bench of record, printed so it is pasted, never composed.
export function formatBenchOfRecord(record, file) {
  const r = record.reading;
  const control = r.arms.control.measures;
  const med = (key, unit) => (control[key] ? withUnit(value(control[key].median, unit), unit) : '-');
  const started = record.started.replace(/\.\d+Z$/, 'Z');
  const head = `Bench of record (benches/${file}, ${started}, ${record.rounds} rounds, ${record.container.id}: ${record.container.holds}): control medians TBT ${med('tbt', 'ms')}, LCP ${med('lcp', 'ms')}, ${med('requests', '')} requests, ${med('transferBytes', 'KB')}`;
  const quoted = ['tbt', 'lcp', 'requests', 'transferBytes', 'thirdPartyBytes'];
  const arms = Object.entries(r.costs).map(([name, costs]) => {
    if (!r.arms[name].n) return `${name}: no rounds`;
    const parts = quoted.map((key) => {
      const measure = MEASURES.find((m) => m.key === key);
      const c = costs[key];
      return `${measure.label} ${c ? `${signedValue(c.delta, measure.unit)} (${c.real ? 'real' : 'within the wander'})` : '-'}`;
    });
    return `${name}: ${parts.join(' · ')}`;
  });
  return `${head}; ${arms.join('; ')}`;
}
