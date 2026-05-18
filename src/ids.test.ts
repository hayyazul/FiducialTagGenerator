import { describe, expect, it } from "vitest";
import { formatIdSpec, parseTagIdSpec } from "./ids";

describe("parseTagIdSpec", () => {
  it("parses a single id", () => {
    expect(parseTagIdSpec("5")).toEqual([5]);
  });

  it("expands an inclusive range", () => {
    expect(parseTagIdSpec("1-5")).toEqual([1, 2, 3, 4, 5]);
  });

  it("treats a-a as the single id a", () => {
    expect(parseTagIdSpec("3-3")).toEqual([3]);
  });

  it("mixes ids and ranges, preserving written order", () => {
    expect(parseTagIdSpec("8, 1-3, 5")).toEqual([8, 1, 2, 3, 5]);
  });

  it("ignores surrounding whitespace and trailing commas", () => {
    expect(parseTagIdSpec("  1 - 3 ,  7 ,")).toEqual([1, 2, 3, 7]);
  });

  it("rejects a backwards range", () => {
    expect(() => parseTagIdSpec("5-1")).toThrow(/backwards/i);
  });

  it("rejects a repeated id across tokens", () => {
    expect(() => parseTagIdSpec("1-7, 5")).toThrow(/more than once/i);
  });

  it("rejects a repeated id within a token list", () => {
    expect(() => parseTagIdSpec("3, 3")).toThrow(/more than once/i);
  });

  it("rejects overlapping ranges", () => {
    expect(() => parseTagIdSpec("1-5, 4-6")).toThrow(/more than once/i);
  });

  it("rejects non-numeric / malformed tokens", () => {
    expect(() => parseTagIdSpec("abc")).toThrow();
    expect(() => parseTagIdSpec("1.5")).toThrow();
    expect(() => parseTagIdSpec("1--3")).toThrow();
    expect(() => parseTagIdSpec("1-")).toThrow();
  });

  it("rejects empty / whitespace-only / comma-only input", () => {
    expect(() => parseTagIdSpec("")).toThrow();
    expect(() => parseTagIdSpec("   ")).toThrow();
    expect(() => parseTagIdSpec(",,")).toThrow();
  });

  it("rejects an absurdly large range", () => {
    expect(() => parseTagIdSpec("0-99999999")).toThrow(/too many/i);
  });
});

describe("formatIdSpec", () => {
  it("returns empty for empty array", () => {
    expect(formatIdSpec([])).toBe("");
  });

  it("formats a single id", () => {
    expect(formatIdSpec([7])).toBe("7");
  });

  it("compresses a contiguous range", () => {
    expect(formatIdSpec([3, 4, 5, 6])).toBe("3-6");
  });

  it("mixes singles and ranges", () => {
    expect(formatIdSpec([0, 5, 6, 10, 11, 12, 13])).toBe("0, 5-6, 10-13");
  });

  it("round-trips through parseTagIdSpec", () => {
    const original = "1-4, 7, 8-9";
    expect(formatIdSpec(parseTagIdSpec(original))).toBe("1-4, 7-9");
  });
});
