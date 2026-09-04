"""The Measurement Server: the origin the Storefront is served from during a Run.

Its keep-alive, compression, and cache headers are part of what a Run measures, not scaffolding
around the page, so results measured under any other server will not reproduce.

    python server.py [port]        # default 8000; 0 binds an ephemeral port and prints the bound one

Three tables decide everything the handler does. POLICY holds the facts about the bytes: a file's
suffix maps to its content type and whether it is gzipped. PUBLIC and DIRECTORIES hold the facts
about the URLs: PUBLIC is every single path a Run may fetch and how it is cached, DIRECTORIES the
two folders whose flat-named files are public under one cache rule. The Arms' rows are read from
bench/arms.json at boot, so the table and the documents cannot drift. Caching is a property of the
URL, not of the bytes, which is why it lives with the path: an Immutable Asset's filename is its
cache key, and sw.js is the one script in the lab whose filename is deliberately not one -- a
Worker registration is identified by its URL, so a Generation-stamped Worker would be a second
registration, not a replacement. Everything else in the repository -- Reports, the Performance
Contract, this file -- is a 404 that is never cacheable. tests/measurement-server.mjs asserts all
three tables through HTTP, the seam a Run crosses. A revalidated row also carries an ETag over its
bytes and answers a matching If-None-Match with 304, so a repeat view pays for the headers rather
than the document; an Immutable Asset carries none, because max-age=1y is never revalidated.
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
import gzip
import hashlib
import json
import re
import sys

ROOT = Path(__file__).resolve().parent
IMAGES = ROOT / "images"
ICONS = ROOT / "icons"

# An Immutable Asset's filename is its cache key, so it may be cached for a year and never
# revalidated; the document, the crawler files, and anything identified by its URL alone must be
# revalidated on every request.
IMMUTABLE = "public, max-age=31536000, immutable"
NO_CACHE = "no-cache"

# suffix -> (Content-Type, gzip?): the facts about the bytes. mimetypes is deliberately not
# consulted: Python on win32 has no entry for .webp and answered application/octet-stream for the
# LCP image.
POLICY = {
    ".html": ("text/html; charset=utf-8", True),
    ".txt": ("text/plain; charset=utf-8", True),
    ".js": ("text/javascript; charset=utf-8", True),
    ".css": ("text/css; charset=utf-8", True),
    ".webp": ("image/webp", False),
    ".jpg": ("image/jpeg", False),
    ".ico": ("image/x-icon", False),
    ".png": ("image/png", False),
    ".webmanifest": ("application/manifest+json", True),
}

# URL path -> (file, Cache-Control): the Storefront and what a browser fetches alongside it.
PUBLIC = {
    "/": (ROOT / "index.html", NO_CACHE),
    # The behaviour's current Generation. A superseded one stays on disk (CONTEXT.md) and leaves
    # this table, so "kept" never quietly means "still served".
    "/app.v2.min.js": (ROOT / "app.v2.min.js", IMMUTABLE),
    "/favicon.ico": (ROOT / "favicon.ico", IMMUTABLE),
    "/robots.txt": (ROOT / "robots.txt", NO_CACHE),
    "/llms.txt": (ROOT / "llms.txt", NO_CACHE),
    # The manifest is identified by its URL, not its content, so it is revalidated like the document.
    "/manifest.webmanifest": (ROOT / "manifest.webmanifest", NO_CACHE),
    # The Worker: the one script whose filename is deliberately not a cache key (see the docstring).
    "/sw.js": (ROOT / "sw.js", NO_CACHE),
}

# The Arms (CONTEXT.md): the Storefront delivered with one way of loading the tags, each at its own
# root-level URL, generated from index.html by tools/build-arms.mjs. bench/arms.json is the one home
# of every Arm fact, so the rows come from it; they are documents, revalidated like /.
ARMS = ROOT / "bench" / "arms.json"
for _arm in json.loads(ARMS.read_text(encoding="utf-8"))["arms"]:
    if _arm["path"] != "/":
        PUBLIC[_arm["path"]] = (ROOT / _arm["file"], NO_CACHE)

# URL directory -> (folder, suffixes, Cache-Control): a flat name (no separators) with one of the
# suffixes is public under the folder; nothing else under the directory is, the index included.
DIRECTORIES = {
    "/images": (IMAGES, {".webp", ".jpg"}, IMMUTABLE),
    "/icons": (ICONS, {".png"}, IMMUTABLE),
}
FLAT_NAME = re.compile(r"[A-Za-z0-9_-]+\.[a-z0-9]+")

# A public path with no POLICY row is a programming error, caught here at boot: a 500 in the middle
# of a Run would corrupt the measurement instead of failing the assertion that spawns this server.
for _path, (_file, _cache) in PUBLIC.items():
    if _file.suffix.lower() not in POLICY:
        sys.exit(f"server.py: PUBLIC {_path} has no POLICY row for {_file.suffix!r}")
for _directory, (_folder, _suffixes, _cache) in DIRECTORIES.items():
    for _suffix in sorted(_suffixes - POLICY.keys()):
        sys.exit(f"server.py: DIRECTORIES {_directory} has no POLICY row for {_suffix!r}")


def public_file(url_path):
    """The (file, Cache-Control) a request path maps to, or None when the path is not public."""
    path = unquote(urlsplit(url_path).path)
    if path in PUBLIC:
        file, cache = PUBLIC[path]
    else:
        directory, _, name = path.rpartition("/")
        if directory not in DIRECTORIES or not FLAT_NAME.fullmatch(name):
            return None
        folder, suffixes, cache = DIRECTORIES[directory]
        file = folder / name
        if file.suffix not in suffixes:
            return None
    resolved = file.resolve()
    if not resolved.is_relative_to(ROOT) or not resolved.is_file():
        return None
    return resolved, cache


class MeasurementServer(BaseHTTPRequestHandler):
    # HTTP/1.1 keeps the connection open, so one connection carries the page and its assets.
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        self.respond(send_body=True)

    def do_HEAD(self):
        self.respond(send_body=False)

    def respond(self, send_body):
        public = public_file(self.path)
        if public is None:
            self.reply(404, b"Not Found\n", "text/plain; charset=utf-8", NO_CACHE, send_body)
            return
        file, cache = public
        content_type, compressible = POLICY[file.suffix.lower()]
        body = file.read_bytes()
        encoding = None
        if compressible and "gzip" in self.headers.get("Accept-Encoding", "").lower():
            encoding = "gzip"
        # A validator for the rows that must be revalidated, over the bytes on disk -- but one per
        # representation: the same URL is served gzipped or not, and a cache holding the identity
        # bytes must not be told the gzip variant is still fresh. Vary picks the variant; the ETag
        # says which one. An Immutable Asset gets none: max-age=1y is never revalidated, and its
        # filename is already its cache key.
        etag = None
        if cache == NO_CACHE:
            etag = '"' + hashlib.sha256(body).hexdigest() + ("-gzip" if encoding else "") + '"'
            if self.headers.get("If-None-Match") == etag:
                # No body, and no compression paid for one: that is the whole point of asking.
                self.reply(304, b"", content_type, cache, False, vary=compressible, etag=etag)
                return
        if encoding:
            body = gzip.compress(body, compresslevel=9)
        self.reply(200, body, content_type, cache, send_body, encoding, vary=compressible, etag=etag)

    def reply(self, status, body, content_type, cache, send_body, encoding=None, vary=False, etag=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", cache)
        if etag:
            self.send_header("ETag", etag)
        if vary:
            self.send_header("Vary", "Accept-Encoding")
        if encoding:
            self.send_header("Content-Encoding", encoding)
        # Content-Length on every response with a body, 404s included: keep-alive depends on it.
        # A 304 is defined to carry no body, so its framing is implicit and a length of 0 would
        # claim the representation is empty when it is not.
        if status != 304:
            self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if send_body:
            self.wfile.write(body)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = ThreadingHTTPServer(("", port), MeasurementServer)
    # flush: under tests/measurement-server.mjs stdout is a pipe, and the bound port must arrive.
    print(f"Serving with gzip and cache headers on http://localhost:{server.server_address[1]}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
