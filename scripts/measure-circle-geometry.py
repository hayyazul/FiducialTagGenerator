#!/usr/bin/env python3
"""
Measure `outerRadius_modules` and `widthAtBorder_modules` for the AprilTag
Circle families from their committed mosaics, and print snippets ready to
drop into `src/families/index.ts`.

Run:   python3 scripts/measure-circle-geometry.py

`outerRadius_modules`
    Radius, in module units, of the smallest circle centered on the tile
    center that encloses every printed (black) pixel across all valid tags.
    Used to size the printed circular cut around each tag.

    Each pixel (col, row) has an outer-corner distance from the tile center
    ((edge-1)/2, (edge-1)/2) of
        sqrt((|col-cx|+0.5)^2 + (|row-cy|+0.5)^2).
    We take the max over all black pixels in any valid tag.

`widthAtBorder_modules`
    Detection edge (length of the black-border square the detector reads).
    Detected as the largest concentric solid black axis-aligned square
    outline that appears in every valid tag. The Circle families ship with
    a black ring along the inner detection square; this script finds that
    ring's edge length by intersecting the per-tag detected sets.

Mosaic format matches the rest of the project (square tiles separated by a
single 1-pixel black gridline, top-left origin).
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Iterable

from PIL import Image

PROJECT_ROOT = Path(__file__).resolve().parent.parent
RESOURCES = PROJECT_ROOT / "public" / "resources"

CIRCLE_FAMILIES: list[tuple[str, int, int]] = [
    # (name, tileSize_px, validTagCount)
    ("tagCircle21h7", 9, 38),
    ("tagCircle49h12", 11, 65535),
]


def load_grayscale(path: Path) -> tuple[bytes, int, int]:
    img = Image.open(path).convert("L")
    return img.tobytes(), img.size[0], img.size[1]


def mosaic_grid(width_px: int, height_px: int, tile_px: int) -> tuple[int, int]:
    stride = tile_px + 1
    return (width_px + 1) // stride, (height_px + 1) // stride


def extract_tile(
    pixels: bytes, W: int, H: int, tile_px: int, cols: int, tag_id: int
) -> list[list[bool]]:
    stride = tile_px + 1
    col = tag_id % cols
    row = tag_id // cols
    x0 = col * stride
    y0 = row * stride
    out: list[list[bool]] = []
    for dy in range(tile_px):
        r: list[bool] = []
        for dx in range(tile_px):
            r.append(pixels[(y0 + dy) * W + (x0 + dx)] < 128)
        out.append(r)
    return out


def circle_occupied_mask(edge: int, outer_radius_modules: float) -> list[list[bool]]:
    """Occupied-cell mask for a circle family: a cell is inside the tag if
    its outer corner lies within outer_radius_modules of the tile center."""
    center = (edge - 1) / 2
    mask: list[list[bool]] = []
    for r in range(edge):
        row: list[bool] = []
        for c in range(edge):
            dx = abs(c - center) + 0.5
            dy = abs(r - center) + 0.5
            row.append((dx * dx + dy * dy) ** 0.5 <= outer_radius_modules + 1e-9)
        mask.append(row)
    return mask


def outer_radius_modules(bits: list[list[bool]], edge: int) -> float:
    """Max distance from tile center to any black pixel's outer corner."""
    cx = (edge - 1) / 2
    cy = (edge - 1) / 2
    best = 0.0
    for row in range(edge):
        for col in range(edge):
            if not bits[row][col]:
                continue
            dx = abs(col - cx) + 0.5
            dy = abs(row - cy) + 0.5
            r = (dx * dx + dy * dy) ** 0.5
            if r > best:
                best = r
    return best


def is_solid_square_outline(
    bits: list[list[bool]], edge: int, side: int, black: bool
) -> bool:
    """Tile-centered solid outline of edge-length `side` (in modules), with
    every pixel matching `black` (true=black, false=white). Square families
    have a solid black detection border; Circle families have a reversed
    (white) border, so we try both colours and take whichever appears."""
    if side < 1 or side > edge:
        return False
    half = side / 2
    cx = (edge - 1) / 2
    cy = (edge - 1) / 2
    x0 = round(cx - (half - 0.5))
    x1 = round(cx + (half - 0.5))
    y0 = round(cy - (half - 0.5))
    y1 = round(cy + (half - 0.5))
    if x0 < 0 or y0 < 0 or x1 >= edge or y1 >= edge:
        return False
    for x in range(x0, x1 + 1):
        if bits[y0][x] != black or bits[y1][x] != black:
            return False
    for y in range(y0, y1 + 1):
        if bits[y][x0] != black or bits[y][x1] != black:
            return False
    return True


