"""Write each Route's generated <head> block into its own document, as routes.json describes it.

Run from the repository root:  python tools/build-pages.py

routes.json is the one home of every Route fact -- path, file, canonical -- with two consumers:
this generator and tests/performance-contract.mjs, which holds every value written here against
the source it came from. server.py does not read it: there is one Route, already served.

This is the first generator whose source and its output are the same file. Everything outside the
two marker comments is hand-written and never touched; everything between them is written here.
Insertion is structural, never a regex over the markup: html.parser walks the document and reports
where the markers and </head> begin, which is the rigour lib/page.mjs applies in JavaScript. A
rebuild replaces what lies between the markers, so running this twice changes no byte -- and a
change to index.html still demands node tools/build-arms.mjs, as a Master's change demands its
Rungs.
"""

import json
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ROUTES = json.loads((ROOT / "routes.json").read_text("utf-8"))

BEGIN = " routes.json: begin "
END = " routes.json: end "
INDENT = "  "


def escape(text):
    """What a double-quoted attribute cannot hold, and nothing else: the four the contract decodes."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


class Head(HTMLParser):
    """Where the generated block's edges and </head> begin, as offsets into the source."""

    def __init__(self, source):
        super().__init__()
        # The first character of each line, so getpos()'s (line, column) reads as an index.
        self.lines = [0]
        for line in source.splitlines(keepends=True):
            self.lines.append(self.lines[-1] + len(line))
        self.begin = None
        self.end = None
        self.head_close = None
        self.feed(source)
        self.close()

    def at(self):
        line, column = self.getpos()
        return self.lines[line - 1] + column

    def handle_endtag(self, tag):
        if tag == "head" and self.head_close is None:
            self.head_close = self.at()

    def handle_comment(self, data):
        if data == BEGIN:
            self.begin = self.at()
        if data == END:
            self.end = self.at() + len(data) + 7  # <!-- + data + -->


def block(route):
    lines = [
        f"<!--{BEGIN}-->",
        f'<link rel="canonical" href="{escape(route["canonical"])}">',
        f"<!--{END}-->",
    ]
    return ("\n" + INDENT).join(lines)


def build(route):
    path = ROOT / route["file"]
    # newline="" on both halves: Windows would otherwise read LF and write CRLF, and every byte of
    # the document would change on a rebuild that changed nothing.
    with path.open("r", encoding="utf-8", newline="") as handle:
        source = handle.read()
    head = Head(source)
    text = block(route)
    if head.begin is not None and head.end is not None:
        written = source[: head.begin] + text + source[head.end :]
    elif head.head_close is not None:
        written = source[: head.head_close] + INDENT + text + "\n" + source[head.head_close :]
    else:
        raise SystemExit(f'{route["file"]}: no </head> to write the block before')
    changed = written != source
    if changed:
        with path.open("w", encoding="utf-8", newline="") as handle:
            handle.write(written)
    print(f'  {route["file"]:24} {"wrote" if changed else "unchanged":9} {route["path"]}')
    return changed


if __name__ == "__main__":
    written = [build(route) for route in ROUTES["routes"]]
    print(f"{len(written)} Routes from routes.json, {sum(written)} written")
