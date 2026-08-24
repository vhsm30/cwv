// The Performance Contract: every Win locked in as an assertion over the page model. Each
// assertion names a property Lighthouse rewards and reads it as a parsed value, so attribute
// order, quote style, and whitespace cannot fail it and a real regression cannot slip past it.
// Facts about the files on disk come from the files themselves, never from literals kept here.

import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import test from 'node:test';

import { imageSizeOf } from '../lib/image-size.mjs';
import { contrast, loadPage, parseSrcset } from '../lib/page.mjs';

const page = await loadPage(new URL('../index.html', import.meta.url));
const { styles } = page;
// Relative URLs resolve against the page, exactly as the browser resolves them.
const fileOf = (relative) => new URL(relative, page.url);

const hero = page.sections.find((section) => section.attrs.class === 'hero');
const heroPicture = page.pictures.find((picture) => picture.start > hero.start && picture.end < hero.end);
const productPictures = page.pictures.filter((picture) => picture !== heroPicture);
const preload = page.elements('link').find((link) => link.attrs.rel === 'preload' && link.attrs.as === 'image');

// The Slot table: one description per image Slot, shared with tools/build-images.py.
const slots = JSON.parse(await readFile(fileOf('./images/slots.json'), 'utf8'));
const rungFile = (name, width, format) => `./images/${name}-${width}.${format}`;
const slotOf = (url) => {
  const match = /\/([a-z0-9_]+)-(\d+)\.(webp|jpg)$/.exec(url ?? '');
  return match ? { name: match[1], width: Number(match[2]), format: match[3] } : undefined;
};
// The generator's crop and resize arithmetic, so a Rung on disk can be checked to the pixel.
const cropOf = (master, ratio) => {
  if (!ratio) return { width: master.width, height: master.height };
  const target = ratio[0] / ratio[1];
  if (master.width / master.height > target) return { width: Math.round(master.height * target), height: master.height };
  return { width: master.width, height: Math.round(master.width / target) };
};
const rungHeight = (crop, width) => (width === crop.width ? crop.height : Math.round((width * crop.height) / crop.width));

const sizesOf = (value) => (value ?? '').replace(/\s+/g, '');
const rungs = (srcset) => parseSrcset(srcset).sort((a, b) => a.width - b.width);
const largest = (srcset) => rungs(srcset).at(-1);
const pixelsOf = async (relative) => {
  try {
    return await imageSizeOf(fileOf(relative));
  } catch (error) {
    assert.fail(`${relative}: ${error.message}`);
  }
};

test('the Hero image is the LCP candidate: responsive, sized, and fetched first', () => {
  const { attrs } = heroPicture.img;
  assert.ok(rungs(attrs.srcset).length >= 2 && rungs(attrs.srcset).every((rung) => rung.width), 'needs width-described candidates');
  assert.ok(sizesOf(attrs.sizes), 'needs sizes so the browser can pick a candidate before layout');
  assert.equal(attrs.fetchpriority, 'high');
  assert.notEqual(attrs.loading, 'lazy');
  assert.ok(Number(attrs.width) > 0 && Number(attrs.height) > 0, 'needs intrinsic dimensions');
});

test('the LCP preload matches the source the browser will actually choose', () => {
  // A preload that drifts from the picked candidate downloads the Hero twice.
  const { source, img } = heroPicture;
  assert.ok(preload, 'the Hero image must be preloaded');
  assert.equal(preload.attrs.type, source.attrs.type);
  assert.deepEqual(rungs(preload.attrs.imagesrcset), rungs(source.attrs.srcset));
  assert.equal(sizesOf(preload.attrs.imagesizes), sizesOf(source.attrs.sizes));
  assert.equal(preload.attrs.fetchpriority, 'high');
  assert.equal(preload.attrs.href, img.attrs.src, 'the fallback href is the fallback image');
  assert.ok(preload.start < page.elements('style')[0].start, 'the preload must be discovered before the stylesheet is parsed');
});

test('declared dimensions match the real pixels on disk, so no box is reserved wrongly', async () => {
  for (const { source, img } of page.pictures) {
    const declared = { width: Number(img.attrs.width), height: Number(img.attrs.height) };
    const fallback = largest(img.attrs.srcset);
    assert.equal(img.attrs.src, fallback.url, 'src is the largest fallback candidate');
    const jpeg = await pixelsOf(fallback.url);
    const webp = await pixelsOf(largest(source.attrs.srcset).url);
    assert.deepEqual({ width: jpeg.width, height: jpeg.height }, declared, `${fallback.url} declares ${declared.width}x${declared.height}`);
    assert.deepEqual({ width: webp.width, height: webp.height }, declared, 'the modern candidate has the declared pixels too');
  }
});

