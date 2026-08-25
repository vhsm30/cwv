# Backlog

Findings from the architecture review of 2026-08-24, recorded before any of them was acted on.
Domain words come from `CONTEXT.md`; architecture words (module, interface, seam, adapter, depth,
leverage, locality) from `.claude/skills/codebase-design/SKILL.md`.

**Status as of 2026-08-25: every candidate and every defect of the 2026-08-24 review is Done**
(commit `12d49b7`; the plan that closed them is `docs/superpowers/plans/2026-08-24-backlog-b1-b4.md`).
Two items found on 2026-08-25, while the Preview URL moved to Cloudflare, are open under "Found on
2026-08-25". Each item below keeps its original Problem / Evidence / Shape and gains a **Status**
line saying what was built and where. Every assertion runs under `node --test "tests/**/*.mjs"`
(48 assertions, all green).

Evidence was gathered by mutating a scratch copy of `index.html` 16 ways against the Performance
Contract, probing `server.py` live on a spare port, rebuilding `images/` from the masters in a
scratch directory, and reading the 14 Reports. The repository was not modified by the review.

## Deepening candidates

| # | Candidate | Strength | Dependency category | Status |
|---|---|---|---|---|
| B1 | Deepen the Performance Contract's view of the page | Strong | in-process | **Done** |
| B2 | Give each image slot one home | Strong | in-process · stands on B1 | **Done** |
| B3 | Encode the Run | Worth exploring | mock (Lighthouse CLI, ngrok) | **Done** |
| B4 | Lock in the Measurement Server | Worth exploring | local-substitutable | **Done** |

### B1 · Deepen the Performance Contract's view of the page

**Status. Done.** `lib/page.mjs` is the one parser: start tags in any attribute order or quote
style, `<picture>`/`<section>` spans, the assets the browser fetches, and the inline stylesheet
cascaded per selector across every `@media` context with `var()` resolved; `lib/image-size.mjs`
reads JPEG/WebP pixels from the file headers. `tests/performance-contract.mjs` was rewritten on
that model — 21 assertions, no literal standing in for a fact on disk. The same 16 mutations now
come out: M1–M6 and M9–M16 caught, M7 and M8 (harmless) pass; the table is encoded in
`tools/mutate-contract.mjs` so it can be re-run. D8 and D9 absorbed: `llms.txt` was
brought back in line with the page and is asserted (site name, description, in-page routes), as are
the verification tag and `robots.txt`.

**Files.** `tests/performance-contract.mjs:8–26` (four parsers), `:14` (attribute order), `:23`
(double quotes only), `:18` (first rule per selector), `:29`, `:46`, `:50`, `:76`, `:80` (literals
standing in for facts); `CLAUDE.md:104–107`.

**Problem.** The contract's interface is the byte-shape of `index.html` — attribute order, quote
style, first-rule-wins, literal pixel counts — so 6 of 16 mutations that its assertion names promise
to catch pass green, and 2 harmless edits fail.

**Evidence.** Baseline 12/12 green. Mutations of a scratch copy:

| Mutation | Outcome before | Outcome after |
|---|---|---|
| M1 preload `imagesrcset` drifts from the `<source>` | caught | caught |
| M2 `height:auto` dropped from `.product-image` | caught | caught |
| M3 product `height` 875 → 900 | caught | caught |
| M4 `fetchpriority="low"` removed | caught | caught |
| M5 `.eyebrow` stops using `--accent` | **passes** — `:80` greps the hex literal only | caught (contrast computed: 3.95:1) |
| M6 hero `src` → `https://cdn.example.com/…` | **passes** — `:76` bans `unsplash.com` only | caught (any other origin) |
| M7 harmless: `as=` before `rel=` on the preload | **fails** — `:14` demands attribute order | passes |
| M8 harmless: single-quoted `fetchpriority` | **fails** — `:23` parses double quotes only | passes |
| M9 hero gains `loading="lazy"` | caught | caught |
| M10 mobile `.hero-image` gains `height:300px` | **passes** — `:18` reads the first rule only; `CLAUDE.md:91` claims otherwise | caught (cascade per context) |
| M11 `<source sizes>` ≠ `<img sizes>` | caught | caught |
| M12 / M13 `srcset` names a missing `.jpg` / `.webp` | caught — `:69` `stat`, the contract's only contact with disk | caught (pixels read from disk) |
| M14 hero rebuilt at 1200×800, markup still says 803 | **passes** — `:46` compares to the constant `1200/803` | caught (compared to the file) |
| M15 `google-site-verification` removed | passes — guideline only (`CLAUDE.md:125`) | caught |
| M16 `<title>` changed, `llms.txt` untouched | passes — guideline only (`CLAUDE.md:123`) | caught |

