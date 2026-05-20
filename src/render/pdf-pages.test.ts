/**
 * Unit tests for the duplex back-label sheet (`drawBackPage`).
 *
 * Two independent properties are checked:
 *
 *  1. Alignment. Long-edge duplex flips the sheet about its vertical
 *     centre, so each back label must be centred on the horizontal
 *     reflection (x → paper.width − x, y unchanged) of its front tag, or
 *     the label lands behind the wrong tag.
 *
 *  2. Containment. The label box and every line of text must fit inside
 *     the tag's bounds at every scale — the original code applied a
 *     1.5 mm font floor that overflowed ~10 mm tags, and the old tests
 *     only checked alignment so they never caught it. The containment
 *     tests below assert the fit directly and would fail on that floor.
 *
 *  The back also deliberately draws no tag-boundary geometry (no cut
 *  lines, cut circles, or full-tile outline): those edges sit on the cut
 *  and look broken under misregistration. Tests assert their absence.
 *
 * Scope note: this is the software guard. It cannot test the physical
 * front-to-back misregistration of a real duplex printer (±1–2 mm,
 * varies per sheet) — that is a hardware tolerance the PDF can't fix.
 */
import { describe, expect, it } from "vitest";
import { BitGridMarker, type MarkerProvider } from "../families";
import { type CutShape, planSmallTagLayout } from "../layout/plan";
import type { LayoutOptions, LayoutPlan, Paper, TagSpec } from "../layout/types";
import { composePage } from "./compose";
import { drawBackPage } from "./pdf-pages";
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

function recordingCanvas(
  width_mm: number,
  height_mm: number,
): { canvas: Canvas; calls: Call[] } {
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
      width_mm: 0,
      ascent_mm: 0,
      descent_mm: 0,
    }),
  };
  return { canvas, calls };
}

// US Letter — the paper the misalignment was first reported on.
const LETTER: Paper = { width_mm: 215.9, height_mm: 279.4 };

// Mono (Courier) advance per em — the real glyph width of the back
// labels' font, used here to compute true on-page text width.
const GLYPH_ADVANCE_EM = 0.6;

function gridProvider(edge: number): MarkerProvider {
  const bits: boolean[][] = Array.from({ length: edge }, () =>
    Array.from({ length: edge }, () => true),
  );
  return {
    getMarker: (family, id) => new BitGridMarker(bits, `${family}#${id}`),
  };
}

function rects(calls: Call[]): RectOpts[] {
  return calls
    .filter((c): c is { kind: "rect"; opts: RectOpts } => c.kind === "rect")
    .map((c) => c.opts);
}
function lines(calls: Call[]): LineOpts[] {
  return calls
    .filter((c): c is { kind: "line"; opts: LineOpts } => c.kind === "line")
    .map((c) => c.opts);
}
function circleCalls(calls: Call[]): CircleOpts[] {
  return calls
    .filter((c): c is { kind: "circle"; opts: CircleOpts } => c.kind === "circle")
    .map((c) => c.opts);
}
function textCalls(calls: Call[]): TextOpts[] {
  return calls
    .filter((c): c is { kind: "text"; opts: TextOpts } => c.kind === "text")
    .map((c) => c.opts);
}

/** Stroked, unfilled rects: the per-tag label boxes (the white page
 *  background is filled, so it is excluded). */
function labelBoxes(calls: Call[]): RectOpts[] {
  return rects(calls).filter((r) => r.fill === undefined && r.stroke !== undefined);
}

function buildPlan(
  family: string,
  count: number,
  tile_mm: number,
  options: LayoutOptions,
  cutShape: CutShape,
  withSubtag: boolean,
): LayoutPlan {
  const tags: TagSpec[] = Array.from({ length: count }, (_, i) =>
    withSubtag
      ? { family, id: i, subtag: { family, id: i + 100 } }
      : { family, id: i },
  );
  const plan = planSmallTagLayout(tags, tile_mm, LETTER, options, tile_mm * 0.8, cutShape);
  if (withSubtag) {
    // A realistic sub-tag level so the back prints the longest line form
    // ("> family #id · size"), the worst case for horizontal overflow.
    plan.subtagLevels = [
      { familyName: family, tileSize_mm: tile_mm * 0.4, tagSize_mm: tile_mm * 0.32 },
    ];
  }
  return plan;
}

