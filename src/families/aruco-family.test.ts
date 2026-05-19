/**
 * Unit tests for `ArucoFamily`. The pure bit-building helper is tested
 * directly; the lifecycle (`load` / `getMarker`) goes through a stubbed
 * `fetch` so the family logic can run in jsdom-free Node.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArucoFamily, buildArucoBits } from "./aruco-family";
import { BitGridMarker } from "./family";

describe("buildArucoBits", () => {
  it("wraps the data grid in a one-cell black border", () => {
    // 3×3 all-white data → 5×5 grid with a full black ring inside.
    const bits = buildArucoBits(3, [1, 1, 1, 1, 1, 1, 1, 1, 1], 0);
    expect(bits).toEqual([
      [true, true, true, true, true],
      [true, false, false, false, true],
      [true, false, false, false, true],
      [true, false, false, false, true],
      [true, true, true, true, true],
    ]);
  });

  it("inverts the source 0=black / 1=white convention", () => {
    const bits = buildArucoBits(2, [0, 1, 1, 0], 0);
    // Inner block:
    //   0 1   → true  false
    //   1 0   → false true
    expect(bits[1]![1]).toBe(true);
    expect(bits[1]![2]).toBe(false);
    expect(bits[2]![1]).toBe(false);
    expect(bits[2]![2]).toBe(true);
  });

  it("throws when the flat array length does not match gridSize²", () => {
    expect(() => buildArucoBits(4, [0, 0, 0], 7)).toThrow(/expected 16/);
  });
});

interface FakeFetchInit {
  jsonBody: unknown;
  status?: number;
}

function installFakeFetch({ jsonBody, status = 200 }: FakeFetchInit): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async (): Promise<unknown> => jsonBody,
    })),
  );
}

describe("ArucoFamily", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("getMarker throws before load() resolves", () => {
    const f = new ArucoFamily({
      name: "aruco_test_3x3_2",
      gridSize: 3,
      count: 2,
      jsonPath: "test.json",
    });
    expect(() => f.getMarker(0)).toThrow(/before load/);
  });

  it("returns a BitGridMarker with bordered grid after load()", async () => {
    installFakeFetch({
      jsonBody: {
        name: "aruco_test_3x3_2",
        gridSize: 3,
        numMarkers: 2,
        markers: [
          [0, 1, 0, 1, 0, 1, 0, 1, 0],
          [1, 1, 0, 0, 1, 0, 1, 1, 0],
        ],
      },
    });
    const f = new ArucoFamily({
      name: "aruco_test_3x3_2",
      gridSize: 3,
      count: 2,
      jsonPath: "test.json",
    });
    await f.load();
    const m = f.getMarker(0);
    expect(m.cacheKey).toBe("aruco_test_3x3_2#0");
    expect((m as BitGridMarker).bits).toEqual([
      [true, true, true, true, true],
      [true, true, false, true, true],
      [true, false, true, false, true],
      [true, true, false, true, true],
      [true, true, true, true, true],
    ]);
  });

  it("geometry has edge = gridSize + 2 and widthAtBorder = edge", () => {
    const f = new ArucoFamily({
      name: "aruco_4x4_50",
      gridSize: 4,
      count: 50,
      jsonPath: "test.json",
    });
    expect(f.geometry.edge).toBe(6);
    expect(f.geometry.widthAtBorder).toBe(6);
    expect(f.geometry.outerShape).toBe("square");
  });

  it("throws RangeError on out-of-range id", async () => {
    installFakeFetch({
      jsonBody: {
        name: "x",
        gridSize: 3,
        numMarkers: 1,
        markers: [[0, 0, 0, 0, 0, 0, 0, 0, 0]],
      },
    });
    const f = new ArucoFamily({
      name: "x",
      gridSize: 3,
      count: 1,
      jsonPath: "test.json",
    });
    await f.load();
    expect(() => f.getMarker(-1)).toThrow(RangeError);
    expect(() => f.getMarker(1)).toThrow(/count=1/);
  });

  it("rejects a dictionary whose gridSize disagrees with the registry", async () => {
    installFakeFetch({
      jsonBody: { name: "x", gridSize: 5, numMarkers: 1, markers: [[]] },
    });
    const f = new ArucoFamily({
      name: "x",
      gridSize: 4,
      count: 1,
      jsonPath: "test.json",
    });
    await expect(f.load()).rejects.toThrow(/gridSize/);
  });

  it("load() is idempotent — concurrent calls share the same promise", async () => {
    installFakeFetch({
      jsonBody: {
        name: "x",
        gridSize: 3,
        numMarkers: 1,
        markers: [[0, 0, 0, 0, 0, 0, 0, 0, 0]],
      },
    });
    const f = new ArucoFamily({
      name: "x",
      gridSize: 3,
      count: 1,
      jsonPath: "test.json",
    });
    const p1 = f.load();
    const p2 = f.load();
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
    expect(f.load()).toBe(p1);
  });

  it("caches markers by id (same instance on repeat lookup)", async () => {
    installFakeFetch({
      jsonBody: {
        name: "x",
        gridSize: 3,
        numMarkers: 1,
        markers: [[0, 1, 0, 1, 0, 1, 0, 1, 0]],
      },
    });
    const f = new ArucoFamily({
      name: "x",
      gridSize: 3,
      count: 1,
      jsonPath: "test.json",
    });
    await f.load();
    expect(f.getMarker(0)).toBe(f.getMarker(0));
  });
});

describe("ArUco registry integration", () => {
  beforeEach(() => {
    vi.stubGlobal("import.meta", { env: { BASE_URL: "/" } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("registers 18 ArUco families under the 'ArUco' group", async () => {
    const { listFamilies } = await import("./index");
    const aruco = listFamilies().filter((f) => f.group === "ArUco");
    expect(aruco).toHaveLength(18);
    // Spot-check a few canonical entries.
    const names = new Set(aruco.map((f) => f.name));
    for (const n of [
      "aruco_original",
      "aruco_4x4_50",
      "aruco_5x5_1000",
      "aruco_6x6_250",
      "aruco_7x7_1000",
      "aruco_mip_36h12",
    ]) {
      expect(names.has(n)).toBe(true);
    }
  });
});
