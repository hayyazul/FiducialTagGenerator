/**
 * Unit tests for `MosaicFamily` (chunked). The decoder path (fetch + 2D
 * canvas decode) is browser-only, so each test installs a fake `Image`
 * and `document.createElement("canvas")` that returns a stubbed
 * `getImageData`. The stub picks a pixel buffer based on the image
 * `src`, so different chunks can return different bytes — enough to
 * exercise per-chunk loading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BitGridMarker, type FamilyGeometry } from "./family";
import { MosaicFamily, chunkUrl } from "./mosaic-family";

/** 2×2 grid of 4×4 tiles with 1-pixel separators (9×9 total). Tile 2
 *  has black at (0,0) and (3,3). Used for the single-chunk happy-path
 *  tests so the bit grid is easy to read by eye. */
function fakeSingleChunkRgba(): { rgba: Uint8ClampedArray; W: number; H: number } {
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

  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = gray[i]!;
    rgba[i * 4 + 1] = gray[i]!;
    rgba[i * 4 + 2] = gray[i]!;
    rgba[i * 4 + 3] = 255;
  }
  return { rgba, W, H };
}

interface FakeDomHooks {
  imageLoads: () => number;
  perChunkImageLoads: () => Map<string, number>;
  resolveAllLoads: () => Promise<void>;
}

/** Install a fake DOM where every chunk URL decodes to the same 9×9
 *  buffer. The `manualResolve` toggle defers image-load callbacks so
 *  concurrency tests can inspect in-flight state before fetches
 *  complete. */