**Shape (not an interface yet).** Parse the page once into one model every assertion reads from:
attributes in any order or quote, every rule for a selector (`@media` included), real pixel sizes
read from the JPEG/WebP files themselves, the LCP preload compared to the `<source>` as parsed
values, "self-hosted" as a rule rather than a hostname. Delete the literals.

**Wins.** 6 vacuous assertions become real · 2 false negatives disappear · locality: one parser,
12 assertions · declared pixels verified against disk · absorbs the title ↔ `llms.txt` rule ·
interface shrinks to "the page".

**Deletion test.** Delete the four parsers and every assertion regrows its own regex → concentrates.

### B2 · Give each image slot one home

**Status. Done.** `images/slots.json` describes each Slot once — Master, ratio, widths, `sizes`, the
CSS box, an optional WebP quality. `tools/build-images.py` builds every Rung from it (Hero JPEG
Rungs included, refuses a width the Master cannot honestly supply, rebuilds byte-identically), and
the contract verifies both the markup and the files on disk against it: candidates, `sizes` and its
breakpoint against the stylesheet's own `@media`, every Rung's pixels against the crop arithmetic,
the Master's existence and width, the box's `aspect-ratio`, and that `images/` holds nothing but
Masters and Rungs. Rung names are uniform (`<slot>-<width>.<ext>`): `hero.webp` became
`hero-1200.webp` by `git mv` (identical bytes), `hero-1200.jpg` is new, and the orphan
`hero-640.jpg`/`hero-768.jpg` were rebuilt by their new owner (640×428 now matches the WebP). D6 and
D10 absorbed. `CONTEXT.md` gained Slot, Rung, and Master; `CLAUDE.md:71–95` is one paragraph
pointing at the table.

**Files.** `index.html:10–12` (preload), `:32–35` (Hero), `:46–49`, `:58–61`, `:70–73` (Products),
`:13` (`.hero-image`, `.product-image`); `tools/build-images.py:9`, `:27`, `:34–36`, `:78`;
`tests/performance-contract.mjs:29`, `:46`, `:50`; `CLAUDE.md:71–95`; `images/hero-640.jpg`,
`images/hero-768.jpg`.

**Problem.** One Hero image's facts — rungs, `sizes`, pixels, ratio, preload — live in five files
that must agree by hand (markup, inline CSS, generator, contract, prose), and the last commit's three
bugs (preload drift, `height` attribute beating `aspect-ratio`, wrong declared pixels) were those
files disagreeing. The generator knows the CSS box (`build-images.py:27`); the contract knows the
generator's arithmetic (`0.8`, `1200/803`, `640w…1200w`); neither can see the other or the disk.

**Evidence.**

- Rung filenames and widths 640/768/1200: `index.html:11` (`imagesrcset`), `:32` (`<source srcset>`),
  `:34` (`<img srcset>`); `build-images.py:36` and `:78`; contract `:29`.
- The `sizes` string `(max-width: 700px) 100vw, 50vw`: `index.html:12`, `:32`, `:35` — three copies;
  the `700px` breakpoint appears ten times in the file, `@media` included.
