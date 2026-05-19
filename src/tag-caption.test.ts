import { describe, expect, it } from "vitest";
import { formatTagSize, subtagSizeLine, tagCaptionLine } from "./tag-caption";

describe("tag-caption", () => {
  it("formats sizes with up to two decimals, dropping trailing zeros", () => {
    expect(formatTagSize(40)).toBe("40 mm");
    expect(formatTagSize(40.125)).toBe("40.13 mm");
  });

  it("joins family, id, and size into one caption line", () => {
    expect(tagCaptionLine("tag36h11", 587, 33.333)).toBe("tag36h11 #587 · 33.33 mm");
  });

  it("chains nested sub-tag levels with arrows", () => {
    expect(subtagSizeLine([])).toBe("");
    expect(
      subtagSizeLine([
        { familyName: "tagCustom48h12", tileSize_mm: 13.33, tagSize_mm: 8 },
        { familyName: "tag36h11", tileSize_mm: 2.67, tagSize_mm: 2.13 },
      ]),
    ).toBe("sub: tagCustom48h12 8 mm > tag36h11 2.13 mm");
  });
});