function installFakeDom(opts?: { manualResolve?: boolean }): FakeDomHooks {
  const { rgba, W, H } = fakeSingleChunkRgba();
  const manualResolve = opts?.manualResolve ?? false;
  let totalImageLoads = 0;
  const perChunk = new Map<string, number>();
  const pending: Array<() => void> = [];

  class FakeImage {
    naturalWidth = W;
    naturalHeight = H;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private _src = "";
    get src(): string {
      return this._src;
    }
    set src(v: string) {
      this._src = v;
      totalImageLoads += 1;
      perChunk.set(v, (perChunk.get(v) ?? 0) + 1);
      const fire = (): void => this.onload?.();
      if (manualResolve) pending.push(fire);
      else queueMicrotask(fire);
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

  return {
    imageLoads: () => totalImageLoads,
    perChunkImageLoads: () => new Map(perChunk),
    resolveAllLoads: async () => {
      while (pending.length > 0) pending.shift()!();
      await Promise.resolve();
    },
  };
}

const squareGeometry: FamilyGeometry = {
  edge: 4,
  widthAtBorder: 4,
  outerShape: "square",
};

function makeSingleChunkFamily(): MosaicFamily {
  return new MosaicFamily({
    name: "fake",
    count: 4,
    chunkSize: 4,
    geometry: squareGeometry,
    chunkBasePath: "/fake",
  });
}

describe("MosaicFamily (chunked)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("load() with no ids is a no-op (no fetches)", async () => {
    const hooks = installFakeDom();
    const f = makeSingleChunkFamily();
    await f.load();
    expect(hooks.imageLoads()).toBe(0);
    expect(f.isIdLoaded(0)).toBe(false);
  });

  it("load([id]) fetches the containing chunk, isIdLoaded flips, getMarker works", async () => {
    installFakeDom();
    const f = makeSingleChunkFamily();
    expect(f.isIdLoaded(2)).toBe(false);
    await f.load([2]);
    expect(f.isIdLoaded(2)).toBe(true);
    const m = f.getMarker(2);
    expect(m.cacheKey).toBe("fake#2");
    expect((m as BitGridMarker).bits).toEqual([
      [true, false, false, false],
      [false, false, false, false],
      [false, false, false, false],
      [false, false, false, true],
    ]);
  });

  it("getMarker throws if its chunk hasn't been loaded", () => {
    installFakeDom();
    const f = makeSingleChunkFamily();
    expect(() => f.getMarker(0)).toThrow(/chunk 0 not loaded/);
  });

  it("getMarker throws RangeError on out-of-range id (even when chunk loaded)", async () => {
    installFakeDom();
    const f = makeSingleChunkFamily();
    await f.load([0]);
    expect(() => f.getMarker(-1)).toThrow(RangeError);
    expect(() => f.getMarker(4)).toThrow(RangeError);
    expect(() => f.getMarker(4)).toThrow(/count=4/);
  });

  it("isIdLoaded returns false for out-of-range ids", async () => {
    installFakeDom();
    const f = makeSingleChunkFamily();
    await f.load([0]);
    expect(f.isIdLoaded(-1)).toBe(false);
    expect(f.isIdLoaded(4)).toBe(false);
  });

  it("repeat load([id]) does not re-fetch", async () => {
    const hooks = installFakeDom();
    const f = makeSingleChunkFamily();
    await f.load([0]);
    await f.load([1]);
    await f.load([0, 1, 2, 3]);
    expect(hooks.imageLoads()).toBe(1);
  });

  it("concurrent load([id]) calls share the same in-flight fetch per chunk", async () => {
    const hooks = installFakeDom({ manualResolve: true });
    const f = makeSingleChunkFamily();
    const p1 = f.load([0]);
    const p2 = f.load([1]);
    expect(hooks.imageLoads()).toBe(1);
    await hooks.resolveAllLoads();
    await Promise.all([p1, p2]);
    expect(hooks.imageLoads()).toBe(1);
  });

  it("multi-chunk family fetches only the chunks containing requested ids", async () => {
    const hooks = installFakeDom();
    // count=10, chunkSize=4 → chunks 0 (ids 0..3), 1 (ids 4..7), 2 (ids 8..9)
    const f = new MosaicFamily({
      name: "multi",
      count: 10,
      chunkSize: 4,
      geometry: squareGeometry,
      chunkBasePath: "/multi",
    });
    await f.load([0, 9]);
    const perChunk = hooks.perChunkImageLoads();
    expect(perChunk.get(chunkUrl("/multi", 0))).toBe(1);
    expect(perChunk.get(chunkUrl("/multi", 2))).toBe(1);
    expect(perChunk.get(chunkUrl("/multi", 1))).toBeUndefined();
    expect(f.isIdLoaded(0)).toBe(true);
    expect(f.isIdLoaded(5)).toBe(false);
    expect(f.isIdLoaded(9)).toBe(true);
  });

  it("caches markers by id (same instance on repeat lookup)", async () => {
    installFakeDom();
    const f = makeSingleChunkFamily();
    await f.load([2]);
    expect(f.getMarker(2)).toBe(f.getMarker(2));
  });

  it("applies the circle mask when geometry.outerShape === 'circle'", async () => {
    const W = 5;
    const H = 5;
    const rgba = new Uint8ClampedArray(W * H * 4);
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
      chunkSize: 1,
      geometry: {
        edge: 5,
        widthAtBorder: 5,
        outerShape: "circle",
        outerRadiusCells: 2.0,
      },
      chunkBasePath: "/circle",
    });
    await f.load([0]);
    const m = f.getMarker(0) as BitGridMarker;
    expect(m.bits[0]![0]).toBe(false);
    expect(m.bits[0]![4]).toBe(false);
    expect(m.bits[4]![0]).toBe(false);
    expect(m.bits[4]![4]).toBe(false);
    expect(m.bits[2]![2]).toBe(true);
  });

  it("chunkUrl pads to 3 digits", () => {
    expect(chunkUrl("/x", 0)).toBe("/x/chunk_000.png");
    expect(chunkUrl("/x", 5)).toBe("/x/chunk_005.png");
    expect(chunkUrl("/x", 99)).toBe("/x/chunk_099.png");
    expect(chunkUrl("/x", 255)).toBe("/x/chunk_255.png");
  });
});

describe("MosaicFamily (chunked) — happy-path single-chunk", () => {
  beforeEach(() => installFakeDom());
  afterEach(() => vi.unstubAllGlobals());

  it("constructor rejects non-positive chunkSize", () => {
    expect(
      () =>
        new MosaicFamily({
          name: "bad",
          count: 1,
          chunkSize: 0,
          geometry: squareGeometry,
          chunkBasePath: "/bad",
        }),
    ).toThrow(/chunkSize/);
  });
});
