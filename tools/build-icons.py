"""Rebuild every icon and screenshot in icons/ from manifest.webmanifest, as pure geometry.

Run from the repository root:  python tools/build-icons.py

manifest.webmanifest is the one home of every icon fact -- src, sizes, purpose, form_factor, and
the two colours -- with three consumers: this generator, tests/performance-contract.mjs (which
verifies the files on disk against the same manifest), and the browser. There is no icons.json:
a manifest is already a data file, so a second table would only need an agreement assertion.

Every file in icons/ is drawn here from theme_color and background_color alone, with no text, no
timestamp, and no anti-aliasing luck (drawn at 4x and reduced with LANCZOS), so a rebuild is
byte-identical -- which is what lets each file be Generation-stamped in its name and served by the
Measurement Server as an Immutable Asset. They are placeholders: the mark is a ring of ink on
paper holding three ruled lines, and each screenshot is the Storefront's layout in blocks. Replace
them by editing the manifest and re-running; never edit a PNG by hand.
"""

import json
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "icons"
MANIFEST = json.loads((ROOT / "manifest.webmanifest").read_text("utf-8"))

SCALE = 4  # drawn at this multiple, then reduced: ImageDraw itself does not anti-alias


def colour(hex_value):
    digits = hex_value.lstrip("#")
    return tuple(int(digits[at:at + 2], 16) for at in (0, 2, 4))


INK = colour(MANIFEST["theme_color"])
PAPER = colour(MANIFEST["background_color"])


def blend(amount):
    """Ink over paper at `amount` (0 = paper, 1 = ink): every other tone derives from the two."""
    return tuple(round(p + (i - p) * amount) for p, i in zip(PAPER, INK))


def size_of(entry):
    width, height = entry["sizes"].split("x")
    return int(width), int(height)


def reduce(canvas, width, height):
    return canvas.resize((width, height), Image.LANCZOS)


def mark(size, maskable):
    """A ring of ink holding three ruled lines. Maskable icons keep to the launcher's safe zone --
    the central circle of 80% -- so the mark is drawn smaller and the paper fills the whole square."""
    big = size * SCALE
    canvas = Image.new("RGB", (big, big), PAPER)
    draw = ImageDraw.Draw(canvas)
    diameter = big * (0.56 if maskable else 0.72)
    ring = big * 0.055
    centre = big / 2
    outer = (centre - diameter / 2, centre - diameter / 2, centre + diameter / 2, centre + diameter / 2)
    draw.ellipse(outer, fill=INK)
    inner = tuple(edge + ring * (1 if index < 2 else -1) for index, edge in enumerate(outer))
    draw.ellipse(inner, fill=PAPER)
    line_width = diameter * 0.42
    line_height = diameter * 0.055
    for offset in (-0.16, 0.0, 0.16):
        top = centre + diameter * offset - line_height / 2
        draw.rectangle((centre - line_width / 2, top, centre + line_width / 2, top + line_height), fill=INK)
    return reduce(canvas, size, size)


