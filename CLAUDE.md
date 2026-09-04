# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A Core Web Vitals lab disguised as a storefront. `index.html` renders "Field Notes Supply" — a
dependency-free, client-only Storefront with no checkout — but the point of the repo is the
measure → optimize → lock-in loop around it: serve the page locally, expose it through a Cloudflare
quick tunnel, perform a Run against the Preview URL, and encode each Win as an assertion so it
cannot silently regress.

No package manager, no framework, and nothing shipped to the browser has a dependency. Tooling may
generate what ships — `images/` and `icons/` already are, from PIL — provided the generated files
are committed and rebuild byte-identically (`docs/adr/0001-tooling-may-generate-what-ships.md`);
`index.html` is hand-written and hand-minified but for one block in its `<head>`, which
`tools/build-pages.py` writes from `routes.json` between two marker comments.

`CONTEXT.md` defines this project's vocabulary (Run, Report, Preview URL, Win, Lock-in,
Performance Contract, Generation, Slot, Rung, Master, ...). Use those terms and honour the words it
says to avoid.

## Commands

```bash
python server.py 8000                              # the Measurement Server at http://localhost:8000/ (0 = ephemeral port)
./start-cloudflare.ps1                             # PowerShell: starts server.py + a Cloudflare quick tunnel (the Preview URL)
./start-ngrok.ps1 -Domain <ngrok-domain>           # PowerShell: the ngrok alternative (omit -Domain for a temp URL)
node tools/run.mjs https://<name>.trycloudflare.com/   # perform a Run: pre-flight (resolve, warm, read the document), measure, save the Report, print the summary
node tools/run.mjs reports/<file>.json             # print a recorded Report's summary and its CLAUDE.md current-state line
node tools/run.mjs compare <earlier>.json <later>.json   # a Paired Run read side by side: every delta, and whose the LCP difference is
node tools/run.mjs repeat https://<name>.trycloudflare.com/   # a Repeat Visit: two navigations of one browser, the second with storage kept
node tools/bench.mjs https://<name>.trycloudflare.com/ --rounds 3   # a Bench: a warm-up Run of the control, then 3 rounds of every Arm through the one Preview URL; writes benches/<host>-<stamp>.json
node tools/bench.mjs read benches/<file>.json      # recompute a Bench's reading from the Reports it names, and its CLAUDE.md bench-of-record line
node --test "tests/**/*.mjs"                       # every assertion: Performance Contract, Measurement Server, Run, Bench
node --test tests/performance-contract.mjs         # the Performance Contract alone (page + images)
node --test tests/measurement-server.mjs           # the Measurement Server alone (spawns python server.py 0)
node --test tests/run.mjs                          # the Run alone (recorded Reports, no tunnel or Chrome)
node --test tests/bench.mjs                        # the Bench alone: the Arms table, the generated Arms, the reading, the record
node --test --test-name-pattern="lazy" tests/performance-contract.mjs   # one assertion
node tools/mutate-contract.mjs                     # prove the contract can still fail (55 mutations of the page, the manifest, the Worker, an Arm, the Arms table and the Route table)
python tools/build-images.py                       # rebuild every Rung from the Masters per images/slots.json
python tools/build-icons.py                        # rebuild every icon and screenshot in icons/ from manifest.webmanifest
node tools/build-arms.mjs                          # rebuild every Arm document from index.html per bench/arms.json
python tools/build-pages.py                        # rebuild every Route's generated <head> block from routes.json
```

`node --test tests/` fails — the filenames do not match Node's default test glob. Quote the glob
above, or pass a file path. `lib/` holds the modules the assertions, the Run and the Bench share; it is not a
test directory.

### Measuring

How to warm the Preview URL, perform a Run, and read its Report (Cloudflare/ngrok gotchas, timing
figures, known artifacts) lives in the `measuring-runs` skill — load it before starting a tunnel or
running `node tools/run.mjs`.

## Architecture