- Intrinsic 1200×803: `index.html:35`; contract `:46`; `CLAUDE.md:93–95`; the truth is `images/hero.jpg`.
- Declared vs real pixels all match today (hero 1200×803, notebook-700 700×875, mug-374 and
  coffee-374 374×467) — and nothing verifies it (M14).
- A scratch rebuild via `build-images.py` is byte-identical for the 11 files it owns.
  `hero-640.jpg` / `hero-768.jpg` are owned by nobody (`build-images.py:9`); `hero-640.jpg` is
  640×429 beside a 640×428 WebP. `CLAUDE.md:75` "rebuilds every derived file" holds only for the
  files the script chose to own.
- Masters `notebook.jpg`, `mug.jpg`, `coffee.jpg` are not referenced by the page, so the contract's
  "every referenced image file exists" (`:65`) would not notice their deletion. `hero.jpg` is both
  master and the 1200w rung.

**Shape.** One description per slot — master, target ratio, rungs, formats, `sizes` — that the
generator builds from (Hero JPEG rungs included) and the contract verifies both the markup and the
files on disk against. `index.html` stays hand-written; no build step.

**Wins.** locality: one table, three consumers · contract verifies disk, not literals · orphan Hero
JPEGs get an owner · delete 6 literals from the contract · `CLAUDE.md:71–95` shrinks to a pointer.

**Deletion test.** Delete the generator or the contract and the facts reappear in the other →
concentrates.

**Depends on** B1's disk-reading seam. **Vocabulary:** Slot, Rung (see the last section).

### B3 · Encode the Run

