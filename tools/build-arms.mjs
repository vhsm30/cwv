#!/usr/bin/env node
// The Arms are derived from the control, never edited: each is index.html with exactly one
// delivery's snippet inserted, committed and byte-identical on every rebuild (ADR 0001), so the
// difference an Arm measures is the snippet's and nothing else. Run from the repository root:
//
//     node tools/build-arms.mjs
//
// tests/bench.mjs holds every Arm on disk equal to buildArm(index.html); a change to index.html
// demands a rebuild, as a Master's change demands its Rungs.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { GTM_ORIGIN, ROOT_URL, loadArms } from '../lib/arms.mjs';
import { parsePage } from '../lib/page.mjs';

// Google's standard snippet, verbatim but for the container id: an inline script that loads gtm.js
// async before the first script in the document, and the noscript iframe.
export const headSnippet = (id) =>
  `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='${GTM_ORIGIN}/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${id}');</script>`;
export const noscriptSnippet = (id) =>
  `<noscript><iframe src="${GTM_ORIGIN}/ns.html?id=${id}" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>`;
// The deferred delivery: after load, when idle (one-second ceiling), seed dataLayer exactly as the
// standard snippet does and append the same gtm.js. No noscript: nothing standard to be verbatim about.
export const afterLoadSnippet = (id) =>
  `<script>addEventListener('load',function(){(window.requestIdleCallback||function(f){setTimeout(f,0)})(function(){window.dataLayer=window.dataLayer||[];window.dataLayer.push({'gtm.start':new Date().getTime(),event:'gtm.js'});var s=document.createElement('script');s.async=true;s.src='${GTM_ORIGIN}/gtm.js?id=${id}';document.head.appendChild(s)},{timeout:1000})})</script>`;

export function buildArm(control, arm, container) {
  if (arm.delivery === 'none') return control;
  const id = container.id;
  if (arm.delivery === 'head') {
    const page = parsePage(control);
    const charset = page.elements('meta').find((tag) => 'charset' in tag.attrs);
    const body = page.elements('body')[0];
    if (!charset || !body) throw new Error('the control has no <meta charset> or no <body> start tag');
    // The later insertion first, so the earlier offset stays valid.
    let html = control.slice(0, body.end) + '\n  ' + noscriptSnippet(id) + control.slice(body.end);
    html = html.slice(0, charset.end) + '\n  ' + headSnippet(id) + html.slice(charset.end);
    return html;
  }
  if (arm.delivery === 'after-load') {
    const close = control.lastIndexOf('</body>');
    if (close === -1) throw new Error('the control has no </body>');
    return control.slice(0, close) + afterLoadSnippet(id) + '\n' + control.slice(close);
  }
  throw new Error(`${arm.name}: unknown delivery ${JSON.stringify(arm.delivery)}`);
}

// Write every Arm; report which files changed. Byte-identical when nothing did.
export async function buildArms() {
  const table = await loadArms();
  const control = await readFile(new URL('index.html', ROOT_URL), 'utf8');
  const written = [];
  for (const arm of table.arms) {
    if (arm.delivery === 'none') continue;
    const target = new URL(arm.file, ROOT_URL);
    const next = buildArm(control, arm, table.container);
    let previous = null;
    try {
      previous = await readFile(target, 'utf8');
    } catch {
      // A first build.
    }
    if (previous !== next) await writeFile(target, next);
    written.push({ file: arm.file, changed: previous !== next });
  }
  return written;
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const written = await buildArms();
  for (const { file, changed } of written) console.log(`${changed ? 'wrote' : 'unchanged'}  ${file}`);
  console.log(`${written.length} Arms from ${path.relative(process.cwd(), fileURLToPath(new URL('index.html', ROOT_URL)))}`);
}
