---
name: measuring-runs
description: How to warm the Preview URL, perform a Run against it, and read the resulting Report — Cloudflare/ngrok tunnel gotchas, timing figures, and the known Report artifacts. Use when starting the Cloudflare or ngrok tunnel, performing a Run, or reading a saved Report from reports/.
---

# Measuring: performing a Run and reading its Report

## Warming the tunnel and performing a Run

The Preview URL is a Cloudflare quick tunnel: `./start-cloudflare.ps1` (by hand: `python server.py
8000` plus `cloudflared tunnel --url http://localhost:8000`) prints a
`https://<four-words>.trycloudflare.com` address that changes every session. The script starts its
own Measurement Server, so stop any `python server.py 8000` already listening before running it
(`Get-NetTCPConnection -LocalPort 8000 -State Listen` names the process) — otherwise the tunnel
points at the older process, which may be serving older files. Cloudflare's edge
interposes almost nothing — no interstitial, no bypass header, `Cache-Control`/`Vary`/gzip pass
through unchanged, and every response, Immutable Assets included, is `CF-Cache-Status: DYNAMIC`, so
a Run never measures an edge cache. It adds two things: gzip on `favicon.ico` (the Measurement
Server sends it uncompressed, 4286 B; the edge delivers 1426 B) and a cold start — the first request
through a fresh tunnel takes ~1.4 s to first byte, ~0.2 s after that. The Run of 2026-08-24T20:19:31Z
measured a cold tunnel (TTFB 976 ms, LCP 1151 ms); the next one through the same tunnel, warm, read
TTFB 174 ms and LCP 946 ms.

`node tools/run.mjs <preview-url>` is the Run. It pre-flights before Chrome launches: one DNS query
for the hostname, made directly to the configured servers (not through the Windows cache `curl`
reads from), one GET of the document read through the page model against `index.html` on disk,
and then — once the document checks out — a GET of every asset the page references, in parallel,
which is the warming: one request is not enough for a fresh quick tunnel (the Run of
2026-09-03T12:40:10Z followed one and still read a 266 ms server-latency estimate, because
Chrome's parallel requests took paths the one request had not), so nothing needs warming by hand.
It refuses in seconds, naming the cause, when the name does not resolve (a hostname that has not
propagated, or a poisoned resolver — start a new tunnel), when the response is not 200, when the
title is not the Storefront's (ngrok's interstitial), or when the document references other assets
than the page on disk (an older Measurement Server still listening on 8000). After the measurement it refuses a
Report that is not a real Run (interstitial requests, wrong host, localhost, desktop form factor,
redirects, storage kept), names the Report by its own UTC `fetchTime`, writes it under `reports/`,
and prints the summary. The known artifacts live in `lib/report.mjs`, not in anyone's head:

- A trailing `EPERM ... chrome-launcher` exit on Windows happens after the Report is written; the Run
  keeps the Report and ignores the exit code.
- ngrok only (`./start-ngrok.ps1`): free-tier ngrok serves an interstitial to browser user-agents,
  so a naive Lighthouse run measures ngrok's error page and reports plausible-looking garbage. The
  Run always sends the `ngrok-skip-browser-warning` bypass header (other tunnels ignore it) and
  refuses a Report with `cdn.ngrok.com` requests. The header does **not** reach Lighthouse's
  separate robots.txt fetch, so `robots-txt` scores 0 over ngrok and SEO reads 92; the summary names
  the artifact and prints SEO without it (100). `robots.txt` itself is valid — the Performance
  Contract asserts it.
- A cold tunnel: when Lantern's `network-server-latency` estimate is above 150 ms (a warm Cloudflare
  tunnel reads 54–92 ms, ngrok 18–86 ms; the two cold Runs read 267 and 304 ms) the summary names
  it as a known artifact of the tunnel, and the simulated LCP carries almost exactly that excess.
  The pre-flight's GET is what prevents it; a Run that shows it measured the tunnel waking up.
- A Repeat Visit in which every request came down in full: nothing was reused, so it measured a
  first visit, which is what one looks like when the two navigations did not share a browser. The
  Report of 2026-09-04T19:04:21Z is kept as the example and prints the mark when read back.

Reports captured through the chrome-devtools MCP (`channel: devtools`, the first nine) carry an extra
`agentic-browsing` category; a Run reads `channel: cli` and a Repeat Visit `channel: node`, because
the two take different paths into Lighthouse (below). Throttling is identical (mobile, simulated,
412×823 @1.75), so metrics are comparable. At that emulation the Run fetches `hero-768.webp` as the
LCP image.

### A Repeat Visit

