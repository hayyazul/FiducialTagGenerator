import { describe, expect, it } from "vitest";
import { extractTagBits, mosaicGrid, type TagFamilyDef } from "./index";

/** Build a fake mosaic pixel buffer: 2×2 grid of 4×4 tiles with 1-pixel
 *  black separators between them. Then write a known bit pattern into one
 *  tile's bitmap region (the inner 2×2 after stripping the embedded quiet
 *  zone of 1 px on each side). */
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
    embeddedQuietZone_px: 1,
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

  // Write bits into tile id=2 (col=0, row=1), inner region is (1..2, 6..7).
  // We want a checkerboard:
  //   row 0 (y=6): black, white   →  bits[0] = [true, false]
  //   row 1 (y=7): white, black   →  bits[1] = [false, true]
  set(1, 6, 0);
  set(2, 6, 255);
  set(1, 7, 255);
  set(2, 7, 0);

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
      embeddedQuietZone_px: 1,
    };
    expect(mosaicGrid(family, 263, 274)).toEqual({ cols: 24, rows: 25 });
  });
});

describe("extractTagBits", () => {
  it("strips the embedded quiet zone and returns the bitmap as bits", () => {
    const { family, pixels, width, height } = makeFakeMosaic();
    const bits = extractTagBits(pixels, width, height, family, 2);
    expect(bits).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it("throws on out-of-range tag id", () => {
    const { family, pixels, width, height } = makeFakeMosaic();
    expect(() => extractTagBits(pixels, width, height, family, 4)).toThrow(/out of range/);
    expect(() => extractTagBits(pixels, width, height, family, -1)).toThrow(/out of range/);
  });

  it("preserves row-major orientation: y=0 is the top row of the tag", () => {
    const family: TagFamilyDef = {
      name: "tiny",
      mosaicPath: "",
      tileSize_px: 4,
      embeddedQuietZone_px: 1,
    };
    // Single 4×4 tile; bitmap region (1..2, 1..2).
    // Make top row black, bottom row white.
    const w = 4;
    const h = 4;
    const px = new Uint8Array(w * h).fill(255);
    px[1 * w + 1] = 0;
    px[1 * w + 2] = 0;
    const bits = extractTagBits(px, w, h, family, 0);
    expect(bits[0]).toEqual([true, true]);
    expect(bits[1]).toEqual([false, false]);
  });
});