test('every srcset descriptor tells the truth about its file', async () => {
  const candidates = page.pictures.flatMap(({ source, img }) => [...rungs(source.attrs.srcset), ...rungs(img.attrs.srcset)]);
  assert.ok(candidates.length >= 12);
  for (const { url, width } of candidates) {
    assert.equal((await pixelsOf(url)).width, width, `${url} is described as ${width}w`);
  }
});

test('every image is offered in a modern format with a JPEG fallback on identical terms', () => {
  for (const { source, img } of page.pictures) {
    assert.equal(source.attrs.type, 'image/webp');
    assert.ok(rungs(source.attrs.srcset).every((rung) => rung.url.endsWith('.webp')));
    assert.ok(rungs(img.attrs.srcset).every((rung) => rung.url.endsWith('.jpg')));
    assert.deepEqual(rungs(source.attrs.srcset).map((r) => r.width), rungs(img.attrs.srcset).map((r) => r.width), 'both formats ship the same widths');
    assert.equal(sizesOf(source.attrs.sizes), sizesOf(img.attrs.sizes));
  }
});

test('all storefront assets are self-hosted', () => {
  const references = [...page.assets, ...page.hrefs];
  assert.ok(references.length > 0);
  for (const reference of references) {
    assert.doesNotMatch(reference, /^[a-z][a-z0-9+.-]*:/i, `${reference} names another origin`);
    assert.doesNotMatch(reference, /^\/\//, `${reference} is protocol-relative`);
  }
});

test('the small Hero label meets normal-text contrast against the Hero background', () => {
  const eyebrow = page.elements('span').find((span) => span.attrs.class === 'eyebrow');
  assert.ok(eyebrow.start > hero.start && eyebrow.end < hero.end, 'the label sits on the Hero');
  const text = styles.resolve(styles.cascade('.eyebrow').color);
  const background = styles.resolve(styles.cascade('.hero').background);
  assert.ok(contrast(text, background) >= 4.5, `${text} on ${background} is ${contrast(text, background)}:1`);
});

test('nothing render-blocking sits in the critical path', () => {
  assert.ok(!page.elements('link').some((link) => /\bstylesheet\b/.test(link.attrs.rel ?? '')));
  assert.ok(!page.assets.some((asset) => asset.endsWith('.css')));
  // The layout lives in the inline stylesheet, so first paint needs nothing but the document.
  assert.equal(page.elements('style').length, 1);
  assert.ok(Object.keys(styles.cascade('.hero')).length > 0);
  assert.ok(Object.keys(styles.cascade('.products')).length > 0);
});

test('behaviour stays external, deferred, and free of inline script', async () => {
  assert.equal(page.scripts.length, 1);
  const [script] = page.scripts;
  assert.equal(script.inline, '');
  assert.ok('defer' in script.attrs);
  await stat(fileOf(script.attrs.src));
});

test('below-the-fold Product images are lazy, sized, and deprioritised', () => {
  assert.equal(productPictures.length, 3, 'the Collection is three Products');
  for (const { img } of productPictures) {
    assert.equal(img.attrs.loading, 'lazy');
    // Chrome loads the first lazy images eagerly; without this they outrank the LCP image.
    assert.equal(img.attrs.fetchpriority, 'low');
    assert.ok(Number(img.attrs.width) > 0 && Number(img.attrs.height) > 0);
  }
});

test('aspect-ratio boxes release the HTML height attribute in every media context', () => {
  // Without height:auto the height attribute wins outright and aspect-ratio is dead code,
  // which silently stretched every Product to 875px tall. A later @media rule can undo it.
  for (const selector of new Set(Object.values(slots).map((slot) => slot.box))) {
    for (const context of styles.contexts) {
      const box = styles.cascade(selector, context);
      if (box['aspect-ratio'] || box.height) {
        assert.equal(box.height, 'auto', `${selector} in ${context ?? 'the base stylesheet'} needs height:auto`);
      }
    }
  }
});

test('every picture is one Slot and every Slot is one picture', () => {
  const names = page.pictures.map(({ img }) => slotOf(img.attrs.src)?.name ?? `unknown (${img.attrs.src})`);
  assert.deepEqual([...names].sort(), Object.keys(slots).sort());
});

test('each Slot ships exactly its Rungs, in both formats, on its own sizes', () => {
  for (const { source, img } of page.pictures) {
    const name = slotOf(img.attrs.src)?.name;
    const slot = slots[name];
    const widths = [...slot.widths].sort((a, b) => a - b);
    assert.deepEqual(rungs(source.attrs.srcset), widths.map((width) => ({ url: rungFile(name, width, 'webp'), width })));
    assert.deepEqual(rungs(img.attrs.srcset), widths.map((width) => ({ url: rungFile(name, width, 'jpg'), width })));
    assert.equal(img.attrs.src, rungFile(name, widths.at(-1), 'jpg'));
    assert.equal(sizesOf(img.attrs.sizes), sizesOf(slot.sizes));
  }
});

test('every sizes breakpoint is the stylesheet\'s own mobile breakpoint', () => {
  const contexts = styles.contexts.filter(Boolean);
  assert.equal(contexts.length, 1, 'one mobile @media context');
  const breakpoint = /max-width:(\d+)px/.exec(contexts[0])?.[1];
  assert.ok(breakpoint);
  for (const [name, slot] of Object.entries(slots)) {
    assert.ok(sizesOf(slot.sizes).includes(`(max-width:${breakpoint}px)`), `${name} sizes switch at ${breakpoint}px`);
  }
});

test('every Rung on disk is its Master cropped and resized exactly as the Slot says', async () => {
  for (const [name, slot] of Object.entries(slots)) {
    const master = await pixelsOf(`./images/${slot.master}`);
    const crop = cropOf(master, slot.ratio);
    assert.ok(Math.max(...slot.widths) <= crop.width, `${name}: the Master can honestly supply ${crop.width}px`);
    for (const width of slot.widths) {
      for (const format of ['webp', 'jpg']) {
        const pixels = await pixelsOf(rungFile(name, width, format));
        assert.deepEqual({ width: pixels.width, height: pixels.height }, { width, height: rungHeight(crop, width) }, rungFile(name, width, format));
      }
    }
  }
});

test('a ratio-driven Slot renders into a box of that ratio', () => {
  for (const [name, slot] of Object.entries(slots)) {
    if (!slot.ratio) continue;
    const declared = /^(\d+)\s*\/\s*(\d+)$/.exec(styles.cascade(slot.box)['aspect-ratio'] ?? '');
    assert.ok(declared, `${slot.box} declares an aspect-ratio for ${name}`);
    assert.equal(Number(declared[1]) / Number(declared[2]), slot.ratio[0] / slot.ratio[1]);
  }
});

test('images/ holds nothing but Masters and Rungs', async () => {
  const files = (await readdir(fileOf('./images/'))).filter((file) => file !== 'slots.json').sort();
  const expected = Object.entries(slots).flatMap(([name, slot]) => [
    slot.master,
    ...slot.widths.flatMap((width) => [`${name}-${width}.webp`, `${name}-${width}.jpg`]),
  ]).sort();
  assert.deepEqual(files, expected);
});

test('picture dissolves without promoting <source> to a layout item', () => {
  // picture must stay boxless or it, not the img, becomes the grid/flex item. display:contents
  // promotes BOTH children, so an unhidden <source> becomes a second grid item that takes the
  // Hero image's column on desktop; mobile hides the damage because .hero is column-reverse there.
  for (const context of styles.contexts) {
    assert.equal(styles.cascade('picture', context).display, 'contents');
    assert.equal(styles.cascade('picture>source', context).display, 'none');
  }
});

test('the site-verification tag is preserved', () => {
  assert.ok((page.meta('google-site-verification') ?? '').length > 0);
});

test('llms.txt describes the page it sits beside', async () => {
  const lines = (await readFile(fileOf('./llms.txt'), 'utf8')).split(/\r?\n/);
  const name = page.title.split('|')[0].trim();
  assert.equal(lines[0], `# ${name}`);
  assert.ok(lines.includes(`> ${page.meta('description')}`), 'the summary is the meta description');
  const routes = new Set(page.hrefs.filter((href) => href.startsWith('#')));
  assert.ok(routes.size > 0);
  for (const route of routes) {
    assert.ok(lines.some((line) => line.includes(`(./${route})`)), `${route} is listed`);
  }
});

test('robots.txt is well-formed and lets the Storefront be crawled', async () => {
  const lines = (await readFile(fileOf('./robots.txt'), 'utf8')).split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('#'));
  assert.ok(lines.length > 0);
  for (const line of lines) assert.match(line, /^[A-Za-z-]+:\s*\S*$/);
  assert.ok(lines.some((line) => /^User-agent:\s*\*$/i.test(line)));
  assert.ok(!lines.some((line) => /^Disallow:\s*\/\s*$/i.test(line)));
});
