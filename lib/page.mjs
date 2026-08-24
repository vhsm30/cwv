// The page model. `index.html` is parsed once, here, into values every assertion in the
// Performance Contract reads from: start tags with attributes in any order and any quote style,
// <picture> and <section> spans, the subresources the browser will fetch, and the inline
// stylesheet as rules that cascade per selector across every @media context. Nothing else in the
// repository should look at the page's bytes.

import { readFile } from 'node:fs/promises';

// A start tag: name, then attributes whose values may be double-quoted, single-quoted, or bare.
const START_TAG = /<([a-zA-Z][\w-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

const collapse = (text) => text.replace(/\s+/g, ' ').trim();
const normalizeSelector = (selector) => collapse(selector).replace(/\s*([>+~])\s*/g, '$1');
const normalizeMedia = (media) => (media == null ? null : String(media).replace(/\s+/g, ''));

function attributes(text) {
  const attrs = {};
  for (const m of text.matchAll(ATTRIBUTE)) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return attrs;
}

function startTags(html) {
  return [...html.matchAll(START_TAG)].map((m) => ({
    name: m[1].toLowerCase(),
    attrs: attributes(m[2]),
    start: m.index,
    end: m.index + m[0].length,
  }));
}

export function parseSrcset(value) {
  if (!value) return [];
  return value.split(',').map((candidate) => candidate.trim()).filter(Boolean).map((candidate) => {
    const [url, descriptor] = candidate.split(/\s+/);
    const width = descriptor && /^\d+w$/.test(descriptor) ? Number(descriptor.slice(0, -1)) : null;
    return { url, width };
  });
}

function closingBrace(text, open) {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === '{') depth += 1;
    if (text[at] === '}' && (depth -= 1) === 0) return at;
  }
  return text.length;
}

function parseDeclarations(body) {
  const declarations = {};
  for (const declaration of body.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon > 0) declarations[declaration.slice(0, colon).trim().toLowerCase()] = declaration.slice(colon + 1).trim();
  }
  return declarations;
}

function parseStylesheet(css) {
  const rules = [];
  const read = (text, media) => {
    let at = 0;
    for (;;) {
      const open = text.indexOf('{', at);
      if (open === -1) break;
      const head = text.slice(at, open).trim();
      const close = closingBrace(text, open);
      const body = text.slice(open + 1, close);
      if (head.startsWith('@media')) {
        read(body, normalizeMedia(head.slice('@media'.length)));
      } else if (head.startsWith('@') && body.includes('{')) {
        read(body, media); // any other nested at-rule keeps its context; the page only uses @media
      } else {
        const declarations = parseDeclarations(body);
        for (const selector of head.split(',')) {
          if (selector.trim()) rules.push({ media, selector: normalizeSelector(selector), declarations });
        }
      }
      at = close + 1;
    }
  };
  read(css, null);

  const contexts = [null, ...new Set(rules.map((rule) => rule.media).filter((media) => media !== null))];
  const cascade = (selector, media = null) => {
    const wanted = normalizeSelector(selector);
    const context = normalizeMedia(media);
    const declarations = {};
    for (const rule of rules) {
      if (rule.selector === wanted && (rule.media === null || rule.media === context)) Object.assign(declarations, rule.declarations);
    }
    return declarations;
  };
  const root = cascade(':root');
  const resolve = (value) => String(value ?? '').replace(/var\((--[\w-]+)\)/g, (whole, name) => (name in root ? resolve(root[name]) : whole));
  return { rules, contexts, cascade, resolve };
}

function luminance(hex) {
  const digits = String(hex).replace('#', '');
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`${hex} is not a hex colour`);
  const [r, g, b] = [0, 2, 4].map((at) => {
    const channel = parseInt(full.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// WCAG 2.x contrast ratio between two hex colours, to two decimals as it is usually quoted.
export function contrast(colorA, colorB) {
  const [light, dark] = [luminance(colorA), luminance(colorB)].sort((a, b) => b - a);
  return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
}

export async function loadPage(url) {
  const html = await readFile(url, 'utf8');
  const tags = startTags(html);

  // The span from a start tag to its own closing tag. The page does not nest these elements.
  const span = (open) => {
    const close = html.indexOf('</' + open.name, open.end);
    const innerEnd = close === -1 ? html.length : close;
    const end = close === -1 ? html.length : html.indexOf('>', close) + 1;
    return { ...open, end, text: html.slice(open.end, innerEnd), inner: tags.filter((t) => t.start >= open.end && t.end <= innerEnd) };
  };
  const spans = (name) => tags.filter((t) => t.name === name).map(span);
  const elements = (name) => tags.filter((t) => t.name === name.toLowerCase());

  const title = collapse(spans('title')[0]?.text ?? '');
  const meta = (name) => elements('meta').find((m) => m.attrs.name === name)?.attrs.content;
  const sections = spans('section').map(({ name, attrs, start, end }) => ({ name, attrs, start, end }));
  const pictures = spans('picture').map(({ start, end, inner }) => ({
    start, end, source: inner.find((t) => t.name === 'source'), img: inner.find((t) => t.name === 'img'),
  }));
  const scripts = spans('script').map(({ attrs, start, end, text }) => ({ attrs, start, end, inline: text.trim() }));
  const styles = parseStylesheet(spans('style').map((s) => s.text).join('\n'));

  const assets = [];
  const hrefs = [];
  for (const tag of tags) {
    const { name, attrs } = tag;
    if (name === 'img' || name === 'script') assets.push(attrs.src);
    if (name === 'img' || name === 'source') assets.push(...parseSrcset(attrs.srcset).map((c) => c.url));
    if (name === 'link') {
      hrefs.push(attrs.href);
      if (/\b(?:preload|modulepreload|stylesheet|icon)\b/.test(attrs.rel ?? '')) {
        assets.push(attrs.href, ...parseSrcset(attrs.imagesrcset).map((c) => c.url));
      }
    }
    if (name === 'a') hrefs.push(attrs.href);
  }

  return {
    url,
    html,
    title,
    meta,
    elements,
    sections,
    pictures,
    scripts,
    assets: [...new Set(assets.filter(Boolean))],
    hrefs: hrefs.filter((href) => href !== undefined),
    styles,
  };
}
