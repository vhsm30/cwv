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
through a fresh tunnel takes ~1.4 s to first byte, ~0.2 s after that. Warm the Preview URL with one
request (a browser visit or `curl`) before a Run: the Run of 2026-08-24T20:19:31Z measured a cold
tunnel (TTFB 976 ms, LCP 1151 ms); the next one through the same tunnel, warm, read TTFB 174 ms and
LCP 946 ms.

`node tools/run.mjs <preview-url>` is the Run: it refuses a Report that is not a real Run
(interstitial requests, wrong host, localhost, desktop form factor, redirects), names the Report by
its own UTC `fetchTime`, writes it under `reports/`, and prints the summary. The known artifacts
live in `lib/report.mjs`, not in anyone's head:

- A trailing `EPERM ... chrome-launcher` exit on Windows happens after the Report is written; the Run
  keeps the Report and ignores the exit code.
- ngrok only (`./start-ngrok.ps1`): free-tier ngrok serves an interstitial to browser user-agents,
  so a naive Lighthouse run measures ngrok's error page and reports plausible-looking garbage. The
  Run always sends the `ngrok-skip-browser-warning` bypass header (other tunnels ignore it) and
  refuses a Report with `cdn.ngrok.com` requests. The header does **not** reach Lighthouse's
  separate robots.txt fetch, so `robots-txt` scores 0 over ngrok and SEO reads 92; the summary names
  the artifact and prints SEO without it (100). `robots.txt` itself is valid — the Performance
  Contract asserts it.

Reports captured through the chrome-devtools MCP (`channel: devtools`, the first nine) carry an extra
`agentic-browsing` category; newer ones are `channel: cli`. Throttling is identical (mobile, simulated,
412×823 @1.75), so metrics are comparable. At that emulation the Run fetches `hero-768.webp` as the
LCP image.

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
recorded Report (scores, metrics, requests, bytes, known artifacts) without measuring anything; for
anything deeper, `lib/report.mjs` exports `readReport`/`summarize`, and the raw keys worth reading
are `categories.*.score` and `audits[...]` — `network-requests`, `lcp-breakdown-insight`,
`render-blocking-insight`, `network-dependency-tree-insight`, `image-delivery-insight`,
`layout-shifts`, `cls-culprits-insight`, and `network-server-latency` / `network-rtt`, Lantern's
estimate of the tunnel's share. Read those two before blaming the page: two Runs of the same page
twelve minutes apart on 2026-09-02 read LCP 1114 ms and 911 ms with the same load delay, load
duration and render delay, and the only difference was `network-server-latency` (267 ms against
60 ms; 60–90 ms is usual). When TTFB moves and the page's share does not, the tunnel moved.
