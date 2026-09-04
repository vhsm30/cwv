// The Performance Contract: every Win locked in as an assertion over the page model. Each
// assertion names a property Lighthouse rewards and reads it as a parsed value, so attribute
// order, quote style, and whitespace cannot fail it and a real regression cannot slip past it.
// Facts about the files on disk come from the files themselves, never from literals kept here.

import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import test from 'node:test';

import { imageSizeOf } from '../lib/image-size.mjs';
import { contrast, loadPage, parseSrcset } from '../lib/page.mjs';
import { loadServiceWorker, scriptGeneration } from '../lib/service-worker.mjs';

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

// The Route table: one description per Route, shared with tools/build-pages.py. There is one
// Route today; it is a table so P3 extends it rather than inventing a second file.
// routeTable, not routes: two existing tests already bind `routes` to the in-page routes locally.
const routeTable = JSON.parse(await readFile(fileOf('./routes.json'), 'utf8'));
const routeOf = (file) => {
  const found = routeTable.routes.find((candidate) => candidate.file === file);
  assert.ok(found, `routes.json names no Route for ${file}`);
  return found;
};

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

// The manifest the page links: the one home of every icon fact, shared with tools/build-icons.py
// and the browser. Read through the page model so a page that stops linking it fails here.
const manifest = page.manifest ? JSON.parse(await readFile(fileOf(page.manifest), 'utf8')) : {};
const pictured = [...(manifest.icons ?? []), ...(manifest.screenshots ?? [])];
const sizesDeclared = (entry) => {
  const match = /^(\d+)x(\d+)$/.exec(entry.sizes ?? '');
  assert.ok(match, `${entry.src} declares exactly one WxH in sizes`);
  return { width: Number(match[1]), height: Number(match[2]) };
};

test('the page links one manifest, and the manifest describes the page it sits beside', () => {
  assert.ok(page.manifest, 'the page links a manifest');
  assert.match(page.manifest, /\.webmanifest$/);
  const name = page.title.split('|')[0].trim();
  assert.equal(manifest.name, name);
  assert.ok(manifest.short_name.length <= 12 && name.startsWith(manifest.short_name), 'short_name is the name, shortened to fit under an icon');
  assert.equal(manifest.description, page.meta('description'));
  assert.equal(manifest.lang, page.elements('html')[0].attrs.lang);
  // One identity, one scope, opened as its own window: what makes the Storefront installable.
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
});

test("the manifest's colours are the page's own ink and paper, and the theme-color meta agrees", () => {
  const body = styles.cascade('body');
  assert.equal(manifest.background_color, styles.resolve(body.background), 'background_color paints the splash screen the colour of the page');
  assert.equal(manifest.theme_color, styles.resolve(body.color), 'theme_color is the ink');
  assert.equal(page.meta('theme-color'), manifest.theme_color);
});

test('the shortcuts are exactly the in-page routes', () => {
  const routes = [...new Set(page.hrefs.filter((href) => href.startsWith('#')))].map((route) => `./${route}`).sort();
  assert.ok(routes.length > 0);
  assert.deepEqual(manifest.shortcuts.map((shortcut) => shortcut.url).sort(), routes);
  for (const shortcut of manifest.shortcuts) assert.ok((shortcut.name ?? '').trim(), `${shortcut.url} is named`);
});

test('no word CONTEXT.md avoids reaches a visitor through the manifest', async () => {
  const context = await readFile(fileOf('./CONTEXT.md'), 'utf8');
  const avoided = [...context.matchAll(/^_Avoid_:\s*(.+)$/gm)]
    .flatMap((m) => m[1].split(','))
    .map((word) => word.replace(/\(.*?\)/g, '').trim().toLowerCase())
    .filter(Boolean);
  assert.ok(avoided.length >= 20, 'the avoid-lists were read');
  const visible = [
    manifest.name, manifest.short_name, manifest.description,
    ...manifest.shortcuts.flatMap((shortcut) => [shortcut.name, shortcut.description]),
    ...manifest.screenshots.map((shot) => shot.label),
  ].filter(Boolean);
  assert.ok(visible.length >= 5);
  for (const text of visible) {
    for (const word of avoided) {
      // Whole words only. Built without \b on purpose: in a template literal that is a backspace.
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.doesNotMatch(text.toLowerCase(), new RegExp('(?:^|[^a-z])' + escaped + '(?:$|[^a-z])'), `"${text}" says "${word}"`);
    }
  }
});

