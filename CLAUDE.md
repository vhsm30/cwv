# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A Core Web Vitals lab disguised as a storefront. `index.html` renders "Field Notes Supply" — a
dependency-free, client-only demo shop with no checkout — but the point of the repo is the
measure → optimize → lock-in loop around it: serve the page locally, expose it over ngrok, run
Lighthouse against the public URL, and encode each win as an assertion so it cannot silently regress.

No package manager, no build step, no framework. Everything shipped is hand-written and hand-minified.

## Commands

```bash
python server.py 8000                              # serve at http://localhost:8000/
./start-ngrok.ps1 -Domain <ngrok-domain>           # PowerShell: starts server.py + ngrok (omit -Domain for a temp URL)
node --test tests/performance-contract.mjs         # run the performance contract
node --test --test-name-pattern="lazy" tests/performance-contract.mjs   # run one test
```

`node --test tests/` fails — the filename does not match Node's default test glob. Pass the file
path (or `"tests/**/*.mjs"`).

Lighthouse 13.x is installed globally. Existing reports in `reports/` were captured through the
DevTools channel (`chrome-devtools` MCP `lighthouse_audit`) against the ngrok URL, mobile form
factor, simulated throttling, categories `performance, accessibility, best-practices, seo,
agentic-browsing`. Measure the ngrok URL, not `localhost` — the throttling model only makes sense
over a real network hop.

## Architecture

**`server.py` is part of the optimization, not scaffolding.** It subclasses
`SimpleHTTPRequestHandler` to add HTTP/1.1 keep-alive, gzip for text types, and
`Cache-Control: immutable, max-age=1y` for asset suffixes (`.css .js .jpg .png .webp .ico .woff2`)
while HTML gets `no-cache`. Page results measured under any other server will not reproduce.

**Versioned asset filenames are the cache-busting mechanism.** Because assets are served
`immutable`, the filename *is* the cache key, so each experiment ships a new generation rather than
editing in place, and older generations are kept:

- `styles.min.css` → `styles.v1.min.css` — single stylesheet (all three files are byte-identical)
- `styles.v2-critical.min.css` + `styles.v2-content.min.css` — above/below-the-fold split, content
  half loaded via `rel=preload` + `onload` swap
- `styles.v3-critical.min.css` + `styles.v3-content.min.css` — current generation; critical holds
  the full sheet again and content is empty, i.e. the split has been rolled back while the two-link
  structure stays in `index.html`
- `app.min.js` → `app.v1.min.js` — the bag counter, ~300 bytes, `defer`red

When bumping a generation, update `index.html` **and** `tests/performance-contract.mjs` — the test
hardcodes the current filenames.

**`tests/performance-contract.mjs` is a regression contract, not a unit test suite.** It reads
`index.html` and the current CSS as text and regex-asserts the properties Lighthouse rewards: the
hero `<img>` keeps its 640/768/1200 `srcset`, `sizes`, intrinsic `width`/`height`, `fetchpriority=high`
and no `loading=lazy`; all three product images stay lazy and sized; no inline `<style>`/`<script>`;
images self-hosted (never Unsplash hotlinks); the `--accent` value stays at the contrast-passing
`#8d3f2b`. Markup edits that break these fail the suite — fix the markup, or change the assertion
deliberately when the contract itself is what's changing.

**`reports/` is the measurement history**, named `<ngrok-domain>-<UTC timestamp>.json`. Each file is
~500 KB — never `cat` one. Extract with `node -e "const r=require('./reports/<file>'); ..."` and read
`r.categories.*.score` plus `r.audits['largest-contentful-paint' | 'cumulative-layout-shift' |
'total-blocking-time' | 'layout-shifts' | 'cls-culprits-insight']`.

As of the newest report (`...20260821T134307`), performance sits at **76**, down from a run of 100s:
CLS 0.795 attributed to `body` and TBT ~100 ms, introduced when the content stylesheet started
loading asynchronously. That regression is the open thread; accessibility, best-practices, and SEO are 100.

## Change guidelines

- Keep the site framework-free and dependency-free unless a migration is explicitly requested.
- Keep `index.html`, `llms.txt`, and `robots.txt` consistent whenever the title, description, routes,
  or visible content change.
- Preserve the `google-site-verification` meta tag unless asked to replace or remove it.
- Do not touch `start-ngrok.ps1` for page or content changes — only when the preview workflow itself
  needs to change.
- `AGENTS.md` carries an overlapping (and now partly stale) version of these rules; it still claims
  there is no automated test suite.
