import { describe, expect, it } from "vitest";
import { parseCCTagData } from "./cctag-data";

describe("parseCCTagData", () => {
  it("parses a 3-ring file (5 radii per line) and normalises by 100", () => {
    const text = "90 80 70 60 50\n90 80 70 60 45\n";
    expect(parseCCTagData(text, 5)).toEqual([
      [0.9, 0.8, 0.7, 0.6, 0.5],
      [0.9, 0.8, 0.7, 0.6, 0.45],
    ]);
  });

  it("parses a 4-ring file (7 radii per line)", () => {
    const text = "92 84 76 68 60 52 44\n";
    expect(parseCCTagData(text, 7)).toEqual([
      [0.92, 0.84, 0.76, 0.68, 0.6, 0.52, 0.44],
    ]);
  });

  it("skips blank lines and CRLF line endings", () => {
    const text = "\r\n90 80 70 60 50\r\n\r\n90 80 70 60 45\r\n";
    expect(parseCCTagData(text, 5)).toHaveLength(2);
  });

  it("throws when a line has the wrong number of radii", () => {
    expect(() => parseCCTagData("90 80 70 60\n", 5)).toThrow(
      /expected 5 radii, got 4/,
    );
  });

  it("throws on a non-integer token", () => {
    expect(() => parseCCTagData("90 80 7.5 60 50\n", 5)).toThrow(
      /non-integer token "7\.5"/,
    );
  });

  it("throws when a value is outside (0, 100)", () => {
    expect(() => parseCCTagData("90 80 70 60 100\n", 5)).toThrow(/out of range/);
    expect(() => parseCCTagData("90 80 70 60 0\n", 5)).toThrow(/out of range/);
  });

  it("throws when radii are not strictly decreasing", () => {
    expect(() => parseCCTagData("90 80 80 60 50\n", 5)).toThrow(
      /strictly decreasing/,
    );
    expect(() => parseCCTagData("90 80 85 60 50\n", 5)).toThrow(
      /strictly decreasing/,
    );
  });

  it("rejects a non-positive expectedRingsPerLine", () => {
    expect(() => parseCCTagData("", 0)).toThrow(/expectedRingsPerLine/);
  });
});
