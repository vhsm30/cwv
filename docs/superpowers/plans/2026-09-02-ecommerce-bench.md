# Evolving the lab into an e-commerce CWV bench

## Context

The Storefront has run out of Wins. The performance score is 80% weighted on metrics that
structurally cannot move on this page — TBT 30% (0 ms, 942 bytes of script), CLS 25% (0, nothing
moves) — and of LCP's 911 ms only 134 ms is the page's own share; the rest is the tunnel. The
review of 2026-08-27 already recorded the conclusion in the repo's own words: *"No performance
item is recorded below — there is none to record."* By CONTEXT.md's definition a Win needs a metric
a Run shows moving, so the loop has nothing left to move.

Confirmed against the newest Report: `interaction-to-next-paint` is absent from all 155 audits, and
`inp-breakdown-insight` comes back `notApplicable` — a navigation Run has no interactions. The lab
is blind to the one Core Web Vital that e-commerce loses on.

Growing the Storefront is therefore not scope creep; it is the only way the loop keeps running. But
the direction is sharper than "add more pages". `C:\Users\victo\Documents\Projects\Mod3zero` names
two live client pains this repo is uniquely placed to answer:

1. **Platforms give poor, non-standard data layers** (VTEX, Magazord, Loja Integrada). Nobody
   ships a correct reference implementation.
2. **Tag delivery costs CWV, and every number in the market is vendor marketing.** The Mod3zero
   pack flags it twice: Google's 11–14% "uplift" measures script loads, the 10–35% VTEX purchase
   loss is a consultant's, *no independent controlled study exists* — because almost nobody has a
   clean control.

This repo **is** the clean control: TBT 0, CLS 0, 9 requests, 43.7 KB, 100/100/100/100, an
executable Performance Contract, and a Run that refuses dishonest Reports. Every millisecond an
Arm costs here is attributable to that Arm.

### The Cloudflare question, answered

Three problems get conflated and only one is a CWV problem. The Mod3zero pack already has the
decisive line about Google Tag Gateway — *"Só o TRANSPORTE. Execução segue no browser."*

| Problem | What fixes it | CWV? |
|---|---|---|
| Blocking / signal loss (adblock, ITP) | Tag Gateway, Stape Custom Loader, sGTM | No |
| Bad data (LI pre-payment purchase, dupes) | data-layer contract + server-side purchase | No |
| **Main-thread cost (TBT / INP)** | execute elsewhere · ship fewer vendor scripts · load later | **Yes** |

So: **Cloudflare yes — Zaraz, not Tag Gateway.** GTG serves the same `gtm.js` from your domain:
identical bytes, identical parse, identical main-thread work. Only three things move TBT/INP —
Zaraz (edge Worker), Partytown (web worker; VTEX FastStore already ships this), and sGTM insofar as
Meta CAPI / Ads stop being client-side scripts. Plus the unglamorous winner: defer the container
until after LCP or first interaction.

## Decisions taken

| Decision | Choice |
|---|---|
| Ambition | Full storefront short of payment — 10+ Routes: category, per-Product, Bag, search, facets, policy, account stub |
| No-build-step rule | **Reversed.** A generator writes documents to disk, as `build-images.py` owns `images/`. Standing principle: *anything that gets in the way of evolving this product is contested and kept only if necessary* |
| Stable domain | Not yet — designed as a clean seam; domain-gated Arms land in a later phase |
| Bench Arms | Control + client-side GTM + deferred GTM now; Stape sGTM/Custom Loader, Zaraz, Tag Gateway once a domain exists |
| Sequencing | Mine to decide (below) |

`tools/build-images.py` and `build-icons.py` already import **PIL**, so the rule that actually
holds is *nothing shipped to the browser has dependencies* — never *no tooling*. The build step is
consistent with existing practice, not a departure from it.

## Program

Six sub-projects. Each gets its own spec and plan when picked. **This plan's approval covers P0
only.**

| # | Sub-project | Why here |
|---|---|---|
| **P0** | **Make two Runs comparable** | You cannot run an A/B bench without it. Detailed below |
| P1 | The Bench: control · client-side GTM · deferred GTM | Needs no domain, no Routes. Uses the pristine control before the Storefront muddies it. Fastest Mod3zero value |
| P2 | The lab learns Routes (ADR + `build-pages.py` + routing) | Enabling change. Absorbs D14, D15, D17, D18 |
| P3 | The catalogue and the reference data layer | 10+ Routes to Mod3zero's house standard, with a data-layer contract — the executable `tracking-plan.md` §6 |
| P4 | Field vitals + interaction measurement | RUM beacon (p75) and a timespan Run, so INP is finally measurable |
| P5 | Domain-gated Arms | Stape, Zaraz, Tag Gateway, Meta CAPI, Ads, Merchant Center |

**Why P1 before P2/P3.** GTM's *load* cost lands in TBT, which a Run measures today with zero new
apparatus — half the answer, immediately, on the cleanest control that will ever exist. Its
*interaction* cost needs P4. P1's result also shapes P3: if deferred loading wins big, the data
layer must buffer events, and that is a design input, not an afterthought.

