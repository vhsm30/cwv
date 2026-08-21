from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote
import gzip
import mimetypes
import sys

ROOT = Path(__file__).parent.resolve()
COMPRESSIBLE = {"text/html", "text/css", "application/javascript", "application/json", "application/manifest+json", "image/svg+xml", "text/plain", "application/xml"}
IMMUTABLE_SUFFIXES = {".css", ".js", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".ico", ".woff2"}


class PerformanceHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def translate_path(self, path):
        relative = Path(unquote(path.split("?", 1)[0]).lstrip("/"))
        return str(ROOT / relative)

    def end_headers(self):
        path = Path(self.translate_path(self.path))
        if path.suffix.lower() in IMMUTABLE_SUFFIXES:
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_head(self):
        path = Path(self.translate_path(self.path))
        if path.is_dir():
            path /= "index.html"
        if path.is_file():
            content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
            raw = path.read_bytes()
            accepts_gzip = "gzip" in self.headers.get("Accept-Encoding", "").lower()
            compressed = accepts_gzip and content_type in COMPRESSIBLE
            body = gzip.compress(raw, compresslevel=9) if compressed else raw
            self.send_response(200)
            self.send_header("Content-type", content_type)
            self.send_header("Content-Length", str(len(body)))
            if compressed:
                self.send_header("Content-Encoding", "gzip")
                self.send_header("Vary", "Accept-Encoding")
            self.end_headers()
            return body
        return super().send_head()

    def do_GET(self):
        body = self.send_head()
        if isinstance(body, bytes):
            self.wfile.write(body)
        elif body:
            self.copyfile(body, self.wfile)
            body.close()

    def do_HEAD(self):
        body = self.send_head()
        if body and not isinstance(body, bytes):
            body.close()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = ThreadingHTTPServer(("", port), PerformanceHandler)
    print(f"Serving with gzip and cache headers on http://localhost:{port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
