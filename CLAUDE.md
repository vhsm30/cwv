# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A Core Web Vitals lab disguised as a storefront. `index.html` renders "Field Notes Supply" — a
dependency-free, client-only Storefront with no checkout — but the point of the repo is the
measure → optimize → lock-in loop around it: serve the page locally, expose it over ngrok, perform a
Run against the Preview URL, and encode each Win as an assertion so it cannot silently regress.

No package manager, no build step, no framework. Everything shipped is hand-written and hand-minified.

`CONTEXT.md` defines this project's vocabulary (Run, Report, Preview URL, Win, Lock-in,
Performance Contract, Generation, Slot, Rung, Master, ...). Use those terms and honour the words it
says to avoid.

## Commands

```bash
python server.py 8000                              # the Measurement Server at http://localhost:8000/ (0 = ephemeral port)
./start-ngrok.ps1 -Domain <ngrok-domain>           # PowerShell: starts server.py + ngrok (omit -Domain for a temp URL)
node tools/run.mjs https://<domain>.ngrok-free.dev/   # perform a Run, save the Report, print the summary
node --test "tests/**/*.mjs"                       # every assertion: Performance Contract, Measurement Server, Run
node --test tests/performance-contract.mjs         # the Performance Contract alone (page + images)
node --test tests/measurement-server.mjs           # the Measurement Server alone (spawns python server.py 0)
node --test tests/run.mjs                          # the Run alone (recorded Reports, no ngrok or Chrome)
node --test --test-name-pattern="lazy" tests/performance-contract.mjs   # one assertion
node tools/mutate-contract.mjs                     # prove the contract can still fail (16 mutations of index.html)
python tools/build-images.py                       # rebuild every Rung from the Masters per images/slots.json
```

`node --test tests/` fails — the filenames do not match Node's default test glob. Quote the glob
above, or pass a file path. `lib/` holds the modules the assertions and the Run share; it is not a
test directory.

### Measuring

Free-tier ngrok serves an interstitial to browser user-agents, so a naive Lighthouse run measures
ngrok's error page and reports plausible-looking garbage. `node tools/run.mjs <preview-url>` is the
Run: it passes the bypass header, refuses a Report that is not a real Run (interstitial requests,
wrong host, localhost, desktop form factor, redirects), names the Report by its own UTC `fetchTime`,
writes it under `reports/`, and prints the summary. The known artifacts live in `lib/report.mjs`, not
in anyone's head:

- The bypass header does **not** reach Lighthouse's separate robots.txt fetch, so `robots-txt`
  scores 0 over the tunnel and SEO reads 92. The summary names it and prints SEO without it (100).
  `robots.txt` itself is valid — the Performance Contract asserts it.
- A trailing `EPERM ... chrome-launcher` exit on Windows happens after the Report is written; the Run
  keeps the Report and ignores the exit code.

Reports captured through the chrome-devtools MCP (`channel: devtools`, the first nine) carry an extra
`agentic-browsing` category; newer ones are `channel: cli`. Throttling is identical (mobile, simulated,
412×823 @1.75), so metrics are comparable. At that emulation the Run fetches `hero-768.webp` as the
LCP image.

## Architecture

**`server.py` is part of the optimization, not scaffolding.** It is the Measurement Server: one
`POLICY` table (suffix → content type, gzip, cache) and one public allowlist (`/`, the script, the
favicon, `robots.txt`, `llms.txt`, `images/*.{webp,jpg}`). Immutable Assets are served with
`max-age=1y, immutable`; the document and the crawler files are `no-cache`; 404s are never cacheable;
nothing else in the repository is reachable. `tests/measurement-server.mjs` asserts all of it over
HTTP against the real `python server.py 0`, including that every asset the page references is
served. Results measured under any other server will not reproduce.

**The critical path is one request.** `index.html` carries the whole stylesheet in an inline
`<style>`, so nothing render-blocking sits between the document and first paint. That `<style>` block
is the single source of truth for CSS. The superseded stylesheet Generations (`styles.min.css`,
`styles.v1/v2/v3*`) and `app.min.js` were deleted once the CSS moved inline; recover them from the
initial commit if a Generation needs to be revisited. `app.v1.min.js` is the live behaviour, external
and `defer`red.

**`images/slots.json` is the one home of every image fact.** Each Slot (the Hero image and the three
Product images) is described once — Master, ratio, widths, `sizes`, and the CSS box it renders into —
with three consumers: `tools/build-images.py` builds every Rung from it (`<slot>-<width>.{webp,jpg}`,
both formats, byte-identically on every rebuild, refusing any width the Master cannot honestly
supply); the Performance Contract verifies the markup *and* the files on disk against it (candidates,
`sizes`, real pixels via `lib/image-size.mjs`, orphans in `images/`); this paragraph points at it.
Masters (`hero.jpg`, `notebook.jpg`, `mug.jpg`, `coffee.jpg`) are never requested by the page, but
deleting one makes its Rungs unrebuildable — the contract notices. Products are centre-cropped to
`.product-image`'s 4:5 so `object-fit: cover` discards nothing.

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
the page. Markup edits that break these fail the suite — fix the markup, or change the assertion
deliberately when the contract itself is what's changing.

When adding assertions, do not build regexes from strings: a `` `\b${name}` `` in a template literal
is a backspace character, not a word boundary, and it made every attribute lookup silently return
`undefined` while the suite still reported green. Read facts through the page model or from disk
rather than as literals, and mutation-check new assertions by breaking the thing they guard: add a
row to `tools/mutate-contract.mjs`, which mutates `index.html` sixteen ways (restoring it after) and
expects fourteen to fail the contract and two harmless ones to pass.

**`reports/` holds the Reports**, named `<host>-<UTC fetchTime>Z.json` by the Run itself. Each file
is ~500 KB — never `cat` one. `node tools/run.mjs reports/<file>.json` prints the summary of a
recorded Report (scores, metrics, requests, bytes, known artifacts) without measuring anything; for
anything deeper, `lib/report.mjs` exports `readReport`/`summarize`, and the raw keys worth reading
are `categories.*.score` and `audits[...]` — `network-requests`, `lcp-breakdown-insight`,
`render-blocking-insight`, `network-dependency-tree-insight`, `image-delivery-insight`,
`layout-shifts`, `cls-culprits-insight`.

Current state (last Run, 2026-08-21T17:26:57Z, before the Measurement Server and Hero-rung changes
of 2026-08-24): performance 100 / accessibility 100 / best-practices 100 / SEO 92 (100 net of the
robots-txt artifact), FCP 894 ms, LCP 936 ms, TBT 0, CLS 0, 7 requests, 35.9 KB transferred. The
next Run should hold or improve on it: WebP now arrives as `image/webp` and the script gzipped.

## Change guidelines

- Keep the site framework-free and dependency-free unless a migration is explicitly requested.
- Image facts change in `images/slots.json` first; then rebuild with `tools/build-images.py` and
  update the markup until the contract is green.
- Keep `index.html`, `llms.txt`, and `robots.txt` consistent whenever the title, description, routes,
  or visible content change — the contract asserts the title, description, and in-page routes.
- Preserve the `google-site-verification` meta tag unless asked to replace or remove it (asserted).
- Do not touch `start-ngrok.ps1` for page or content changes — only when the preview workflow itself
  needs to change.
