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
| B5 | The Run warms the Preview URL before measuring | local-substitutable | **Done** |
| D11 | `favicon.ico` leaves the Measurement Server uncompressed | in-process | Open |
| D12 | `CLAUDE.md`'s current state is prose nothing ties to the newest Report | local-substitutable | **Done** |

### B5 · The Run warms the Preview URL before measuring

**Status. Done** with P0 of `docs/superpowers/plans/2026-09-02-ecommerce-bench.md` (2026-09-03),
together with B9: `performRun` takes a `preflight` adapter beside `measure` (`tools/run.mjs`,
`fetchPreflight`), which fetches the document and then every asset the page references, in
parallel — the Shape below said one GET, and the Run of 2026-09-03T12:40:10Z, taken after exactly
one, still read a 266 ms server-latency estimate: Chrome's parallel requests take paths one
request does not warm. `tests/run.mjs` asserts with a counting fake that the pre-flight runs before
`measure`, does not run when the URL is refused, stops the Run when it refuses, and warms every
asset the page model lists. A Run that still measures a cold tunnel is named in its summary (B8).

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

**Status. Done** with P0 (2026-09-03), in the Shape's second form: `node tools/run.mjs
reports/<file>.json` ends with a `CLAUDE.md:` line (`formatCurrentState`, `lib/report.mjs`) that the
paragraph quotes verbatim, and `tests/run.mjs` asserts that the Run CLAUDE.md cites is the newest
Report on disk and that its line appears in the paragraph. The next Run fails the suite until the
paragraph is pasted over.

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

## Found on 2026-08-27

From a review of the Storefront through the Preview URL
(`https://leads-phillips-walk-governor.trycloudflare.com/`, warm), performed with the `claude-seo`
plugin across nine parallel reviewers. **No Run was taken** — nothing here comes from Lighthouse
under the project's own harness, and no Report was written. The performance ceiling was confirmed
unchanged against the Run of 2026-08-25T12:41:32Z: an independent Lighthouse measurement through
the same tunnel read simulated LCP 953 ms against that Report's 946 ms, 7 requests and 32.3 KB
byte-for-byte, and every insight audit that would surface headroom (render-blocking, image
delivery, CLS culprits, preconnect, DOM size) came back empty. **No performance item is recorded
below** — there is none to record.

Recorded, not acted on. The repository was not modified apart from this file.

| # | Item | Dependency category | Status |
|---|---|---|---|
| B6 | Decide whether the Storefront carries structured data | in-process | Open |
| D13 | The notebook Slot's Master is a photograph of a tote bag | local-substitutable | Open |
| D14 | The Storefront declares no canonical | in-process | **Done** |
| D15 | No Open Graph or Twitter Card tags | in-process | **Done** |
| D16 | The `.add` tap target renders 80x17 px | in-process | Open |
| D17 | The nav vanishes at 700px with no replacement | in-process | **Done** |
| D18 | `#story` is nested inside the `#shop` section | in-process | **Done** |
| D19 | `.product-type` clears AA by 0.07 and nothing asserts it | in-process | Open |
| D20 | The mug and coffee Slots ship a single Rung | local-substitutable | Open |
| D21 | The Hero preload declares `type="image/webp"` over a `.jpg` href | in-process | Open |

### B6 · Decide whether the Storefront carries structured data

**Problem.** The Storefront ships no structured data at all — no JSON-LD, no microdata, no RDFa.
The ordinary way to add it is an inline `<script type="application/ld+json">`, and the Performance
Contract asserts `page.scripts.length === 1`, counting every `<script>` span regardless of `type`.
So structured data is not a markup edit here; it is a deliberate change to an assertion, which is
the one thing CLAUDE.md says to do on purpose rather than in passing. Nobody has decided.

Underneath the mechanics sits a content question the mechanics hide: `Product` + `Offer` with
`price` and `availability` asserts that the three Products can be bought. Nothing here is
purchasable — `llms.txt` says so in its own words, and the Bag is a browser-held count. Emitting an
Offer would make the Storefront's most machine-readable surface contradict its own prose. Without
an Offer, `review`, or `aggregateRating`, a `Product` node is not eligible for any rich result, so
the honest version buys no SERP benefit either.

**Evidence.** `tests/performance-contract.mjs:128` (`assert.equal(page.scripts.length, 1)`);
`lib/page.mjs:136` (`spans('script')` — every script tag, `type` ignored). `index.html:92` is the
one script, external and deferred. `llms.txt:6` — "Nothing is purchasable: the bag is held in the
browser and there is no checkout or payment." Three reviewers reached the one-script conflict
independently.

**Shape.** Three positions, and the decision is which one is wanted, not how to build it:
(a) stay bare — the current state, defensible and free; (b) `Organization` + `WebSite` +
`CollectionPage` + `ItemList`/`Product` **without** `offers` — honest, not rich-result eligible,
costs one deliberate widening of the script assertion to permit exactly one inline `ld+json` span
beside the one external Generation; (c) a full `Offer` — only ever with a real checkout behind it,
which this Storefront does not have and is not meant to have. D15 is the part of this that needs no
contract change at all and can move on its own.

### D13 · The notebook Slot's Master is a photograph of a tote bag

**Problem.** The Product named "Linen notebook" renders a photograph of a tan kraft-paper tote bag.
The `alt` text is not the defect — it accurately describes the photograph. The wrong Master is
assigned to the Slot, so the Product's name and its image disagree on the page itself.

