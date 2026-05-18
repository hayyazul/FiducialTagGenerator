import { describe, expect, it } from "vitest";
import {
  applyOccupiedMask,
  circleOccupiedMask,
  extractTagBits,
  getFamily,
  isRecursiveFamily,
  listSquareFamilyNames,
  mosaicGrid,
  outerRadiusModulesFor,
  type TagFamilyDef,
} from "./index";

/** Build a fake mosaic pixel buffer: 2×2 grid of 4×4 tiles with 1-pixel
 *  black separators between them. Then write a known bit pattern into one
 *  tile so the extractor's row/col indexing can be checked. */
function makeFakeMosaic(): {
  family: TagFamilyDef;
  pixels: Uint8Array;
  width: number;
  height: number;
} {
  const family: TagFamilyDef = {
    name: "fake",
    mosaicPath: "",
    tileSize_px: 4,
    widthAtBorder_modules: 4,
    validTagCount: 4,
    shape: "square",
  };
  // Layout:
  //   tiles at (0..3, 0..3), (5..8, 0..3), (0..3, 5..8), (5..8, 5..8)
  //   separator columns at x=4, separator rows at y=4
  const width = 9;
  const height = 9;
  const pixels = new Uint8Array(width * height).fill(255); // all white
  const set = (x: number, y: number, v: number): void => {
    pixels[y * width + x] = v;
  };
  // Black separator column at x=4 and row at y=4.
  for (let y = 0; y < height; y++) set(4, y, 0);
  for (let x = 0; x < width; x++) set(x, 4, 0);

  // Write a recognisable diagonal pattern into tile id=2 (col=0, row=1),
  // which occupies pixels (0..3, 5..8). All other pixels in the tile are
  // white, so we can read back the full 4×4 grid.
  set(0, 5, 0); // top-left
  set(3, 8, 0); // bottom-right

  return { family, pixels, width, height };
}

describe("mosaicGrid", () => {
  it("computes 2×2 for a 9×9 mosaic of 4×4 tiles + separators", () => {
    const { family } = makeFakeMosaic();
    expect(mosaicGrid(family, 9, 9)).toEqual({ cols: 2, rows: 2 });
  });

  it("computes 24×25 for the real tag36h11 geometry", () => {
    const family: TagFamilyDef = {
      name: "tag36h11",
      mosaicPath: "",
      tileSize_px: 10,
      widthAtBorder_modules: 8,
      validTagCount: 587,
      shape: "square",
    };
    expect(mosaicGrid(family, 263, 274)).toEqual({ cols: 24, rows: 25 });
  });
});

describe("extractTagBits", () => {
  it("returns the full tile as the bit grid", () => {
    const { family, pixels, width, height } = makeFakeMosaic();
    const bits = extractTagBits(pixels, width, height, family, 2);
    // Tile id=2 occupies pixels (0..3, 5..8): top-left and bottom-right
    // were set to black; everything else is white.
    expect(bits).toEqual([
      [true, false, false, false],
      [false, false, false, false],
      [false, false, false, false],
      [false, false, false, true],
    ]);
  });

  it("throws on out-of-range tag id", () => {
    const { family, pixels, width, height } = makeFakeMosaic();
    expect(() => extractTagBits(pixels, width, height, family, 4)).toThrow(/out of range/);
    expect(() => extractTagBits(pixels, width, height, family, -1)).toThrow(/out of range/);
  });

  it("computes outer radius (in modules) of the smallest enclosing circle", () => {
    // A 5×5 tile with a single black pixel at the (0, 0) corner. Tile center
    // is at (2, 2); the outer corner of pixel (0, 0) is at (-0.5, -0.5),
    // which is sqrt(2.5² + 2.5²) ≈ 3.5355 modules from the center.
    const tile = (mark: Array<[number, number]>, edge: number): boolean[][] =>
      Array.from({ length: edge }, (_, r) =>
        Array.from({ length: edge }, (_, c) => mark.some(([y, x]) => y === r && x === c)),
      );
    expect(outerRadiusModulesFor(tile([[0, 0]], 5))).toBeCloseTo(Math.sqrt(2 * 2.5 * 2.5), 6);
    // A tile with a single pixel at the center (radius = 0.5 √2 ≈ 0.707).
    expect(outerRadiusModulesFor(tile([[2, 2]], 5))).toBeCloseTo(Math.sqrt(0.5), 6);
    // Empty tile: zero radius.
    expect(outerRadiusModulesFor(tile([], 5))).toBe(0);
  });

  it("preserves row-major orientation: y=0 is the top row of the tag", () => {
    const family: TagFamilyDef = {
      name: "tiny",
      mosaicPath: "",
      tileSize_px: 2,
      widthAtBorder_modules: 2,
      validTagCount: 1,
      shape: "square",
    };
    // Single 2×2 tile occupying the entire image.
    // Make top row black, bottom row white.
    const w = 2;
    const h = 2;
    const px = new Uint8Array(w * h).fill(255);
    px[0] = 0;
    px[1] = 0;
    const bits = extractTagBits(px, w, h, family, 0);
    expect(bits[0]).toEqual([true, true]);
    expect(bits[1]).toEqual([false, false]);
  });
});

