# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A Core Web Vitals lab disguised as a storefront. `index.html` renders "Field Notes Supply" — a
dependency-free, client-only Storefront with no checkout — but the point of the repo is the
measure → optimize → lock-in loop around it: serve the page locally, expose it through a Cloudflare
quick tunnel, perform a Run against the Preview URL, and encode each Win as an assertion so it
cannot silently regress.

No package manager, no build step, no framework. Everything shipped is hand-written and hand-minified.

`CONTEXT.md` defines this project's vocabulary (Run, Report, Preview URL, Win, Lock-in,
Performance Contract, Generation, Slot, Rung, Master, ...). Use those terms and honour the words it
says to avoid.

## Commands

```bash
python server.py 8000                              # the Measurement Server at http://localhost:8000/ (0 = ephemeral port)
./start-cloudflare.ps1                             # PowerShell: starts server.py + a Cloudflare quick tunnel (the Preview URL)
./start-ngrok.ps1 -Domain <ngrok-domain>           # PowerShell: the ngrok alternative (omit -Domain for a temp URL)
node tools/run.mjs https://<name>.trycloudflare.com/   # perform a Run, save the Report, print the summary
node --test "tests/**/*.mjs"                       # every assertion: Performance Contract, Measurement Server, Run
node --test tests/performance-contract.mjs         # the Performance Contract alone (page + images)
node --test tests/measurement-server.mjs           # the Measurement Server alone (spawns python server.py 0)
node --test tests/run.mjs                          # the Run alone (recorded Reports, no tunnel or Chrome)
node --test --test-name-pattern="lazy" tests/performance-contract.mjs   # one assertion
node tools/mutate-contract.mjs                     # prove the contract can still fail (34 mutations of the page, the manifest, the Worker)
python tools/build-images.py                       # rebuild every Rung from the Masters per images/slots.json
python tools/build-icons.py                        # rebuild every icon and screenshot in icons/ from manifest.webmanifest
```

`node --test tests/` fails — the filenames do not match Node's default test glob. Quote the glob
above, or pass a file path. `lib/` holds the modules the assertions and the Run share; it is not a
test directory.

### Measuring

How to warm the Preview URL, perform a Run, and read its Report (Cloudflare/ngrok gotchas, timing
figures, known artifacts) lives in the `measuring-runs` skill — load it before starting a tunnel or
running `node tools/run.mjs`.

## Architecture

**`server.py` is part of the optimization, not scaffolding.** It is the Measurement Server: a
`POLICY` table (suffix → content type, gzip: facts about the bytes), a `PUBLIC` table (path → file,
cache: facts about the URL — `/`, the behaviour's current Generation, the favicon, `robots.txt`,
`llms.txt`, `manifest.webmanifest`, `sw.js`) and a `DIRECTORIES` table (`/images/*.{webp,jpg}`,
`/icons/*.png`). Immutable Assets are served with `max-age=1y, immutable`; the document, the crawler
files, the manifest and `sw.js` are `no-cache` — `sw.js` on purpose: a Worker registration is
identified by its URL, so a Generation-stamped Worker would be a second registration, not a
replacement, and it is the one script whose filename is deliberately not a cache key. 404s are never
cacheable; a superseded Generation (`app.v1.min.js`) stays on disk and is a 404; nothing else in the
repository is reachable; a public path with no `POLICY` row exits at boot rather than answering 500
mid-Run. `tests/measurement-server.mjs` asserts all of it over HTTP against the real
`python server.py 0`, including that every asset the page references and every icon the manifest
declares is served. Results measured under any other server will not reproduce.

**The critical path is one request.** `index.html` carries the whole stylesheet in an inline
`<style>`, so nothing render-blocking sits between the document and first paint. That `<style>` block
is the single source of truth for CSS. The superseded stylesheet Generations (`styles.min.css`,
`styles.v1/v2/v3*`) and `app.min.js` were deleted once the CSS moved inline; recover them from the
initial commit if a Generation needs to be revisited. `app.v2.min.js` is the live behaviour, external
and `defer`red: the Bag, the Notice, and the Worker's registration. `app.v1.min.js` is kept on disk
and unserved, following CONTEXT.md's rule that Generations are kept — which the deletion recorded
above contradicts; BACKLOG.md D24 holds that contradiction rather than this paragraph resolving it.

**`images/slots.json` is the one home of every image fact.** Each Slot (the Hero image and the three
Product images) is described once — Master, ratio, widths, `sizes`, and the CSS box it renders into —
with three consumers: `tools/build-images.py` builds every Rung from it (`<slot>-<width>.{webp,jpg}`,
both formats, byte-identically on every rebuild, refusing any width the Master cannot honestly
supply); the Performance Contract verifies the markup *and* the files on disk against it (candidates,
`sizes`, real pixels via `lib/image-size.mjs`, orphans in `images/`); this paragraph points at it.
Masters (`hero.jpg`, `notebook.jpg`, `mug.jpg`, `coffee.jpg`) are never requested by the page, but
deleting one makes its Rungs unrebuildable — the contract notices. Products are centre-cropped to
`.product-image`'s 4:5 so `object-fit: cover` discards nothing.