test('the head declares the Storefront capable without the deprecated Apple tag, and one touch icon', () => {
  assert.equal(page.meta('mobile-web-app-capable'), 'yes');
  // Chrome reports the apple- tag as a deprecation: deprecations (w5) and inspector-issues (w1)
  // out of 25 in best-practices, so landing in both reads 76.
  assert.equal(page.meta('apple-mobile-web-app-capable'), undefined);
  const links = page.elements('link');
  const touch = links.filter((link) => link.attrs.rel === 'apple-touch-icon');
  assert.equal(touch.length, 1, 'iOS reads its icon from the head, not the manifest');
  const icon = (manifest.icons ?? []).find((entry) => entry.src === touch[0].attrs.href);
  assert.ok(icon, 'the touch icon is one the manifest declares, so the manifest stays the one home');
  assert.equal(sizesDeclared(icon).width, 180);
  // No rel=icon link: it would change which favicon request a Run records.
  assert.ok(!links.some((link) => /\bicon\b/.test(link.attrs.rel ?? '') && link.attrs.rel !== 'apple-touch-icon'));
});

test('icons/ holds nothing but what the manifest declares, Generation-stamped', async () => {
  assert.ok(pictured.length > 0);
  for (const entry of pictured) {
    // A flat, stamped PNG name under icons/: the Measurement Server serves the directory immutable.
    assert.match(entry.src, /^\.\/icons\/[A-Za-z0-9_]+-v\d+-[A-Za-z0-9_-]+\.png$/, `${entry.src} is a stamped PNG under icons/`);
    assert.equal(entry.type, 'image/png', entry.src);
  }
  const files = (await readdir(fileOf('./icons/'))).sort();
  assert.deepEqual(files, pictured.map((entry) => entry.src.slice('./icons/'.length)).sort());
});

test('every icon and screenshot has the pixels its sizes declare', async () => {
  for (const entry of pictured) {
    const pixels = await pixelsOf(entry.src);
    assert.equal(pixels.format, 'png', entry.src);
    assert.deepEqual({ width: pixels.width, height: pixels.height }, sizesDeclared(entry), entry.src);
  }
});

test('the icons cover what a home screen needs', () => {
  const purposes = (icon) => (icon.purpose ?? 'any').split(/\s+/);
  const any = manifest.icons.filter((icon) => purposes(icon).includes('any'));
  for (const icon of manifest.icons) {
    const { width, height } = sizesDeclared(icon);
    assert.equal(width, height, `${icon.src} is square`);
  }
  assert.ok(any.some((icon) => sizesDeclared(icon).width === 192), 'a 192px icon is what makes the Storefront installable');
  assert.ok(any.some((icon) => sizesDeclared(icon).width >= 512), 'a 512px icon is what the splash screen wants');
  assert.ok(manifest.icons.some((icon) => purposes(icon).includes('maskable')), 'a maskable icon survives the launcher\'s mask');
});

test("the screenshots satisfy Chrome's rules for the richer install dialog", () => {
  assert.ok(manifest.screenshots.length > 0);
  const ratios = new Map();
  for (const shot of manifest.screenshots) {
    const { width, height } = sizesDeclared(shot);
    const [short, long] = [Math.min(width, height), Math.max(width, height)];
    assert.ok(short >= 320 && long <= 3840, `${shot.src} is within 320-3840px`);
    assert.ok(long <= 2.3 * short, `${shot.src} is at most 2.3:1`);
    assert.ok(['narrow', 'wide'].includes(shot.form_factor), `${shot.src} names its form factor`);
    assert.ok((shot.label ?? '').trim(), `${shot.src} carries a label`);
    if (ratios.has(shot.form_factor)) {
      assert.equal(width / height, ratios.get(shot.form_factor), `${shot.form_factor} screenshots share one aspect ratio`);
    }
    ratios.set(shot.form_factor, width / height);
  }
});