def screenshot(width, height, narrow):
    """The Storefront in blocks: announcement, header, Hero, the Collection, the note, footer."""
    big_w, big_h = width * SCALE, height * SCALE
    canvas = Image.new("RGB", (big_w, big_h), PAPER)
    draw = ImageDraw.Draw(canvas)
    unit = big_w / 100
    y = 0

    def block(x0, y0, x1, y1, tone):
        draw.rectangle((x0, y0, x1, y1), fill=tone)

    block(0, 0, big_w, unit * 4, INK)  # the announcement
    y += unit * 4
    block(unit * 4, y + unit * 2.5, unit * 26, y + unit * 4.5, INK)  # the brand
    block(big_w - unit * 14, y + unit * 2.5, big_w - unit * 4, y + unit * 4.5, blend(0.6))  # the Bag
    y += unit * 7

    hero_h = unit * (134 if narrow else 34)
    block(0, y, big_w, y + hero_h, blend(0.08))  # the Hero ground
    if narrow:
        block(0, y, big_w, y + big_w, blend(0.35))  # the Hero image, square, above the copy
        copy_top, copy_left, copy_w = y + big_w + unit * 6, unit * 5, unit * 70
    else:
        block(big_w / 2, y, big_w, y + hero_h, blend(0.35))  # the Hero image in the right column
        copy_top, copy_left, copy_w = y + unit * 6, unit * 6, unit * 32
    block(copy_left, copy_top, copy_left + copy_w * 0.3, copy_top + unit * 1.2, blend(0.5))  # the label
    block(copy_left, copy_top + unit * 3, copy_left + copy_w, copy_top + unit * 8, INK)  # the headline
    block(copy_left, copy_top + unit * 9, copy_left + copy_w * 0.8, copy_top + unit * 14, INK)
    block(copy_left, copy_top + unit * 16, copy_left + copy_w * 0.7, copy_top + unit * 17.2, blend(0.45))  # the line
    block(copy_left, copy_top + unit * 20, copy_left + copy_w * 0.45, copy_top + unit * 24, INK)  # the button
    y += hero_h + unit * (7 if narrow else 5)

    columns = 2 if narrow else 3
    gap = unit * 2
    margin = unit * 5
    column_w = (big_w - margin * 2 - gap * (columns - 1)) / columns
    block(margin, y, margin + column_w * 0.9, y + unit * 3, INK)  # the Collection's heading
    y += unit * 5
    for index in range(3):
        column = index % columns
        row = index // columns
        x0 = margin + column * (column_w + gap)
        y0 = y + row * (column_w * 1.25 + unit * 9)
        block(x0, y0, x0 + column_w, y0 + column_w * 1.25, blend(0.12))  # the Product image, 4:5
        block(x0, y0 + column_w * 1.25 + unit * 1.5, x0 + column_w * 0.6, y0 + column_w * 1.25 + unit * 3, INK)  # the name
        block(x0, y0 + column_w * 1.25 + unit * 4, x0 + column_w * 0.35, y0 + column_w * 1.25 + unit * 5, blend(0.5))  # the type
    rows = -(-3 // columns)
    y += rows * (column_w * 1.25 + unit * 9)

    # A screenshot is one screenful: the note and the footer appear only where the page ends on it.
    footer_top = max(y + unit * 12, big_h - unit * 8)
    if footer_top < big_h:
        block(margin, y, big_w - margin, y + unit * 0.3, blend(0.2))  # the note's rule
        block(margin, y + unit * 2, margin + unit * 30, y + unit * 4.5, INK)
        block(margin, y + unit * 6, big_w - margin, y + unit * 7, blend(0.45))
        block(margin, y + unit * 8, big_w - margin * 3, y + unit * 9, blend(0.45))
        block(0, footer_top, big_w, big_h, INK)  # the footer
    return reduce(canvas, width, height)


def build():
    ICONS.mkdir(exist_ok=True)
    for entry in MANIFEST["icons"]:
        width, height = size_of(entry)
        if width != height:
            raise SystemExit(f"{entry['src']}: an icon must be square, not {entry['sizes']}")
        maskable = "maskable" in entry.get("purpose", "any").split()
        save(mark(width, maskable), entry["src"])
    for entry in MANIFEST["screenshots"]:
        width, height = size_of(entry)
        save(screenshot(width, height, narrow=entry["form_factor"] == "narrow"), entry["src"])


def save(image, src):
    path = ROOT / src.removeprefix("./")
    if path.parent != ICONS:
        raise SystemExit(f"{src}: every icon and screenshot lives directly under icons/")
    image.save(path, "PNG", optimize=True)
    print(f"  {path.name:28} {path.stat().st_size:7} bytes  {image.width}x{image.height}")


if __name__ == "__main__":
    build()