**Evidence.** `images/notebook.jpg` (the Master) and every Rung derived from it were opened and
viewed: a tan kraft-paper tote bag with woven handles on a pale ground. `index.html:49` —
`alt="A tan kraft paper tote bag with woven handles, laid flat on a pale grey background"` against
`index.html:53`'s `<h3 class="product-name">Linen notebook</h3>`. `images/slots.json:9-14` names
the Master. Two reviewers reached this independently; one of them first reported it as wrong `alt`
text, which the photographs disprove.

The Hero is the same shape of question and is left as a judgement call: `index.html:36` reads
`alt="A charcoal floor lamp angled against a sage green wall"`, and `images/hero.jpg` is indeed a
floor lamp — a fourth category the Collection does not carry. As an ambient Hero that may be
intended; as the LCP element it is the first thing a reader sees.

**Shape.** Source a notebook Master, drop it in per `images/slots.json`, rebuild every Rung with
`tools/build-images.py`, and bring the `alt` text with it. Content, not a Win — no metric moves.
Nothing in the Performance Contract compares a Slot's subject to its Product's name, and nothing
reasonably could.

### D14 · The Storefront declares no canonical

**Status. Done** with P2 (2026-09-04), and corrected the same day. It shipped relative, on the
reasoning below that a Preview URL is random per session; the Run of 2026-09-04T18:31:37Z read SEO
92 and named the reason itself — "Is not an absolute URL (./)" — so it is now absolute,
`https://field-notes-supply.example/`, written by `tools/build-pages.py` from `routes.json`. A fix
round the same day added `routes.json`'s `site`, the origin every Route's canonical must be on, and
moved the canonical out of `page.hrefs` in `lib/page.mjs` so the self-hosted rule never reads it.

**Problem.** There is no `<link rel="canonical">` anywhere in the document.

**Evidence.** The served document was searched for `canonical`; nothing. `index.html:5-12` is the
whole `<head>` before the inline `<style>`.

**Shape.** `<link rel="canonical" href="https://field-notes-supply.example/">` — absolute on
purpose, and on a reserved `.example` host rather than the Preview URL. A canonical says where a
page prefers to live, not where it happens to be served, so the hostname that changes every session
was never the one that belonged there; and Lighthouse scores a relative canonical 0 outright, which
is eight SEO points. `routes.json:2` holds the origin, `routes.json:6` the Route's own canonical,
and `tools/build-pages.py` writes the line between the marker comments.

### D15 · No Open Graph or Twitter Card tags

**Status. Done** with P2 (2026-09-04). Open Graph and the Twitter card, with `og:title`/
`og:description` read from the document rather than written twice, as the item itself asked. The
preview URLs are document-relative, so a crawler that requires absolute `og:image` will not render
it; that waits on a stable origin, which this repo does not have and P3 does not give it.

**Problem.** Nothing describes the Storefront to a link preview. A reader pasting the Preview URL
anywhere gets `<title>` and the meta description, with no image.

**Evidence.** The served document was searched for `og:` and `twitter:`; nothing.

**Shape.** `og:title`, `og:description`, `og:image` pointing at a Hero Rung, `twitter:card`. Pure
`<meta>` additions — this is the one structured-description item that does **not** touch the
one-script assertion, so it moves independently of B6. The Performance Contract already asserts the
title and description agree with `llms.txt`; whatever is added here should be read from the same
model rather than written twice.

### D16 · The `.add` tap target renders 80x17 px

**Problem.** The "Add to bag" control under each Product renders 80x17 CSS px — under the 24x24
floor WCAG 2.5.8 AA sets, and far under the 44-48 px a thumb wants. It is the Storefront's only
per-Product control.

**Evidence.** `.add{...font:700 .68rem Arial,sans-serif;...padding:0 0 .25rem;...}` in the inline
stylesheet — zero horizontal padding, a quarter-rem below the text and nothing else. Measured
rendered box 80x17 px at 1920, 1366, 768 and 375 px wide. `index.html:55`, `:67`, `:79`. The
accessibility score of 100 in the Run of 2026-08-25T12:41:32Z does not contradict this: Lighthouse
does not audit target size.

**Shape.** Give `.add` symmetric padding, or a `min-height`. It changes a box inside a Product, so
screenshot the Collection at both widths afterwards.

### D17 · The nav vanishes at 700px with no replacement

**Status. Done** with P2 (2026-09-04). The nav wraps to its own row below 700px rather than
vanishing. Note why it is not a disclosure: a toggle needs the behaviour, and the behaviour is a
Generation.

**Problem.** `nav{display:none}` inside `@media(max-width:700px)` removes both "Shop" and "Our
approach" on a narrow viewport, and nothing takes their place — there is no disclosure control in
the markup and none in `app.v1.min.js`. The Hero's invitation scrolls to `#shop`, so `#story` has
no in-page route at all below 700px.

**Evidence.** `index.html:20` is the nav; the rule sits in the `@media(max-width:700px)` block of
the inline stylesheet. `app.v1.min.js` holds only the Bag counter. Confirmed rendered at 375 px:
both anchors unreachable.

**Shape.** Either a small hand-written disclosure, or accept it and say so — the Collection is one
scroll away, so this may be a deliberate reading of a one-page Storefront. Worth deciding rather
than leaving as an accident of a display rule.

