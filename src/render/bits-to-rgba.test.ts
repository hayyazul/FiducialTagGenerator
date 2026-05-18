import { describe, expect, it } from "vitest";
import { bitsToRgba } from "./bits-to-rgba";

describe("bitsToRgba", () => {
  it("maps a black bit to opaque black and an unset bit to opaque white", () => {
    const rgba = bitsToRgba([
      [true, false],
      [false, true],
    ]);
    expect(Array.from(rgba)).toEqual([
      0, 0, 0, 255, 255, 255, 255, 255,
      255, 255, 255, 255, 0, 0, 0, 255,
    ]);
  });

  it("keeps row 0 as the top row of the image", () => {
    const rgba = bitsToRgba([
      [true, true],
      [false, false],
    ]);
    expect(Array.from(rgba.slice(0, 8))).toEqual([0, 0, 0, 255, 0, 0, 0, 255]);
    expect(Array.from(rgba.slice(8))).toEqual([
      255, 255, 255, 255, 255, 255, 255, 255,
    ]);
  });

  it("produces a buffer of edge² RGBA quads", () => {
    const edge = 8;
    const grid = Array.from({ length: edge }, () =>
      Array.from({ length: edge }, () => false),
    );
    expect(bitsToRgba(grid).length).toBe(edge * edge * 4);
  });
});
