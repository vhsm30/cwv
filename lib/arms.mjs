// The Arms (CONTEXT.md): the Storefront delivered with one way of loading the tags, each at its own
// URL, and the control delivered with none. bench/arms.json is the one home of every Arm fact; this
// module is its one reader, shared by the generator (tools/build-arms.mjs), the Run's pre-flight
// (tools/run.mjs), the bench (tools/bench.mjs) and the assertions (tests/bench.mjs). server.py reads
// the same file in Python.
import { readFile } from 'node:fs/promises';

export const ROOT_URL = new URL('../', import.meta.url);
export const ARMS_URL = new URL('bench/arms.json', ROOT_URL);
// Where the container is served from. The Reports name it; the reading marks an Arm Run without it.
export const GTM_ORIGIN = 'https://www.googletagmanager.com';
export const CONTAINER_HOST = new URL(GTM_ORIGIN).host;

const CONTAINER_ID = /^GTM-[A-Z0-9]{5,}$/;
const ROOT_LEVEL = /^\/[a-z0-9-]+\.html$/;
const DELIVERIES = new Set(['none', 'head', 'after-load']);

// Every reason the table cannot drive a Bench; empty when it can.
export function validateArms(table) {
  const problems = [];
  const id = table?.container?.id;
  if (typeof id !== 'string' || !CONTAINER_ID.test(id)) problems.push(`the container id must look like GTM-XXXXXXX, not ${JSON.stringify(id)}`);
  if (typeof table?.container?.holds !== 'string' || !table.container.holds.trim()) problems.push('the table must say what the container holds');
  const arms = Array.isArray(table?.arms) ? table.arms : [];
  if (!arms.length) problems.push('the table names no Arms');
  const names = arms.map((arm) => arm.name);
  if (new Set(names).size !== names.length) problems.push('Arm names must be unique');
  const paths = arms.map((arm) => arm.path);
  if (new Set(paths).size !== paths.length) problems.push('Arm paths must be unique');
  const controls = arms.filter((arm) => arm.name === 'control');
  if (controls.length !== 1 || controls[0].path !== '/' || controls[0].file !== 'index.html' || controls[0].delivery !== 'none') {
    problems.push('exactly one Arm is the control: name "control", path "/", file "index.html", delivery "none"');
  }
  for (const arm of arms) {
    if (arm.name === 'control') continue;
    if (typeof arm.path !== 'string' || !ROOT_LEVEL.test(arm.path)) problems.push(`${arm.name}: the path must be root-level, /<name>.html, not ${JSON.stringify(arm.path)}`);
    else if (arm.file !== arm.path.slice(1)) problems.push(`${arm.name}: the file must be the path without its slash (${arm.path.slice(1)}), not ${JSON.stringify(arm.file)}`);
    if (!DELIVERIES.has(arm.delivery) || arm.delivery === 'none') problems.push(`${arm.name}: the delivery must be "head" or "after-load", not ${JSON.stringify(arm.delivery)}`);
  }
  return problems;
}

export async function loadArms(url = ARMS_URL) {
  const table = JSON.parse(await readFile(url, 'utf8'));
  const problems = validateArms(table);
  if (problems.length) throw new Error(`bench/arms.json cannot drive a Bench:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  return table;
}

export const armForPath = (table, pathname) => table.arms.find((arm) => arm.path === pathname) ?? null;

// The part of a Report's name that says which Arm it measured: nothing for the control.
export const slugOf = (pathname) => (pathname === '/' ? null : pathname.replace(/^\//, '').replace(/\.html$/, ''));