### D18 · `#story` is nested inside the `#shop` section

**Status. Done** with P2 (2026-09-04). `#story` is its own `<section>` with `aria-labelledby`, and
`.story` carries the container it used to borrow from `.catalog`.

**Problem.** The nav and `llms.txt` both present "Shop" and "Our approach" as peers. In the markup
"Our approach" is a `<div class="note" id="story">` inside `<section class="catalog" id="shop"
aria-labelledby="shop-title">`, so it is a subsection of "The collection" — labelled by it, and
inside its landmark. The stated information architecture and the document structure disagree.

**Evidence.** `index.html:39` opens the section, `index.html:82` opens the note, `index.html:87`
closes the section. `llms.txt:8-9` lists the two as separate entries.

**Shape.** Close the Collection's section before the note and give the note its own section with
its own `aria-labelledby`, pointing at the `<h2>` it already has. Structure, not a Win.

### D19 · `.product-type` clears AA by 0.07 and nothing asserts it

**Problem.** The Product's type label computes 4.57:1 against the Storefront's ground — over the
4.5 AA floor for normal text by 0.07. The Performance Contract computes contrast, but only for the
Hero's small label, so this pair can drift under the floor without anything noticing.

**Evidence.** Measured 4.57:1, grey-green (102,113,107) on cream (245,243,237).
`tests/performance-contract.mjs:110-115` — "the small Hero label meets normal-text contrast against
the Hero background", asserting `contrast(text, background) >= 4.5` for that pair alone.

**Shape.** Either darken the label to hold a real margin, or widen the existing contrast assertion
to cover every text pair the page computes — the machinery is already in `lib/page.mjs`, so this is
a Lock-in of a Win nobody has taken yet rather than new apparatus.

### D20 · The mug and coffee Slots ship a single Rung

**Problem.** The notebook Slot offers two Rungs (400w, 700w); the mug and coffee Slots offer one
each (374w). At `30vw` of the Collection's width the box is roughly 354 px, so a 374w Rung is right
at 1x and has no headroom at 2x, where the notebook Slot stays sharp.

**Evidence.** `images/slots.json:12` (`[400, 700]`) against `:19` and `:26` (`[374]`). Rendered box
measured 362x453 at 1920 px wide.

**Shape.** Add a Rung to each of the two Slots in `images/slots.json` and rebuild with
`tools/build-images.py`; the Masters are already there. The Performance Contract reads candidates
and pixels from the same file, so it follows without editing. Both are lazy and `fetchpriority=low`
and neither is the LCP element, so this is bytes and sharpness, not a Win — unless a Run says
otherwise.

### D21 · The Hero preload declares `type="image/webp"` over a `.jpg` href

**Problem.** The Hero preload carries `type="image/webp"` while its `href` fallback is a `.jpg`.
`type` gates whether the preload is honoured at all, so a browser without WebP would drop the whole
preload — including the perfectly good JPEG in the `href` — instead of falling back to it.

**Evidence.** `index.html:10-12` — `<link rel="preload" as="image" type="image/webp"
href="./images/hero-1200.jpg" imagesrcset="...webp 640w, ...webp 768w, ...webp 1200w">`.

**Shape.** Drop the `type`, or point `href` at a WebP Rung. Cosmetic today — every browser that
would reach this Storefront supports WebP, and the Run of 2026-08-25T12:41:32Z shows the preload
resolving through `imagesrcset` as intended. Recorded because the contract asserts the preload
matches the `<source>` the browser picks and says nothing about `type`.

## Found on 2026-09-02

From planning the PWA. The design was stress-tested against the repository before any code was
written, and three of the findings are defects that exist today, independently of whether the PWA
ships. **No Run was taken** — nothing here comes from Lighthouse, and no Report was written. Two
CLAUDE.md paragraphs were reinforced in the same pass (the UA-versus-author cascade trap beside the
`height`/`aspect-ratio` one, and applying the mutation test at design time); apart from those and
this file, the repository was not modified.

Worth recording alongside them: Lighthouse 13.4.1 has no PWA category — it was removed in v12, the
Run requests `performance,accessibility,best-practices,seo` (`tools/run.mjs:24`), and no recorded
Report contains an `installable-manifest`, `themed-omnibox` or `apple-touch-icon` audit. By
CONTEXT.md:30-33 a PWA therefore cannot be a Win here, only a non-regression.

| # | Item | Dependency category | Status |
|---|---|---|---|
| D22 | The keep-alive assertion stays green against a 404 | in-process | **Done** |
| D23 | The Measurement Server sends no validators, so `no-cache` costs a full download | in-process | **Done** |
| D24 | CONTEXT.md and CLAUDE.md disagree on whether a superseded Generation is kept | local-substitutable | Open |

### D22 · The keep-alive assertion stays green against a 404

**Status. Done** with the PWA of 2026-09-02: the keep-alive loop asserts 200, and
`tests/measurement-server.mjs` names the behaviour once, from the page model (`page.scripts[0]`),
so a Generation bump moves every assertion at once; `/app.v1.min.js` is asserted 404.

**Problem.** The assertion that one connection carries the page and its assets never checks that
either request succeeded. A 404 is HTTP/1.1, keeps the connection open, and reuses the socket, so
the assertion passes unchanged if the asset it names stops being served — which is exactly what
happens the next time the behaviour's Generation is bumped.

