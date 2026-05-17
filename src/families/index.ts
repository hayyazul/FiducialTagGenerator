/**
 * Tag-family registry. Each family ships as a single PNG mosaic stored at
 * `mosaicPath`, served as a static asset by Vite. The mosaic format,
 * shared with the upstream `apriltag-imgs` repository, is:
 *
 *   - A grid of square tiles, each `tileSize_px × tileSize_px`.
 *   - Tiles are separated by a 1-pixel black line (so the stride from the
 *     left edge of one tile to the next is `tileSize_px + 1`).
 *   - Tile (col, row) holds tag id = row * cols + col, with row 0 at the
 *     top, col 0 at the left.
 *   - The tile is the tag bitmap exactly as it should be printed; any
 *     white border the family ships with (e.g. tag36h11's outer ring) is
 *     part of the tag, not a quiet zone to strip.
 *
 * Adding a new family is one entry in `FAMILIES` plus dropping its mosaic
 * into `public/resources/`. No other code needs to change.
 */

/**
 * A source of tag bit grids. `render/pdf` consumes one to draw each tag as
 * vector rectangles; `preview/tag-images` consumes one to rasterise each tag
 * to a small PNG for the live preview. Neither cares whether the grid came
 * from a static fixture, the live `families/load` loader, or a unit-test
 * mock. `null` means "not available right now" (mosaic still loading, unknown
 * family, id out of range); consumers should fall back to a placeholder
 * rather than failing.
 */
export interface BitsProvider {
  bits(family: string, id: number): boolean[][] | null;
}

export interface TagFamilyDef {
  name: string;
  mosaicPath: string;
  /** Side length of one tile in mosaic pixels, equal to the tag bitmap's
   *  side length in modules (one pixel per module). */
  tileSize_px: number;
  /** AprilTag-spec "tag size" in modules — the distance between detection
   *  corners, i.e. the length of the edge between the white border and the
   *  black border. For families whose tile already contains a white outer
   *  ring (tag36h11) this is `tileSize_px − 2`; for "Standard" / "Custom"
   *  families whose outer modules carry data, it is smaller still. The UI's
   *  Tag size input is interpreted in these units, then scaled to compute
   *  the printed tile dimension. */
  widthAtBorder_modules: number;
  /** Number of valid tag IDs in the family. The mosaic may contain extra
   *  blank tiles to round out a rectangular grid; ids ≥ this number do not
   *  correspond to real tags. */
  validTagCount: number;
  /** UI grouping label. Families with the same `group` appear under one
   *  `<optgroup>` in the family picker. Layout/render code ignores this. */
  group?: string;
}

// Display order is the iteration order of this object. The UI groups
// consecutive entries by `group`, so keep families intended for the same
// `<optgroup>` adjacent here.
const FAMILIES: Record<string, TagFamilyDef> = {
  tag36h11: {
    name: "tag36h11",
    mosaicPath: `${import.meta.env.BASE_URL}resources/tag36h11_mosaic.png`,
    tileSize_px: 10,
    widthAtBorder_modules: 8,
    validTagCount: 587,
    group: "Classic",
  },
  tagStandard41h12: {
    name: "tagStandard41h12",
    mosaicPath: `${import.meta.env.BASE_URL}resources/tagStandard41h12_mosaic.png`,
    tileSize_px: 9,
    widthAtBorder_modules: 5,
    validTagCount: 2115,
    group: "Standard",
  },
  tagStandard52h13: {
    name: "tagStandard52h13",
    mosaicPath: `${import.meta.env.BASE_URL}resources/tagStandard52h13_mosaic.png`,
    tileSize_px: 10,
    widthAtBorder_modules: 6,
    validTagCount: 48714,
    group: "Standard",
  },
  tagCustom48h12: {
    name: "tagCustom48h12",
    mosaicPath: `${import.meta.env.BASE_URL}resources/tagCustom48h12_mosaic.png`,
    tileSize_px: 10,
    widthAtBorder_modules: 6,
    validTagCount: 42211,
    group: "Custom",
  },
};

export function getFamily(name: string): TagFamilyDef | undefined {
  return FAMILIES[name];
}

export function listFamilyNames(): string[] {
  return Object.keys(FAMILIES);
}

/** Number of tile columns and rows in a mosaic of the given pixel size,
 *  given the family's tile geometry. */
export function mosaicGrid(
  family: TagFamilyDef,
  mosaicWidth_px: number,
  mosaicHeight_px: number,
): { cols: number; rows: number } {
  const stride = family.tileSize_px + 1;
  // (n*tile + (n-1)*1) = mosaic ⇒ n = (mosaic+1)/(tile+1)
  return {
    cols: Math.floor((mosaicWidth_px + 1) / stride),
    rows: Math.floor((mosaicHeight_px + 1) / stride),
  };
}

/**
 * Extract the bit grid for tag `id` from raw mosaic pixel data. `pixels` is
 * grayscale (one byte per pixel) in row-major order, top-left first. Returns
 * a `[edge][edge]` boolean grid where `true` is a black bit and `bits[0]` is
 * the topmost row of the tag bitmap.
 *
 * Pure function; suitable for unit tests with synthesized pixel buffers.
 */
export function extractTagBits(
  pixels: Uint8Array | Uint8ClampedArray,
  mosaicWidth_px: number,
  mosaicHeight_px: number,
  family: TagFamilyDef,
  id: number,
): boolean[][] {
  if (pixels.length < mosaicWidth_px * mosaicHeight_px) {
    throw new Error(
      `pixels buffer too small: have ${pixels.length}, need ${
        mosaicWidth_px * mosaicHeight_px
      }`,
    );
  }
  const { cols, rows } = mosaicGrid(family, mosaicWidth_px, mosaicHeight_px);
  if (id < 0 || id >= cols * rows) {
    throw new Error(
      `tag id ${id} out of range for ${family.name} mosaic (have ${cols * rows} tiles)`,
    );
  }
  const stride = family.tileSize_px + 1;
  const col = id % cols;
  const row = Math.floor(id / cols);
  const x0 = col * stride;
  const y0 = row * stride;
  const edge = family.tileSize_px;

  const out: boolean[][] = [];
  for (let dy = 0; dy < edge; dy++) {
    const r: boolean[] = [];
    for (let dx = 0; dx < edge; dx++) {
      const idx = (y0 + dy) * mosaicWidth_px + (x0 + dx);
      // Threshold at midpoint; mosaic pixels are pure 0 or 255 in practice.
      r.push(pixels[idx]! < 128);
    }
    out.push(r);
  }
  return out;
}
