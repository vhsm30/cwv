# Field Notes Supply

A Core Web Vitals lab wearing a storefront's clothes. **Field Notes Supply** is the page under
test; everything else in this repo exists to measure that page, improve it, and stop the
improvement from quietly reverting.

## Language

### The lab

**Run**:
One Lighthouse measurement of the Preview URL, taken at mobile form factor under simulated
throttling. A measurement taken any other way is not a Run.
_Avoid_: audit, scan, test, check

**Report**:
The JSON a Run leaves behind, named for the Preview URL and the UTC moment of capture.
_Avoid_: result, output, log, snapshot

**Preview URL**:
The public address the page is exposed at for a Run, by cloudflared (the default) or by ngrok. The
only address a Run is valid against, because the throttling model assumes a real network hop.
_Avoid_: localhost, staging URL, tunnel, dev URL

**Tunnel**:
The cloudflared or ngrok process that carries the Preview URL to the Measurement Server. Its cold
start, its edge and the resolvers' view of its hostname are measured by every Run and belong to no
page.
_Avoid_: proxy, relay, hop, network

**Measurement Server**:
The origin the page is served from, whose keep-alive, compression, and cache headers are part of
what a Run measures rather than scaffolding around it.
_Avoid_: dev server, static server, harness, local server

**Win**:
A change to the page that a Run shows moved a metric in the right direction. Unmeasured changes
are not Wins.
_Avoid_: fix, improvement, optimization, tweak

**Lock-in**:
Turning a Win into an assertion, so the next person to touch the markup has to break it on purpose.
_Avoid_: guard, safeguard, protect, enforce

**Performance Contract**:
The accumulated assertions of every locked-in Win. A record of decisions that happens to be
executable, not a unit test suite.
_Avoid_: test suite, unit tests, regression tests, specs

**Generation**:
A set of assets shipped under new filenames instead of edited in place, so one experiment's
results can never be mistaken for another's. Superseded Generations are kept, not deleted.
_Avoid_: version, revision, bump, release

**Immutable Asset**:
An asset whose filename is its cache key, because it is served as permanently cacheable. The
reason Generations exist.
_Avoid_: static asset, versioned file, hashed asset

### The storefront

**Storefront**:
The single page a visitor sees: a fictional shop with no server behind it, no checkout, and no
payment. It exists to be measured.
_Avoid_: site, app, store, demo, shop

**Hero**:
The first screenful — headline, invitation, and the one large image that is the page's LCP
element.
_Avoid_: banner, splash, masthead, above the fold

**The Collection**:
The three Products shown below the Hero.
_Avoid_: catalog, shop, grid, listings, inventory

**Product**:
One object in the Collection: a name, a type, a price, an image. Nothing here is purchasable.
_Avoid_: item, SKU, listing, card

**Bag**:
The visitor's running count of added Products, held in the browser and lost on reload.
_Avoid_: cart, basket, order, checkout

### The images

**Slot**:
The place in the Storefront where one image renders into a fixed box: the Hero's image and each
Product's image.
_Avoid_: image slot, placeholder, frame

**Rung**:
One candidate width of a Slot's image, offered in every format the Slot ships.
_Avoid_: size, variant, resolution, breakpoint image

**Master**:
The largest honest source held for a Slot, from which every Rung is derived and which the
Storefront never requests.
_Avoid_: original, source image, raw

### Working offline

**Worker**:
The script that stands between the Storefront and the network once a visitor has been here: it
answers from what it has kept and asks the network for the rest. A Run clears storage first, so
the Worker installs fresh on every Run and never serves one.
_Avoid_: service worker (in prose), sw, cache layer

**Shell**:
The set of URLs the Storefront needs to render with the network gone: the document, the
behaviour, and the favicon. Images are not in it; the Worker keeps each one as the visitor sees it.
_Avoid_: precache, app shell, bundle

**Notice**:
The one element that offers to add the Storefront to the home screen, and later offers the newer
Generation. Hidden until the browser says it may be shown, so no Run ever sees it.
_Avoid_: banner, prompt, toast, modal

### Two Runs side by side

**Page share**:
Of what a Run observed on the way to LCP, the part the Tunnel cannot move: the LCP element's load
delay and render delay, and the bytes of the Rung it loaded. The browser's own state moves it too,
which is why one Paired Run reads it and repeats decide.
_Avoid_: own time, real LCP, page time

**Tunnel share**:
Of what a Run observed on the way to LCP, the part the Tunnel moves — time to first byte and the
LCP element's load duration — together with the server-latency and round-trip estimates the
simulated LCP is built from. Two Runs of one page differ here first.
_Avoid_: network time, overhead, noise

**Paired Run**:
Two Runs through one Preview URL minutes apart, read side by side so the Tunnel share cancels and
a difference in the Page share can be called the page's.
_Avoid_: A/B test, before/after, comparison, benchmark