describe("circleOccupiedMask", () => {
  it("generates a 9x9 mask from radius=4.949747 (tagCircle21h7)", () => {
    const mask = circleOccupiedMask(9, 4.949747468305833);
    expect(mask).toHaveLength(9);
    mask.forEach((row) => expect(row).toHaveLength(9));

    // Corner L-shapes (5 cells) are outside the radius.
    expect(mask[0]![0]).toBe(false);
    expect(mask[0]![1]).toBe(false);
    expect(mask[0]![2]).toBe(false);
    expect(mask[1]![0]).toBe(false);
    expect(mask[2]![0]).toBe(false);

    // Top arm (row 0, cols 3-5) at distance ≤ 4.743 modules — inside radius.
    expect(mask[0]![3]).toBe(true);
    expect(mask[0]![4]).toBe(true);
    expect(mask[0]![5]).toBe(true);
    expect(mask[8]![3]).toBe(true);

    // 7x7 inner corner at distance 4.950 — inside radius.
    expect(mask[1]![1]).toBe(true);
    expect(mask[4]![4]).toBe(true);
    expect(mask[7]![7]).toBe(true);

    // Left arm (col 0, rows 3-5) occupied.
    expect(mask[3]![0]).toBe(true);
    expect(mask[4]![0]).toBe(true);
    expect(mask[5]![0]).toBe(true);
  });

  it("generates an 11x11 mask from radius=5.700877 (tagCircle49h12)", () => {
    const mask = circleOccupiedMask(11, 5.70087712549569);
    expect(mask).toHaveLength(11);

    // Corner L-shapes are outside the radius.
    expect(mask[0]![0]).toBe(false);
    expect(mask[0]![3]).toBe(false); // distance 6.041 > 5.701
    expect(mask[1]![1]).toBe(false); // distance 6.364 > 5.701 — key fix vs old mask
    expect(mask[3]![0]).toBe(false);

    // Second-ext top arm (row 0, cols 4-6) at distance ≤ 5.701 — inside radius.
    expect(mask[0]![4]).toBe(true);
    expect(mask[0]![5]).toBe(true);
    expect(mask[0]![6]).toBe(true);

    // First-ext corner at (1,2) distance 5.701 — inside radius.
    expect(mask[1]![2]).toBe(true);
    // Core 7x7 at (2,2) distance 4.950 — inside radius.
    expect(mask[2]![2]).toBe(true);
    expect(mask[5]![5]).toBe(true);
  });
});

describe("isRecursiveFamily", () => {
  it("returns true for tagCustom48h12", () => {
    const f = getFamily("tagCustom48h12")!;
    expect(isRecursiveFamily(f)).toBe(true);
    expect(f.centerBlock).toEqual({ row: 4, col: 4, size: 2 });
  });

  it("returns false for non-recursive families", () => {
    for (const name of ["tag36h11", "tagStandard41h12", "tagStandard52h13", "tagCircle21h7", "tagCircle49h12"]) {
      const f = getFamily(name)!;
      expect(isRecursiveFamily(f)).toBe(false);
      expect(f.centerBlock).toBeUndefined();
    }
  });
});

describe("listSquareFamilyNames", () => {
  it("returns only square-shaped families", () => {
    const names = listSquareFamilyNames();
    expect(names).toContain("tag36h11");
    expect(names).toContain("tagCustom48h12");
    expect(names).not.toContain("tagCircle21h7");
    expect(names).not.toContain("tagCircle49h12");
  });
});

describe("applyOccupiedMask", () => {
  it("passes bits through unchanged for square families", () => {
    const bits = [[true, false], [false, true]];
    const family: TagFamilyDef = {
      name: "sq", mosaicPath: "", tileSize_px: 2,
      widthAtBorder_modules: 2, validTagCount: 1, shape: "square",
    };
    const result = applyOccupiedMask(bits, family);
    expect(result).toEqual(bits);
    expect(result).not.toBe(bits);
  });

  it("zeros out unoccupied corner cells for circle families", () => {
    const allTrue = Array.from({ length: 9 }, () => Array(9).fill(true) as boolean[]);
    const family: TagFamilyDef = {
      name: "tagCircle21h7", mosaicPath: "", tileSize_px: 9,
      widthAtBorder_modules: 5, outerRadius_modules: 4.949747468305833,
      validTagCount: 38, shape: "circle",
    };
    const result = applyOccupiedMask(allTrue, family);
    expect(result[0]![0]).toBe(false);
    expect(result[0]![2]).toBe(false);
    expect(result[2]![0]).toBe(false);
    expect(result[0]![4]).toBe(true);
    expect(result[4]![4]).toBe(true);
  });
});