**Evidence.** `tests/measurement-server.mjs:156-164` requests `/` and `/app.v1.min.js` and asserts
`httpVersion`, `connection` and `reusedSocket`. No status assertion. The two assertions that would
catch the break name `/app.v1.min.js` by hand at `:82` and `:87`, so the file's name lives in three
places and only two of them fail when it moves.

**Shape.** `assert.equal(res.status, 200)` inside the existing loop at `:159`. One line.

### D23 · The Measurement Server sends no validators, so `no-cache` costs a full download

**Status. Done** with P2 (2026-09-04). An `ETag` over the bytes before gzip on all seven
`no-cache` rows, a 304 on a matching `If-None-Match`.

**Problem.** `no-cache` means revalidate, not "do not store" — but revalidation needs an `ETag` or
`Last-Modified` to revalidate against. The Measurement Server sends neither, so every conditional
request for the document or a crawler file returns 200 with the whole body instead of a 304. The
document is 3,024 B on the wire today, and any client that revalidates pays all of it every time.

**Evidence.** `server.py:94-106` — `reply()` sends `Content-Type`, `Cache-Control`, optional `Vary`
and `Content-Encoding`, and `Content-Length`. No validator header, and no `If-None-Match` /
`If-Modified-Since` handling in `respond()` at `:80-92`.

**Shape.** An `ETag` from a hash of the bytes, and a 304 branch when the request carries a matching
`If-None-Match`. Costs nothing on a first view, so it does not move the current Run — it changes
what a repeat view costs, which nothing in the repository measures yet.

### D24 · CONTEXT.md and CLAUDE.md disagree on whether a superseded Generation is kept

**Status. Open.** The PWA of 2026-09-02 bumped the behaviour to `app.v2.min.js` and followed
CONTEXT.md's rule — a stated rule outranks a record of one occasion: `app.v1.min.js` is kept on
disk, out of the Measurement Server's allowlist, and asserted 404, so "kept" does not mean "still
served". CLAUDE.md now points here from beside its record of the deletion instead of resolving the
contradiction; deciding which document cites which is still open.

**Problem.** The rule and the record contradict each other, and the next Generation bump has to pick
one without guidance.

**Evidence.** CONTEXT.md:44-47 defines a Generation as assets shipped under new filenames "so one
experiment's results can never be mistaken for another's" and states that "superseded Generations
are kept, not deleted". CLAUDE.md:57-59 records the opposite happening: the superseded stylesheet
Generations and `app.min.js` "were deleted once the CSS moved inline; recover them from the initial
commit if a Generation needs to be revisited."

**Shape.** Decide which is the rule and make the other cite it. If Generations are kept, a
superseded one should also leave the Measurement Server's allowlist and be asserted 404 — otherwise
"kept" quietly means "still served", which is a third behaviour neither document describes.

## The PWA · 2026-09-02

Built from the plan at `docs/superpowers/plans/2026-09-02-pwa.md`: a Worker, a Shell, a manifest
with placeholder icons, and a Notice, each locked into the Performance Contract and the Measurement
Server's assertions. CONTEXT.md gained the three words under "Working offline".

**This is a non-regression, not a Win.** Lighthouse 13.4.1 has no PWA category — it was removed in
v12 — and the Run requests only `performance,accessibility,best-practices,seo` (`tools/run.mjs:24`),
so no Run can show a Worker, a manifest, or a Notice moving a metric; by CONTEXT.md:30-33 that is
not a Win. The Performance Contract, not the Report, is what holds this work in place, and what the
Run after it has to show is that nothing moved.

**Before** — the Run of 2026-08-25T12:41:32Z through a warm Cloudflare quick tunnel: performance
100 / accessibility 100 / best-practices 100 / SEO 100; FCP = LCP = 946 ms, TBT 0, CLS 0; 7
requests, 32.3 KB transferred (`/` 3,024 · `hero-768.webp` 6,746 · `app.v1.min.js` 302 ·
`notebook-400.webp` 5,982 · `mug-374.webp` 1,992 · `coffee-374.webp` 13,492 · `favicon.ico` 1,488).
`hero-640.webp`, `hero-1200.webp` and `notebook-700.webp` are never fetched at the Run's viewport,
which is why the Shell is three URLs and not every Rung: keeping every Rung would add three requests
and 52.7 KB to that list for nothing.

**After** — the Run of 2026-09-02T18:36:43Z through a warm Cloudflare quick tunnel: performance
100 / accessibility 100 / best-practices 100 / SEO 100; FCP = LCP = 911 ms, TBT 0, CLS 0; 9
requests, 43.7 KB transferred (`/` 3,357 · `hero-768.webp` 6,747 · `app.v2.min.js` 942 ·
`manifest.webmanifest` 594 · `notebook-400.webp` 5,982 · `mug-374.webp` 1,992 · `coffee-374.webp`
13,492 · `favicon.ico` 1,488 · `icon-v1-180.png` 10,118). The page's own share of LCP reads 10 ms
load delay, 83 ms load duration and 41 ms render delay against 10 / 88 / 48 before, so nothing
moved; the rest of the difference is time to first byte (133 ms against 174 ms), which is the
tunnel's. `deprecations`, `inspector-issues` and `errors-in-console` are empty, and the Issues panel
of a Chrome opened on the Preview URL was empty too. The 11.4 KB the PWA adds to a first visit is
the manifest and the one icon Chrome fetches after reading it (10.7 KB together), plus 333 B more
document and 640 B more script. The Run of 2026-09-02T18:24:24Z, twelve minutes earlier through
another tunnel, read LCP 1114 ms with that same page share: its `network-server-latency` estimate
was 267 ms against 60 ms here, so it measured the tunnel, and is kept as the record of that.

