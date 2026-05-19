/**
 * Unit tests for `MosaicFamily`. The decoder path (fetch + canvas
 * decode) is browser-only; here we stub the network and 2D canvas via
 * `vi.stubGlobal` so the family logic itself (lifecycle, getMarker
 * caching, error cases) can be exercised in jsdom-free Node.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BitGridMarker, type FamilyGeometry } from "./family";
import { MosaicFamily } from "./mosaic-family";

/** 2×2 grid of 4×4 tiles with 1-pixel separators (9×9 total). Tile 2
 *  has a recognisable diagonal pattern; all other tiles are white. */
function buildFakeMosaicPixels(): { rgba: Uint8ClampedArray; W: number; H: number } {
  const W = 9;
  const H = 9;
  const gray = new Uint8Array(W * H).fill(255);
  const set = (x: number, y: number, v: number): void => {
    gray[y * W + x] = v;
  };
  for (let y = 0; y < H; y++) set(4, y, 0);
  for (let x = 0; x < W; x++) set(x, 4, 0);
  set(0, 5, 0);
  set(3, 8, 0);

  // Expand grayscale to RGBA so the decoder's getImageData read returns
  // the same byte pattern.
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = gray[i]!;
    rgba[i * 4 + 1] = gray[i]!;
    rgba[i * 4 + 2] = gray[i]!;
    rgba[i * 4 + 3] = 255;
  }
  return { rgba, W, H };
}

function installFakeDom(): void {
  const { rgba, W, H } = buildFakeMosaicPixels();

  class FakeImage {
    naturalWidth = W;
    naturalHeight = H;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_v: string) {
      queueMicrotask(() => this.onload?.());
    }
  }

  const ctx = {
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: rgba, width: W, height: H })),
  };

  const fakeDocument = {
    createElement(tag: string): unknown {
      if (tag !== "canvas") throw new Error(`unexpected createElement(${tag})`);
      return {
        width: 0,
        height: 0,
        getContext(kind: string): unknown {
          if (kind !== "2d") return null;
          return ctx;
        },
      };
    },
  };

  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("document", fakeDocument);
}

const squareGeometry: FamilyGeometry = {
  edge: 4,
  widthAtBorder: 4,
  outerShape: "square",
};

describe("MosaicFamily", () => {
  beforeEach(() => installFakeDom());
  afterEach(() => vi.unstubAllGlobals());

  it("getMarker throws before load() resolves", () => {
    const f = new MosaicFamily({
      name: "fake",
      count: 4,
      geometry: squareGeometry,
      mosaicPath: "fake.png",
    });
    expect(() => f.getMarker(0)).toThrow(/before load/);
  });

  it("getMarker returns a BitGridMarker after load()", async () => {
    const f = new MosaicFamily({
      name: "fake",
      count: 4,
      geometry: squareGeometry,
      mosaicPath: "fake.png",
    });
    await f.load();
    const m = f.getMarker(2);
    expect(m.cacheKey).toBe("fake#2");
    // Same diagonal pattern as in buildFakeMosaicPixels — tile 2 has
    // black at (0, 0) and (3, 3).
    expect((m as BitGridMarker).bits).toEqual([
      [true, false, false, false],
      [false, false, false, false],
      [false, false, false, false],
      [false, false, false, true],
    ]);
  });

  it("getMarker throws RangeError on out-of-range id", async () => {
    const f = new MosaicFamily({
      name: "fake",
      count: 4,
      geometry: squareGeometry,
      mosaicPath: "fake.png",
    });
    await f.load();
    expect(() => f.getMarker(-1)).toThrow(RangeError);
    expect(() => f.getMarker(4)).toThrow(RangeError);
    expect(() => f.getMarker(4)).toThrow(/count=4/);
  });

  it("load() is idempotent — concurrent calls share the same promise", async () => {
    const f = new MosaicFamily({
      name: "fake",
      count: 4,
      geometry: squareGeometry,
      mosaicPath: "fake.png",
    });
    const p1 = f.load();
    const p2 = f.load();
    expect(p1).toBe(p2);
    await Promise.all([p1, p2]);
    // Third call after resolution is still idempotent.
    const p3 = f.load();
    expect(p3).toBe(p1);
  });

  it("caches markers by id (same instance on repeat lookup)", async () => {
    const f = new MosaicFamily({
      name: "fake",
      count: 4,
      geometry: squareGeometry,
      mosaicPath: "fake.png",
    });
    await f.load();
    const m1 = f.getMarker(2);
    const m2 = f.getMarker(2);
    expect(m1).toBe(m2);
  });

  it("applies the circle mask when geometry.outerShape === 'circle'", async () => {
    // 5×5 mosaic with one all-black 5×5 tile in it. Using a tight
    // outerRadiusCells should knock the corners to false.
    const W = 5;
    const H = 5;
    const rgba = new Uint8ClampedArray(W * H * 4);
    // All cells black (0).
    for (let i = 0; i < W * H; i++) rgba[i * 4 + 3] = 255;

    const ctx = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: rgba, width: W, height: H })),
    };
    class FakeImage {
      naturalWidth = W;
      naturalHeight = H;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    const fakeDocument = {
      createElement: (): unknown => ({
        width: 0,
        height: 0,
        getContext: (): unknown => ctx,
      }),
    };
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("document", fakeDocument);

    const f = new MosaicFamily({
      name: "circle-fake",
      count: 1,
      geometry: {
        edge: 5,
        widthAtBorder: 5,
        outerShape: "circle",
        outerRadiusCells: 2.0,
      },
      mosaicPath: "fake.png",
    });
    await f.load();
    const m = f.getMarker(0) as BitGridMarker;
    // Corners are outside r=2, so they should be masked off.
    expect(m.bits[0]![0]).toBe(false);
    expect(m.bits[0]![4]).toBe(false);
    expect(m.bits[4]![0]).toBe(false);
    expect(m.bits[4]![4]).toBe(false);
    // Centre cell stays on.
    expect(m.bits[2]![2]).toBe(true);
  });
});
