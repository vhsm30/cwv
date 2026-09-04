#!/usr/bin/env node
// The Performance Contract's own check: can it still fail? Each mutation below breaks one thing an
// assertion guards (or, for the rows marked "passes", changes something harmless). One of the
// files the contract and the Bench's assertions read — the page, the manifest, the Worker, an Arm,
// the Arms table — is mutated in place, the contract is run, and the file is restored; a crash
// mid-way is undone by `git checkout .`. Add a
// row whenever you add an assertion: a new assertion that no mutation can fail is documentation,
// not Lock-in — and apply the test while designing the assertion, since one that restates the
// markup it guards cannot fail.
//
//     node tools/mutate-contract.mjs
//
// M1-M16 are the table from the architecture review of 2026-08-24 (BACKLOG.md, B1); before the
// contract read the page through lib/page.mjs, M5, M6, M10, M14, M15 and M16 passed unnoticed and
// M7 and M8 failed for no reason. M17-M34 came with the PWA of 2026-09-02; M35-M38 with the Bench
// of 2026-09-03. M39 came with the harness fix of 2026-09-04, and
// covers the rule M7 and M8 used to cover by accident.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadArms } from '../lib/arms.mjs';
import { buildArm } from '../tools/build-arms.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const FILES = ['index.html', 'manifest.webmanifest', 'sw.js', 'arm-gtm.html', 'arm-gtm-deferred.html', 'bench/arms.json', 'routes.json'];
const paths = Object.fromEntries(FILES.map((file) => [file, fileURLToPath(new URL(`../${file}`, import.meta.url))]));
const originals = Object.fromEntries(FILES.map((file) => [file, readFileSync(paths[file], 'utf8')]));

// armsTable, not table: `table` is already this file's row constructor for bench/arms.json.
const armsTable = await loadArms();

// A page mutation rebuilds the Arms from the mutated control before the contract runs. Without
// this, every page row is caught by tests/bench.mjs's Arm-identity rule — any byte of index.html
// trips it — and the row says nothing about the Performance Contract, which is what it is for.
// One row opts out on purpose (`stale`): that rule is what it checks.
const apply = ({ file, mutate, stale }) => {
  const text = mutate(originals[file], file);
  writeFileSync(paths[file], text);
  // A mutated Route table regenerates the document it describes, exactly as a mutated control
  // rebuilds the Arms: otherwise the page and the table simply disagree and the equality
  // assertion fires before the one the row is aiming at.
  let control = file === 'index.html' ? text : originals['index.html'];
  if (file === 'routes.json') {
    const built = spawnSync('python', ['tools/build-pages.py'], { cwd: root, encoding: 'utf8' });
    if (built.error) throw built.error; // python itself did not run: a broken harness, not a caught row
    if (built.status !== 0) return 'generator'; // the generator refused: that is the row's answer
    control = readFileSync(paths['index.html'], 'utf8');
  }
  if (stale || (file !== 'index.html' && file !== 'routes.json')) return;
  for (const entry of armsTable.arms) {
    if (entry.delivery === 'none') continue;
    writeFileSync(paths[entry.file], buildArm(control, entry, armsTable.container));
  }
};
const restore = () => {
  for (const file of FILES) writeFileSync(paths[file], originals[file]);
};

const must = (text, needle, file) => {
  if (!text.includes(needle)) throw new Error(`mutation target missing from ${file}: ${needle}`);
  return text;
};
const swap = (needle, replacement) => (text, file) => must(text, needle, file).replace(needle, replacement);
const swapAll = (needle, replacement) => (text, file) => must(text, needle, file).replaceAll(needle, replacement);
const page = (name, mutate, expected) => ({ name, file: 'index.html', mutate, expected });
// index.html mutated and the Arms deliberately left stale: the one row that checks CLAUDE.md's
// own rule that a change to the control demands node tools/build-arms.mjs.
const stalePage = (name, mutate, expected) => ({ name, file: 'index.html', mutate, expected, stale: true });
const manifest = (name, mutate, expected) => ({ name, file: 'manifest.webmanifest', mutate, expected });
const worker = (name, mutate, expected) => ({ name, file: 'sw.js', mutate, expected });
const arm = (name, mutate, expected) => ({ name, file: 'arm-gtm.html', mutate, expected });
const table = (name, mutate, expected) => ({ name, file: 'bench/arms.json', mutate, expected });
const route = (name, mutate, expected) => ({ name, file: 'routes.json', mutate, expected });
// The container id, read from the table rather than written here, so a new container moves the rows.
const containerId = JSON.parse(originals['bench/arms.json']).container.id;