**`server.py` is part of the optimization, not scaffolding.** It is the Measurement Server: a
`POLICY` table (suffix → content type, gzip: facts about the bytes), a `PUBLIC` table (path → file,
cache: facts about the URL — `/`, the behaviour's current Generation, the favicon, `robots.txt`,
`llms.txt`, `manifest.webmanifest`, `sw.js`, plus one row per Arm read from `bench/arms.json` at
boot) and a `DIRECTORIES` table (`/images/*.{webp,jpg}`,
`/icons/*.png`). Immutable Assets are served with `max-age=1y, immutable`; the document, the crawler
files, the manifest and `sw.js` are `no-cache` — `sw.js` on purpose: a Worker registration is
identified by its URL, so a Generation-stamped Worker would be a second registration, not a
replacement, and it is the one script whose filename is deliberately not a cache key. `no-cache`
means revalidate, not "do not store", so every one of those rows carries an ETag over the bytes on
disk, one tag per representation with the gzip variant suffixed `-gzip` — a cache holding the
identity bytes must not be told the gzip variant is still fresh. A matching `If-None-Match` gets a
304 carrying the validator and no body at all, not even a `Content-Length`, since a length of 0
would claim the representation is empty when it is not. `tests/measurement-server.mjs` asserts that
against the real `python server.py 0`, and that is where the authority sits: what survives a
Cloudflare quick tunnel is a separate question, and an open one (BACKLOG.md D31). 404s are never
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

**A Repeat Visit is the measurement a Run cannot be.** A Run clears storage, so the Worker installs
fresh and never serves one; what a returning visitor pays was therefore unmeasured (BACKLOG.md B7).
`node tools/run.mjs repeat <url>` performs two navigations of one browser, driven through
Lighthouse's Node API — the first an ordinary navigation, thrown away, which installs the Worker;
the second with `disableStorageReset`, which the Worker serves. The API rather than the CLI because
the CLI launches a Chrome of its own and cannot be told which profile to use, and one browser across
both is the whole of what makes the second a return: Chromium honours the **first** `--user-data-dir`
it is given and chrome-launcher's own is always first, so a profile passed through `--chrome-flags`
is ignored in silence — which is how every Repeat Visit before 2026-09-04 measured a first visit
twice. A Repeat Visit whose every request came down in full is therefore marked, because that is
indistinguishable from the two navigations not having shared a browser; and `channel` reads `node`
where a Run reads `cli`, which the summary prints, because a Report should say how it was taken.
Its Report is named `<host>[-<Arm>]-repeat-<moment>.json` and `checkReport` accepts it only under the
same flag, refusing a cleared-storage Report as a Repeat Visit and a kept-storage one as a Run, so
neither can be read as the other; `compare` names the pair when they are mixed. Both Reports of
2026-09-04 are kept under `reports/` — the one that measured a first visit twice and the one that
returned — and `tests/run.mjs` reads the mark off them. Only `disableStorageReset` decides which
measurement a Report is; `clearStorageTypes` lists what *would* be cleared and keeps listing it when
the reset is disabled. CLAUDE.md's current state stays a Run's: a Repeat Visit measures the returning
visitor, not the first one.