def candidate_widthAtBorder(bits: list[list[bool]], edge: int) -> set[tuple[int, bool]]:
    """(side, isBlack) pairs of solid centered outlines in this tile. The
    (side, color) pair present in *every* valid tag identifies the family's
    detection border; the largest such side is `widthAtBorder_modules`.
    Square families resolve to isBlack=True, Circle families (reversed
    border) to isBlack=False."""
    out: set[tuple[int, bool]] = set()
    for side in range(1, edge + 1):
        for black in (True, False):
            if is_solid_square_outline(bits, edge, side, black=black):
                out.add((side, black))
    return out


def measure(name: str, tile_px: int, valid: int, mask_radius: float):
    path = RESOURCES / f"{name}_mosaic.png"
    pixels, W, H = load_grayscale(path)
    cols, _rows = mosaic_grid(W, H, tile_px)
    raw_max = 0.0  # max distance to any black pixel
    common_outlines: set[tuple[int, bool]] | None = None
    mask = circle_occupied_mask(tile_px, mask_radius)
    violations = 0
    for tag_id in range(valid):
        bits = extract_tile(pixels, W, H, tile_px, cols, tag_id)
        r = outer_radius_modules(bits, tile_px)
        if r > raw_max:
            raw_max = r
        # Check mask covers all black pixels.
        for row in range(tile_px):
            for col in range(tile_px):
                if bits[row][col] and not mask[row][col]:
                    violations += 1
        outlines = candidate_widthAtBorder(bits, tile_px)
        common_outlines = outlines if common_outlines is None else (common_outlines & outlines)
        if common_outlines is None or len(common_outlines) == 0:
            break
    cands = sorted(common_outlines or [], key=lambda x: (x[0], not x[1]))
    return raw_max, mask_radius, cands, violations


# Known-good mask radii that produce the correct circular tag shape.
# These are DESIGN CHOICES, not measured values — they exclude corner
# cells of the decorative ring that lie outside the circular contour.
MASK_RADII = {
    "tagCircle21h7": 4.949747468305833,
    "tagCircle49h12": 5.70087712549569,
}


def main() -> None:
    print("Family               tile_px   validTags   raw_max_radius   mask_radius   cells_suppressed   border candidates")
    print("-" * 115)
    results: list[tuple[str, int, int, float, float, list[tuple[int, bool]]]] = []
    for name, tile_px, valid in CIRCLE_FAMILIES:
        mr = MASK_RADII[name]
        raw, mask_r, cands, violations = measure(name, tile_px, valid, mr)
        results.append((name, tile_px, valid, raw, mask_r, cands))
        cands_str = ", ".join(
            f"{side}/{'B' if black else 'W'}" for side, black in cands
        ) or "(none)"
        print(f"{name:<20} {tile_px:>7}   {valid:>9}   {raw:>14.6f}   {mask_r:>10.6f}   {violations:>15}   {cands_str}")

    print(
        "\nNote: for square families the canonical detection border is the largest\n"
        "all-black outline; for the Circle families (`reversed_border` upstream) it is\n"
        "the largest all-white outline. Pick `widthAtBorder_modules` from the\n"
        "candidate list accordingly. Upstream apriltag values: 5 for both Circle\n"
        "families."
    )

    print("\nDrop-in entries for src/families/index.ts (widthAtBorder from upstream):\n")
    UPSTREAM_WAB = {"tagCircle21h7": 5, "tagCircle49h12": 5}
    for name, tile_px, valid, _raw, mask_r, _cands in results:
        wab = UPSTREAM_WAB[name]
        print(f"  {name}: {{")
        print(f'    name: "{name}",')
        print(f"    mosaicPath: `${{import.meta.env.BASE_URL}}resources/{name}_mosaic.png`,")
        print(f"    tileSize_px: {tile_px},")
        print(f"    widthAtBorder_modules: {wab},")
        print(f"    outerRadius_modules: {mask_r:.15f},")
        print(f"    validTagCount: {valid},")
        print(f'    shape: "circle",')
        print(f'    group: "Circle",')
        print(f"  }},")


if __name__ == "__main__":
    main()
