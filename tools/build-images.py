"""Rebuild every Rung in images/ from the Masters, as images/slots.json describes them.

Run from the repository root:  python tools/build-images.py

images/slots.json is the one home of each Slot's facts -- master, ratio, widths, sizes, box --
with three consumers: this generator, tests/performance-contract.mjs (which verifies the markup
and the files on disk against the same table), and CLAUDE.md. A Master is the largest honest
source we hold; the page never requests it. Every other file in images/ is a Rung named
<slot>-<width>.<webp|jpg>, derived here, and safe to delete and rebuild byte-identically.

Two rules are load-bearing and the Performance Contract asserts their results:

1. A Slot with a ratio is centre-cropped to it, so object-fit:cover discards nothing at render
   time. Shipping the uncropped frame wastes ~47% of the bytes for the landscape sources.
2. A Rung never exceeds what the Master can honestly supply. Upscaling invents detail and costs
   bytes for nothing, so a width wider than the crop is refused rather than built.

The crop and resize arithmetic here is mirrored in the contract; both round half up.
"""

import json
import math
from pathlib import Path

from PIL import Image

IMAGES = Path(__file__).resolve().parent.parent / "images"
SLOTS = json.loads((IMAGES / "slots.json").read_text("utf-8"))

WEBP_QUALITY = 82  # a Slot may override this in slots.json ("webp_quality")
JPEG_QUALITY = 80


def half_up(value):
    """Round half up, like Math.round in the contract (Python's round() is half-to-even)."""
    return math.floor(value + 0.5)


def centre_crop(image, ratio):
    if ratio is None:
        return image
    target = ratio[0] / ratio[1]
    if image.width / image.height > target:
        width = half_up(image.height * target)
        left = (image.width - width) // 2
        return image.crop((left, 0, left + width, image.height))
    height = half_up(image.width / target)
    top = (image.height - height) // 2
    return image.crop((0, top, image.width, top + height))


def rung(crop, width):
    if width == crop.width:
        return crop
    return crop.resize((width, half_up(width * crop.height / crop.width)), Image.LANCZOS)


def save(image, path, quality):
    if path.suffix == ".webp":
        image.save(path, "WEBP", quality=quality, method=6)
    else:
        image.save(path, "JPEG", quality=quality, optimize=True, progressive=True)
    print(f"  {path.name:22} {path.stat().st_size:7} bytes  {image.width}x{image.height}")


def build(name, slot):
    master = Image.open(IMAGES / slot["master"]).convert("RGB")
    crop = centre_crop(master, slot.get("ratio"))
    too_wide = [width for width in slot["widths"] if width > crop.width]
    if too_wide:
        raise SystemExit(f"{name}: {too_wide} exceed the {crop.width}px the master can honestly supply")
    webp_quality = slot.get("webp_quality", WEBP_QUALITY)
    print(f"{name}: master {master.width}x{master.height}, crop {crop.width}x{crop.height}, webp q{webp_quality}")
    for width in slot["widths"]:
        image = rung(crop, width)
        save(image, IMAGES / f"{name}-{width}.webp", webp_quality)
        save(image, IMAGES / f"{name}-{width}.jpg", JPEG_QUALITY)


if __name__ == "__main__":
    for name, slot in SLOTS.items():
        build(name, slot)