| # | Item | Dependency category | Status |
|---|---|---|---|
| B7 | Teach the Run to measure a Worker-warm repeat visit | mock (Lighthouse CLI) | **Done** |
| B8 | The Run's summary names nothing of the tunnel's share | in-process | **Done** |
| B9 | The Run refuses a poisoned hostname only after a full Lighthouse pass | mock (Lighthouse CLI) | **Done** |

### B7 · Teach the Run to measure a Worker-warm repeat visit

**Status. Done** with P2 (2026-09-04). The Repeat Visit: two passes through one Chrome profile,
`checkReport` under a flag, `<host>-repeat-<moment>.json`, CONTEXT.md's new term. Note the
deviation from the Shape: only `disableStorageReset` is weighed, because `clearStorageTypes` keeps
listing both stores when the reset is disabled. Note also what is still unmeasured — a Worker
topping up a *second* Route, which needs P3.

**Problem.** A Run clears storage before it navigates, so every Run is a first visit and the Worker
never serves one. What a returning visitor pays — the document from the Shell, every image from the
cache — is exactly what the Worker exists to change, and nothing in the repository measures it.

**Evidence.** Every recorded Report has `configSettings.disableStorageReset: false` and clears
`service_workers` and `cache_storage`; `lib/report.mjs` refuses any Report that does not, on
purpose, because one `--disable-storage-reset` would let the Worker serve the document from
`caches` and record a fake first-visit result with nothing able to tell.

**Shape.** A second, deliberately named measurement: warm the Preview URL in the same Chrome
profile, then measure with storage kept, and have `checkReport` accept that Report only under a
flag that also changes its name. Touches `tools/run.mjs`, `lib/report.mjs`, the Report naming and
`tests/run.mjs:123`. Not a Run by CONTEXT.md's definition until CONTEXT.md says so.

### B8 · The Run's summary names nothing of the tunnel's share

**Status. Done** with P0 (2026-09-03). The summary prints the **Page share** (load delay, render
delay, the LCP image's own bytes) and the **Tunnel share** (TTFB, load duration, Lantern's
server-latency and RTT estimates), both defined in CONTEXT.md; a server-latency estimate above
150 ms is a known artifact (`network-server-latency`, `lib/report.mjs`), and `node tools/run.mjs
compare` reads two Reports side by side with a verdict on whose the LCP difference is. The evidence
below was wrong in one respect and the corrected reading is why the shares are split as they are:
the two Runs did **not** have the same load duration — 315 ms against 83 ms — and across all
eighteen Reports load duration tracks the tunnel (83–88 ms warm, 315–332 ms cold for one Rung)
while load delay and render delay hold; the simulated LCP moved by −203 ms for −210 ms of
server-latency estimate. The pair is also two Preview URLs, so it is not a Paired Run; `compare`
names it as such and still reads `tunnel`.

**Problem.** Two Runs of the same page twelve minutes apart on 2026-09-02 read LCP 1114 ms and
911 ms with the same load delay, load duration and render delay. The summary printed both as if
they were the page's; the difference was Lantern's `network-server-latency` estimate (267 ms against
60 ms), which nothing in the summary shows, so a tunnel-caused figure is indistinguishable from a
regression until someone opens the Report by hand.

