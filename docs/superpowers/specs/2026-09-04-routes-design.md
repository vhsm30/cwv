# Routes: a generated head, a real mobile nav, revalidation, and a Repeat Visit

Design for P2 of `docs/superpowers/plans/2026-09-02-ecommerce-bench.md`, settled in conversation on
2026-09-04. Status: approved. The implementation plan is
`docs/superpowers/plans/2026-09-04-routes.md`; two things this document said were corrected while
that plan was written, both marked in place — D17 becomes CSS-only, and the mutation harness has to
be fixed before any new row means anything. A third was corrected during execution and is marked in
place the same way: the canonical is **absolute**, not document-relative. A Run of
2026-09-04T18:31:37Z scored SEO 92 against this document's reasoning, and `reports/` holds it.

## What P2 answers

The site was not complete enough to make event tracking (P4) worth measuring: no canonical, no
Open Graph/Twitter tags, a nav that vanishes below 700px with nothing to replace it, a section
nested where it shouldn't be, no revalidation on a repeat view, and no way to measure what the
Worker actually saves a returning visitor. P2 answers all of it — B7, D14, D15, D17, D18, D23 —
without adding a second URL: the Storefront stays one document, `index.html`, but its `<head>`
gains a generated block, its nav gains real mobile behaviour, `server.py` gains revalidation, and
the Run gains a second, honestly-named measurement for a warm visit. P3 (the catalogue, multiple
Routes) is what event tracking will actually need; P2 is the infrastructure it stands on.

## Decisions taken in brainstorming

