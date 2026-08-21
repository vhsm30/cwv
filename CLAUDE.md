# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A Core Web Vitals lab disguised as a storefront. `index.html` renders "Field Notes Supply" — a
dependency-free, client-only demo shop with no checkout — but the point of the repo is the
measure → optimize → lock-in loop around it: serve the page locally, expose it over ngrok, run
Lighthouse against the public URL, and encode each win as an assertion so it cannot silently regress.

No package manager, no build step, no framework. Everything shipped is hand-written and hand-minified.

`CONTEXT.md` defines this project's vocabulary (Run, Report, Preview URL, Win, Lock-in,
Performance Contract, Generation, ...). Use those terms and honour the words it says to avoid.

## Commands

```bash
python server.py 8000                              # serve at http://localhost:8000/
./start-ngrok.ps1 -Domain <ngrok-domain>           # PowerShell: starts server.py + ngrok (omit -Domain for a temp URL)
node --test tests/performance-contract.mjs         # run the Performance Contract (12 assertions)
python tools/build-images.py                       # rebuild derived images from the masters
node --test --test-name-pattern="lazy" tests/performance-contract.mjs   # run one test
```

`node --test tests/` fails — the filename does not match Node's default test glob. Pass the file
path (or `"tests/**/*.mjs"`).

### Measuring

Lighthouse 13.x is installed globally. **Free-tier ngrok serves an interstitial to browser
user-agents**, so a naive run audits ngrok's error page, not this site — it reports plausible-looking
garbage (SEO 54, FCP 4 s, 700 KB of ngrok web fonts). Always pass the bypass header:

```bash
lighthouse https://<domain>.ngrok-free.dev/ --output=json --output-path=reports/<domain>-$(date +%Y%m%dT%H%M%S).json \
  --form-factor=mobile --screenEmulation.mobile \
  --extra-headers='{"ngrok-skip-browser-warning":"true"}' \
  --only-categories=performance,accessibility,best-practices,seo \
  --chrome-flags="--headless=new --no-sandbox" --quiet
```

Then confirm the run is real by checking `network-requests` contains this site's assets and no
`cdn.ngrok.com` entries. Two caveats:

- The header does **not** reach Lighthouse's separate robots.txt fetch, so `robots-txt` always fails
  over the tunnel with ngrok's interstitial text as the "errors". It is an artifact — `robots.txt` is
  valid. Audit `http://localhost:8000/` to confirm (that run scores 100 across all four categories).
- A trailing `EPERM ... chrome-launcher` error is Chrome temp-dir cleanup on Windows and happens
  *after* the report is written. Harmless.

Older reports in `reports/` have `channel: devtools` (captured via the chrome-devtools MCP
`lighthouse_audit`, which does not cover performance); newer ones are `channel: cli`. Throttling is
identical, so metrics are comparable.

## Architecture

**`server.py` is part of the optimization, not scaffolding.** It subclasses
`SimpleHTTPRequestHandler` to add HTTP/1.1 keep-alive, gzip for text types, and
`Cache-Control: immutable, max-age=1y` for asset suffixes while HTML gets `no-cache`. Results
measured under any other server will not reproduce.

**The critical path is one request.** `index.html` carries the whole stylesheet in an inline
`<style>`, so nothing render-blocking sits between the document and first paint. That `<style>` block
is the single source of truth for CSS. The superseded stylesheet Generations (`styles.min.css`,
`styles.v1/v2/v3*`) and `app.min.js` were deleted once the CSS moved inline; recover them from the
initial commit if a Generation needs to be revisited. `app.v1.min.js` is the live behaviour, external
and `defer`red.

**Images are pre-cropped to the box the CSS actually renders**, so `object-fit: cover` discards
nothing. Products are centre-cropped to 4:5 (matching `.product-image`'s `aspect-ratio`) and offered
as WebP with a JPEG fallback via `<picture>`; candidate widths stop at what the source can honestly
supply (mug/coffee max out at 374px because their originals are 700×467 landscape). Generated with
Pillow via `python tools/build-images.py`, which rebuilds every derived file byte-identically from
the masters. `hero.jpg`, `notebook.jpg`, `mug.jpg` and `coffee.jpg` are those masters: the page
never requests them, but deleting them makes the derived set unrebuildable.

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
every product card to 875px tall for a long time while `aspect-ratio:4/5` sat there as dead code.
Any image rule that declares `aspect-ratio` must also declare `height:auto`; the contract enforces it.

Declared `width`/`height` must match the file's real pixels. They were all wrong at one point (hero
declared 1200×900 for a 1200×803 image; mug and coffee declared 700×875 for 700×467 files), which
reserved the wrong box on desktop where no CSS `aspect-ratio` applies.

**`tests/performance-contract.mjs` is a regression contract, not a unit test suite.** It parses
`index.html` as text and asserts the properties Lighthouse rewards: single-request critical path,
LCP image preloaded on terms identical to the `<source>` the browser will pick (a drifted preload
downloads the hero twice), WebP + JPEG pairing, declared ratios matching the CSS box, product images
lazy/sized/`fetchpriority=low`, no inline script. Markup edits that break these fail the suite — fix
the markup, or change the assertion deliberately when the contract itself is what's changing.

When adding assertions, do not build regexes from strings: a `` `\b${name}` `` in a template literal
is a backspace character, not a word boundary, and it made every attribute lookup silently return
`undefined` while the suite still reported green. Prefer literal regexes or `indexOf`/`slice`, and
mutation-check new assertions by breaking the thing they guard.

**`reports/` holds the Reports**. CONTEXT.md specifies naming by the UTC moment of capture, but every
file on disk is stamped in local time (`...T135410` for a 16:54:10Z capture) — confirm which is wanted
before adding more. Each
file is ~500 KB — never `cat` one. Extract with `node -e "const r=require('./reports/<file>'); ..."`
and read `r.categories.*.score` plus `r.audits[...]`; useful keys are `network-requests`,
`lcp-breakdown-insight`, `render-blocking-insight`, `network-dependency-tree-insight`,
`image-delivery-insight`, `layout-shifts`, `cls-culprits-insight`.

Current state: 100 performance / accessibility / best-practices / SEO, FCP = LCP = 880 ms, TBT 0,
CLS 0, 7 requests, ~36 KB transferred.

## Change guidelines

- Keep the site framework-free and dependency-free unless a migration is explicitly requested.
- Keep `index.html`, `llms.txt`, and `robots.txt` consistent whenever the title, description, routes,
  or visible content change.
- Preserve the `google-site-verification` meta tag unless asked to replace or remove it.
- Do not touch `start-ngrok.ps1` for page or content changes — only when the preview workflow itself
  needs to change.
