"""The Measurement Server: the origin the Storefront is served from during a Run.

Its keep-alive, compression, and cache headers are part of what a Run measures, not scaffolding
around the page, so results measured under any other server will not reproduce.

    python server.py [port]        # default 8000; 0 binds an ephemeral port and prints the bound one

Two tables decide everything the handler does. POLICY maps a file's suffix to its content type,
whether it is gzipped, and how it is cached. PUBLIC (plus IMAGE_NAME under /images/) is the whole
set of URLs a Run may fetch; everything else in the repository -- Reports, the Performance
Contract, this file -- is a 404 that is never cacheable. tests/measurement-server.mjs asserts both
tables through HTTP, the seam a Run crosses.
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
import gzip
import re
import sys

ROOT = Path(__file__).resolve().parent
IMAGES = ROOT / "images"

# An Immutable Asset's filename is its cache key, so it may be cached for a year and never
# revalidated; the document and the crawler files must be revalidated on every request.
IMMUTABLE = "public, max-age=31536000, immutable"
NO_CACHE = "no-cache"

# suffix -> (Content-Type, gzip?, Cache-Control). mimetypes is deliberately not consulted:
# Python on win32 has no entry for .webp and answered application/octet-stream for the LCP image.
POLICY = {
    ".html": ("text/html; charset=utf-8", True, NO_CACHE),
    ".txt": ("text/plain; charset=utf-8", True, NO_CACHE),
    ".js": ("text/javascript; charset=utf-8", True, IMMUTABLE),
    ".css": ("text/css; charset=utf-8", True, IMMUTABLE),
    ".webp": ("image/webp", False, IMMUTABLE),
    ".jpg": ("image/jpeg", False, IMMUTABLE),
    ".ico": ("image/x-icon", False, IMMUTABLE),
}

# URL path -> file: the Storefront and what a browser fetches alongside it. Nothing else is public.
PUBLIC = {
    "/": ROOT / "index.html",
    "/app.v1.min.js": ROOT / "app.v1.min.js",
    "/favicon.ico": ROOT / "favicon.ico",
    "/robots.txt": ROOT / "robots.txt",
    "/llms.txt": ROOT / "llms.txt",
}
# A Rung or Master under /images/: a flat name, no separators, one of the image suffixes.
IMAGE_NAME = re.compile(r"[A-Za-z0-9_-]+\.(?:webp|jpg)")


def public_file(url_path):
    """The file a request path maps to, or None when the path is not public."""
    path = unquote(urlsplit(url_path).path)
    if path in PUBLIC:
        file = PUBLIC[path]
    else:
        directory, _, name = path.rpartition("/")
        if directory != "/images" or not IMAGE_NAME.fullmatch(name):
            return None
        file = IMAGES / name
    resolved = file.resolve()
    if not resolved.is_relative_to(ROOT) or not resolved.is_file():
        return None
    return resolved


class MeasurementServer(BaseHTTPRequestHandler):
    # HTTP/1.1 keeps the connection open, so one connection carries the page and its assets.
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        self.respond(send_body=True)

    def do_HEAD(self):
        self.respond(send_body=False)

    def respond(self, send_body):
        file = public_file(self.path)
        if file is None:
            self.reply(404, b"Not Found\n", "text/plain; charset=utf-8", NO_CACHE, send_body)
            return
        content_type, compressible, cache = POLICY[file.suffix.lower()]
        body = file.read_bytes()
        encoding = None
        if compressible:
            if "gzip" in self.headers.get("Accept-Encoding", "").lower():
                body = gzip.compress(body, compresslevel=9)
                encoding = "gzip"
        self.reply(200, body, content_type, cache, send_body, encoding, vary=compressible)

    def reply(self, status, body, content_type, cache, send_body, encoding=None, vary=False):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", cache)
        if vary:
            self.send_header("Vary", "Accept-Encoding")
        if encoding:
            self.send_header("Content-Encoding", encoding)
        # Content-Length on every response, 404s included: keep-alive depends on it.
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
