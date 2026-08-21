import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

// The stylesheet is inlined, so the page itself is the single source of truth for it.
const styles = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
// Match each <picture> without letting [\s\S] run past its own closing tag into the next one.
const pictures = [...html.matchAll(/<picture>(?:(?!<\/picture>)[\s\S])*<\/picture>/g)].map((m) => m[0]);
const heroPicture = pictures.find((p) => p.includes('class="hero-image"')) ?? '';
const heroImg = heroPicture.match(/<img[\s\S]*?>/)?.[0] ?? '';
const heroSource = heroPicture.match(/<source[\s\S]*?>/)?.[0] ?? '';
const heroPreload = html.match(/<link rel="preload" as="image"[\s\S]*?>/)?.[0] ?? '';
const products = pictures.filter((p) => p.includes('class="product-image"'));

const attribute = (tag, name) => Object.fromEntries(
  [...tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
)[name];
const candidates = (srcset) => (srcset ?? '').split(',').map((c) => c.trim().split(/\s+/)[0]);

test('the LCP image has responsive candidates and intrinsic dimensions', () => {
  assert.match(heroImg, /srcset="[^"]+ 640w, [^"]+ 768w, [^"]+ 1200w"/);
  assert.equal(attribute(heroImg, 'sizes'), '(max-width: 700px) 100vw, 50vw');
  assert.equal(attribute(heroImg, 'fetchpriority'), 'high');
  assert.doesNotMatch(heroImg, /loading="lazy"/);
});

test('the LCP preload matches the source the browser will actually choose', () => {
  // A preload that drifts from the picked candidate downloads the hero twice.
  assert.equal(attribute(heroPreload, 'type'), 'image/webp');
  assert.equal(attribute(heroPreload, 'imagesrcset'), attribute(heroSource, 'srcset'));
  assert.equal(attribute(heroPreload, 'imagesizes'), attribute(heroSource, 'sizes'));
  assert.equal(attribute(heroPreload, 'fetchpriority'), 'high');
  assert.ok(html.indexOf(heroPreload) < html.indexOf('<style>'));
});

test('declared dimensions match the real pixels, so no box is reserved wrongly', () => {
  // Ratio check only: the CSS box is aspect-ratio driven, so the declared ratio must agree with it.
  assert.equal(Number(attribute(heroImg, 'width')) / Number(attribute(heroImg, 'height')), 1200 / 803);
  for (const product of products) {
    const img = product.match(/<img[\s\S]*?>/)[0];
    const ratio = Number(attribute(img, 'width')) / Number(attribute(img, 'height'));
    assert.ok(Math.abs(ratio - 0.8) < 0.005, `product ratio ${ratio} must match the 4:5 CSS box`);
  }
});

test('every image is offered in a modern format with a JPEG fallback', () => {
  for (const picture of [heroPicture, ...products]) {
    const source = picture.match(/<source[\s\S]*?>/)?.[0] ?? '';
    const img = picture.match(/<img[\s\S]*?>/)[0];
    assert.equal(attribute(source, 'type'), 'image/webp');
    assert.ok(candidates(attribute(source, 'srcset')).every((c) => c.endsWith('.webp')));
    assert.ok(candidates(attribute(img, 'srcset')).every((c) => c.endsWith('.jpg')));
    assert.equal(attribute(source, 'sizes'), attribute(img, 'sizes'));
  }
});

test('every referenced image file exists', async () => {
  const referenced = [...html.matchAll(/\.\/images\/[\w.-]+\.(?:jpg|webp)/g)].map((m) => m[0]);
  assert.ok(referenced.length >= 12);
  for (const relative of new Set(referenced)) {
    await stat(new URL(`../${relative.slice(2)}`, import.meta.url));
  }
});

test('all storefront images are self-hosted', () => {
  const sources = [...html.matchAll(/(?:src|srcset|href|imagesrcset)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(sources.length > 0);
  assert.ok(sources.every((source) => !source.includes('unsplash.com')));
});

test('the small hero label meets normal text contrast', () => {
  assert.match(styles, /--accent:#8d3f2b;/);
});

test('nothing render-blocking sits in the critical path', () => {
  assert.doesNotMatch(html, /<link[^>]+rel="stylesheet"/);
  assert.doesNotMatch(html, /\.css/);
  assert.match(styles, /\.hero\{/);
  assert.match(styles, /\.products\{/);
  // picture must stay boxless or it, not the img, becomes the grid/flex item.
  assert.match(styles, /picture\{display:contents\}/);
});

test('behavior stays external, deferred, and free of inline script', () => {
  assert.match(html, /<script src="\.\/app\.v1\.min\.js" defer><\/script>/);
  assert.equal(html.match(/<script/g).length, 1);
  assert.doesNotMatch(html, /<script>/);
});

test('below-the-fold product images are lazy, sized, and deprioritised', () => {
  assert.equal(products.length, 3);
  for (const product of products) {
    const img = product.match(/<img[\s\S]*?>/)[0];
    assert.match(img, /loading="lazy"/);
    // Chrome loads the first lazy images eagerly; without this they outrank the LCP image.
    assert.match(img, /fetchpriority="low"/);
    assert.ok(attribute(img, 'width') && attribute(img, 'height'));
  }
});