**`bench/arms.json` is the one home of every Arm fact**, as `images/slots.json` is for images: the
container (`GTM-PRVCQ335`, the user's own, and a prose note of what it holds) and the three Arms —
the control (`/`, `index.html`), `gtm` (`/arm-gtm.html`, Google's standard snippet at the top of
the head) and `gtm-deferred` (`/arm-gtm-deferred.html`, the container after `load` when idle, with
a one-second ceiling). `tools/build-arms.mjs` derives each Arm document from `index.html` by
inserting exactly that delivery's snippet, byte-identically on rebuild; `lib/arms.mjs` is the
table's one reader for the Run, the bench and the assertions; `server.py` reads it in Python. The
Performance Contract keeps holding for `index.html` alone; `tests/bench.mjs` holds every Arm equal
to the generator applied to the control on disk, so a change to `index.html` demands a rebuild, as
a Master's demands its Rungs. A Run of an Arm is pre-flighted against the Arm's own file, refused
when the Report's path is another Arm's, and named `<host>-<arm>-<stamp>.json`; its summary
accounts for every third party by origin. The Bench (`tools/bench.mjs`) performs a warm-up Run of
the control, then rounds of every Arm through one Preview URL, and its reading gives each Arm min /
median / max per measure with the cost against the control called real only when the Arm's Runs
and the control's do not overlap — the control's own spread in the same session is the floor, never
a quoted threshold. Two marks: a cold-tunnel Run, and an Arm Run whose Report holds no request to
`www.googletagmanager.com` (the container never loaded). The record under `benches/` names the
Reports; `read` recomputes the reading from them.

**`routes.json` is the one home of every Route fact**, as `images/slots.json` is for images: each
Route (there is one, `/` → `index.html`) with the URL it canonicalises to and the image and card
type its social preview uses. That canonical is absolute because Lighthouse scores a relative one
0 — a Run of 2026-09-04 read SEO 92 on "Is not an absolute URL (./)" — and it names a reserved
`.example` host rather than the Preview URL, because a canonical says where a page prefers to live
rather than where it happens to be served; the table's `site`, above the Routes, is the origin
every Route's canonical must be on. `lib/page.mjs` reads a canonical as a named fact of the page
and never as a reference, so it never reaches `page.hrefs` and the self-hosted rule never sees it —
exempting it there by its URL string would exempt any asset that happened to spell the same string.
Two consumers: `tools/build-pages.py`, which writes the canonical
link and the Open Graph and Twitter metas into the Route's own document between
`<!-- routes.json: begin -->` and `<!-- routes.json: end -->`, and the Performance Contract, which
holds every written value against the source it came from. `og:title` and `og:description` are not
in the table: they are the document's own `<title>` and description, read by the generator and
written once, so the two cannot drift. `server.py` does not read it — there is one Route and it is
already served; a second one is P3's, and that is when a `PUBLIC` row would follow. The generator
is the first here whose source and output are the same file, it parses with Python's
`html.parser` rather than any pattern over the markup, and it rebuilds byte-identically. The chain
runs in one order: `routes.json` → `python tools/build-pages.py` → `index.html` →
`node tools/build-arms.mjs` → the Arm documents.

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
row to `tools/mutate-contract.mjs`, which mutates the page, the manifest, the Worker, an Arm, the
Arms table and the Route table fifty-five ways (restoring each after) and expects every row to
behave as its table says — a page mutation rebuilds the Arms first and a Route-table mutation
regenerates the document, so what a row reports is the contract's own verdict rather than a
stale-generated-file failure. Apply that test while designing
an assertion, not only after writing it: an assertion that restates markup you are about to write
cannot fail, and it is easiest to propose one in the same breath as the feature it is meant to guard.

**`reports/` holds the Reports**, named `<host>-<UTC fetchTime>Z.json` by the Run itself. See the
`measuring-runs` skill for how to read one back.

Current state (Run of 2026-09-04T19:02:12Z through a warm Cloudflare quick tunnel, the second of a
Paired Run against the Routes): performance 100 / accessibility 100 / best-practices 100 / SEO 100,
FCP = LCP = 910 ms, TBT 0, CLS 0, 9 requests, 43.9 KB transferred; WebP arrives as `image/webp`, the
script and the manifest gzipped, no robots-txt artifact, and `deprecations`, `inspector-issues` and
`errors-in-console` all empty. The summary splits LCP into the Page share (load delay 13 ms, render
delay 43 ms, and the LCP image resolved to `hero-768.webp` — D25 did not recur on this 49-character
hostname, where the two it did recur on were 63 and 58 characters; one more data point for the guess
D25 already records, not yet a rule) and the Tunnel share (TTFB 140 ms, load duration 78 ms,
Lantern's server latency 54 ms and RTT 19 ms). Its pair six minutes earlier, 18:56:01Z, read LCP
949 ms with a Page share of 12 / 49 ms, and `compare` says `tunnel`: the tunnel moved −44 ms, which
covers LCP −39 ms, against a Page share that moved −4 ms. Both Runs measure the same document
(`resourceSize` 10 868 in each), so what the pair establishes is that nothing moved between them —
not what the Routes cost against the page before them, which no Paired Run can say.

The 43.9 KB against the PWA-era control Reports' 43.7 KB has two causes, and it is worth keeping
them apart. `manifest.webmanifest` isolates one: its body is byte-identical everywhere
(`resourceSize` 1148 in all thirty Reports that fetch it), and its `transferSize` reads 593–596 B in
the twenty-five taken before 2026-09-04 and 648 B in every one taken after — **about 54 bytes** a
row, against the 79 raw bytes of the header `server.py` writes. A Run fetches exactly two `no-cache`
rows, that manifest and the document, so roughly 106 B of the change is that. The rest is the page:
the document's own body grew 674 bytes (`resourceSize` 10 194 → 10 868) for the generated head block
and the header's CSS, which cost 126 B on the wire of which about 53 is its own ETag. Reports taken
before and after 2026-09-04 are therefore not byte-comparable, and the ETag alone would have read
43.8 KB. No Report yet shows the other side of that trade: the first Repeat Visit's eight rows are
all `statusCode` 200, and there is not a 304 anywhere in it.

The first Run of that tunnel, 2026-09-04T18:31:37Z, is kept and scored SEO 92:
`canonical | score 0 | Is not an absolute URL (./)`. The canonical was relative on purpose and the
Performance Contract held it that way, while Lighthouse accepts only an absolute one — the contract
and the canonical audit wanted opposite things, and eight points were the cost. Nothing reasoned
that out; a Report did.

The first Repeat Visit that returned is 2026-09-04T19:23:02Z, and what it shows is not what
`8 requests · 0.0 KB` suggests. Every row reads `transferSize` 0 and `statusCode` 200, and the
favicon does not appear at all. The six rows reading `cache: disk` — the four images, the behaviour
and the icon — took 2 to
5 ms each: Chrome's own cache served those, `immutable` doing exactly its job. The two reading
`cache: none` are precisely the two `no-cache` rows, the document and the manifest, and they took
79.9 ms and 89.6 ms with `server-response-time` at 76 ms. `sw.js` puts both through `networkFirst`,
so the Worker went to the network for them and the page recorded nothing, because a Report does not
see the Worker's own fetches. The 0.0 KB is the page context's figure, not the wire's.

So the returning visitor's gain is small, and `compare` says it is not the page's: LCP reads 893 ms
against the Run's 910, the tunnel moved −73 ms which covers that −17 ms, and the Page share moved
**+30 ms** — render delay 75 ms against the Run's 43. That is B7's answer for now. A Worker that
fetches the document network-first leaves the one request on the critical path where it was, and
what the returning visitor saves is what the HTTP cache would have saved without it. Two of the
readings a Repeat Visit was meant to give are still missing, both for the same reason: no 304
appears, and `topUp()` leaves no trace of the three Rungs the page never fetches, because that work
happens in the Worker's context too. The one before it, 19:04:21Z, is kept and carries a mark: it
measured a first visit twice.

The Run of record before these (2026-09-03T17:53:53Z, the control's third round of the Bench against
the real container) read 921 ms with a Page share of 11 / 43 ms and a Tunnel share of
150 / 93 / 65 / 21 ms. The three Runs of that 2026-09-03T12:40–12:47Z tunnel session are the first
Paired Runs: 2026-09-03T12:40:10Z, after one warming GET, read LCP 1177 ms with a load duration of
350 ms, a server-latency estimate of 266 ms (the summary names it a known artifact) and a render
delay of 131 ms, the first Chrome of the session; 12:42:08Z, after the pre-flight had fetched every
asset, read 1006 ms with 93 / 59 ms and 47 ms, and `node tools/run.mjs compare` over the two says
`tunnel`; 12:42 → 12:47 says `noise` — LCP −59 ms with the Page share +7 ms and the estimates
−1 ms, which is what a tunnel looks like when nothing changed. The Run of record before these
(2026-09-02T18:36:43Z, the first of the PWA, another tunnel) read 911 ms with a Page share of
10 / 41 ms and a Tunnel share of 133 / 83 / 57 / 21 ms; `compare` against 12:47 reads `page` on
+17 ms of render delay for +35 ms of LCP, which is the wander an unchanged page shows between Runs
(34–60 ms of render delay across the Cloudflare Runs, the cold first Chrome of a session aside;
the ngrok ones ran to 95 ms), not a regression — one pair cannot tell the two
apart, and the verdict says so. The last Run before the PWA (2026-08-25T12:41:32Z) read 946 ms with
a Page share of 10 / 48 ms over 7 requests and 32.3 KB; the two requests the PWA adds are
`manifest.webmanifest` (594 B) and `icon-v1-180.png` (10.1 KB), and the 35 ms of LCP gained by
2026-09-02 was exactly the 35 ms Lantern's server-latency estimate fell by (92 → 57 ms), the
tunnel's. The last ngrok Run (2026-08-21T17:26:57Z) read TTFB 105 ms and FCP 894 / LCP 936 ms with
a Page share of 13 / 36 ms; the bytes differ (response headers ~70 B apart per request, and
Cloudflare gzips the favicon). Compare Runs through one Preview URL only — a Paired Run — and read
the Page share, which the Tunnel cannot move; load duration, TTFB and Lantern's estimates are the
Tunnel share, and two Runs of one page differ there first. A Win has to clear the wander, so it
needs the `page` (or `image`) verdict on every repeat, not on one pair.

Bench of record (benches/contribute-displayed-recommend-induction.trycloudflare.com-20260903T175220Z.json,
2026-09-03T17:52:20Z, 3 rounds, GTM-PRVCQ335: one Google Tag ([SFP] 01 GA4 Config, id
G-CNGFJDDBFB) on the built-in All Pages trigger, consent-gated (consentSettings.consentStatus=NEEDED
on analytics_storage, no CMP banner); one constant variable holding the Measurement ID, plus the
five built-in ones. Published 2026-09-03, superseding the empty floor.): control medians TBT 0 ms,
LCP 931 ms, 9 requests, 43.7 KB; gtm: TBT +208 ms (real) · LCP +21 ms (real) · requests +3 (real) ·
transferred +291.0 KB (real) · third-party bytes +290.7 KB (real); gtm-deferred: TBT +280 ms
(real) · LCP +17 ms (real) · requests +3 (real) · transferred +291.0 KB (real) · third-party bytes
+290.7 KB (real). Ten Runs, no marks. Both Arms now also fetch `www.google-analytics.com` — the
config tag still sent a hit despite `consentSettings.consentStatus=NEEDED`, since nothing in this
container sets an explicit default consent state (no CMP) for the tag's runtime to read as denied;
worth confirming directly in GTM's consent-state debugger if that matters for a later container.
Everything the floor Bench
(benches/cartoons-environmental-undergraduate-emission.trycloudflare.com-20260903T161359Z.json)
called within the wander is real here: a container that actually does something costs LCP as well
as TBT. The one surprise: `gtm-deferred` costs *more* TBT than `gtm` (+280 ms against +208 ms),
not less, while still costing *less* LCP (+17 ms against +21 ms) — TBT sums blocking time across
the whole trace, not only before paint, so moving the container's execution later shifts it out of
LCP's way without shrinking it; deferring helps what it can help and nothing else. Performance
reads 96 (`gtm`) and 94 (`gtm-deferred`) against the control's 100 — the first Arm scores below
100 a Bench has produced. Its 43.7 KB control median predates both the ETag and the Routes: the
document has grown 674 bytes since, and against this `server.py` the control now reads 43.9 KB. Read
a later Bench's Arm costs against its own control's medians, never against these.

## Change guidelines

- Keep the Storefront framework-free and dependency-free unless a migration is explicitly requested.
- Anything that gets in the way of evolving the Storefront is contested and kept only if necessary.
  A rule that survives the contest is recorded in `docs/adr/` with the reason it survived; a rule
  that does not is reversed there too (ADR 0001 is the first).
- Plans live in `docs/superpowers/plans/`, dated, and are committed with the work they describe.
- Image facts change in `images/slots.json` first; then rebuild with `tools/build-images.py` and
  update the markup until the contract is green. Icon facts change in `manifest.webmanifest` first;
  then rebuild with `tools/build-icons.py`.
- Arm facts change in `bench/arms.json` first; then rebuild with `node tools/build-arms.mjs`. Any
  change to `index.html` rebuilds the Arms (asserted). The container is the user's own; what it
  holds is written in the table's `holds` note whenever it changes, and every bench record copies it.
- Route facts change in `routes.json` first; then rebuild with `python tools/build-pages.py`, and
  then `node tools/build-arms.mjs`, because the block lands in `index.html` and every Arm is
  derived from it. Never hand-edit between the `routes.json:` marker comments.
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