// The Notice: markup and CSS live in the page, inside the page model, because no Run will ever
// see it (beforeinstallprompt never fires in Lighthouse's profile) and only the contract can hold it.
const notice = page.elements('div').find((div) => (div.attrs.class ?? '').split(/\s+/).includes('notice'));
const classed = (name, className) => page.elements(name).filter((el) => (el.attrs.class ?? '').split(/\s+/).includes(className));

test('the Notice ships hidden, and hidden means hidden in every media context', () => {
  assert.ok(notice, 'the Notice is in the markup');
  assert.ok('hidden' in notice.attrs);
  // [hidden]{display:none} is the UA's, and any author display rule beats it on origin alone, so
  // a .notice{display:flex} would ship the Notice visible on every load. Only an !important author
  // rule keeps the attribute meaning what it reads as.
  for (const context of styles.contexts) {
    const display = (styles.cascade('[hidden]', context).display ?? '').replace(/\s+/g, '');
    assert.equal(display, 'none!important', `[hidden] in ${context ?? 'the base stylesheet'}`);
  }
});

test('the Notice is out of flow everywhere, so revealing it shifts nothing', () => {
  for (const context of styles.contexts) {
    assert.equal(styles.cascade('.notice', context).position, 'fixed', `.notice in ${context ?? 'the base stylesheet'}`);
  }
});

test('the Notice and its controls read at normal-text contrast, because no Run will ever check them', () => {
  const ground = styles.resolve(styles.cascade('.notice').background);
  const text = styles.resolve(styles.cascade('.notice').color);
  assert.ok(contrast(text, ground) >= 4.5, `${text} on ${ground} is ${contrast(text, ground)}:1`);
  for (const className of ['notice-accept', 'notice-dismiss']) {
    assert.equal(classed('button', className).length, 1, `one .${className} button`);
    const rule = styles.cascade(`.${className}`);
    const background = !rule.background || rule.background === 'none' ? ground : styles.resolve(rule.background);
    const colour = styles.resolve(rule.color);
    assert.ok(contrast(colour, background) >= 4.5, `.${className}: ${colour} on ${background} is ${contrast(colour, background)}:1`);
  }
});

// The Worker, read through its own model. It is registered from the one script, after load, so a
// Run fetches it but is never served by it: storage is cleared before every Run.
const worker = await loadServiceWorker(fileOf('./sw.js')).catch(() => null);

test('the Worker keeps exactly the Shell: the document, the behaviour, and the favicon', async () => {
  assert.ok(worker, 'sw.js sits beside the page');
  const [script] = page.scripts;
  // Not one Rung: three of the Rungs the page offers are never fetched at the Run's viewport, and
  // keeping every one would add three requests to a first visit. Images are kept as they are seen.
  assert.deepEqual([...worker.shell].sort(), ['./', script.attrs.src, './favicon.ico'].sort());
  for (const entry of worker.shell) await stat(fileOf(entry === './' ? './index.html' : entry));
  const behaviour = await readFile(fileOf(script.attrs.src), 'utf8');
  assert.ok(behaviour.includes("register('./sw.js')"), 'the behaviour registers the Worker by its fixed URL');
});

test('the cache is named for the Generation of the behaviour it keeps', () => {
  assert.ok(worker);
  const script = worker.shell.find((entry) => scriptGeneration(entry) !== null);
  assert.ok(script, 'the Shell names a Generation-stamped script');
  assert.equal(worker.generation, scriptGeneration(script), `${worker.cacheName} tracks ${script}`);
});