**`manifest.webmanifest` is the one home of every icon fact**, as `images/slots.json` is for
images: each icon and screenshot (src, sizes, purpose, form factor) and the two colours, with three
consumers — `tools/build-icons.py` draws every file in `icons/` from it as pure geometry (byte-identical
rebuilds, Generation-stamped names so `immutable` is honest), the Performance Contract verifies
`icons/` and each file's real pixels against it, and the browser reads it. There is no `icons.json`:
a manifest is already a data file, and a second table would only need an agreement assertion.

**The Worker is a non-regression, not a Win.** Lighthouse 13 has no PWA category, so no Run can
reward `sw.js`, the manifest, or the Notice; only the Performance Contract holds them. A Run clears
storage first, so the Worker installs fresh on every Run and never serves one, and `lib/report.mjs`
refuses any Report that kept storage or did not clear `service_workers` and `cache_storage` — a
Worker-served document would record a fake LCP with nothing able to tell. The Shell is three URLs
(`./`, the behaviour, the favicon) and never a Rung: three of the Rungs the page offers are never
fetched at the Run's viewport, so images are kept as they are seen, and a returning (controlled)
page asks the Worker to top up the rest — a first-time visitor genuinely is not a returning one, and
a Run is always a first visit. `sw.js` takes no page mid-Run (no `clients.claim()`; `skipWaiting()`
only in the message handler, where the Notice asks for it on the visitor's behalf); its cache is
named for the Generation of the behaviour it keeps, and `lib/service-worker.mjs` is its one parser.
The Notice ships `hidden` with `[hidden]{display:none!important}` and `position:fixed`, so no Run
sees it and revealing it shifts nothing. A Report shows nothing of the Worker: the registration and
the Shell's fetches happen in the Worker's own context, which the Report does not record — what it
does record is the manifest and the one icon Chrome fetches after reading it.

`picture{display:contents}` is load-bearing: without it the `<picture>` becomes the grid/flex item
instead of the `<img>`, and every `.hero-image`/`.product-image` rule stops applying. It must be paired
with `picture>source{display:none}`, because `display:contents` promotes **both** children — an
unhidden `<source>` becomes a second grid item, takes the Hero image's column, and pushes the image
onto its own row. Mobile hides that damage (`.hero` is `column-reverse` there, where a zero-size item
costs nothing), so it only shows on desktop. Measuring the img's box will not catch it either: the
size and ratio come out correct while the placement is wrong. Screenshot desktop after touching
`.hero`.

**The `height` attribute beats CSS `aspect-ratio`.** An `<img>` with `height="875"` gets an 875px box
no matter what `aspect-ratio` says, unless the rule also sets `height:auto`. This silently stretched
every Product to 875px tall for a long time while `aspect-ratio:4/5` sat there as dead code. Any
image box that declares `aspect-ratio` or `height` must resolve to `height:auto` in every `@media`
context; the contract cascades each Slot's box per context and checks.

The trap has a second form worth knowing before it costs a score: a UA-stylesheet default loses to
any author rule that sets the same property. `[hidden]{display:none}` is the UA's, so an element that
ships with `hidden` but carries an author `display` renders anyway — the attribute reads as if it
guarantees something it does not. Pair `hidden` with `[hidden]{display:none!important}`, and make the
assertion the cascade check across every context, never the presence of the attribute.

Declared `width`/`height` must match the file's real pixels (they were all wrong at one point, which
reserved the wrong box on desktop where no CSS `aspect-ratio` applies). The contract reads the pixels
from the JPEG/WebP headers, so a rebuilt image with stale markup fails.

**`tests/performance-contract.mjs` is a regression contract, not a unit test suite.** It reads one
model of the page — `lib/page.mjs`, which parses `index.html` once into start tags (any attribute order
or quote style), `<picture>`/`<section>` spans, the assets the browser fetches, and the inline
stylesheet cascaded per selector per `@media` context with `var()` resolved — and asserts the
properties Lighthouse rewards: single-request critical path, LCP preload identical to the `<source>`
the browser will pick (a drifted preload downloads the Hero twice), WebP + JPEG pairing, every Slot's
Rungs on disk, computed text contrast, self-hosting as a rule, Product images lazy/sized/
`fetchpriority=low`, no inline script, and `llms.txt`/`robots.txt`/the verification tag agreeing with
the page. The PWA added its own: the manifest agreeing with the page (name, description, `lang`, the
page's own ink and paper as colours, shortcuts equal to the in-page routes, no CONTEXT.md avoid-word
where a visitor reads it), every icon and screenshot on disk with its declared pixels and within
Chrome's rules, the head capable without the deprecated Apple tag, the Notice hidden by an
`!important` rule in every context and out of flow, and the Worker's Shell, cache Generation and
restraint read through `lib/service-worker.mjs`. Markup edits that break these fail the suite — fix
the markup, or change the assertion deliberately when the contract itself is what's changing.

