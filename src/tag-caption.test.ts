import { describe, expect, it } from "vitest";
import { formatTagSize, tagCaptionLine } from "./tag-caption";

describe("formatTagSize", () => {
  it("drops the decimals on a whole number of millimetres", () => {
    expect(formatTagSize(40)).toBe("40 mm");
  });

  it("keeps a single significant decimal", () => {
    expect(formatTagSize(40.5)).toBe("40.5 mm");
  });

  it("rounds to two decimals", () => {
    expect(formatTagSize(40.125)).toBe("40.13 mm");
    expect(formatTagSize(33.333)).toBe("33.33 mm");
  });
});

describe("tagCaptionLine", () => {
  it("joins family, id, and size into one line", () => {
    expect(tagCaptionLine("tag36h11", 5, 40)).toBe("tag36h11 #5 · 40 mm");
  });

  it("carries multi-digit ids and fractional sizes", () => {
    expect(tagCaptionLine("tag36h11", 587, 33.333)).toBe("tag36h11 #587 · 33.33 mm");
  });
});