const mutations = [
  page('M1 preload imagesrcset drifts from the <source>', (h, f) => must(h, 'imagesrcset=', f).replace(/\.\/images\/hero-768\.webp 768w/, './images/hero-768.webp 770w'), 'caught'),
  page('M2 height:auto dropped from .product-image', swap('display:block;height:auto;object-fit:cover', 'display:block;object-fit:cover'), 'caught'),
  page('M3 product height 875 -> 900', swap('width="700" height="875"', 'width="700" height="900"'), 'caught'),
  page('M4 fetchpriority="low" removed', swapAll(' fetchpriority="low"', ''), 'caught'),
  page('M5 .eyebrow stops using --accent', swap('.eyebrow{color:var(--accent);', '.eyebrow{color:var(--muted);'), 'caught'),
  page('M6 hero src -> https://cdn.example.com/', (h, f) => must(h, 'src="./images/hero', f).replace(/src="\.\/images\/hero[^"]*\.jpg"/, 'src="https://cdn.example.com/hero.jpg"'), 'caught'),
  // M7 and M8 are harmless to the Performance Contract: the page model reads attribute order and
  // quote style the same either way. They read `caught` between 2026-09-03 and 2026-09-04 only
  // because every page mutation tripped tests/bench.mjs's Arm-identity rule; the rows now rebuild
  // the Arms, so what they report is the contract's own verdict again. M39 keeps that rule covered.
  page('M7 harmless: as= before rel= on the preload', swap('<link rel="preload" as="image"', '<link as="image" rel="preload"'), 'passes'),
  page('M8 harmless: single-quoted fetchpriority', swapAll('fetchpriority="low"', "fetchpriority='low'"), 'passes'),
  page('M9 hero gains loading="lazy"', swap('alt="A charcoal floor lamp', 'loading="lazy" alt="A charcoal floor lamp'), 'caught'),
  page('M10 mobile .hero-image gains height:300px', swap('.hero-image{aspect-ratio:1/1;min-height:0}', '.hero-image{aspect-ratio:1/1;min-height:0;height:300px}'), 'caught'),
  page('M11 <source sizes> != <img sizes>', swap('sizes="(max-width: 700px) 45vw, 30vw">', 'sizes="(max-width: 700px) 45vw, 33vw">'), 'caught'),
  page('M12 srcset names a missing .jpg', swap('./images/hero-640.jpg 640w', './images/hero-641.jpg 640w'), 'caught'),
  page('M13 srcset names a missing .webp', swapAll('./images/notebook-400.webp 400w', './images/notebook-401.webp 400w'), 'caught'),
  page('M14 hero pixels differ from the markup (803 declared, file differs)', swap('height="803"', 'height="800"'), 'caught'),
  page('M15 google-site-verification removed', (h, f) => must(h, 'google-site-verification', f).replace(/\s*<meta name="google-site-verification"[^>]*>/, ''), 'caught'),
  page('M16 <title> changed, llms.txt untouched', swap('<title>Field Notes Supply |', '<title>Field Notes Co |'), 'caught'),
  // The PWA of 2026-09-02: the Notice, the head, the manifest, the Worker.
  page('M17 [hidden] loses !important, so the Notice\'s own display rule reveals it', swap('[hidden]{display:none!important}', '[hidden]{display:none}'), 'caught'),
  page('M18 the Notice ships without hidden', swap('<div class="notice" role="status" hidden>', '<div class="notice" role="status">'), 'caught'),
  page('M19 the Notice enters the flow (position:fixed -> sticky)', swap('padding:.9rem 1.1rem;position:fixed', 'padding:.9rem 1.1rem;position:sticky'), 'caught'),
  page('M20 the deprecated apple-mobile-web-app-capable tag is added', swap('<meta name="mobile-web-app-capable" content="yes">', '<meta name="mobile-web-app-capable" content="yes">\n  <meta name="apple-mobile-web-app-capable" content="yes">'), 'caught'),
  page('M21 the theme-color meta drifts from the manifest', swap('<meta name="theme-color" content="#17211d">', '<meta name="theme-color" content="#000000">'), 'caught'),
  page('M22 the manifest link is dropped', (h, f) => must(h, 'rel="manifest"', f).replace(/\s*<link rel="manifest"[^>]*>/, ''), 'caught'),
  manifest('M23 theme_color drifts from the ink', swap('"theme_color": "#17211d"', '"theme_color": "#000000"'), 'caught'),
  manifest('M24 a shortcut points at a route the page does not have', swap('"url": "./#story"', '"url": "./#about"'), 'caught'),
  manifest('M25 an icon declares sizes its pixels do not have', swap('"sizes": "192x192"', '"sizes": "200x200"'), 'caught'),
  manifest('M26 the name gains a word CONTEXT.md avoids', swap('"name": "Field Notes Supply"', '"name": "Field Notes Supply app"'), 'caught'),
  manifest('M27 both screenshots claim one form factor with two aspect ratios', swap('"form_factor": "narrow"', '"form_factor": "wide"'), 'caught'),
  manifest('M28 harmless: keys reordered', (text) => {
    const { name, ...rest } = JSON.parse(text);
    return JSON.stringify({ ...rest, name }, null, 2);
  }, 'passes'),
  worker('M29 the Shell drops the behaviour', swap("'./app.v2.min.js', ", ''), 'caught'),
  worker('M30 the Shell keeps a Rung ahead of time', swap("'./favicon.ico']", "'./favicon.ico', './images/hero-1200.webp']"), 'caught'),
  worker('M31 the cache Generation drifts from the behaviour it keeps', swap("const CACHE = 'field-notes-v2';", "const CACHE = 'field-notes-v3';"), 'caught'),
  worker('M32 clients.claim() is added at activate', swap("self.addEventListener('activate', (event) => {", "self.addEventListener('activate', (event) => {\n  event.waitUntil(self.clients.claim());"), 'caught'),
  worker('M33 skipWaiting() is called at install', swap("self.addEventListener('install', (event) => {", "self.addEventListener('install', (event) => {\n  self.skipWaiting();"), 'caught'),
  worker('M34 harmless: Shell entries reordered', swap("['./', './app.v2.min.js', './favicon.ico']", "['./favicon.ico', './', './app.v2.min.js']"), 'passes'),
  // The Bench of 2026-09-03: the Arms are the generator applied to the control, and nothing else.
  arm('M35 the head snippet is removed from the head Arm', (h, f) => must(h, "'dataLayer','" + containerId, f).replace(/\n  <script>\(function\(w,d,s,l,i\)[\s\S]*?<\/script>/, ''), 'caught'),
  arm('M36 the container id changes in one Arm only', swapAll(containerId, 'GTM-0000000'), 'caught'),
  arm('M37 the head snippet moves below the stylesheet', (h, f) => {
    const match = /\n  <script>\(function\(w,d,s,l,i\)[\s\S]*?<\/script>/.exec(must(h, "'dataLayer','" + containerId, f));
    return h.replace(match[0], '').replace('</head>', `${match[0].trim()}\n</head>`);
  }, 'caught'),
  table('M38 the table names a new container without a rebuild', swap(`"id": "${containerId}"`, '"id": "GTM-0000000"'), 'caught'),
  // The rule M7 and M8 used to cover by accident, covered on purpose: the same harmless edit, with
  // the Arms left as they were.
  stalePage('M39 index.html changed without node tools/build-arms.mjs', swap('<link rel="preload" as="image"', '<link as="image" rel="preload"'), 'caught'),
  // Routes of 2026-09-04: the generated head block, and the document facts it carries.
  page('M40 the canonical link points somewhere else', swap('<link rel="canonical" href="https://field-notes-supply.example/">', '<link rel="canonical" href="https://field-notes-supply.example/index.html">'), 'caught'),
  page('M41 the generated block is deleted', (h, f) => {
    const begin = must(h, '<!-- routes.json: begin -->', f).indexOf('<!-- routes.json: begin -->');
    const end = h.indexOf('<!-- routes.json: end -->') + '<!-- routes.json: end -->'.length;
    return h.slice(0, begin) + h.slice(end);
  }, 'caught'),
  // M42 is the regression a real Run caught: a relative canonical scores 0 on Lighthouse's canonical
  // audit and cost the Storefront eight SEO points. What refuses it now is the contract's own rule
  // that the canonical is an absolute https URL — the self-hosted rule no longer reads it at all.
  route('M42 routes.json makes the canonical relative again', swap('"canonical": "https://field-notes-supply.example/"', '"canonical": "./"'), 'caught'),
  route('M53 routes.json makes the canonical protocol-relative', swap('"canonical": "https://field-notes-supply.example/"', '"canonical": "//field-notes-supply.example/"'), 'caught'),
  page('M43 og:title drifts from the document title', swap('<meta property="og:title" content="Field Notes Supply |', '<meta property="og:title" content="Field Notes Co |'), 'caught'),
  page('M44 og:image drifts from the document', swap('content="./images/hero-1200.jpg">', 'content="./images/hero-1201.jpg">'), 'caught'),
  route('M45 routes.json names a preview image that is not on disk', swap('"image": "./images/hero-1200.jpg"', '"image": "./images/hero-1201.jpg"'), 'caught'),
  route('M46 routes.json declares a card type Twitter does not define', swap('"card": "summary_large_image"', '"card": "large_image"'), 'caught'),
  page('M47 harmless: the generated block\'s tags are reordered', (h, f) => {
    const title = must(h, '<meta property="og:title"', f).match(/\n  <meta property="og:title"[^\n]*/)[0];
    const description = h.match(/\n  <meta property="og:description"[^\n]*/)[0];
    return h.replace(title, '').replace(description, description + title);
  }, 'passes'),
  page('M48 #story is nested back inside #shop', (h, f) => must(h, '<section class="story" id="story"', f)
    .replace('      </div>\n    </section>\n    <section class="story" id="story" aria-labelledby="story-title">\n', '      </div>\n      <div class="story" id="story" aria-labelledby="story-title">\n')
    .replace('      </div>\n    </section>\n  </main>', '      </div>\n      </div>\n    </section>\n  </main>'), 'caught'),
  page('M49 #story loses the heading that labels it', swap(' aria-labelledby="story-title">', '>'), 'caught'),
  page('M50 #story is labelled by the other Route\'s heading', swap('aria-labelledby="story-title"', 'aria-labelledby="shop-title"'), 'caught'),
  page('M51 #story is a Route nested inside #shop', (h, f) => must(h, '<section class="story" id="story"', f)
    .replace('      </div>\n    </section>\n    <section class="story" id="story"', '      </div>\n    <section class="story" id="story"')
    .replace('      </div>\n    </section>\n  </main>', '      </div>\n    </section>\n    </section>\n  </main>'), 'caught'),
  page('M52 the nav is hidden again below 700px', swap('nav{gap:1.2rem;justify-content:center;order:3;padding-top:1rem;width:100%}', 'nav{display:none}'), 'caught'),
];

// The Performance Contract and the Bench's assertions together: an Arm row can only fail the latter.
const contract = () => spawnSync(process.execPath, ['--test', 'tests/performance-contract.mjs', 'tests/bench.mjs'], { cwd: root, encoding: 'utf8' });

if (contract().status !== 0) {
  console.error('the contract is not green on the unmutated files; fix that first');
  process.exit(2);
}

const rows = [];
try {
  for (const mutation of mutations) {
    const refused = apply(mutation);
    const outcome = refused || (contract().status === 0 ? 'passes' : 'caught');
    rows.push({ name: mutation.name, expected: mutation.expected, outcome: outcome === 'generator' ? 'caught' : outcome });
    restore(); // every file at once, so a rebuilt Arm never stacks onto the next row
  }
} finally {
  restore();
}

for (const { name, expected, outcome } of rows) {
  console.log(`${outcome === expected ? 'ok ' : 'BAD'}  ${outcome.padEnd(6)} (expected ${expected.padEnd(6)})  ${name}`);
}
const good = rows.filter((row) => row.outcome === row.expected).length;
console.log(`${good}/${rows.length} mutations behave as intended`);
process.exit(good === rows.length ? 0 : 1);
