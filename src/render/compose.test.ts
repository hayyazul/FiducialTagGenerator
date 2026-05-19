/**
 * Unit tests for `composePage` against a recording mock `Canvas`.
 *
 * `composePage` is the renderer every backend (SVG preview, PDF, PNG)
 * funnels through. The integration tests in `src/preview/svg.test.ts`
 * and `src/render/pdf.test.ts` exercise it indirectly, but those check
 * the final string/byte stream and miss things that are easier to assert
 * here: the order calls go out in, the exact coordinates of registration
 * marks and sub-tag placements, whether center-block masking was applied
 * before the parent's bit grid was drawn.
 */
import { describe, expect, it } from "vitest";
import { BitGridMarker, type MarkerProvider } from "../families";
import { planSmallTagLayout, type CutShape } from "../layout/plan";
import type { LayoutOptions, Paper, TagSpec } from "../layout/types";
import { composePage } from "./compose";
import type {
  BitGridOpts,
  Canvas,
  CircleOpts,
  CurvedTextOpts,
  LineOpts,
  MeasureOpts,
  RectOpts,
  TextMetrics,
  TextOpts,
} from "./canvas";

type Call =
  | { kind: "rect"; opts: RectOpts }
  | { kind: "circle"; opts: CircleOpts }
  | { kind: "line"; opts: LineOpts }
  | { kind: "text"; opts: TextOpts }
  | { kind: "curvedText"; opts: CurvedTextOpts }
  | { kind: "bitGrid"; opts: BitGridOpts };

function recordingCanvas(width_mm: number, height_mm: number): {
  canvas: Canvas;
  calls: Call[];
} {
  const calls: Call[] = [];
  const canvas: Canvas = {
    page: { width_mm, height_mm },
    drawRect: (opts) => calls.push({ kind: "rect", opts }),
    drawCircle: (opts) => calls.push({ kind: "circle", opts }),
    drawLine: (opts) => calls.push({ kind: "line", opts }),
    drawText: (opts) => calls.push({ kind: "text", opts }),
    drawCurvedText: (opts) => calls.push({ kind: "curvedText", opts }),
    drawBitGrid: (opts) => calls.push({ kind: "bitGrid", opts }),
    measureText: (_opts: MeasureOpts): TextMetrics => ({
      // Rough mono-font metrics good enough for compose: glyph width ≈ 0.6em.
      width_mm: 0,
      ascent_mm: 0,
      descent_mm: 0,
    }),
  };
  return { canvas, calls };
}

const square100: Paper = { width_mm: 100, height_mm: 100 };
const noMargins: LayoutOptions = {
  pageMargin_mm: 0,
  quietZone_mm: 0,
  cutMargin_mm: 0,
};

function defaultBitGrid(): readonly (readonly boolean[])[] {
  // 10×10 grid — matches tag36h11 / tagCustom48h12 edges, with the corner
  // bits set so the masked-vs-unmasked variant is visibly different.
  const bits: boolean[][] = [];
  for (let r = 0; r < 10; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < 10; c++) row.push(true);
    bits.push(row);
  }
  return bits;
}

function markerProvider(): MarkerProvider {
  return {
    getMarker(family, id) {
      return new BitGridMarker(defaultBitGrid(), `${family}#${id}`);
    },
  };
}

const nullProvider: MarkerProvider = { getMarker: () => null };

function makeTags(family: string, count: number): TagSpec[] {
  return Array.from({ length: count }, (_, i) => ({ family, id: i }));
}