describe("drawBackPage — front/back alignment", () => {
  const opts: LayoutOptions = { pageMargin_mm: 5, quietZone_mm: 5, cutMargin_mm: 2 };

  for (const cut of [
    { name: "square", shape: { kind: "square" } as CutShape, family: "tag36h11", edge: 10 },
    {
      name: "circle",
      shape: { kind: "circle", outerRadius_mm: 9 } as CutShape,
      family: "tagCircle21h7",
      edge: 9,
    },
  ]) {
    it(`centres each back label on the reflection of its front tag (${cut.name})`, () => {
      const plan = buildPlan(cut.family, 6, 20, opts, cut.shape, false);
      const W = plan.paper.width_mm;

      const front = recordingCanvas(W, plan.paper.height_mm);
      const back = recordingCanvas(W, plan.paper.height_mm);
      composePage(plan, 0, front.canvas, gridProvider(cut.edge));
      drawBackPage(back.canvas, plan, 0);

      // Front tag centres come from the bit-grid draws.
      const frontCenters = front.calls
        .filter((c): c is { kind: "bitGrid"; opts: BitGridOpts } => c.kind === "bitGrid")
        .map((c) => {
          const side = c.opts.cellSize_mm * c.opts.bits.length;
          return { x: c.opts.x_mm + side / 2, y: c.opts.y_mm + side / 2 };
        });
      const backCenters = labelBoxes(back.calls).map((r) => ({
        x: r.x_mm + r.width_mm / 2,
        y: r.y_mm + r.height_mm / 2,
      }));

      expect(backCenters.length).toBe(frontCenters.length);
      expect(backCenters.length).toBeGreaterThan(0);
      for (const f of frontCenters) {
        const match = backCenters.find(
          (b) => Math.abs(b.x - (W - f.x)) < 1e-6 && Math.abs(b.y - f.y) < 1e-6,
        );
        expect(match, `no back label centred at reflection of (${f.x}, ${f.y})`).toBeDefined();
      }
    });
  }

  it("draws registration marks at identical positions on front and back", () => {
    const plan = buildPlan("tag36h11", 6, 20, opts, { kind: "square" }, false);
    const W = plan.paper.width_mm;
    const front = recordingCanvas(W, plan.paper.height_mm);
    const back = recordingCanvas(W, plan.paper.height_mm);
    composePage(plan, 0, front.canvas, gridProvider(10));
    drawBackPage(back.canvas, plan, 0);

    const canon = (l: LineOpts): string =>
      `${l.x0_mm.toFixed(6)},${l.y0_mm.toFixed(6)}->${l.x1_mm.toFixed(6)},${l.y1_mm.toFixed(6)}`;
    const reg = (cs: Call[]): Set<string> =>
      new Set(
        lines(cs)
          .filter((l) => Math.abs(l.strokeWidth_mm - 0.2) < 1e-9 && l.dash_mm === undefined)
          .map(canon),
      );
    const regBack = reg(back.calls);
    expect(regBack.size).toBeGreaterThan(0);
    expect(regBack).toEqual(reg(front.calls));
  });
});