When adding assertions, do not build regexes from strings: a `` `\b${name}` `` in a template literal
is a backspace character, not a word boundary, and it made every attribute lookup silently return
`undefined` while the suite still reported green. Read facts through the page model or from disk
rather than as literals, and mutation-check new assertions by breaking the thing they guard: add a
row to `tools/mutate-contract.mjs`, which mutates `index.html`, `manifest.webmanifest` and `sw.js`
thirty-four ways (restoring each after) and expects thirty to fail the contract and four harmless
ones to pass. Apply that test while designing
an assertion, not only after writing it: an assertion that restates markup you are about to write
cannot fail, and it is easiest to propose one in the same breath as the feature it is meant to guard.

**`reports/` holds the Reports**, named `<host>-<UTC fetchTime>Z.json` by the Run itself. See the
`measuring-runs` skill for how to read one back.

Current state (Run of 2026-09-02T18:36:43Z through a warm Cloudflare quick tunnel, the first of the
PWA): performance 100 / accessibility 100 / best-practices 100 / SEO 100, FCP = LCP = 911 ms, TBT 0,
CLS 0, 9 requests, 43.7 KB transferred; WebP arrives as `image/webp`, the script and the manifest
gzipped, no robots-txt artifact, and `deprecations`, `inspector-issues` and `errors-in-console` all
empty. Of the 911 ms, 133 ms is time to first byte, then 10 ms load delay, 83 ms load duration and
41 ms render delay (`lcp-breakdown-insight`). The last Run before the PWA (2026-08-25T12:41:32Z,
same kind of tunnel) read 946 ms with TTFB 174 ms and the same page share (10 / 88 / 48) over 7
requests and 32.3 KB; the two requests the PWA adds are `manifest.webmanifest` (594 B) and
`icon-v1-180.png` (10.1 KB), and the unchanged page share says neither sits on the LCP's path. A
Run twelve minutes earlier through another tunnel (2026-09-02T18:24:24Z) read LCP 1114 ms with that
same page share: Lantern's `network-server-latency` estimate for it was 267 ms against the usual
60–90 ms, so the difference was the tunnel's. The last ngrok Run (2026-08-21T17:26:57Z) read TTFB
105 ms and FCP 894 / LCP 936 ms — the same page share; the bytes differ (response headers ~70 B apart
per request, and Cloudflare gzips the favicon). Compare Runs taken through the same tunnel only, and
read the page's own share of LCP — load delay, load duration, render delay — which is what a Win
moves.

## Change guidelines

- Keep the site framework-free and dependency-free unless a migration is explicitly requested.
- Image facts change in `images/slots.json` first; then rebuild with `tools/build-images.py` and
  update the markup until the contract is green. Icon facts change in `manifest.webmanifest` first;
  then rebuild with `tools/build-icons.py`.
- A new Generation of the behaviour is a new filename: the `<script src>`, the `PUBLIC` row, the
  `SHELL` entry and the cache name in `sw.js` move together (the contract ties the last two to the
  first), and the superseded file stays on disk, unserved, asserted 404. `sw.js` itself is never
  renamed.
- Keep `index.html`, `llms.txt`, and `robots.txt` consistent whenever the title, description, routes,
  or visible content change — the contract asserts the title, description, and in-page routes.
- Preserve the `google-site-verification` meta tag unless asked to replace or remove it (asserted).
- Do not touch `start-cloudflare.ps1` or `start-ngrok.ps1` for page or content changes — only when
  the preview workflow itself needs to change.
- What the page costs is read from a Report, never reasoned about. `network-requests` names every
  request and its transfer size; argue the cost from the markup instead and you will be wrong, since
  three of the Rungs the page offers are never fetched at the Run's viewport.
- Before changing the page, ask what the change does to *measuring* it, not only to the page itself.
  Anything touching storage, caching, or the network can invalidate a Report rather than merely cost
  bytes — and a Report that is wrong is worse than one that is slow.
- Give a decision the reason CONTEXT.md gives it. A generic web-performance rationale the repo's own
  vocabulary contradicts is worse than none: Preview URLs are random per session, so no client can
  hold a stale asset for the current host, and "caches would go stale" argues nothing here.
- A review or exploration that surfaces several findings records them in `BACKLOG.md` (status Open,
  `file:line` evidence, CONTEXT.md vocabulary) and stops there; planning starts from that list when
  an item is picked, so acting on a finding straight away pre-empts it. `/improve` is the exception:
  config changes approved during a run are applied during the run.
- Commits go on `main` — the history is linear and single-author, and no feature branch is wanted
  unless asked for. Commit only when asked.