describe("composePage — drawing order", () => {
  it("emits background, then reg-marks, then markers, then cut lines (no captions)", () => {
    const opts: LayoutOptions = { pageMargin_mm: 5, quietZone_mm: 0, cutMargin_mm: 0 };
    const plan = planSmallTagLayout(makeTags("tag36h11", 2), 20, square100, opts);
    const { canvas, calls } = recordingCanvas(100, 100);
    composePage(plan, 0, canvas, markerProvider());

    // First call is the page background rect.
    expect(calls[0]?.kind).toBe("rect");
    expect((calls[0] as { opts: RectOpts }).opts.fill).toEqual({ r: 1, g: 1, b: 1 });

    // Reg-mark lines come before any bit-grid draw.
    const firstBitGrid = calls.findIndex((c) => c.kind === "bitGrid");
    const firstLine = calls.findIndex((c) => c.kind === "line");
    expect(firstLine).toBeGreaterThan(0);
    expect(firstLine).toBeLessThan(firstBitGrid);

    // All bitGrid draws happen before any cut-line draw. Reg-marks are solid;
    // cut lines are dashed — discriminate by stroke pattern.
    const lastBitGrid = calls.map((c) => c.kind).lastIndexOf("bitGrid");
    const firstCutLine = calls.findIndex(
      (c) => c.kind === "line" && (c as { opts: LineOpts }).opts.dash_mm !== undefined,
    );
    expect(firstCutLine).toBeGreaterThan(lastBitGrid);
  });

  it("emits all captions after all markers and before cut lines", () => {
    const opts: LayoutOptions = { pageMargin_mm: 0, quietZone_mm: 2, cutMargin_mm: 0 };
    const plan = planSmallTagLayout(makeTags("tag36h11", 3), 20, square100, opts);
    const { canvas, calls } = recordingCanvas(100, 100);
    composePage(plan, 0, canvas, markerProvider(), { printLabelsInQuietZone: true });

    const lastBitGrid = calls.map((c) => c.kind).lastIndexOf("bitGrid");
    const firstCaption = calls.findIndex((c) => c.kind === "text");
    const firstCutLine = calls.findIndex(
      (c) => c.kind === "line" && (c as { opts: LineOpts }).opts.dash_mm !== undefined,
    );
    expect(firstCaption).toBeGreaterThan(lastBitGrid);
    expect(firstCutLine).toBeGreaterThan(firstCaption);
  });
});

describe("composePage — page background", () => {
  it("draws one full-page white rect at the start", () => {
    const plan = planSmallTagLayout([], 20, square100, noMargins);
    const { canvas, calls } = recordingCanvas(100, 100);
    composePage(plan, 0, canvas, nullProvider);
    expect(calls).toHaveLength(1);
    const r = (calls[0] as { opts: RectOpts }).opts;
    expect(r.x_mm).toBe(0);
    expect(r.y_mm).toBe(0);
    expect(r.width_mm).toBe(100);
    expect(r.height_mm).toBe(100);
    expect(r.fill).toEqual({ r: 1, g: 1, b: 1 });
  });
});

describe("composePage — registration marks", () => {
  it("places one crosshair at each corner, two strokes each, with the configured arm length", () => {
    const opts: LayoutOptions = { pageMargin_mm: 10, quietZone_mm: 0, cutMargin_mm: 0 };
    const plan = planSmallTagLayout([], 20, square100, opts);
    const { canvas, calls } = recordingCanvas(100, 100);
    composePage(plan, 0, canvas, nullProvider);
    const lines = calls
      .filter((c) => c.kind === "line")
      .map((c) => (c as { opts: LineOpts }).opts);
    // 4 corners × 2 strokes = 8.
    expect(lines).toHaveLength(8);
    // Reg-marks are solid (cut lines would be dashed, but this plan has none).
    for (const l of lines) expect(l.dash_mm).toBeUndefined();

    // Corner centres are (m, m), (W-m, m), (m, H-m), (W-m, H-m). For each,
    // expect one horizontal arm and one vertical arm of length 2mm (arm) on each side.
    const corners: Array<[number, number]> = [
      [10, 10], [90, 10], [10, 90], [90, 90],
    ];
    for (const [cx, cy] of corners) {
      const hor = lines.find(
        (l) => l.y0_mm === cy && l.y1_mm === cy && Math.min(l.x0_mm, l.x1_mm) === cx - 2,
      );
      const ver = lines.find(
        (l) => l.x0_mm === cx && l.x1_mm === cx && Math.min(l.y0_mm, l.y1_mm) === cy - 2,
      );
      expect(hor, `horizontal arm at (${cx},${cy})`).toBeDefined();
      expect(ver, `vertical arm at (${cx},${cy})`).toBeDefined();
      expect(Math.max(hor!.x0_mm, hor!.x1_mm)).toBe(cx + 2);
      expect(Math.max(ver!.y0_mm, ver!.y1_mm)).toBe(cy + 2);
    }
  });

  it("omits reg-marks entirely when pageMargin_mm is zero", () => {
    const plan = planSmallTagLayout([], 20, square100, noMargins);
    const { canvas, calls } = recordingCanvas(100, 100);
    composePage(plan, 0, canvas, nullProvider);
    expect(calls.filter((c) => c.kind === "line")).toHaveLength(0);
  });
});