**Status. Done.** `lib/report.mjs` is everything the lab knows about a Report — `checkReport`
(every reason a Report is not a real Run: interstitial CDN requests, nothing of the Storefront's own,
wrong host, localhost, desktop, unsimulated throttling, redirect, non-200 document, runtime error),
`reportName` (host + the Report's own UTC `fetchTime` with a `Z`), `summarize`/`formatSummary`
(scores, FCP/LCP/TBT/CLS, requests, bytes, known artifacts with the category score recomputed
without them). `tools/run.mjs` performs the Run behind `performRun({url, measure, reportsDir})`
with two adapters, `lighthouseMeasure` (the global CLI, spawned without a shell, headers via a
file, tolerant of the post-write EPERM exit) and `recordedMeasure`; the command is
`node tools/run.mjs <preview-url>`, or `node tools/run.mjs reports/<file>.json` to summarise a
recorded Report. `tests/run.mjs` holds 17 assertions over the 14 recorded Reports. D5 decided: the
14 Reports were renamed with `git mv` to their own UTC `fetchTime`, and "every Report on disk is
named by its own fetchTime" is now an assertion. D7 absorbed: `CLAUDE.md`'s current state reads
from the newest Run (SEO 92, 100 net of the artifact). The Lighthouse adapter was smoke-run once
against a local port to prove the spawn path returns a parseable Report.

**Files.** `CLAUDE.md:30–55` (the Run's only home; `:37` is the command); `reports/` (14 Reports);
`tools/` (nothing yet).

**Problem.** The Run — the loop's measure step — is a shell command a human copies plus four
unwritten rules (bypass header, realness verification, robots-txt artifact, EPERM noise). Nothing
refuses to save a Report that measured ngrok's interstitial. Reading a Report means knowing
Lighthouse's schema (`categories[].score`, `audits[].numericValue`, `network-requests` items,
`configSettings.channel`, `fetchTime`) and rebuilding `node -e` one-liners each time.

**Evidence.**

- Every Report on disk is stamped in local time (UTC−3): `…T130625.json` has
  `fetchTime 2026-08-21T16:06:25Z`; `…T135410` → `16:54:10Z`; `…T142652` → `17:26:57Z` (the stamp
  is taken before Lighthouse starts, so it also drifts by seconds). CONTEXT.md names a Report by the
  UTC moment of capture. `CLAUDE.md:37` uses `date` without `-u`.
- Newest Report (`…T142652`): 7 requests, none from ngrok, FCP 894 ms, LCP 936 ms, TBT 0, CLS 0,
  SEO **0.92** — solely the robots-txt artifact (`0, "2 errors found"`). `CLAUDE.md:117` "100 across
  all four" is the `http://localhost:8000/` number, which by CONTEXT.md's definition is not a Run.
- 9 Reports are `channel: devtools`, 5 are `channel: cli`.

**Shape.** One command that takes a Preview URL, performs the Run, refuses an unreal Report, names it
by its own UTC `fetchTime`, writes it, and prints the summary (scores, FCP/LCP/TBT/CLS, request
count, bytes, known artifacts). The 14 recorded Reports are the second adapter, so the verifying,
naming, and summarising logic has assertions without ngrok.

**Wins.** a garbage Report cannot be saved · Report names stop drifting from UTC · robots-txt
artifact named in code · two adapters: Lighthouse, recorded Report · `CLAUDE.md:30–55` becomes one
line.

**Deletion test.** Nothing to delete — the module does not exist; its complexity lives in the
operator's head.

### B4 · Lock in the Measurement Server

**Status. Done.** `server.py` is one `POLICY` table (suffix → content type, gzip, cache), one
public allowlist (`/`, `app.v1.min.js`, `favicon.ico`, `robots.txt`, `llms.txt`,
`images/*.{webp,jpg}`), and a thin handler; 404s are `no-cache`, there is no directory index, HEAD
mirrors GET, `python server.py 0` binds an ephemeral port and prints it flushed.
`tests/measurement-server.mjs` asserts it over HTTP against the real process — 10 assertions,
including that every asset the page model says the page references is served as an Immutable
Asset. D1–D4 fixed, each mutation-checked.

**Files.** `server.py:9–10` (`COMPRESSIBLE`, `IMMUTABLE_SUFFIXES`), `:14`, `:16–18`, `:20–26`
(`end_headers`), `:28–46` (`send_head`); no assertions anywhere.

**Problem.** The headers a Run measures — keep-alive, gzip, immutable-by-suffix, HTML no-cache — are
the only measured thing with zero assertions, and the policy is threaded through three handler
overrides (`translate_path` is resolved twice per request). Verifying it today means starting the
server and reading response headers by hand.

**Evidence** (live probe on port 8765):

| Request | Observed |
|---|---|
| `GET /` | 200 `text/html`, gzip 9164 → 2859 bytes, `no-cache`; a second request reused the connection |
| `GET /app.v1.min.js` | 200 `text/javascript`, **not gzipped**, immutable 1y — `:9` lists `application/javascript`, `mimetypes` returns `text/javascript` |
| `GET /images/hero.webp` | 200 **`application/octet-stream`**, immutable 1y — Python 3.12 on win32 has no `.webp`; the newest Report records this `mimeType` for every WebP, LCP image included |
| `GET /robots.txt` | 200 `text/plain`, gzip, `no-cache` |
| `GET /images/missing.jpg` | **404 with `public, max-age=31536000, immutable`** — `:22` keys on suffix and ignores status |
| `GET /images/` | 200 directory index, `no-cache` |
| `GET /server.py`, `/CLAUDE.md`, `/reports/…json` | 200 — the served root is the repository |
| `GET /../CONTEXT.md` | 404 (traversal blocked) |

**Shape.** Concentrate type, compression, and cache into one policy the handler applies, and assert
it through the interface a Run uses — HTTP on an ephemeral port — not through an extracted helper:
the 404 defect exists only in how the policy is called, so a pure function alone would not catch it.

**Wins.** Wins in `server.py` get Lock-in · three latent defects become assertions · policy readable
as one table · assertions cross the seam, not internals.

**Deletion test.** Pull the policy out and it concentrates; the handler becomes a thin adapter.

## Defects found on the way

Small, independent, and not architecture. Each was absorbed by the candidate named.

| # | Defect | Where | Absorbed by | Status |
|---|---|---|---|---|
| D1 | WebP served as `application/octet-stream`, LCP image included | `server.py:33`; win32 `mimetypes` | B4 | Done — `POLICY` names `image/webp`; asserted |
| D2 | JS never gzipped: `text/javascript` ∉ `COMPRESSIBLE` | `server.py:9`, `:36` | B4 | Done — `.js` row gzips; asserted |
| D3 | 404s under asset suffixes are `immutable, max-age=1y` | `server.py:22` | B4 | Done — 404s are `no-cache`; asserted |
| D4 | Served root is the repository — `/CLAUDE.md`, `/server.py`, `/reports/*.json`, `/images/` index are public on the Preview URL | `server.py:8`, `:17` | B4, or a one-line allowlist | Done — allowlist; each path asserted 404 |
| D5 | All 14 Reports named in local time; CONTEXT.md says UTC | `CLAUDE.md:37` (`date` without `-u`) | B3 — decide: rename the 14 on disk, or amend CONTEXT.md | Done — renamed on disk (`git mv`), rule asserted |
| D6 | `hero-640.jpg` / `hero-768.jpg` owned by nobody; 640×429 vs the 640×428 WebP; `CLAUDE.md:75` overstates the generator | `tools/build-images.py:9` | B2 | Done — generator owns and rebuilt them; orphans asserted |
| D7 | `CLAUDE.md:117` "100 across all four" is the localhost number; the newest Preview URL Report is SEO 0.92 | `CLAUDE.md:117` | B3 | Done — current state reads from the newest Run |
| D8 | Assertion names over-promise: "match the real pixels" (`:44`) never opens a file; "contrast" (`:79`) greps a hex literal; "self-hosted" (`:73`) bans one hostname; `CLAUDE.md:91` "the contract enforces it" is false for any `.hero-image` rule after the first | `tests/performance-contract.mjs` | B1 | Done — each name now describes what is checked |
| D9 | `llms.txt` description drifted from `<meta name="description">`; `llms.txt` lists only Home, not `#shop` / `#story`; no assertion behind `CLAUDE.md:123` / `:125` | `llms.txt:3`, `index.html:8–9` | B1 | Done — `llms.txt` fixed; both guidelines asserted |
| D10 | Masters `notebook.jpg`, `mug.jpg`, `coffee.jpg` are unreferenced, so deleting one goes unnoticed until the generator runs | `tests/performance-contract.mjs:65` | B2 | Done — every Master's existence and width asserted |

## Found on 2026-08-25

While the Preview URL moved from ngrok to a Cloudflare quick tunnel. Recorded, not acted on; the
evidence is two Runs through the same tunnel and a few `curl` probes of it. D12 came later the
same day, from the first `/improve` run.

| # | Item | Dependency category | Status |
|---|---|---|---|
| B5 | The Run warms the Preview URL before measuring | local-substitutable | Open |
| D11 | `favicon.ico` leaves the Measurement Server uncompressed | in-process | Open |
| D12 | `CLAUDE.md`'s current state is prose nothing ties to the newest Report | local-substitutable | Open |

### B5 · The Run warms the Preview URL before measuring

**Problem.** Lighthouse's simulated throttling takes the server's response time from the one
navigation it observes, and the first request through a fresh quick tunnel is a cold start. A Run
taken cold measures the tunnel waking up and records it as the page's LCP.

**Evidence.** Five `curl`s of the document in a row: 1.37 s to first byte, then 0.23, 0.17, 0.21,
0.17 s. The Run of 2026-08-24T20:19:31Z (cold): TTFB 976 ms, server-response-time 779 ms, Hero load
duration 332 ms, LCP 1151 ms. The Run of 2026-08-25T12:41:32Z through the same tunnel (warm): TTFB
174 ms, server-response-time 95 ms, Hero load duration 88 ms, LCP 946 ms — the same page, 205 ms
apart.

**Shape.** `performRun` takes a `warm` adapter beside `measure` (default: one GET of the Preview
URL, awaited before `measure` runs); `tests/run.mjs` asserts with a counting fake that the Run warms
before it measures and does not warm when it refuses. Until then: one browser visit or `curl` of the
Preview URL before `node tools/run.mjs`.

### D11 · `favicon.ico` leaves the Measurement Server uncompressed

**Problem.** `server.py`'s `POLICY` row for `.ico` says no gzip, on the rule of thumb that images
do not compress — but ICO is uncompressed bitmap data: 4286 B raw, 1426 B gzipped. Cloudflare's
edge already gzips it (the Cloudflare Runs record 1.5 KB for the favicon, the ngrok Runs 4.3 KB),
so a Run through Cloudflare cannot show the difference; a Run through ngrok, or the local probe in
`tests/measurement-server.mjs`, can.

**Shape.** Flip the row to gzip and assert `GET /favicon.ico` arrives `Content-Encoding: gzip` under
1.5 KB. It is fetched after load, so no metric moves: bytes, not a Win, unless a Run says otherwise.

### D12 · `CLAUDE.md`'s current state is prose nothing ties to the newest Report

**Problem.** `CLAUDE.md:145` quotes one Run — its fetchTime, scores, metrics, request count and
bytes — by hand. D7 closed by making that paragraph read from the newest Run, but nothing asserts
that it still does: after the next Run someone has to remember to rewrite it, and until they do the
file describes a superseded Run as the current state.

**Evidence.** `grep -n CLAUDE tests/*.mjs lib/*.mjs tools/*` finds only the Measurement Server's
404 allowlist (`tests/measurement-server.mjs:133`) and a docstring in `tools/build-images.py`. In
sync today: the newest Report on disk is
`valued-washer-york-jvc.trycloudflare.com-20260825T124132Z.json`, the Run the paragraph cites.

**Shape.** An assertion in `tests/run.mjs` that reads the fetchTime `CLAUDE.md` cites, asserts it is
the newest Report under `reports/`, and asserts the scores and metrics quoted match that Report's
summary — or `node tools/run.mjs` prints the paragraph so it is pasted, never composed. Prose, not
a Win.

## Set aside

Recorded so the next review does not re-raise them.

- **Bag** (`app.v1.min.js`, `index.html:21`): 326 bytes, no assertions, `aria-label` text duplicated
  between markup and script. No change pressure; the deletion test says "moves".
- **Title/description ↔ `llms.txt`/`robots.txt` as its own module**: one assertion; folds into B1
  (see D9). Folded.
- **A readable CSS source for the inline `<style>`**: contradicts CLAUDE.md's no-build-step rule. No
  ADR records that rule; if it is meant to hold, it deserves one (`docs/adr/` does not exist yet).
- **Glossary drift**: `.catalog` (`index.html:13`, `:39`) and `#shop` (`:20`, `:29`, `:39`, `:41`)
  in the markup; "demo shop" (`CLAUDE.md:8–9`), "audit", "fix", "guard" elsewhere in CLAUDE.md;
  "demo" in `llms.txt:3`, and "optimize"/"optimization" in CLAUDE.md prose (`:9`, `:75`) — all on
  CONTEXT.md's avoid lists. Domain housekeeping, not architecture.
  The `CLAUDE.md` and `llms.txt` prose touched on 2026-08-24 uses the glossary words; the markup
  class and id names were left alone.

## Vocabulary

Settled on 2026-08-24 and added to `CONTEXT.md` under "The images":

- **Slot** — the place in the Storefront where one image renders into a fixed box: the Hero's
  image and each Product's image.
- **Rung** — one candidate width of a Slot's image, offered in every format the Slot ships.
- **Master** — the largest honest source held for a Slot, from which every Rung is derived and
  which the Storefront never requests.