**Evidence.** `lib/report.mjs:150-176` (`summarize` reads scores, four metrics, requests and bytes,
nothing of latency); `lib/report.mjs:133-148` (the only known artifact is ngrok's `robots-txt`);
`reports/strain-pound-zoloft-allowed…-20260902T182424Z.json` and
`reports/preceding-sensitive-secondary-festivals…-20260902T183643Z.json`.

**Shape.** Print `network-server-latency` and `network-rtt` beside TTFB in the summary, and name an
out-of-band estimate as a known artifact the way the ngrok one is named, so `node tools/run.mjs
reports/<file>.json` says "the tunnel's" without a reader having to. Recorded Reports exercise all
of it; no tunnel or Chrome needed.

### B9 · The Run refuses a poisoned hostname only after a full Lighthouse pass

**Status. Done** with P0 (2026-09-03), together with B5, in a shape that deviates from the one
below: instead of launching Chrome, the pre-flight asks the configured DNS servers directly
(`dns.Resolver`, c-ares — the Windows cache that `curl` reads from is bypassed, which is the cache
that said "yes" on 2026-09-02 while Chrome was told "no such name"), then fetches the document
once and reads it through the page model against `index.html`. It refuses in seconds naming DNS
when the name does not resolve, the status when it is not 200, the title when the document is not
the Storefront's, and the assets when an older Measurement Server is still answering.
`tests/run.mjs` exercises every refusal against in-test HTTP servers and a reserved `.invalid`
name, and the command itself against that name. Which resolver Lighthouse's Chrome asks is not
established; the `measuring-runs` skill keeps the wait and the `nslookup … 1.1.1.1` first.

**Problem.** A fresh quick-tunnel hostname looked up before it propagates leaves the ISP resolver
holding "no such name" for 30 minutes. The Run checks the URL's shape, launches Chrome, waits out
the whole measurement, and only then refuses the Report with `CHROME_INTERSTITIAL_ERROR` — a reason
that says nothing about DNS, while `curl` on the same machine succeeds from the Windows cache.

**Evidence.** `tools/run.mjs:36` (the only check before launch is `previewUrlProblem`, a URL-shape
test); `tools/run.mjs:39` and `lib/report.mjs:42-44` (the refusal reads `runtimeError` after the
fact); the `measuring-runs` skill, "A fresh hostname and DNS", for the procedure done by hand on
2026-09-02.

**Shape.** A pre-flight before Lighthouse: fetch the Preview URL once from the same Chrome the Run
will launch (headless `--dump-dom`, or one CDP navigation) and refuse to measure when the document
that comes back is not the Storefront's, naming DNS as the likely cause. This is also where B5's
warming request belongs, so one request does both.

## The e-commerce bench · 2026-09-03

`docs/superpowers/plans/2026-09-02-ecommerce-bench.md` is the program: the Storefront grows into an
e-commerce Core Web Vitals bench in six sub-projects, P0–P5, of which P0 — make two Runs comparable
— was approved and is built (B5, B8, B9 and D12 above; CONTEXT.md gained Tunnel, Page share, Tunnel
share and Paired Run; `docs/adr/0001` records the reversal of the no-build-step rule), and P1 — the
Bench: control, client-side GTM, deferred GTM — is built (spec
`docs/superpowers/specs/2026-09-03-bench-design.md`, plan `docs/superpowers/plans/2026-09-03-bench.md`;
CONTEXT.md gained Arm and Bench; nothing listed below was absorbed, B7 being P2's), and P2 — Routes
— is built (spec `docs/superpowers/specs/2026-09-04-routes-design.md`, plan
`docs/superpowers/plans/2026-09-04-routes.md`; CONTEXT.md gained Route and Repeat Visit), absorbing
B7, D14, D15, D17, D18 and D23 below. The plan proposes where the items still open would be
absorbed, recorded here so the evolution pays the backlog down instead of orphaning it; each stays
**Open** until its phase is picked and planned, per CLAUDE.md's backlog rule.

| Item | Proposed by the plan for | Why there |
|---|---|---|
| B6 structured data | P3 (the catalogue) | Answerable once Products have their own Routes; still without `Offer` |
| B7 Worker-warm repeat visit | P2 (Routes) — **built** | Navigating between Routes is what a Worker changes |
| D14 canonical · D15 Open Graph · D17 nav below 700px · D18 `#story` nesting | P2 (Routes) — **built** | Each is a property of a document a generator would write once |
| D23 validators for `no-cache` | P2 (Routes), beside B7 — **built** | Both are what a repeat view costs, which nothing measures yet |

Unassigned and Open: D11, D13, D16, D19, D20, D21, D24, D25. The two Set-aside items premised on
one URL — no per-Product URLs and a sitemap (`## Set aside on 2026-08-27`) — are still set aside,
now with a date to revisit: whenever P3 lands a second Route.

### D25 · `lcpResource`'s prefix match goes ambiguous under a long tunnel hostname

**Status. Open.** Found during P1's live Bench (2026-09-03).

**Problem.** `lib/report.mjs`'s `lcpResource(report)` finds the LCP element's own request by
matching `network-requests` entries whose URL starts with the `src="…"` prefix carried in
`lcp-breakdown-insight`'s node snippet — a prefix Lighthouse truncates to a length of its own
choosing, not the page's. Against this Bench's tunnel host
(`cartoons-environmental-undergraduate-emission.trycloudflare.com`, 63 characters), the snippet
truncated to `.../im…`, two characters past the origin, which is a prefix of all four Rungs under
`images/` (`hero-768.webp`, `notebook-400.webp`, `mug-374.webp`, `coffee-374.webp`). The match came
back ambiguous on every Report of that tunnel, control included — `pageShare.lcpUrl`/`lcpBytes`
printed `-`, even though `network-requests` on the same Report names `hero-768.webp` (6,746 B) as
what was actually fetched.

**Evidence.** `reports/cartoons-environmental-undergraduate-emission.trycloudflare.com-20260903T161533Z.json`'s
`lcp-breakdown-insight` node item's `snippet` truncates the `src` to
`https://cartoons-environmental-undergraduate-emission.trycloudflare.com/im…`;
`node tools/run.mjs reports/<that file>.json` prints `page share: load delay 12 ms · render delay
45 ms · LCP image - (-)`. CLAUDE.md's current-state paragraph records the same Run and names this
item. It recurred the same day on a second, unrelated tunnel hostname
(`contribute-displayed-recommend-induction.trycloudflare.com`, 58 characters,
`reports/contribute-displayed-recommend-induction.trycloudflare.com-20260903T175353Z.json`) — two
for two quick-tunnel hostnames so far, so this is not a rare edge case; a four-random-word
`trycloudflare.com` hostname is long enough to trigger it more often than not.

**Shape.** `lcpResource` needs a second signal once the prefix is this short: the same snippet's
`srcset` attribute names every Rung's filename (`hero-` already appears before the truncation
point here), so a fixed, non-interpolated pattern could recover the Slot's own filename stem
without depending on the prefix at all, or the `selector`/`boundingRect` the node item already
carries could disambiguate against `lib/page.mjs`'s Slot model. Mutation-check it: a fixture
Report with a short truncated prefix that matches two or more Rungs should still resolve, and one
where it cannot should say so rather than print `-` silently.

## Found on 2026-09-04

From the reviews of Task 8 (`docs/superpowers/plans/2026-09-04-routes.md`, B7's Report side: a
Repeat Visit is not a Run) and Task 9 (B7's Run side: two passes through one Chrome profile).
Recorded, not acted on; the repository was not otherwise modified by Task 10.

| # | Item | Dependency category | Status |
|---|---|---|---|
| D26 | `tests/measurement-server.mjs`'s file header uses `--` where the repository's other `.mjs` prose uses `—` | local-substitutable | Open |
| D27 | `RunRefused`'s message names a refused Repeat Visit a Run | in-process | Open |
| D28 | A Repeat Visit's Report is accepted on host, a 200 document and the ngrok check alone | in-process | Open |
| D29 | `formatComparison`'s `!sameVisit` branch has unpinned precedence | in-process | Open |
| D30 | `core.autocrlf` with no `.gitattributes` makes the mutation harness report caught rows as `passes` | in-process | Open |

### D26 · `tests/measurement-server.mjs`'s file header uses `--` where the repository's other `.mjs` prose uses `—`

**Problem.** `tests/measurement-server.mjs`'s file header writes its asides with `--` where the
repository's other `.mjs` prose (`lib/report.mjs`, `tools/run.mjs`, `tools/mutate-contract.mjs`)
uses `—`, an em dash. Predates this plan; cosmetic — it changes no byte an assertion reads.

**Evidence.** `tests/measurement-server.mjs:1-2`:

```
// Lock-in for the Measurement Server. The headers a Run measures -- keep-alive, gzip, immutable
// caching, HTML never cached -- are asserted through the same seam a Run crosses: HTTP against the
```

**Shape.** Replace the two `--` with `—`. One file, two characters; not mutation-checked, since no
assertion reads prose.

### D27 · `RunRefused`'s message names a refused Repeat Visit a Run

**Problem.** `RunRefused`'s message is fixed at `Run refused:` regardless of which measurement was
being performed, so a refused **Repeat Visit** announces itself as a **Run**. CONTEXT.md keeps the
two distinct everywhere else, including the summary's first line and the Report's filename
(`reportName`, `<host>[-<Arm>][-repeat]-<moment>.json`). It is a shared error path — `performRun`
throws it whether `repeat` is `true` or `false` — which is why it was not a drive-by edit in this
plan.

**Evidence.** `tools/run.mjs:104-107`:

```
export class RunRefused extends Error {
  constructor(reasons) {
    super(`Run refused:\n${reasons.map((reason) => `  - ${reason}`).join('\n')}`);
```

`tools/run.mjs:116-123` (`performRun`) throws it identically for a Run and a Repeat Visit.

**Shape.** Thread `repeat` into the message, e.g. `` `${repeat ? 'Repeat Visit' : 'Run'} refused:` ``,
and mutation-check it: a refused Repeat Visit's printed reasons should read "Repeat Visit refused",
never "Run refused".

### D28 · A Repeat Visit's Report is accepted on host, a 200 document and the ngrok check alone

**Problem.** On the Repeat Visit path, `checkReport`'s "nothing of the Storefront's own came back"
guard is relaxed, so acceptance rests on host, a 200 document, and the `cdn.ngrok.com` check alone.
That check is ngrok-specific: a Cloudflare tunnel serving an HTML error body with a 200 would not
be named by it. It cannot make a **Run** fake — the guard still applies there — and a document-only
Report genuinely is the expected Repeat Visit shape (the Worker answers the Shell and the Rungs it
kept from CacheStorage, so nothing else "of our own" need cross the network), which is why this is
a finding to record rather than a change to make.

**Evidence.** `lib/report.mjs:160-168`:

```
  const own = requests.filter(
    (r) => r !== document && hostOf(r.url) === host && !String(r.mimeType ?? '').startsWith('text/html'),
  );
  // Not on a Repeat Visit: the Worker answers the Shell and the Rungs it kept from CacheStorage, so
  // a document and nothing else is the expected shape rather than evidence of an interstitial —
  // which the cdn.ngrok.com check above names on its own either way.
  if (document && !own.length && !repeat) {
```

`lib/report.mjs:27` is the ngrok-only check: `const isNgrokCdn = (host) => host === 'ngrok.com' || host?.endsWith('.ngrok.com');`.

**Shape.** None proposed today: a Cloudflare quick tunnel has no interstitial and no artifact, so
nothing currently serves an HTML error body with 200 through one. If that ever changes, a
same-origin check that compares the document's own bytes against a known-good hash could still
apply on a Repeat Visit without depending on anything else arriving — recorded here rather than
built ahead of a Report that needs it.

### D29 · `formatComparison`'s `!sameVisit` branch has unpinned precedence

**Problem.** `formatComparison`'s `!sameVisit` branch is checked first in its `if`/`else if` chain,
but the only case that exercises it today — a Run compared against a Repeat Visit of the same host
and document — would also satisfy every later branch's condition, so nothing pins the branch to
that position. An implementation that checked `!samePreviewUrl` or `!sameDocument` first would still
pass every existing assertion, and would then head a cross-host Run/Repeat Visit pair with "Two
Runs, not a Paired Run (two Preview URLs)" — false, since one Report of the pair is not a Run at
all. A second fixture pairing a Run and a Repeat Visit that also differ in host (or document) would
pin the order.

**Evidence.** `lib/report.mjs:390-409`:

```
    samePreviewUrl: hostOf(a.url) === hostOf(b.url),
    sameDocument: parseUrl(a.url)?.pathname === parseUrl(b.url)?.pathname,
    sameVisit: isRepeatVisit(earlier) === isRepeatVisit(later),
    ...
export function formatComparison(comparison) {
  ...
  if (!comparison.sameVisit) {
    head = `A Run and a Repeat Visit, not a Paired Run: ...`;
  } else if (!comparison.samePreviewUrl) {
    head = `Two Runs, not a Paired Run (two Preview URLs): ...`;
  } else if (!comparison.sameDocument) {
```

**Shape.** Add a fixture pair to `tests/run.mjs` that is both a Run/Repeat Visit mismatch
(`!sameVisit`) and a host mismatch (`!samePreviewUrl`), and assert the printed head names it "A Run
and a Repeat Visit," never "Two Runs" — pinning `!sameVisit` ahead of the other checks rather than
leaving the order accidental.

### D30 · `core.autocrlf` with no `.gitattributes` makes the mutation harness report caught rows as `passes`

**Problem.** `core.autocrlf` is `true` and the repository has no `.gitattributes`, so a
`git checkout` or `git stash` over `index.html`, `routes.json`, `manifest.webmanifest` or `sw.js`
rewrites every one of their LF line endings to CRLF in the working tree. `tools/mutate-contract.mjs`
then reads those bytes as its originals, and every mutation whose needle spans a line — written with
`\n` — silently matches nothing. The row's file goes unmutated, the contract is green, and the
harness prints `passes` for a mutation the contract does in fact catch: a false green in the one
tool whose job is proving the contract can fail. It happened during Task 12 on 2026-09-04, on M48
and M51, and it took an hour to tell from a real result.

**Evidence.** `git config core.autocrlf` prints `true`; there is no `.gitattributes` at the
repository root. `tools/mutate-contract.mjs:6` recommends the very command that causes it:

```
// mid-way is undone by `git checkout .`. Add a
```

`tools/mutate-contract.mjs:162` and `:167` (M48 and M51) chain `.replace()` calls whose needles carry
`\n` and which `must()` does not cover, so a miss is silent rather than an error:

```
  page('M48 #story is nested back inside #shop', (h, f) => must(h, '<section class="story" id="story"', f)
    .replace('      </div>\n    </section>\n    <section class="story" id="story" ...
```

**Shape.** A `.gitattributes` carrying `eol=lf` for the files the harness rewrites — the seven of
`tools/mutate-contract.mjs:26`'s `FILES` — so a checkout of any of them cannot change a byte the
harness reads. Not a repository-wide `text=auto`: that renormalises every file in the repository and
would bury the diff of whatever round adds it. Worth pairing with a guard in the harness itself, so
a needle that matches nothing fails the row instead of passing it, and with correcting the header's
`git checkout .` advice to `git show HEAD:<path>`.

## Set aside on 2026-08-27

Recorded so the next review does not re-raise them.

- **"Free shipping on orders over $75"** (`index.html:17`): raised by two reviewers as an
  unsupported claim, one of them at Critical. Set aside. The Storefront is fictional by design —
  the Products, the prices and the Bag are equally unreal — so a shipping line is no more a
  misrepresentation than a `$24` notebook nobody can buy. It would matter the moment anything here
  became purchasable, and not before.
- **Thin content, absent E-E-A-T, no per-Product URLs, no about/contact/policy routes**: all real
  against a commercial storefront, all inherent to what CONTEXT.md says this is. The Measurement
  Server's allowlist does not serve such routes and should not start.
- **Security response headers** (no CSP, `X-Content-Type-Options`, `Referrer-Policy`,
  `X-Frame-Options`, HSTS): the Measurement Server sends `Content-Type`, `Cache-Control`, `Vary`,
  `Content-Encoding`, `Content-Length` and nothing else. Every header a Run reads is deliberate;
  adding headers changes the bytes of every response and so changes what a Run measures. If they
  are wanted they belong in one `POLICY`-shaped decision with a Run either side, not dropped in.
- **A sitemap**: one URL, already reachable at the root of an `Allow: /` Storefront, and any
  spec-valid `<loc>` is absolute and therefore stale the next session. The absent `Sitemap:`
  directive in `robots.txt` is correct for the same reason.
- **IndexNow, hreflang, backlinks, local and Maps signals, marketplace intelligence**: all
  structurally inapplicable to a fictional, non-purchasable Storefront on a hostname that changes
  every session.

## Set aside

Recorded so the next review does not re-raise them.

- **Bag** (`app.v1.min.js`, `index.html:21`): 326 bytes, no assertions, `aria-label` text duplicated
  between markup and script. No change pressure; the deletion test says "moves".
- **Title/description ↔ `llms.txt`/`robots.txt` as its own module**: one assertion; folds into B1
  (see D9). Folded.
- **A readable CSS source for the inline `<style>`**: contradicts CLAUDE.md's no-build-step rule. No
  ADR records that rule; if it is meant to hold, it deserves one (`docs/adr/` does not exist yet).
  Since 2026-09-03, `docs/adr/0001-tooling-may-generate-what-ships.md` records that rule's
  reversal — tooling may generate what ships, committed and byte-identical on rebuild — so this is
  unpicked, not forbidden.
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