describe("composePage — placement filtering", () => {
  it("draws only the placements on the requested page", () => {
    // 30 tags, 20mm each on 100×100 → 5×5 = 25 per page → 2 pages.
    const plan = planSmallTagLayout(makeTags("tag36h11", 30), 20, square100, noMargins);
    expect(plan.pageCount).toBe(2);

    const expectedPage0 = plan.placements.filter((p) => p.page === 0).length;
    const expectedPage1 = plan.placements.filter((p) => p.page === 1).length;

    const r0 = recordingCanvas(100, 100);
    composePage(plan, 0, r0.canvas, markerProvider());
    expect(r0.calls.filter((c) => c.kind === "bitGrid")).toHaveLength(expectedPage0);

    const r1 = recordingCanvas(100, 100);
    composePage(plan, 1, r1.canvas, markerProvider());
    expect(r1.calls.filter((c) => c.kind === "bitGrid")).toHaveLength(expectedPage1);
  });
});

describe("composePage — placeholder", () => {
  it("emits placeholder rect + family#id text when getMarker returns null", () => {
    const plan = planSmallTagLayout(
      [{ family: "tag36h11", id: 7 }],
      20,
      square100,
      noMargins,
    );
    const { canvas, calls } = recordingCanvas(100, 100);
    composePage(plan, 0, canvas, nullProvider);

    // Background rect + placeholder rect = 2 rects total.
    const rects = calls.filter((c) => c.kind === "rect");
    expect(rects).toHaveLength(2);
    // The placeholder is the non-white one and matches the tile geometry.
    const placeholder = (rects[1] as { opts: RectOpts }).opts;
    expect(placeholder.width_mm).toBe(20);
    expect(placeholder.height_mm).toBe(20);
    expect(placeholder.fill).not.toEqual({ r: 1, g: 1, b: 1 });

    // Exactly one text call, carrying the family#id label.
    const texts = calls
      .filter((c) => c.kind === "text")
      .map((c) => (c as { opts: TextOpts }).opts);
    expect(texts).toHaveLength(1);
    expect(texts[0]?.text).toBe("tag36h11#7");
    expect(texts[0]?.anchor).toBe("middle");
    expect(texts[0]?.verticalAnchor).toBe("middle");
  });

  it("emits no bit grid when the marker is null", () => {
    const plan = planSmallTagLayout(
      [{ family: "tag36h11", id: 0 }],
      20,
      square100,
      noMargins,
    );
    const { canvas, calls } = recordingCanvas(100, 100);
    composePage(plan, 0, canvas, nullProvider);
    expect(calls.filter((c) => c.kind === "bitGrid")).toHaveLength(0);
  });
});

describe("composePage — sub-tag geometry", () => {
  it("places the sub-tag at (parent.x + cb.col·cell, parent.y + size − (cb.row+cb.size)·cell)", () => {
    // tagCustom48h12: edge=10, centerBlock={row:4, col:4, size:2}.
    // For tile size 10mm at origin: cell=1mm, subX=4, subY=10-6=4, subSize=2.
    const plan = planSmallTagLayout(
      [{ family: "tagCustom48h12", id: 0, subtag: { family: "tag36h11", id: 0 } }],
      10,
      square100,
      noMargins,
    );
    const placement = plan.placements[0]!;
    const expectedSubX = placement.x_mm + 4;
    const expectedSubY = placement.y_mm + 4;

    const { canvas, calls } = recordingCanvas(100, 100);
    composePage(plan, 0, canvas, markerProvider());

    const bitGrids = calls
      .filter((c) => c.kind === "bitGrid")
      .map((c) => (c as { opts: BitGridOpts }).opts);
    // Two bit grids: outer parent, then sub-tag.
    expect(bitGrids).toHaveLength(2);
    const sub = bitGrids[1]!;
    expect(sub.x_mm).toBeCloseTo(expectedSubX, 6);
    expect(sub.y_mm).toBeCloseTo(expectedSubY, 6);
    expect(sub.cellSize_mm * sub.bits.length).toBeCloseTo(2, 6);
  });

  it("invokes withMaskedCenterBlock on the parent — masked variant carries the +sub cacheKey", () => {
    const plan = planSmallTagLayout(
      [{ family: "tagCustom48h12", id: 5, subtag: { family: "tag36h11", id: 9 } }],
      10,
      square100,
      noMargins,
    );
    const { canvas, calls } = recordingCanvas(100, 100);
    composePage(plan, 0, canvas, markerProvider());
    const bitGrids = calls
      .filter((c) => c.kind === "bitGrid")
      .map((c) => (c as { opts: BitGridOpts }).opts);
    expect(bitGrids[0]?.cacheKey).toBe("tagCustom48h12#5+sub");
    expect(bitGrids[1]?.cacheKey).toBe("tag36h11#9");
  });

  it("does not mask when the family has no centerBlock (square non-recursive family)", () => {
    const plan = planSmallTagLayout(
      [{ family: "tag36h11", id: 0 }],
      20,
      square100,
      noMargins,
    );
    const { canvas, calls } = recordingCanvas(100, 100);
    composePage(plan, 0, canvas, markerProvider());
    const bitGrids = calls
      .filter((c) => c.kind === "bitGrid")
      .map((c) => (c as { opts: BitGridOpts }).opts);
    // Just the outer tag, no masking.
    expect(bitGrids).toHaveLength(1);
    expect(bitGrids[0]?.cacheKey).toBe("tag36h11#0");
  });
});