`node tools/run.mjs repeat https://<host>/` measures what a Run cannot: the returning visitor. It
performs two navigations of **one** browser — the first ordinary and thrown away, which installs the
Worker; the second with `disableStorageReset`, which the Worker serves. The Report is named
`<host>[-<Arm>]-repeat-<moment>.json` and `checkReport` accepts it only under that flag, refusing a
cleared-storage Report as a Repeat Visit and a kept-storage one as a Run; `compare` names the pair
when they are mixed.

It goes through Lighthouse's **Node API**, not the CLI, and that is not a style choice. The CLI
launches a Chrome of its own and has no way to be told which profile to use, and Chromium honours the
**first** `--user-data-dir` it is given — chrome-launcher's own is always first — so a profile passed
through `--chrome-flags` is ignored in silence. Every Repeat Visit taken before 2026-09-04 measured a
first visit twice for exactly that reason, and read like a perfectly ordinary Run.

Read one against a Run of the same page, not against another Repeat Visit, and expect the numbers to
be less flattering than they look: `transferSize` 0 on every row means the page context paid nothing,
not that the wire did. Check the `cache` field and the network span per row before concluding
anything — on 2026-09-04 the two `no-cache` rows read `cache: none` and took 80 and 90 ms, because
`sw.js` fetches both `networkFirst` and a Report never sees the Worker's own fetches.

### A fresh hostname and DNS

A quick tunnel's hostname is new to the world when cloudflared prints it, and the ISP resolver caches
a "no such name" answer for the zone's negative TTL — 30 minutes for `trycloudflare.com`. Querying
the name before it has propagated poisons that cache: on 2026-09-02 a hostname polled every 5 s from
the start resolved for `curl` after ~165 s (the Windows cache kept the one positive answer), the
first Run went through, and every later Run was refused with `CHROME_INTERSTITIAL_ERROR` because
Lighthouse's fresh Chrome asks the ISP resolver directly and got the cached NXDOMAIN. `curl` and an
already-open Chrome working prove nothing about the Chrome a Run launches. So: after cloudflared
prints the address, wait ~90 s without looking it up; confirm propagation with `nslookup <host>
1.1.1.1` (Cloudflare's resolver never touches the ISP cache); only then make the first request
through the system resolver. If a Run is refused with an interstitial while `curl` succeeds, the
name is poisoned — start a new tunnel rather than waiting out the TTL.

The Run's pre-flight makes the same kind of direct query (c-ares, the configured servers, no
Windows cache), so a poisoned or unpropagated name is refused in seconds with DNS named as the
cause — but a query cannot un-poison anything, so the wait and the `nslookup … 1.1.1.1` above
still come first. Which resolver Lighthouse's Chrome asks is not established; what is established
is that on 2026-09-02 it did not share the Windows cache.

### The Worker and the tunnel

The page registers a Worker, so warming the Preview URL **in a browser** installs one on that
hostname: eyeballing the page after a change may show the kept copy (the document is network-first,
so a reload usually shows the new one; images are cache-first and do not refresh until their filename
changes), and dead `trycloudflare.com` hostnames accumulate registrations in that profile. Warm with
`curl`. The Run itself is unaffected — Lighthouse clears `service_workers` and `cache_storage` before
it navigates, and `lib/report.mjs` refuses a Report that did not — and its Report records nothing of
the Worker: the registration and the Shell's fetches happen in the Worker's own context. What it does
record beyond the page's assets is `manifest.webmanifest` and the one icon Chrome fetches after
reading it (`icon-v1-180.png`, ~10 KB), which is the whole cost of the PWA on a first visit.

## Reading a Report afterward