test('the Worker never takes a page mid-Run', () => {
  assert.ok(worker);
  // Storage is cleared before every Run, so the Worker installs fresh each time. clients.claim()
  // would take the page then, fire controllerchange, and a reload listener would reload the page
  // inside the trace: every Run, not a flake. skipWaiting() belongs only to the message handler,
  // where the Notice asks for it on the visitor's behalf.
  assert.equal(worker.claimsClients, false, 'no clients.claim()');
  assert.equal(worker.skipsWaitingAtInstall, false, 'no skipWaiting() outside the message handler');
  for (const event of ['install', 'activate', 'fetch', 'message']) assert.ok(worker.handlers.includes(event), `handles ${event}`);
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

test('the document names its own canonical URL, the one routes.json gives it', () => {
  // Relative, never absolute: a Preview URL is random per session, so an absolute canonical would
  // name a host that stopped existing when the tunnel closed. What it points at is not resolved
  // here — only that the document and the table agree. A canonical that names an origin is already
  // refused by 'all storefront assets are self-hosted', which reads every <link href> — this test's
  // own href — and catches a protocol-relative //host too, which a doesNotMatch here would not.
  const route = routeOf('index.html');
  const canonical = page.elements('link').filter((link) => link.attrs.rel === 'canonical');
  assert.equal(canonical.length, 1, 'exactly one canonical link');
  assert.equal(canonical[0].attrs.href, route.canonical);
});

test('the social preview is the page describing itself, not a second copy of its words', async () => {
  // og:title and og:description are not in routes.json: they are the page's own title and
  // description, read by the generator and written once, so the two cannot drift (BACKLOG.md D15).
  // Which card types are legal is tools/build-pages.py's to say — it refuses to write any other,
  // so no document can carry one.
  const route = routeOf('index.html');
  // Both sides are raw source: the page model does not unescape, and the generator re-escapes what
  // it decoded, so a title of `Foo &amp; Co` is `Foo &amp; Co` in both places.
  assert.equal(page.property('og:title'), page.title);
  assert.equal(page.property('og:description'), page.meta('description'));
  assert.equal(page.property('og:image'), route.og.image);
  assert.equal(page.meta('twitter:card'), route.og.card);
  // The preview image is a Rung on disk, checked like every other image fact.
  await stat(fileOf(route.og.image));
});

test('each in-page route is a section of its own, labelled by its own heading', () => {
  const routes = [...new Set(page.hrefs.filter((href) => href.startsWith('#')))];
  assert.ok(routes.length >= 2, 'the page offers in-page routes');
  const headings = page.elements('h2').filter((heading) => heading.attrs.id);
  const sections = routes.map((route) => {
    const section = page.sections.find((candidate) => candidate.attrs.id === route.slice(1));
    assert.ok(section, `${route} names a <section>, not an element inside one`);
    // Its own heading, not merely some heading: the id has to resolve to an <h2> inside this
    // section's own span, or the label belongs to a Route the visitor did not arrive at.
    const heading = headings.find((candidate) => candidate.attrs.id === section.attrs['aria-labelledby']);
    assert.ok(heading && heading.start > section.start && heading.start < section.end,
      `${route} is labelled by a heading of its own`);
    return section;
  });
  // Siblings, never one within another: a route inside another route cannot be arrived at on its own.
  for (const a of sections) {
    for (const b of sections) {
      if (a !== b) assert.ok(a.end <= b.start || b.end <= a.start, `${a.attrs.id} and ${b.attrs.id} are nested`);
    }
  }
});

test('the primary navigation survives every media context', () => {
  // Below 700px the nav used to be display:none with nothing put in its place, so the one form
  // factor every Run measures had no navigation at all. What replaces it is a wrapped row, not a
  // disclosure: a toggle would need the behaviour, and the behaviour is a Generation.
  const routes = [...new Set(page.hrefs.filter((href) => href.startsWith('#')))];
  assert.ok(page.elements('nav').length >= 1, 'the header carries a nav');
  for (const context of styles.contexts) {
    const display = (styles.cascade('nav', context).display ?? '').replace(/\s+/g, '');
    assert.notEqual(display, 'none', `nav in ${context ?? 'the base stylesheet'} leaves no way to reach ${routes.join(' or ')}`);
  }
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