**Buy the domain when P5 is wanted.** ~US$10–15/yr, Cloudflare zone free, Zaraz free tier. Nothing
before P5 needs it.

## P0 · Make two Runs comparable

The bench's measuring instrument. **No page change at all** — `index.html`, `server.py`, `sw.js`
and the Performance Contract are untouched, and the Run of record stays 2026-09-02T18:36:43Z.
Backlog items B5, B8, B9 and D12 are absorbed here.

### P0.1 · Pre-flight that warms and refuses early (B5 + B9)

One request does both jobs, exactly as B9's shape says.

- `tools/run.mjs` — `performRun({ url, measure, reportsDir, preflight = fetchPreflight })`. The
  existing signature already has the seam; add one parameter and one `await` before `measure`.
- `preflight(url)` does one GET carrying `BYPASS_HEADERS`, and refuses **before Chrome launches**
  when the response is not 200, when the document is not the Storefront's, or when the connection
  fails — naming DNS as the likely cause, per the `measuring-runs` skill's "A fresh hostname and
  DNS". Today `previewUrlProblem` (a URL-shape test) is the only check before launch.
- Read the Storefront's marker through `lib/page.mjs`, never as a literal — CLAUDE.md's rule, and
  the reason B1 exists.
- `tests/run.mjs` — a counting fake asserts preflight runs before measure, and that measure does
  not run when preflight refuses. No tunnel, no Chrome.

### P0.2 · The summary names the tunnel's share (B8)

- `lib/report.mjs` `summarize` (`:150-176`) gains `network-server-latency`, `network-rtt`, and the
  `lcp-breakdown-insight` split (load delay / load duration / render delay) that CLAUDE.md
  currently reads by hand.
- `formatSummary` prints the page's share and the tunnel's share on separate lines.
- An out-of-band latency estimate becomes a **known artifact**, named the way ngrok's `robots-txt`
  artifact is at `lib/report.mjs:133-148`, so the summary says "the tunnel's" without a reader
  having to.
- Assertions run over the twin Reports already on disk — `…-20260902T182424Z.json` (267 ms) and
  `…-20260902T183643Z.json` (60 ms), same page share, LCP 1114 vs 911 ms.

### P0.3 · The Paired Run

New, and the reason P0 exists. Two Runs of the same Storefront through the **same** Preview URL,
minutes apart, so the tunnel's share cancels.

- `lib/report.mjs` gains `compare(a, b)`: deltas for scores, FCP/LCP/TBT/CLS, requests and bytes,
  with the page's own LCP share reported separately from the tunnel's, and a refusal to call a
  difference meaningful when the tunnel's share moved more than the page's.
- `node tools/run.mjs compare <a.json> <b.json>` prints it.
- Assertion over the two 2026-09-02 Reports: `compare` must say *the tunnel moved, the page did
  not*. That is the cautionary tale the bench exists to avoid, and the evidence is already on disk.
- The procedure (alternate control and variant through one tunnel, N repeats) goes in the
  `measuring-runs` skill.

### P0.4 · Tie CLAUDE.md's current state to the newest Report (D12)

Backlog's own shape: an assertion in `tests/run.mjs` reads the fetchTime CLAUDE.md cites, asserts
it is the newest Report under `reports/`, and asserts the quoted scores and metrics match that
Report's summary.

### P0.5 · `docs/adr/ADR-001` — tooling may generate; the browser stays dependency-free

The backlog already flagged that `docs/adr/` does not exist and the no-build-step rule "deserves
one". Record the reversal and its reason: PIL is already a tooling dependency, `images/` and
`icons/` are already generated and committed, and the rule that survives is about shipped bytes.
CLAUDE.md's "no build step" line and BACKLOG.md's Set-aside entry both cite it.

### P0.6 · BACKLOG.md bookkeeping

Mark B5, B8, B9, D12 absorbed by P0, and note which phase absorbs B6, B7, D14, D15, D17, D18, D23
— so the evolution pays the backlog down instead of orphaning it. CLAUDE.md's backlog rule is what
requires this.

### Files

`tools/run.mjs` · `lib/report.mjs` · `tests/run.mjs` · `.claude/skills/measuring-runs/SKILL.md` ·
`docs/adr/ADR-001-*.md` (new) · `BACKLOG.md` · `CLAUDE.md`

Reuse rather than rebuild: `previewUrlProblem`, `checkReport`, `reportName`, `summarize`,
`formatSummary` (all `lib/report.mjs`), `recordedMeasure` (`tools/run.mjs`), and `lib/page.mjs` for
any fact about the page.

## Verification

Evidence before assertions — run each and read the output.

1. `node --test "tests/**/*.mjs"` — every existing assertion plus the new ones, green.
2. `node tools/run.mjs reports/strain-pound-zoloft-allowed.trycloudflare.com-20260902T182424Z.json`
   and the `…183643Z.json` one — the tunnel's share now prints; 267 ms vs 60 ms is visible.