`reports/` holds the Reports, named `<host>-<UTC fetchTime>Z.json` by the Run itself. Each file
is ~500 KB — never `cat` one. `node tools/run.mjs reports/<file>.json` prints the summary of a
recorded Report without measuring anything: scores, metrics, requests, bytes, then the **Page
share** (load delay, render delay, the LCP image's own bytes and name) and the **Tunnel share**
(TTFB, load duration, Lantern's server-latency and RTT estimates), the known artifacts, and last a
`CLAUDE.md:` line with the exact words CLAUDE.md's current state quotes — paste it, never compose
it; `tests/run.mjs` holds CLAUDE.md equal to the newest Report through it. For anything deeper,
`lib/report.mjs` exports `readReport`/`summarize`, and the raw keys worth reading are
`categories.*.score` and `audits[...]` — `network-requests`, `lcp-breakdown-insight`,
`render-blocking-insight`, `network-dependency-tree-insight`, `image-delivery-insight`,
`layout-shifts`, `cls-culprits-insight`, and `network-server-latency` / `network-rtt`.

Why the split (CONTEXT.md, "Two Runs side by side"): across the eighteen Reports on disk, load
delay (10–13 ms in every `cli` Run) and render delay (35–65 ms) hold across tunnels, while load
duration tracks the tunnel (83–88 ms warm, 315–332 ms cold for the same Rung) and the simulated LCP
moves almost exactly with the server-latency estimate (2026-09-02: LCP −203 ms for −210 ms of
latency; 2026-08-24/25: −205 for −212). The breakdown is the unthrottled trace's sub-parts and does
not sum to the simulated LCP; the two estimates are what Lantern builds that LCP from. Two Runs of
the same page twelve minutes apart on 2026-09-02 read LCP 1114 ms and 911 ms with the same load
delay and render delay, a load duration of 315 against 83 ms, and a server-latency estimate of 267
against 57 ms: everything that moved was the tunnel's.

### The Paired Run

`node tools/run.mjs compare <earlier>.json <later>.json` reads two Reports side by side: every
delta later minus earlier (scores, FCP/LCP/TBT/CLS, requests, bytes, both shares) and one verdict
on whose the LCP difference is. A side owns the difference when its own movement, in LCP's
direction, covers at least half of it, both weighed as observed (weighing the page share at the
Run's 4× CPU slowdown was tried: the Reports show no such multiple in LCP). `image`: the LCP
element loaded a different Rung or different bytes, so it is the page's and load duration cannot
be attributed (2026-08-21T17:00 → 17:08, the WebP Win). `tunnel`: the estimates cover it (the
2026-09-02 pair: −210 ms of latency for −203 ms of LCP; 2026-09-03T12:40 → 12:42: −207 ms for
−171 ms, with a render delay of −83 ms that falls just under half). `page`: the page share covers
it and the estimates do not. `both`: each covers it on its own, so nothing can be named. `noise`:
neither covers it — the larger of two small movements is not a cause (2026-09-02T18:36 →
09-03T12:42: LCP +95 ms with the estimates +1 ms and the page share +11 ms on an unchanged page).
`unread`: a Report carries no breakdown. Two Preview URLs are named as "not a Paired Run" and
still compared.

A `page` verdict is a reading of the shares, not a Win. Render delay wanders between Runs of one
page — 35–65 ms across the Reports, and 131 ms on the first Run of a Chrome session
(2026-09-03T12:40) — and the Tunnel cannot move it, but Chrome's own state can:
2026-09-02T18:36 → 2026-09-03T12:47 reads `page` on +17 ms of render delay (41 → 58) and LCP
+35 ms with nothing on the page touched. The verdict says so in its own words ("one pair; a Win
needs it on every repeat").

The procedure: one tunnel, the pre-flight warms it, a Run, a few minutes, a Run, `compare`. For the
bench, alternate control and variant through the one tunnel and repeat; a Win needs the `page` (or
`image`) verdict on every pair, by more than the wander above, and a `noise` verdict on the same
page a few minutes apart is what a tunnel looks like when nothing changed (2026-09-03T12:42 →
12:47, one warm tunnel: LCP −59 ms, page share +7 ms, estimates −1 ms; 2026-08-21T17:13 → 17:26
over ngrok: LCP +56 ms, page share −28 ms, estimates +19 ms).

### The Bench

`node tools/bench.mjs https://<host>/ --rounds 3` performs a warm-up Run of the control, then three
rounds of every Arm in `bench/arms.json` (control, `gtm`, `gtm-deferred`), all through the one
tunnel, back to back: ten Runs, about seven minutes. Every Run is the ordinary one — pre-flighted
against the Arm's own file, checked, saved under `reports/` as `<host>-<arm>-<stamp>.json` — and a
refusal stops the bench with its reason, the Reports so far kept. The record goes to
`benches/<host>-<stamp>.json`; `node tools/bench.mjs read benches/<file>.json` recomputes the
reading from the Reports it names and prints the `CLAUDE.md:` bench-of-record line to paste.

The reading: per Arm and measure (TBT, LCP, FCP, requests, transferred, third-party bytes, load
delay, render delay, server latency), min / median / max across the rounds, warm-up excluded. A cost
is the difference of medians and is **real** only when the Arm's Runs and the control's do not
overlap in the direction of the cost; otherwise it is within the wander. Two marks to read before
anything else: `cold tunnel` (the server-latency artifact; the pre-flight should have prevented it)
and `container not loaded` (an Arm Run whose Report holds no request to `www.googletagmanager.com`
— for the deferred Arm, the idle callback landed outside the trace; stop and say so rather than
widening the ceiling without a decision).

Before the first Bench of a session: the container must be published (an unpublished container
serves no `gtm.js`; `curl -sI "https://www.googletagmanager.com/gtm.js?id=GTM-PRVCQ335"` answers
200 when it is), and the Measurement Server must be one started from the current tree, since an
older `python server.py 8000` has no Arm rows and the pre-flight refuses every Arm with "answered
404". Warming the Arms in a browser installs the Worker on that hostname like warming `/` does;
warm with `curl` or let the pre-flight do it.
