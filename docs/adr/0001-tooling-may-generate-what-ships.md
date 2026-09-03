---
status: accepted
date: 2026-09-03
---

# Tooling may generate what ships; the browser stays dependency-free

CLAUDE.md said "no package manager, no build step, no framework" and that everything shipped is
hand-written. The lab is now growing into a Storefront with Routes, and a hand-written document per
Route does not scale, so the no-build-step rule was contested under the principle that decides
every such question here: **anything that gets in the way of evolving the Storefront is contested
and kept only if necessary.** It was not necessary. `tools/build-images.py` and
`tools/build-icons.py` already depend on PIL and already generate `images/` and `icons/`, both
committed, so the rule the repository actually keeps is narrower: *nothing shipped to the browser
has a dependency, and nothing a Run measures is produced at request time.* Tooling may generate
what ships, provided the generated files are committed and rebuild byte-identically, the way the
image and icon generators do.

## Consequences

- A generator that writes documents to disk (planned as `tools/build-pages.py`, the second phase
  of `docs/superpowers/plans/2026-09-02-ecommerce-bench.md`) is permitted. `index.html` stays
  hand-written until it exists.
- The Set-aside item "a readable CSS source for the inline `<style>`" (BACKLOG.md) is no longer
  blocked by a rule; it is unpicked, not forbidden.
- No package manager and no framework still hold, for the same narrower reason: they would put a
  dependency between the page and the browser, or between a Run and the bytes it measures.
- A rule that survives this contest is recorded here, in `docs/adr/`, with the reason it survived.