describe("composePage — cut styling", () => {
  it("draws cut lines dashed with the documented pattern and stroke", () => {
    const plan = planSmallTagLayout(makeTags("tag36h11", 4), 20, square100, noMargins);
    const { canvas, calls } = recordingCanvas(100, 100);
    composePage(plan, 0, canvas, markerProvider());
    const cutLines = calls
      .filter((c) => c.kind === "line")
      .map((c) => (c as { opts: LineOpts }).opts)
      .filter((l) => l.dash_mm !== undefined);
    expect(cutLines.length).toBeGreaterThan(0);
    for (const l of cutLines) {
      expect(l.dash_mm).toEqual([1.5, 1]);
      // Stroke is gray(0.55) — same value on every channel.
      expect(l.stroke.r).toBeCloseTo(0.55, 6);
      expect(l.stroke.g).toBeCloseTo(0.55, 6);
      expect(l.stroke.b).toBeCloseTo(0.55, 6);
    }
  });

  it("draws cut circles dashed with the same pattern", () => {
    const circleShape: CutShape = { kind: "circle", outerRadius_mm: 10 };
    const plan = planSmallTagLayout(
      [{ family: "tagCircle21h7", id: 0 }],
      20,
      square100,
      noMargins,
      20,
      circleShape,
    );
    const { canvas, calls } = recordingCanvas(100, 100);
    composePage(plan, 0, canvas, markerProvider());
    const cutCircles = calls
      .filter((c) => c.kind === "circle")
      .map((c) => (c as { opts: CircleOpts }).opts);
    expect(cutCircles).toHaveLength(1);
    expect(cutCircles[0]?.dash_mm).toEqual([1.5, 1]);
  });
});

describe("composePage — quiet-zone captions", () => {
  it("does not draw a caption when the option is off (default)", () => {
    const opts: LayoutOptions = { pageMargin_mm: 0, quietZone_mm: 2, cutMargin_mm: 0 };
    const plan = planSmallTagLayout([{ family: "tag36h11", id: 1 }], 20, square100, opts);
    const { canvas, calls } = recordingCanvas(100, 100);
    composePage(plan, 0, canvas, markerProvider());
    expect(calls.filter((c) => c.kind === "text")).toHaveLength(0);
  });

  it("draws a linear caption for square plans when the option is on", () => {
    const opts: LayoutOptions = { pageMargin_mm: 0, quietZone_mm: 2, cutMargin_mm: 0 };
    const plan = planSmallTagLayout([{ family: "tag36h11", id: 1 }], 20, square100, opts);
    const { canvas, calls } = recordingCanvas(100, 100);
    composePage(plan, 0, canvas, markerProvider(), { printLabelsInQuietZone: true });
    const texts = calls.filter((c) => c.kind === "text");
    expect(texts).toHaveLength(1);
    expect((texts[0] as { opts: TextOpts }).opts.text).toBe("tag36h11 #1 · 20 mm");
    expect(calls.filter((c) => c.kind === "curvedText")).toHaveLength(0);
  });

  it("draws a curved caption for circle plans when the option is on", () => {
    const circleShape: CutShape = { kind: "circle", outerRadius_mm: 10 };
    const opts: LayoutOptions = { pageMargin_mm: 0, quietZone_mm: 2, cutMargin_mm: 0 };
    const plan = planSmallTagLayout(
      [{ family: "tagCircle21h7", id: 1 }],
      20,
      square100,
      opts,
      20,
      circleShape,
    );
    const { canvas, calls } = recordingCanvas(100, 100);
    composePage(plan, 0, canvas, markerProvider(), { printLabelsInQuietZone: true });
    expect(calls.filter((c) => c.kind === "curvedText")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "text")).toHaveLength(0);
  });

  it("skips the caption when quietZone_mm is zero, even with the option on", () => {
    const plan = planSmallTagLayout([{ family: "tag36h11", id: 1 }], 20, square100, noMargins);
    const { canvas, calls } = recordingCanvas(100, 100);
    composePage(plan, 0, canvas, markerProvider(), { printLabelsInQuietZone: true });
    expect(calls.filter((c) => c.kind === "text")).toHaveLength(0);
  });
});
