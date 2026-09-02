// Lock-in for the Measurement Server. The headers a Run measures -- keep-alive, gzip, immutable
// caching, HTML never cached -- are asserted through the same seam a Run crosses: HTTP against the
// real `python server.py` on an ephemeral port. Nothing here reaches into server.py's internals.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { after, before, test } from 'node:test';

import { loadPage } from '../lib/page.mjs';

const root = new URL('../', import.meta.url);
const IMMUTABLE = 'public, max-age=31536000, immutable';
const gzip = { 'accept-encoding': 'gzip' };
// The page model is the one parser of what the page references and links.
const page = await loadPage(new URL('index.html', root));
const pathOf = (relative) => '/' + relative.replace(/^\.\//, '');
// The behaviour's current Generation, named by the page, so a bump moves every assertion at once.
const behaviour = pathOf(page.scripts[0].attrs.src);

// One keep-alive connection, like the browser a Run drives.
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
let server;
let port;

before(async () => {
  server = spawn('python', ['server.py', '0'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  port = await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(
      `server.py 0 did not print its bound port within 10s\nstdout: ${stdout}\nstderr: ${stderr}`,
    )), 10_000);
    server.stdout.on('data', (chunk) => {
      stdout += chunk;
      const bound = stdout.match(/http:\/\/localhost:(\d+)\//);
      if (bound && Number(bound[1]) > 0) {
        clearTimeout(timer);
        resolve(Number(bound[1]));
      }
    });
    server.stderr.on('data', (chunk) => { stderr += chunk; });
    server.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server.py exited early with code ${code}\n${stderr}`));
    });
  });
});

after(() => {
  agent.destroy();
  server?.kill();
});

// Raw http.request rather than fetch: fetch normalises `..` away and hides socket reuse.
const request = (path, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method, headers, agent }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({
      status: res.statusCode,
      headers: res.headers,
      httpVersion: res.httpVersion,
      body: Buffer.concat(chunks),
      reusedSocket: req.reusedSocket,
    }));
  });
  req.on('error', reject);
  req.end();
});

const file = (relative) => readFile(new URL(relative, root));

test('the Storefront document is HTML, gzipped, and never cached', async () => {
  const res = await request('/', { headers: gzip });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/html/);
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(res.headers.vary, 'Accept-Encoding');
  assert.equal(res.headers['cache-control'], 'no-cache');
  assert.equal(Number(res.headers['content-length']), res.body.length);
  assert.equal(gunzipSync(res.body).toString('utf8'), (await file('index.html')).toString('utf8'));
});

test('behaviour is served as JavaScript, gzipped, and as an Immutable Asset', async () => {
  assert.match(behaviour, /^\/app\.v2\.min\.js$/, 'the page ships the second Generation of the behaviour');
  const res = await request(behaviour, { headers: gzip });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/javascript/);
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(res.headers['cache-control'], IMMUTABLE);
  assert.equal(gunzipSync(res.body).toString('utf8'), (await file(behaviour.slice(1))).toString('utf8'));
});

test('the Worker is served as JavaScript, gzipped, and revalidated on every request', async () => {
  // Its URL is its identity: a Generation-stamped Worker would be a second registration, not a
  // replacement, so sw.js is the one script that must never be immutable. A wrong content type
  // registers-and-fails silently into errors-in-console.
  const res = await request('/sw.js', { headers: gzip });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/javascript/);
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(res.headers['cache-control'], 'no-cache');
  assert.equal(gunzipSync(res.body).toString('utf8'), (await file('sw.js')).toString('utf8'));
});

test('a superseded Generation is kept on disk but leaves the Measurement Server', async () => {
  // CONTEXT.md: Generations are kept, not deleted. Kept must not quietly mean still served.
  await file('app.v1.min.js');
  const res = await request('/app.v1.min.js', { headers: gzip });
  assert.equal(res.status, 404);
  assert.equal(res.headers['cache-control'], 'no-cache');
});

test('images carry their real type, are not gzipped, and are Immutable Assets', async () => {
  const webp = await request('/images/hero-768.webp', { headers: gzip });
  assert.equal(webp.status, 200);
  assert.equal(webp.headers['content-type'], 'image/webp');
  assert.equal(webp.headers['content-encoding'], undefined);
  assert.equal(webp.headers['cache-control'], IMMUTABLE);
  assert.ok(webp.body.equals(await file('images/hero-768.webp')));

  const jpg = await request('/images/notebook-700.jpg', { headers: gzip });
  assert.equal(jpg.status, 200);
  assert.equal(jpg.headers['content-type'], 'image/jpeg');
  assert.equal(jpg.headers['content-encoding'], undefined);
  assert.equal(jpg.headers['cache-control'], IMMUTABLE);

  const ico = await request('/favicon.ico', { headers: gzip });
  assert.equal(ico.status, 200);
  assert.equal(ico.headers['content-type'], 'image/x-icon');
  assert.equal(ico.headers['content-encoding'], undefined);
  assert.equal(ico.headers['cache-control'], IMMUTABLE);
});

test('the manifest the page links is served as a manifest, gzipped, and revalidated like the document', async () => {
  assert.ok(page.manifest, 'the page links a manifest');
  const res = await request(pathOf(page.manifest), { headers: gzip });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/manifest+json');
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(res.headers['cache-control'], 'no-cache');
  assert.equal(gunzipSync(res.body).toString('utf8'), (await file(page.manifest)).toString('utf8'));
});

test('every icon and screenshot the manifest declares is public and immutable', async () => {
  // The OS install pipeline fetches these, not the page, so the page model cannot vouch for them.
  const manifest = JSON.parse(await file(page.manifest ?? 'manifest.webmanifest'));
  const entries = [...manifest.icons, ...manifest.screenshots];
  assert.ok(entries.length > 0);
  for (const { src } of entries) {
    const res = await request(pathOf(src), { headers: gzip });
    assert.equal(res.status, 200, `${src} must be served`);
    assert.equal(res.headers['content-type'], 'image/png', src);
    assert.equal(res.headers['content-encoding'], undefined, src);
    assert.equal(res.headers['cache-control'], IMMUTABLE, `${src} is an Immutable Asset`);
    assert.ok(res.body.equals(await file(src)), `${src} arrives byte for byte`);
  }
});

test('robots.txt and llms.txt are plain text and never cached', async () => {
  for (const path of ['/robots.txt', '/llms.txt']) {
    const res = await request(path, { headers: gzip });
    assert.equal(res.status, 200, path);
    assert.match(res.headers['content-type'], /^text\/plain/, path);
    assert.equal(res.headers['cache-control'], 'no-cache', path);
  }
});

test('a missing asset is a 404 that is never cached', async () => {
  const res = await request('/images/missing.jpg', { headers: gzip });
  assert.equal(res.status, 404);
  assert.equal(res.headers['cache-control'], 'no-cache');
  assert.ok(res.headers['content-length'], 'keep-alive needs a Content-Length even on a 404');
});

test('only the Storefront is public; the repository behind it is not', async () => {
  const [report] = (await readdir(new URL('reports/', root))).filter((name) => name.endsWith('.json'));
  assert.ok(report, 'expected at least one Report on disk to probe');
  const hidden = [
    '/images/',
    '/icons/',
    '/server.py',
    '/CLAUDE.md',
    '/tests/performance-contract.mjs',
    `/reports/${report}`,
    '/../CONTEXT.md',
    '/%2e%2e/CONTEXT.md',
  ];
  for (const path of hidden) {
    const res = await request(path, { headers: gzip });
    assert.equal(res.status, 404, `${path} must not be public`);
    assert.equal(res.headers['cache-control'], 'no-cache', `${path} 404 must not be cacheable`);
  }
});

test('HEAD carries the same headers as GET and no body', async () => {
  const get = await request('/', { headers: gzip });
  const head = await request('/', { method: 'HEAD', headers: gzip });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  for (const name of ['content-type', 'content-encoding', 'cache-control', 'content-length', 'vary']) {
    assert.equal(head.headers[name], get.headers[name], name);
  }
});

test('one keep-alive connection carries the page and its assets', async () => {
  const document = await request('/', { headers: gzip });
  const asset = await request(behaviour, { headers: gzip });
  for (const res of [document, asset]) {
    // A 404 keeps the connection open too, so the status is part of what "carries" means.
    assert.equal(res.status, 200);
    assert.equal(res.httpVersion, '1.1');
    assert.notEqual(res.headers.connection, 'close');
  }
  assert.equal(asset.reusedSocket, true, 'the second request must reuse the first connection');
});

test('every asset the Storefront references is public and immutable', async () => {
  // The allowlist and the page must agree: an asset the page names but the server hides is a 404
  // a Run would measure.
  assert.ok(page.assets.length >= 12);
  for (const asset of page.assets) {
    const res = await request(pathOf(asset), { headers: gzip });
    assert.equal(res.status, 200, `${asset} must be served`);
    assert.equal(res.headers['cache-control'], IMMUTABLE, `${asset} is an Immutable Asset`);
  }
});

test('gzip is applied only when the client asks for it', async () => {
  const res = await request('/');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-encoding'], undefined);
  assert.equal(res.body.toString('utf8'), (await file('index.html')).toString('utf8'));
});