describe("drawBackPage — no tag-boundary geometry", () => {
  const opts: LayoutOptions = { pageMargin_mm: 5, quietZone_mm: 4, cutMargin_mm: 0 };

  it("draws no cut lines on the back (only the corner registration marks)", () => {
    const plan = buildPlan("tag36h11", 6, 20, opts, { kind: "square" }, false);
    expect(plan.cutSegments.length).toBeGreaterThan(0); // front has cut lines

    const back = recordingCanvas(plan.paper.width_mm, plan.paper.height_mm);
    drawBackPage(back.canvas, plan, 0);

    // Every line on the back is a 0.2 mm registration crosshair; there
    // are no 0.25 mm cut lines.
    for (const l of lines(back.calls)) {
      expect(l.strokeWidth_mm).toBeCloseTo(0.2, 9);
    }
    // 4 corners × 2 strokes.
    expect(lines(back.calls).length).toBe(8);
  });

  it("draws no circles on the back, even for circular families", () => {
    const plan = buildPlan(
      "tagCircle21h7",
      5,
      20,
      opts,
      { kind: "circle", outerRadius_mm: 9 },
      false,
    );
    expect(plan.cutCircles.length).toBeGreaterThan(0); // front cuts circles

    const back = recordingCanvas(plan.paper.width_mm, plan.paper.height_mm);
    drawBackPage(back.canvas, plan, 0);

    expect(circleCalls(back.calls).length).toBe(0);
  });

  it("draws no full-tile outline — every label box is strictly inside the tile", () => {
    const tile = 20;
    const plan = buildPlan("tag36h11", 6, tile, opts, { kind: "square" }, false);
    const back = recordingCanvas(plan.paper.width_mm, plan.paper.height_mm);
    drawBackPage(back.canvas, plan, 0);

    const boxes = labelBoxes(back.calls);
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) {
      expect(b.width_mm).toBeLessThan(tile);
      expect(b.height_mm).toBeLessThan(tile);
    }
  });
});

describe("drawBackPage — label containment across scales", () => {
  // The bug the old tests missed: at small tag sizes the back info
  // overflowed the tag. Sweep the full size range, with and without the
  // longest (sub-tag) line form, for both cut shapes.
  const opts: LayoutOptions = { pageMargin_mm: 5, quietZone_mm: 2, cutMargin_mm: 0 };
  const sizes = [10, 12, 20, 40, 60, 100];

  for (const tile of sizes) {
    for (const withSub of [false, true]) {
      it(`square tile=${tile}mm sub=${withSub}: text + box fit inside the tile`, () => {
        const plan = buildPlan("tag36h11", 4, tile, opts, { kind: "square" }, withSub);
        const back = recordingCanvas(plan.paper.width_mm, plan.paper.height_mm);
        drawBackPage(back.canvas, plan, 0);

        const boxes = labelBoxes(back.calls);
        const texts = textCalls(back.calls);
        expect(boxes.length).toBeGreaterThan(0);
        expect(texts.length).toBeGreaterThan(0);

        // Box never exceeds the tile (the cut-out piece is at least the
        // tile, so a box inside the tile cannot be sliced).
        for (const b of boxes) {
          expect(b.width_mm).toBeLessThanOrEqual(tile + 1e-9);
          expect(b.height_mm).toBeLessThanOrEqual(tile + 1e-9);
        }
        // No text line overflows the tile horizontally — the exact
        // failure the 1.5 mm font floor used to cause.
        for (const t of texts) {
          const w = t.text.length * GLYPH_ADVANCE_EM * t.fontSize_mm;
          expect(w, `"${t.text}" overflows tile`).toBeLessThanOrEqual(tile + 1e-9);
        }
      });

      it(`circle tile=${tile}mm sub=${withSub}: text + box fit inside the cut disk`, () => {
        const outerRadius = tile * 0.45;
        const plan = buildPlan(
          "tagCircle21h7",
          4,
          tile,
          opts,
          { kind: "circle", outerRadius_mm: outerRadius },
          withSub,
        );
        const cutRadius = plan.cutCircles[0]!.radius_mm;
        const back = recordingCanvas(plan.paper.width_mm, plan.paper.height_mm);
        drawBackPage(back.canvas, plan, 0);

        const boxes = labelBoxes(back.calls);
        const texts = textCalls(back.calls);
        expect(boxes.length).toBeGreaterThan(0);

        // Box corners stay inside the cut disk.
        for (const b of boxes) {
          const halfDiag = Math.hypot(b.width_mm / 2, b.height_mm / 2);
          expect(halfDiag).toBeLessThanOrEqual(cutRadius + 1e-9);
        }
        // Text fits within the cut diameter.
        for (const t of texts) {
          const w = t.text.length * GLYPH_ADVANCE_EM * t.fontSize_mm;
          expect(w, `"${t.text}" overflows cut disk`).toBeLessThanOrEqual(2 * cutRadius + 1e-9);
        }
      });
    }
  }
});
