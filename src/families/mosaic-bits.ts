/**
 * Pure helpers for the AprilTag mosaic format used by every family
 * shipped with the official `apriltag-imgs` repository.
 *
 * Mosaic layout:
 *   - Grid of square tiles, each `edge_px × edge_px`.
 *   - 1-pixel black line between adjacent tiles (stride = `edge_px + 1`).
 *   - Tile `(col, row)` holds tag id `row * cols + col`, with row 0 at
 *     the top, col 0 at the left.
 *   - The tile is the tag bitmap as it should be printed; any white
 *     border the family ships with (e.g. tag36h11's outer ring) is part
 *     of the tag, not a quiet zone to strip.
 *
 * These helpers take primitive parameters rather than a family object so
 * they remain trivially testable and have no coupling to the rest of the
 * family system.
 */

/** Number of tile columns and rows in a mosaic of the given pixel size. */
export function mosaicGrid(
  edge_px: number,
  mosaicWidth_px: number,
  mosaicHeight_px: number,
): { cols: number; rows: number } {
  const stride = edge_px + 1;
  // (n*tile + (n-1)*1) = mosaic ⇒ n = (mosaic+1)/(tile+1)
  return {
    cols: Math.floor((mosaicWidth_px + 1) / stride),
    rows: Math.floor((mosaicHeight_px + 1) / stride),
  };
}

/**
 * Extract the bit grid for tag `id` from raw mosaic pixel data. `pixels`
 * is grayscale (one byte per pixel), row-major, top-left first. Returns
 * a `[edge_px][edge_px]` boolean grid where `true` is a black bit and
 * `bits[0]` is the topmost row of the tag bitmap.
 *
 * `familyName` is used only to compose error messages on out-of-range id.
 */
export function extractTagBits(
  pixels: Uint8Array | Uint8ClampedArray,
  mosaicWidth_px: number,
  mosaicHeight_px: number,
  edge_px: number,
  familyName: string,
  id: number,
): boolean[][] {
  if (pixels.length < mosaicWidth_px * mosaicHeight_px) {
    throw new Error(
      `pixels buffer too small: have ${pixels.length}, need ${
        mosaicWidth_px * mosaicHeight_px
      }`,
    );
  }
  const { cols, rows } = mosaicGrid(edge_px, mosaicWidth_px, mosaicHeight_px);
  if (id < 0 || id >= cols * rows) {
    throw new Error(
      `tag id ${id} out of range for ${familyName} mosaic (have ${cols * rows} tiles)`,
    );
  }
  const stride = edge_px + 1;
  const col = id % cols;
  const row = Math.floor(id / cols);
  const x0 = col * stride;
  const y0 = row * stride;

  const out: boolean[][] = [];
  for (let dy = 0; dy < edge_px; dy++) {
    const r: boolean[] = [];
    for (let dx = 0; dx < edge_px; dx++) {
      const idx = (y0 + dy) * mosaicWidth_px + (x0 + dx);
      // Threshold at midpoint; mosaic pixels are pure 0 or 255 in practice.
      r.push(pixels[idx]! < 128);
    }
    out.push(r);
  }
  return out;
}

/**
 * Radius (in cell units) of the smallest circle centred on the tile
 * centre that encloses every black pixel in `bits`. The radius is
 * measured to the *outer* corner of each black pixel, not its centre, so
 * the returned circle reaches the visible edge of the printed cell.
 * Returns 0 for an all-white tile.
 *
 * `scripts/measure-circle-geometry.py` uses the same definition tag-by-
 * tag and reports the max across a family.
 */
export function outerRadiusModulesFor(bits: ReadonlyArray<ReadonlyArray<boolean>>): number {
  const edge = bits.length;
  if (edge === 0) return 0;
  const center = (edge - 1) / 2;
  let best = 0;
  for (let row = 0; row < edge; row++) {
    const r = bits[row]!;
    for (let col = 0; col < r.length; col++) {
      if (!r[col]) continue;
      const dx = Math.abs(col - center) + 0.5;
      const dy = Math.abs(row - center) + 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > best) best = dist;
    }
  }
  return best;
}

/**
 * Mask for a circle family: cell `(r, c)` is `true` iff the outer corner
 * of the cell lies within `outerRadiusCells` of the tile centre. This
 * naturally produces the correct shape for any radius — no per-family
 * branching, no hardcoded arm widths.
 */
export function circleOccupiedMask(edge: number, outerRadiusCells: number): boolean[][] {
  const center = (edge - 1) / 2;
  const mask: boolean[][] = [];
  for (let r = 0; r < edge; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < edge; c++) {
      const dx = Math.abs(c - center) + 0.5;
      const dy = Math.abs(r - center) + 0.5;
      row.push(Math.sqrt(dx * dx + dy * dy) <= outerRadiusCells + 1e-9);
    }
    mask.push(row);
  }
  return mask;
}

/**
 * Zero out cells outside the circular shape defined by `outerRadiusCells`.
 * Returns a fresh grid; the original is untouched.
 */
export function applyCircleMask(
  bits: ReadonlyArray<ReadonlyArray<boolean>>,
  outerRadiusCells: number,
): boolean[][] {
  const mask = circleOccupiedMask(bits.length, outerRadiusCells);
  return bits.map((row, r) => row.map((val, c) => val && (mask[r]?.[c] ?? false)));
}