3. `node tools/run.mjs compare` on that pair — must report the page unmoved and the tunnel moved.
4. `node tools/mutate-contract.mjs` — still 30 caught / 4 harmless. P0 must not touch the contract.
5. **Live pre-flight, refusal path**: point `tools/run.mjs` at a hostname that does not resolve and
   confirm it refuses naming DNS, *without* launching Chrome.
6. **Live pre-flight, success path**: `./start-cloudflare.ps1`, then
   `node tools/run.mjs https://<name>.trycloudflare.com/`. Load the `measuring-runs` skill first.
   Expect the page's own share unchanged against 2026-09-02 (10 / 83 / 41 ms).

## Deferred, with triggers

- **A stable domain** — buy when P5 is wanted; nothing before it needs one.
- **Partytown as an Arm** — directly relevant to VTEX clients, but fragile; revisit in P5 once the
  bench harness makes an extra Arm cheap.
- **B6 structured data** — answerable in P3 once Products have their own Routes. Still honestly
  without `Offer`, since nothing is purchasable.
- **B7 Worker-warm repeat visit** — earns its keep in P2, where navigating between Routes is the
  thing a Worker actually changes.
- **Real GA4/GTM containers** — P1 needs one container and one property; consent and LGPD posture
  gets decided there, not assumed.

## New vocabulary for CONTEXT.md

Proposed, to be settled with the `domain-modeling` skill when each phase lands:

- **Route** (P2) — one URL of the Storefront a Run can be taken against.
- **Arm** (P1) — one way of delivering the tags, measured against the control.
- **Paired Run** (P0) — two Runs through the same Preview URL minutes apart, so the tunnel cancels.

## Revised on 2026-09-03, before P0 was executed

Read against the code and the eighteen Reports on disk, five things above needed correcting. P0
was executed with these corrections; the text above is kept as written so the record shows what
was planned and what was found.

1. **The pre-flight asks DNS the way Chrome does.** "One GET" through Node's `fetch` resolves via
   `getaddrinfo`, i.e. the Windows DNS cache — the cache that made `curl` succeed while Lighthouse's
   Chrome got NXDOMAIN on 2026-09-02. `dns.promises.resolve4` asks the configured servers directly
   and returns `ENOTFOUND` for a missing name (verified), so the pre-flight is resolver-direct DNS
   (skipped for IP literals), then a GET of the document checked against the page model (title and
   the assets it references, so a stale Measurement Server serving an older Generation is refused
   too), then a GET of every asset the page references. That last part was learned live: the first
   Run through a fresh tunnel on 2026-09-03 followed one warming GET and still read a 266 ms
   server-latency estimate.
2. **"The same page share" was never true of the 2026-09-02 pair.** Load duration was 315 ms
   against 83 ms. Across all eighteen Reports, load delay (10–13 ms in every `cli` Run) and render
   delay (35–65 ms) are the page's; load duration tracks the tunnel (83–88 ms warm, 315–332 ms
   cold), and the simulated LCP moves almost exactly with Lantern's `network-server-latency`
   (Δ203 ms against Δ210 ms on 09-02; Δ205 against Δ212 on 08-24/25; Δ35 against Δ35 for the PWA
   Run). So the **Page share** is load delay + render delay + the LCP image's bytes, and load
   duration sits on the **Tunnel share**'s side with TTFB and Lantern's two estimates. CONTEXT.md
   defines both, plus **Tunnel** and **Paired Run**.
3. **The 2026-09-02 pair is not a Paired Run** — two Preview URL hosts. It remains the cautionary
   tale `compare` is asserted over; the 2026-08-24/25 pair (one host, cold then warm) is the recorded
   pair through one Preview URL.
4. **The ADR is `docs/adr/0001-tooling-may-generate-what-ships.md`**, the `domain-modeling`
   skill's numbering, not `ADR-001-*`.
5. **D12 moves the Run of record.** Every Run saves its Report and the D12 assertion ties CLAUDE.md
   to the newest, so the live verification became a Paired Run through one fresh tunnel and
   CLAUDE.md's current state was rewritten from it. The Run of record did not stay
   2026-09-02T18:36:43Z.
6. **"The tunnel's share moved more than the page's" is not the verdict rule.** Learned from the
   Runs of 2026-09-03: the pair 2026-09-02T18:36 → 2026-09-03T12:42 read LCP +95 ms with the
   estimates +1 ms and the page share +11 ms on an unchanged page, and "whichever moved more" called
   it the page's. A side owns the difference only when its own movement, in LCP's direction, covers
   at least half of it; both covering is `both`, neither is `noise`. Weighing the page share at the
   Run's 4× CPU slowdown was tried and rejected — the PWA pair moved −35 ms for −35 ms of latency
   with a page share of −7 ms, and pairs where only the page share wandered show no multiple of it
   in LCP. Render delay wanders between Runs of one page (35–65 ms across the Reports, 131 ms on a
   session's first Chrome), so a `page` verdict on one pair is a reading of the shares, not a Win;
   the verdict text says so, and a Win needs it on every repeat. A Paired Run of the unchanged page
   through one warm tunnel (12:42 → 12:47) read `noise` at LCP −59 ms: that is the floor a Win has
   to clear, and P1's repeats are where it gets measured rather than quoted.
