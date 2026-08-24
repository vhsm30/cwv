#!/usr/bin/env node
// The Performance Contract's own check: can it still fail? Each mutation below breaks one thing an
// assertion guards (or, for the two marked "passes", changes something harmless). The page is
// mutated in place, the contract is run, and the page is restored — a crash mid-way is undone by
// `git checkout index.html`. Add a row whenever you add an assertion: a new assertion that no
// mutation can fail is documentation, not Lock-in.
//
//     node tools/mutate-contract.mjs
//
// The table is the one from the architecture review of 2026-08-24 (BACKLOG.md, B1); before the
// contract read the page through lib/page.mjs, M5, M6, M10, M14, M15 and M16 passed unnoticed and
// M7 and M8 failed for no reason.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pagePath = fileURLToPath(new URL('../index.html', import.meta.url));
const original = readFileSync(pagePath, 'utf8');

const must = (html, needle) => {
  if (!html.includes(needle)) throw new Error(`mutation target missing from index.html: ${needle}`);
  return html;
};
const swap = (needle, replacement) => (html) => must(html, needle).replace(needle, replacement);
const swapAll = (needle, replacement) => (html) => must(html, needle).replaceAll(needle, replacement);

const mutations = [
  ['M1 preload imagesrcset drifts from the <source>', (h) => must(h, 'imagesrcset=').replace(/\.\/images\/hero-768\.webp 768w/, './images/hero-768.webp 770w'), 'caught'],
  ['M2 height:auto dropped from .product-image', swap('display:block;height:auto;object-fit:cover', 'display:block;object-fit:cover'), 'caught'],
  ['M3 product height 875 -> 900', swap('width="700" height="875"', 'width="700" height="900"'), 'caught'],
  ['M4 fetchpriority="low" removed', swapAll(' fetchpriority="low"', ''), 'caught'],
  ['M5 .eyebrow stops using --accent', swap('.eyebrow{color:var(--accent);', '.eyebrow{color:var(--muted);'), 'caught'],
  ['M6 hero src -> https://cdn.example.com/', (h) => must(h, 'src="./images/hero').replace(/src="\.\/images\/hero[^"]*\.jpg"/, 'src="https://cdn.example.com/hero.jpg"'), 'caught'],
  ['M7 harmless: as= before rel= on the preload', swap('<link rel="preload" as="image"', '<link as="image" rel="preload"'), 'passes'],
  ['M8 harmless: single-quoted fetchpriority', swapAll('fetchpriority="low"', "fetchpriority='low'"), 'passes'],
  ['M9 hero gains loading="lazy"', swap('alt="A charcoal floor lamp', 'loading="lazy" alt="A charcoal floor lamp'), 'caught'],
  ['M10 mobile .hero-image gains height:300px', swap('.hero-image{aspect-ratio:1/1;min-height:0}', '.hero-image{aspect-ratio:1/1;min-height:0;height:300px}'), 'caught'],
  ['M11 <source sizes> != <img sizes>', swap('sizes="(max-width: 700px) 45vw, 30vw">', 'sizes="(max-width: 700px) 45vw, 33vw">'), 'caught'],
  ['M12 srcset names a missing .jpg', swap('./images/hero-640.jpg 640w', './images/hero-641.jpg 640w'), 'caught'],
  ['M13 srcset names a missing .webp', swapAll('./images/notebook-400.webp 400w', './images/notebook-401.webp 400w'), 'caught'],
  ['M14 hero pixels differ from the markup (803 declared, file differs)', swap('height="803"', 'height="800"'), 'caught'],
  ['M15 google-site-verification removed', (h) => must(h, 'google-site-verification').replace(/\s*<meta name="google-site-verification"[^>]*>/, ''), 'caught'],
  ['M16 <title> changed, llms.txt untouched', swap('<title>Field Notes Supply |', '<title>Field Notes Co |'), 'caught'],
];

const contract = () => spawnSync(process.execPath, ['--test', 'tests/performance-contract.mjs'], { cwd: root, encoding: 'utf8' });

if (contract().status !== 0) {
  console.error('the contract is not green on the unmutated page; fix that first');
  process.exit(2);
}

const rows = [];
try {
  for (const [name, mutate, expected] of mutations) {
    writeFileSync(pagePath, mutate(original));
    const outcome = contract().status === 0 ? 'passes' : 'caught';
    rows.push({ name, expected, outcome });
  }
} finally {
  writeFileSync(pagePath, original);
}

for (const { name, expected, outcome } of rows) {
  console.log(`${outcome === expected ? 'ok ' : 'BAD'}  ${outcome.padEnd(6)} (expected ${expected.padEnd(6)})  ${name}`);
}
const good = rows.filter((row) => row.outcome === row.expected).length;
console.log(`${good}/${rows.length} mutations behave as intended`);
process.exit(good === rows.length ? 0 : 1);
