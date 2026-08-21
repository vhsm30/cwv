"""Regenerate the derived image files in images/ from the checked-in masters.

Run from the repository root:  python tools/build-images.py

The page never requests a master directly. Masters are the largest honest source we hold;
everything else here is derived and safe to delete and rebuild.

  masters (do not delete)   hero.jpg, notebook.jpg, mug.jpg, coffee.jpg
  also pre-existing         hero-640.jpg, hero-768.jpg  (JPEG fallback rungs, not rebuilt here)
  derived by this script    hero-*.webp, <product>-<width>.{webp,jpg}

Two rules are load-bearing and the Performance Contract asserts their results:

1. Products are centre-cropped to 4:5 to match .product-image's aspect-ratio, so object-fit:cover
   discards nothing at render time. Shipping the uncropped frame wastes ~47% of the bytes for the
   landscape sources.
2. Candidate widths never exceed what the master can honestly supply. Upscaling invents detail and
   costs bytes for nothing, so mug and coffee stop at 374px -- their masters are 700x467 landscape,
   which yields only a 374x467 crop at 4:5.
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent / "images"
RATIO = 4 / 5  # .product-image aspect-ratio in index.html's inline <style>

WEBP_QUALITY = 82
JPEG_QUALITY = 80
# The beans photo is high-frequency and misses Lighthouse's image-delivery threshold at 82.
WEBP_QUALITY_OVERRIDES = {"coffee": 75}

PRODUCTS = ("notebook", "mug", "coffee")
PRODUCT_WIDTHS = (400, 700)
HERO_WIDTHS = (640, 768, 1200)


def centre_crop(image, ratio):
    if image.width / image.height > ratio:
        width = round(image.height * ratio)
        left = (image.width - width) // 2
        return image.crop((left, 0, left + width, image.height))
    height = round(image.width / ratio)
    top = (image.height - height) // 2
    return image.crop((0, top, image.width, top + height))


def save(image, path, quality):
    if path.suffix == ".webp":
        image.save(path, "WEBP", quality=quality, method=6)
    else:
        image.save(path, "JPEG", quality=quality, optimize=True, progressive=True)
    print(f"  {path.name:22} {path.stat().st_size:7} bytes  {image.width}x{image.height}")


def build_products():
    for product in PRODUCTS:
        master = centre_crop(Image.open(ROOT / f"{product}.jpg").convert("RGB"), RATIO)
        widths = [w for w in PRODUCT_WIDTHS if w <= master.width] or [master.width]
        webp_quality = WEBP_QUALITY_OVERRIDES.get(product, WEBP_QUALITY)
        print(f"{product}: master crop {master.width}x{master.height}, webp q{webp_quality}")
        for width in widths:
            image = master if width == master.width else master.resize(
                (width, round(width / RATIO)), Image.LANCZOS
            )
            save(image, ROOT / f"{product}-{width}.webp", webp_quality)
            save(image, ROOT / f"{product}-{width}.jpg", JPEG_QUALITY)


def build_hero():
    master = Image.open(ROOT / "hero.jpg").convert("RGB")
    print(f"hero: master {master.width}x{master.height}, webp q{WEBP_QUALITY}")
    for width in HERO_WIDTHS:
        image = master if width == master.width else master.resize(
            (width, round(master.height * width / master.width)), Image.LANCZOS
        )
        name = "hero.webp" if width == master.width else f"hero-{width}.webp"
        save(image, ROOT / name, WEBP_QUALITY)


if __name__ == "__main__":
    build_products()
    build_hero()
