#!/usr/bin/env python3
"""Report likely visual duplicates without modifying image files."""

from __future__ import annotations

import argparse
import fnmatch
import sys
from pathlib import Path

try:
    from PIL import Image, ImageOps, UnidentifiedImageError
except ModuleNotFoundError:
    sys.exit("Pillow is required. Install it with: python3 -m pip install Pillow")


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}


def dhash(path: Path) -> int:
    """Return a 64-bit hash resilient to resizing and JPEG artifacts."""
    with Image.open(path) as image:
        resized = (
            ImageOps.exif_transpose(image)
            .convert("L")
            .resize((9, 8), Image.Resampling.LANCZOS)
        )
        pixels = list(resized.getdata())

    result = 0
    for row in range(8):
        offset = row * 9
        for column in range(8):
            result = (result << 1) | (
                pixels[offset + column] > pixels[offset + column + 1]
            )
    return result


def dimensions(path: Path) -> tuple[int, int]:
    with Image.open(path) as image:
        return image.size


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Find likely Telegram-photo duplicates with a perceptual hash",
    )
    parser.add_argument("images_dir", type=Path)
    parser.add_argument("--candidate-glob", default="photo_*")
    parser.add_argument("--threshold", type=int, default=4)
    args = parser.parse_args()

    if not args.images_dir.is_dir():
        parser.error(f"not a directory: {args.images_dir}")
    if not 0 <= args.threshold <= 64:
        parser.error("--threshold must be between 0 and 64")

    paths = sorted(
        path
        for path in args.images_dir.rglob("*")
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
    )
    candidates = [
        path
        for path in paths
        if fnmatch.fnmatch(path.name.lower(), args.candidate_glob.lower())
    ]
    references = [path for path in paths if path not in candidates]
    hashes: dict[Path, int] = {}

    for path in paths:
        try:
            hashes[path] = dhash(path)
        except (OSError, UnidentifiedImageError) as error:
            print(f"SKIP {path}: {error}", file=sys.stderr)

    matches: list[tuple[int, Path, Path]] = []
    for candidate in candidates:
        if candidate not in hashes:
            continue
        for reference in references:
            if reference not in hashes:
                continue
            distance = (hashes[candidate] ^ hashes[reference]).bit_count()
            if distance <= args.threshold:
                matches.append((distance, candidate, reference))

    if not matches:
        print("No likely duplicates found.")
        return 0

    for distance, candidate, reference in sorted(matches):
        candidate_size = dimensions(candidate)
        reference_size = dimensions(reference)
        print(
            f"distance={distance:2d}  candidate={candidate} "
            f"({candidate_size[0]}x{candidate_size[1]})",
        )
        print(
            f"              render={reference} "
            f"({reference_size[0]}x{reference_size[1]})",
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
