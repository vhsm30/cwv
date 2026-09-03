# The Bench: control, client-side GTM, deferred GTM

Design for P1 of `docs/superpowers/plans/2026-09-02-ecommerce-bench.md`, settled in conversation on
2026-09-03. Status: approved in sections; awaiting review of this document before the plan is
written.

## What P1 answers

What Google Tag Manager costs the Storefront on a first visit, measured on the cleanest control
that will exist: TBT 0, CLS 0, 9 requests, 43.7 KB, 100 / 100 / 100 / 100, through one Preview URL,
with the wander of the unchanged page measured in the same session rather than quoted. Three
**Arms**: the control (the Storefront as it is), the container loaded the way clients load it
(Google's snippet at the top of the head), and the container loaded after `load` when the browser
is idle. The load cost of a container lands in TBT, LCP, requests and bytes, all of which a Run
measures today. Its interaction cost does not, and belongs to P4.

## Decisions taken in brainstorming

| Decision | Choice | Why |
|---|---|---|
| Container | The user's own, `GTM-PRVCQ335` | The Arm measures the real `gtm.js`; a client's container is never pointed at |
| Deferral | After `load`, then an idle callback with a one-second ceiling | It always loads inside the Run's trace, so a navigation Run sees it; interaction-triggered loading depends on Lighthouse's wait, not the page, and is P4's |
| Consent | A real CMP in the container, once configured | The most realistic client shape; the bench measures the CMP as much as the tags, and says which container it measured |
| Arm URLs | Generated Arm documents beside the control (approach A) | The control stays `index.html`, untouched; each Arm's diff against it is its snippet and nothing else; nothing a Run measures is produced at request time (ADR 0001) |

Rejected: one document with the Arm picked by query string (a loader would ship to the control),
and injection at request time (what the Run measured would not exist on disk).

## 1. Arms as data and documents

**`bench/arms.json` is the one home of every Arm fact**, as `images/slots.json` is for images and
`manifest.webmanifest` for icons. Consumers: the generator, `server.py`, the Run's pre-flight, the
bench, `tests/bench.mjs`, and CLAUDE.md's paragraph. Shape:

```json
{
  "container": {
    "id": "GTM-PRVCQ335",
    "holds": "empty: version 1, published 2026-09-03, no tags, no triggers"
  },
  "arms": [
    { "name": "control",      "path": "/",                      "file": "index.html",            "delivery": "none" },
    { "name": "gtm",          "path": "/arm-gtm.html",          "file": "arm-gtm.html",          "delivery": "head" },
    { "name": "gtm-deferred", "path": "/arm-gtm-deferred.html", "file": "arm-gtm-deferred.html", "delivery": "after-load" }
  ]
}
```

One container serves both GTM Arms: they differ by delivery only. `holds` is prose, written by
hand when the container changes, and copied into every bench record, so a reading years later
knows what was measured. The control is a row so that every consumer iterates one table.

**`tools/build-arms.mjs` derives each Arm document from `index.html`.** It exports one function,
`buildArm(control, arm, container)`, and its command-line form writes every Arm with a delivery
other than `none`. Insertion points are found through `lib/page.mjs` (the start tag of `body`, the
`charset` meta, the end of `body`), never by regex on strings. The two deliveries:

- `head`: Google's standard snippet, verbatim, with the ID substituted, inserted immediately after
  the `charset` meta, which is as high in the head as the charset rule allows and where clients
  put it; and the standard `<noscript><iframe …/ns.html?id=…>` immediately after the `body` start
  tag. The snippet injects `gtm.js` with `async` before the first script in the document, which in
  the head is the snippet itself.
- `after-load`: one inline script immediately before `</body>`, after the behaviour: on `load`,
  `requestIdleCallback` (falling back to `setTimeout`) with `{ timeout: 1000 }` seeds `dataLayer`
  exactly as the standard snippet does (`gtm.start`, `event: 'gtm.js'`) and appends the same
  `gtm.js` to the head, `async`. No `noscript`: there is no standard form to be verbatim about.

Nothing else differs from the control. The Arm files live at the repository root so every relative
URL in the document (`./images/…`, `./sw.js`, `./manifest.webmanifest`) resolves exactly as from
`/`, and the Worker the behaviour registers is the same `/sw.js`. Arms are documents, `no-cache`,
not Generation-stamped, like `index.html`. A change to `index.html` demands `node
tools/build-arms.mjs`, as a Master's change demands its Rungs; the assertion below notices when it
was forgotten.

## 2. Serving

`server.py` reads `bench/arms.json` at boot and adds one `PUBLIC` row per Arm whose path is not
`/`: its file, `NO_CACHE`. The existing boot check covers the `.html` policy row. Nothing else in
the server changes: no Content-Security-Policy (the server sends five headers and nothing else, on
purpose, BACKLOG.md's security-headers note), no `robots.txt` change (the Arms are duplicates of the
page on a hostname that lives one session; nothing indexes them, and a `Disallow` would move the
Arm's SEO score for no reading).

`tests/measurement-server.mjs` reads the same table and holds each Arm served as HTML, gzipped when
asked, `no-cache`, bytes equal to the file on disk, HEAD matching GET; and the control row still
`/` → `index.html`.

## 3. The Run on an Arm

- **Pre-flight** (`tools/run.mjs`): the document on disk to compare against is looked up by the URL's
  path through `bench/arms.json` (`/` → `index.html`, `/arm-gtm.html` → `arm-gtm.html`); a path
  the table does not name is refused before Chrome launches. The asset warm covers same-origin
  assets only: the container's URL is in the Arm's assets and is not ours to warm.
- **`checkReport`** (`lib/report.mjs`): the Report's requested URL must equal the URL asked, path
  included, not host alone, so a Report of the wrong Arm is refused. Third-party requests stay
  allowed (only ngrok's CDN is refused, as today).
- **`reportName`**: `<host>-<slug>-<stamp>.json` when the path is not `/`, the slug being the path
  without its slash and extension (`arm-gtm`); the control's name is unchanged. CONTEXT.md's
  definition holds: the name is the Preview URL and the moment.
- **`summarize`** gains the third-party account: `thirdParty: { requests, transferBytes, origins }`,
  every request whose host is not the Preview URL's, by origin. `formatSummary` prints one line,
  `third parties: 4 requests · 71.2 KB (www.googletagmanager.com)`, or `third parties: none`.
- **`compare`** prints, in its header, when the two Reports are of different documents. The verdict
  rule is untouched: it attributes LCP, and an Arm's LCP difference is read the same way.
- **D12** narrows to the newest Report of the control: after a bench the newest Report is usually
  an Arm's, and CLAUDE.md's current state is the Storefront's.

## 4. The Bench procedure

`tools/bench.mjs`, new:

```
node tools/bench.mjs https://<name>.trycloudflare.com/ --rounds 3
node tools/bench.mjs read benches/<file>.json
```

The first form performs, through the one tunnel, a warm-up Run of the control, then `rounds`
rounds of every Arm in the table's order, control first. Every Run is `performRun` from
`tools/run.mjs`: pre-flighted, checked, saved under `reports/`, summarised. The warm-up exists
because the first Chrome of a session renders slower (render delay 131 ms against 47 ms two minutes
later on 2026-09-03) and no page did that. A refused Run stops the bench with its reason; the
Reports so far stay. Ten Runs, about seven minutes.

The bench then writes `benches/<host>-<UTC start>Z.json`: the Preview URL, the rounds, the
container as recorded in the table at the time (`id`, `holds`), the ordered Runs, each with its
Arm, its role (`warm-up` or `round n`) and its Report's name, and the reading. The `read` form
re-reads the named Reports and prints the same reading, so the record is the Reports and never the
summary. `benches/` sits beside `reports/`.

## 5. The reading

For every Arm and every measure, min, median and max across the rounds, warm-up excluded:

- TBT, LCP, FCP;
- requests, transferred bytes, third-party bytes;
- the Page share (load delay, render delay) and the Tunnel share's server-latency estimate, so an
  LCP difference can be read the way `compare` reads one, and a cold-tunnel Run is visible.

An Arm's **cost** on a measure is the difference of medians against the control. It is called
**real** when the Arm's Runs and the control's do not overlap — every Arm value beyond every
control value in the direction of the cost — and otherwise **within the wander**. There is no
threshold: the control's own spread across the same session is the floor, measured rather than
quoted. Three rounds is the minimum that has a spread; the `--rounds` flag raises it.

Two marks: a Run carrying the cold-tunnel artifact is marked as such in the record and the table,
and an Arm Run whose Report holds no request to the container's origin is marked `container not
loaded` — the deferred Arm's idle callback landing outside Lighthouse's trace would show up here
first, and the first live bench decides whether the one-second ceiling is right.

## 6. Assertions and the mutation check

`tests/bench.mjs`, new, holds:

- the table well-formed: names unique, one `control` at `/` → `index.html` with delivery `none`,
  every other path root-level `/<file>.html`, the container ID of the `GTM-` shape;
- every Arm on disk equal to `buildArm(index.html on disk, arm, container)`; no `arm-*.html` on disk
  the table does not name;
- the `head` Arm differing from the control by the two standard snippets only, and the
  `after-load` Arm's head byte-identical to the control's, its only addition one script before
  `</body>`;
- the third-party account over a Report with synthetic `googletagmanager.com` requests, and `none`
  on the Run of record;
- the overlap rule over synthetic summaries: real, within the wander, and the direction of cost;
- `reportName` with the slug; `checkReport` refusing a Report whose path differs; the pre-flight
  accepting an Arm against a fake server and refusing an unnamed path;
- D12 narrowed to the control.

The Performance Contract is not touched: its rules are the control's identity and keep holding for
`index.html` alone. `tools/mutate-contract.mjs` runs `tests/bench.mjs` as well, its `FILES` gains
the two Arm documents and the table, and four rows are added: the head snippet removed from
`arm-gtm.html` (caught), the container ID changed in one Arm only (caught), the head Arm's snippet
moved below the stylesheet (caught), the table's ID changed without a rebuild (caught).

## 7. Vocabulary and documents

CONTEXT.md, a new group after "Two Runs side by side":

- **Arm**: The Storefront delivered with one way of loading the tags, at its own URL; the control is
  the Storefront delivered with none. _Avoid_: variant, treatment, version, experiment, test page.
- **Bench**: One session of Runs through one Preview URL, every Arm in turn for several rounds, read
  as each Arm's spread against the control's. _Avoid_: benchmark, A/B test, experiment, study.

CLAUDE.md: a Bench paragraph in Architecture (the table as one home, the generator, the reading
rule and its two marks); the commands (`node tools/build-arms.mjs`, the two bench forms, `node
--test tests/bench.mjs`); a Change guideline ("Arm facts change in `bench/arms.json` first; then
rebuild with `tools/build-arms.mjs`. A change to `index.html` rebuilds the Arms."); and the bench of
record beside the Run of record, one sentence per Arm with its medians and what was called real.
The `measuring-runs` skill gains the procedure. BACKLOG.md's bench section notes P1 built; nothing
listed is absorbed (B7 is P2's).

## 8. The container

`GTM-PRVCQ335` exists (export of 2026-09-03: version 0, five built-in variables, no tags, no
triggers) and has never been published, so `gtm.js` is not served for it yet. Two bench sessions,
in order:

1. **The floor.** Publish the container as it is. The first bench measures the GTM runtime alone,
   which is the cost under any container, and the empty-container reading is the one every later
   reading is compared with.
2. **The realistic container.** Add what a client ships: a GA4 configuration tag with a bench
   property of the user's, the CMP loaded by GTM (a Community Template or a Custom HTML tag),
   consent defaults, and whatever else the user wants measured; publish; update `holds`; bench
   again. One caution: CMP vendors key their configuration to registered domains, and the Preview
   URL is a hostname that lives one session, so the banner may not render there even though the
   script loads and runs. The Report's screenshots say whether it did, and the reading names the
   container it measured either way.

Nothing else is needed: a GTM container is not domain-restricted, and the container's name is
irrelevant to loading.

## Files

- New: `bench/arms.json`, `tools/build-arms.mjs`, `arm-gtm.html`, `arm-gtm-deferred.html`,
  `tools/bench.mjs`, `tests/bench.mjs`, `benches/` (records), the Reports of the live bench.
- Modified: `server.py` (Arm rows from the table), `tests/measurement-server.mjs`, `tools/run.mjs`
  (pre-flight lookup by path, same-origin warm), `lib/report.mjs` (`checkReport` URL equality,
  `reportName` slug, the third-party account, the `compare` header), `tests/run.mjs` (D12 narrowed,
  naming), `tools/mutate-contract.mjs`, `CONTEXT.md`, `CLAUDE.md`, `BACKLOG.md`,
  `.claude/skills/measuring-runs/SKILL.md`.
- Untouched, on purpose: `index.html`, `sw.js`, `manifest.webmanifest`, `llms.txt`, `robots.txt`,
  `tests/performance-contract.mjs`. `lib/page.mjs` changes only if the generator needs the end
  offset of a start tag exposed, and then by that one addition.

## Verification

1. `node --test "tests/**/*.mjs"` green with the new file counted; `node tools/mutate-contract.mjs`
   at 38/38.
2. `node tools/build-arms.mjs` twice: the second run changes no byte.
3. `python server.py 0` serves both Arms; `tests/measurement-server.mjs` proves it.
4. Live, with the `measuring-runs` skill loaded: publish the container; start a tunnel; wait and
   confirm the name with `nslookup … 1.1.1.1`; `node tools/bench.mjs https://<host>/ --rounds 3`;
   read the record; check that every GTM Arm Run holds a request to `www.googletagmanager.com` and
   that the deferred Arm's arrived after LCP. Then CLAUDE.md's current state and bench of record
   are written from the printed lines, and everything is committed together with this document
   and the plan.

## Out of P1

Interaction cost and INP (P4). Any Arm that needs a domain: Stape, Zaraz, Tag Gateway (P5).
Partytown. Consent-mode variants as separate Arms. Any change to the control.
