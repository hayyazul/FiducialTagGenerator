/**
 * Unit tests for `CCTagFamily`. `fetch` is stubbed so the family logic
 * can run in Node without DOM. Pure parsing is covered separately in
 * `cctag-data.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CCTagFamily } from "./cctag-family";
import { RingMarker } from "./ring-marker";

function installFakeFetch(body: string, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async (): Promise<string> => body,
    })),
  );
}

const CCTAG3_SAMPLE = "90 80 70 60 50\n90 80 70 60 45\n";
const CCTAG4_SAMPLE = "92 84 76 68 60 52 44\n";

describe("CCTagFamily", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("getMarker throws before load() resolves", () => {
    const f = new CCTagFamily({
      name: "cctag3",
      ringsPerMarker: 5,
      count: 2,
      dataPath: "cctag3.txt",
    });
    expect(() => f.getMarker(0)).toThrow(/before load/);
  });

  it("isIdLoaded is false before load and true after", async () => {
    installFakeFetch(CCTAG3_SAMPLE);
    const f = new CCTagFamily({
      name: "cctag3",
      ringsPerMarker: 5,
      count: 2,
      dataPath: "cctag3.txt",
    });
    expect(f.isIdLoaded(0)).toBe(false);
    await f.load();
    expect(f.isIdLoaded(0)).toBe(true);
    expect(f.isIdLoaded(1)).toBe(true);
    expect(f.isIdLoaded(2)).toBe(false);
    expect(f.isIdLoaded(-1)).toBe(false);
  });

  it("returns a RingMarker with the parsed radii", async () => {
    installFakeFetch(CCTAG3_SAMPLE);
    const f = new CCTagFamily({
      name: "cctag3",
      ringsPerMarker: 5,
      count: 2,
      dataPath: "cctag3.txt",
    });
    await f.load();
    const m0 = f.getMarker(0) as RingMarker;
    expect(m0.cacheKey).toBe("cctag3#0");
    expect(m0.ringRadii).toEqual([0.9, 0.8, 0.7, 0.6, 0.5]);
    const m1 = f.getMarker(1) as RingMarker;
    expect(m1.ringRadii).toEqual([0.9, 0.8, 0.7, 0.6, 0.45]);
  });

  it("geometry: edge = widthAtBorder = 5, outerRadiusCells = 2.5, circle", () => {
    const f = new CCTagFamily({
      name: "cctag4",
      ringsPerMarker: 7,
      count: 1,
      dataPath: "cctag4.txt",
    });
    // edge/widthAtBorder = 1  → tile = tagSize (user input is disk diameter)
    // outerRadiusCells/widthAtBorder = 0.5  → cut radius = tagSize/2 (outer disk)
    // Absolute value 5 chosen so the half-module quiet-zone default
    // (0.5·tagSize/widthAtBorder) matches the existing tagCircle21h7 family.
    expect(f.geometry.edge).toBe(5);
    expect(f.geometry.widthAtBorder).toBe(5);
    expect(f.geometry.outerShape).toBe("circle");
    expect(f.geometry.outerRadiusCells).toBe(2.5);
  });

  it("throws RangeError on out-of-range id", async () => {
    installFakeFetch(CCTAG4_SAMPLE);
    const f = new CCTagFamily({
      name: "cctag4",
      ringsPerMarker: 7,
      count: 1,
      dataPath: "cctag4.txt",
    });
    await f.load();
    expect(() => f.getMarker(-1)).toThrow(RangeError);
    expect(() => f.getMarker(1)).toThrow(/count=1/);
  });

  it("rejects a file whose marker count disagrees with the registry", async () => {
    installFakeFetch(CCTAG3_SAMPLE); // file has 2 markers
    const f = new CCTagFamily({
      name: "cctag3",
      ringsPerMarker: 5,
      count: 5, // registry claims 5
      dataPath: "cctag3.txt",
    });
    await expect(f.load()).rejects.toThrow(/2 markers/);
  });

  it("propagates a 4xx fetch failure as a loud error", async () => {
    installFakeFetch("", 404);
    const f = new CCTagFamily({
      name: "cctag3",
      ringsPerMarker: 5,
      count: 2,
      dataPath: "missing.txt",
    });
    await expect(f.load()).rejects.toThrow(/404/);
  });

  it("load() is idempotent — concurrent calls share one fetch", async () => {
    installFakeFetch(CCTAG3_SAMPLE);
    const f = new CCTagFamily({
      name: "cctag3",
      ringsPerMarker: 5,
      count: 2,
      dataPath: "cctag3.txt",
    });
    const p1 = f.load();
    const p2 = f.load();
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
    expect(f.load()).toBe(p1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("caches markers by id (same instance on repeat lookup)", async () => {
    installFakeFetch(CCTAG3_SAMPLE);
    const f = new CCTagFamily({
      name: "cctag3",
      ringsPerMarker: 5,
      count: 2,
      dataPath: "cctag3.txt",
    });
    await f.load();
    expect(f.getMarker(0)).toBe(f.getMarker(0));
  });
});

describe("CCTag registry integration", () => {
  beforeEach(() => {
    vi.stubGlobal("import.meta", { env: { BASE_URL: "/" } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("registers cctag3 and cctag4 with circular geometry", async () => {
    const { getFamily } = await import("./index");
    for (const name of ["cctag3", "cctag4"]) {
      const f = getFamily(name);
      expect(f).toBeDefined();
      expect(f?.geometry.outerShape).toBe("circle");
      expect(f?.count).toBeGreaterThan(0);
    }
  });
});