| Decision | Choice | Why |
|---|---|---|
| Does P2 produce more than one URL | No — infrastructure only, `index.html` becomes generated | The site needs a real catalogue (P3) before multiple Routes mean anything; P2 is what P3 will stand on |
| Generator depth | A thin `<head>`-block generator (canonical + OG/Twitter only) | D14/D15 are the only two items that are actually *data*; D17/D18 are markup/CSS decisions, not facts a generator should derive |
| D17 (nav below 700px) | A CSS-only wrapped nav row — the header wraps and the nav takes the second line (**revised 2026-09-04 while planning**; originally a vanilla-JS disclosure) | "Accept it and document it" leaves the regression in place. A disclosure needs the behaviour, and the behaviour is served `immutable`, so editing it forces a new Generation — a new filename, `<script src>`, `PUBLIC` row, `SHELL` entry and `sw.js` cache name moving together, with `app.v2.min.js` kept and asserted 404. That contradicts this spec's own "Untouched, on purpose: `sw.js`", and it is a large, measurement-sensitive change to buy a toggle for two links |
| The facts file | New `routes.json`, not folded into an existing file | Matches the plan's own proposed vocabulary ("Route"); gives P3 a table to extend rather than a file to invent |
| Canonical form | ~~Document-relative (`./`), never absolute~~ **Absolute, on a `site` origin the table declares** (**revised 2026-09-04 during execution**) | The original reasoning — Preview URLs are random per session, so there is no stable origin to name — was wrong about what a canonical is for. It names where a page *prefers* to live, not where it happens to be served, and Lighthouse scores a relative one 0 outright: the Run of 2026-09-04T18:31:37Z read `canonical | score 0 | Is not an absolute URL (./)` and SEO 92. `routes.json` gained a `site` key, `https://field-notes-supply.example`, a reserved host rather than any Preview URL, and the contract pins every Route's canonical to that origin |
| Generator language and shape | Python (`tools/build-pages.py`, ADR 0001's own naming), self-normalizing: reads and rewrites the same file's own `<head>`, idempotent on rebuild | The first generator whose source and output are the same document, since title/description must be read from the page rather than duplicated (D15's own note) |
| Insertion mechanism | Python stdlib `html.parser.HTMLParser`, structured, never regex; the generated block bracketed by two HTML comments so a rerun replaces rather than duplicates | Matches the rigor `lib/page.mjs`'s `parsePage` already applies in JS; CLAUDE.md's explicit rule against building patterns from strings |
| D23 scope | `NO_CACHE` rows only (the document, the manifest, `sw.js`, the crawler files, the Arms) | `IMMUTABLE` rows already avoid revalidation via `max-age=1y`; an ETag there would be dead code |
| B7 scope | A same-URL reload with storage kept, not cross-Route navigation | BACKLOG.md's own Shape paragraph is a reload story; the plan's "navigating between Routes" line was the *reason* to schedule it here, not a requirement it wait for P3 |
| B7 naming | A new CONTEXT.md term, **Repeat Visit**, never "Run" | BACKLOG.md: "Not a Run by CONTEXT.md's definition until CONTEXT.md says so" |
| ADR | Amend ADR 0001 in place | It already anticipated exactly this generator and left its own forward reference ("`index.html` stays hand-written until it exists") to be resolved, not reversed |

Rejected: heavier generators that would reconstruct more of the head, or template the whole
document from data — unnecessary for what D14/D15 actually need, and it would make `index.html`
stop being the hand-authored artifact ADR 0001 anticipated keeping.

## 1. Routes as data

**`routes.json` is the one home of every Route fact**, as `images/slots.json` is for images. Two
consumers only, deliberately: the generator, and the Performance Contract. `server.py` is *not*
wired to read it in P2 — there is exactly one URL, unchanged, and doing so now would be YAGNI ahead
of P3, which is where a second Route would actually need a new `PUBLIC` row. Shape:

```json
{
  "site": "https://field-notes-supply.example",
  "routes": [
    {
      "path": "/",
      "file": "index.html",
      "canonical": "https://field-notes-supply.example/",
      "og": { "image": "images/hero-1200.jpg", "card": "summary_large_image" }
    }
  ]
}
```

Deliberately thin: `og:title`/`og:description` are not here. They are derived at generation time
from the route's own `<title>`/`<meta name="description">`, per D15's note — read from the same
model rather than written twice. Only `canonical` (varies per Route) and `og:image`/`card`
(nothing else in the page states these) are genuinely new facts.

## 2. The generator

`tools/build-pages.py` (ADR 0001's own naming) reads `routes.json` and, for each route, parses that
route's own `file` with Python's stdlib `html.parser.HTMLParser` — structured tag-walking, matching
the rigor `lib/page.mjs`'s `parsePage` applies in JS, never regex, never a literal string splice.
It reads the title and description already in the document, and writes a `<head>` block:

```html
<!-- routes.json: begin -->
<link rel="canonical" href="https://field-notes-supply.example/">
<meta property="og:title" content="…">
<meta property="og:description" content="…">
<meta property="og:image" content="images/hero-1200.jpg">
<meta name="twitter:card" content="summary_large_image">
<!-- routes.json: end -->
```

The two comments are the insertion point: found via the parser's comment callback (never a string
search on the document), so a rerun replaces what is between them instead of duplicating it. When
absent, the block is inserted immediately before `</head>`, the one anchor every document has
exactly once.

This is a different shape from every other generator in the repository (`build-images.py`,
`build-icons.py`, `build-arms.mjs`): those are pure `facts → separate output` derivations; this one
reads and rewrites the same file it derives from, for the part of the document that stays
hand-authored. "Byte-identical rebuild" means the same thing it always has, just self-referentially:
running `tools/build-pages.py` again against what is already committed changes no byte.

## 3. D17 + D18: hand-edited, no generator involved

**D18** — close `<section class="catalog" id="shop">` before `<div class="note" id="story">`
begins; give `#story` its own `<section aria-labelledby="story-title">` around the `<h2>` it
already has. Markup restructuring only, in the committed template — not something `routes.json`
should ever describe.

**D17** — below 700px, the nav wraps to its own row beneath the brand and the bag instead of
vanishing with nothing to replace it: `header{flex-wrap:wrap}` plus `nav{order:3;width:100%;
justify-content:center;padding-top:1rem}` inside the existing `@media(max-width:700px)` block. One
rule, no JavaScript, no markup change, and both links stay visible and focusable at every width.
Doing this alongside D18 avoids touching the nav's surrounding CSS twice, since D18 already moves
`.catalog`'s and `.note`'s rules next to it.

This replaces the disclosure button first written here. A toggle needs the behaviour;
`app.v2.min.js` is served `immutable` and is its own cache key, so any content change to it is a
new Generation by CLAUDE.md's own rule — the filename, the `<script src>`, the `PUBLIC` row, the
`SHELL` entry and `sw.js`'s cache name all move together and the superseded file stays on disk
asserted 404. That contradicts this spec's own "Untouched, on purpose: `sw.js`", and it puts a
Generation change inside a phase whose Runs are meant to be comparable to the ones before it.

## 4. D23: ETag/304 on the Measurement Server

`server.py`'s `respond()` (`server.py:131`) already reads `body = file.read_bytes()` fresh on every
request, for every `PUBLIC` and `DIRECTORIES` file — no boot-time cache exists to invalidate. For
the seven `NO_CACHE` rows only (the document, `robots.txt`, `llms.txt`, `manifest.webmanifest`,
`sw.js`, and the two Arms), an ETag is computed from those same bytes — `sha256` of the *uncompressed*
body, quoted — before any gzip work happens. A matching `If-None-Match` short-circuits to a 304 with
an empty body and the same `Cache-Control`/`ETag`/`Vary` headers, skipping the compression the 200
path would have paid for; a non-matching or absent one proceeds exactly as today, with `ETag` added
to the 200 response. `IMMUTABLE` rows are untouched — `max-age=1y` already means they are never
revalidated, so an ETag there is dead code.

## 5. B7: the Repeat Visit

`tools/run.mjs` gains a two-pass measurement: an ordinary storage-cleared Lighthouse pass first
(installs the Worker; nothing about it is saved), immediately followed by a second pass in the same
Chrome instance with `--disable-storage-reset`. The second pass's Report is the one saved and named
`<host>-repeat-<UTC fetchTime>Z.json`, following the Arm naming precedent.

`lib/report.mjs`'s `checkReport` (`lib/report.mjs:114-125`) takes a `repeat` flag. `false`
(default) is exactly today's behaviour — refuses a Report that kept storage. `true` inverts the
same three checks — refuses a Report that did *not* keep storage, i.e. requires
`disableStorageReset === true` and requires `service_workers`/`cache_storage` to be *absent* from
`clearStorageTypes` — the mirror-image mistake of the normal path.

Scope, stated plainly: this measures a reload of the same Preview URL, not a navigation between two
Routes. The full "the Worker tops up a second page" story stays unmeasured until P3 gives the
Storefront a second URL; what P2 buys is the Shell-from-cache half — what a returning visitor pays
for the document and its own assets.

## 6. Assertions and the mutation check

**`tests/performance-contract.mjs`** (same single `page` object — one document, so none of the
module-scope restructuring a second document would eventually need applies yet): canonical `href`
agrees with `routes.json`, parses as an absolute URL and sits on the table's own `site` origin
(**revised 2026-09-04 during execution**; originally "and is relative"); `og:title`/`og:description` equal the page's own
`<title>`/`<meta name="description">`; `og:image` resolves to a real file on disk; `twitter:card` is
a valid value. D18: `#story`'s section is not nested inside `#shop`'s, and both carry real
`aria-labelledby` targets. D17: the nav's `display`, cascaded per `@media` context the same way the
contract already cascades image boxes, is never `none` in any context.

Every one of these is new, so each gets a row in `tools/mutate-contract.mjs`, designed against the
mutation rather than after: corrupt the canonical, break OG/title agreement, delete the generated
block outright, re-nest `#story`, hide the nav again.

One thing has to be fixed before any of those rows means anything, and it is not in this spec's
scope as written. `tools/mutate-contract.mjs` runs `tests/performance-contract.mjs` **and**
`tests/bench.mjs`, and `tests/bench.mjs` holds every Arm equal to `buildArm(index.html, …)` — pure
insertion, so any byte of `index.html` fails it. Every `page(...)` row therefore comes back
`caught` whether or not the contract noticed anything; M7 and M8, documented in that file as
harmless, are marked `caught` for exactly that reason. A page mutation must rebuild the Arms from
the mutated control before the contract runs, with one row opting out on purpose to keep the
stale-Arm rule itself covered. That is the implementation plan's first task.

**`tests/measurement-server.mjs`**: for each `NO_CACHE` row — a first request returns an `ETag`; a
second with `If-None-Match` set to it returns 304 with an empty body; one with a deliberately wrong
`If-None-Match` returns 200 with the full body and the same ETag as before, proving the check isn't
always-304ing.

**`tests/run.mjs`** (extending the assertion BACKLOG.md itself names, `tests/run.mjs:123`): the
`repeat: false` path still refuses kept storage exactly as today; a `repeat: true` check over a
synthetic kept-storage Report accepts it and refuses the same Report's cleared-storage twin; the
naming produces `-repeat-`.

## 7. Vocabulary and documents

CONTEXT.md, two new terms:

- **Route**: One URL of the Storefront a Run can be taken against. _Avoid_: page, endpoint, view.
- **Repeat Visit**: A second Lighthouse pass through the Preview URL in the same Chrome profile as a
  preceding one, storage kept so the Worker the first pass installed can serve the Shell and top up
  the rest. Not a Run — its Report is refused by the Run's own `checkReport` and accepted only by
  the Repeat Visit's. _Avoid_: warm Run, cached Run, second Run.

**ADR 0001** is amended, not superseded: its Consequences line — "`index.html` stays hand-written
until [a document generator] exists" — is resolved in place, noting that as of P2,
`tools/build-pages.py` generates the canonical/OG block and the rest of the document stays
hand-written.

**CLAUDE.md**: the opening paragraph's "`index.html` is hand-written and hand-minified today" is
qualified (content hand-written, head block generated, ADR cited); a new Architecture paragraph,
"`routes.json` is the one home of every Route fact," mirrors the images/icons/arms paragraphs; a
short paragraph after the existing Worker paragraph introduces the Repeat Visit and its own
`checkReport`/naming rule; Commands gains `python tools/build-pages.py` and the Repeat Visit's CLI
form; Change guidelines gains "Route facts change in `routes.json` first; then rebuild with
`python tools/build-pages.py`."

**BACKLOG.md**: B7, D14, D15, D17, D18, D23 move to Done, each citing this document and the plan
that will follow it. The two Set-aside items premised on "one URL" (per-Product URLs / a sitemap)
are untouched — P2 does not change that premise — but get a note that they need revisiting once P3
lands a second Route.

## Files

- New: `routes.json`, `tools/build-pages.py`, this document, the Reports of the live verification.
- Modified: `index.html` (generated head block; hand-edited nav CSS and `#story`), `server.py`
  (ETag/304), `tests/measurement-server.mjs`, `lib/report.mjs` (`checkReport`'s `repeat` flag,
  naming), `lib/page.mjs` (a `property()` accessor — `meta()` reads only `attrs.name`, and Open
  Graph names its metas with `property=`), `tools/run.mjs` (the two-pass measurement, CLI surface),
  `tests/run.mjs`, `tests/performance-contract.mjs`, `tools/mutate-contract.mjs`, `CONTEXT.md`,
  `CLAUDE.md`, `docs/adr/0001-tooling-may-generate-what-ships.md`, `BACKLOG.md`.
- Regenerated, never hand-edited: `arm-gtm.html`, `arm-gtm-deferred.html` — every change to
  `index.html` demands `node tools/build-arms.mjs`, asserted.
- Untouched, on purpose: `sw.js`, `app.v2.min.js`, `manifest.webmanifest` (both in-page routes keep
  their ids, so the shortcuts stay true), `llms.txt`, `robots.txt`, `bench/arms.json`,
  `tools/build-arms.mjs`, `tools/bench.mjs` — nothing here changes what an Arm or a Bench is, and
  nothing here is a new Generation.

## Verification

1. `node --test "tests/**/*.mjs"` green with the new assertions counted; `node
   tools/mutate-contract.mjs` at its new caught/harmless count, every new row caught.
2. `python tools/build-pages.py` run twice in a row: the second run changes no byte.
3. `python server.py 0`; `tests/measurement-server.mjs` proves the ETag/304 behaviour for every
   `NO_CACHE` row.
4. A live Repeat Visit measurement against the currently-running tunnel — this is just another
   `node tools/run.mjs` invocation and does not touch the running server/tunnel pair, which is not
   to be restarted. CLAUDE.md's current state is refreshed from a live Run once the head block and
   nav land.

## Out of P2

Multiple Routes and everything that needs them: the catalogue (P3), structured data (B6, P3),
per-Product URLs and a sitemap (both still premised on one URL; revisit when P3 lands). Cross-Route
Worker top-up measurement. Event tracking (P4). Any Arm/Bench change — GTM's own Arms are untouched.
