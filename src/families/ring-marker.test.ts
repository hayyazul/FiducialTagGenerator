import { describe, expect, it } from "vitest";
import { RingMarker } from "./ring-marker";
import {
  BLACK,
  WHITE,
  type Canvas,
  type CircleOpts,
  type Color,
} from "../render/canvas";

interface CapturedCircle {
  cx_mm: number;
  cy_mm: number;
  radius_mm: number;
  fill?: Color;
}

function mockCanvas(): { canvas: Canvas; circles: CapturedCircle[] } {
  const circles: CapturedCircle[] = [];
  const canvas: Canvas = {
    page: { width_mm: 210, height_mm: 297 },
    drawRect: () => {
      throw new Error("RingMarker.draw should not call drawRect");
    },
    drawCircle: (o: CircleOpts) => {
      circles.push({
        cx_mm: o.cx_mm,
        cy_mm: o.cy_mm,
        radius_mm: o.radius_mm,
        fill: o.fill,
      });
    },
    drawLine: () => {
      throw new Error("RingMarker.draw should not call drawLine");
    },
    drawText: () => {
      throw new Error("RingMarker.draw should not call drawText");
    },
    drawCurvedText: () => {
      throw new Error("RingMarker.draw should not call drawCurvedText");
    },
    drawBitGrid: () => {
      throw new Error("RingMarker.draw should not call drawBitGrid");
    },
    measureText: () => ({ width_mm: 0, ascent_mm: 0, descent_mm: 0 }),
  };
  return { canvas, circles };
}

describe("RingMarker", () => {
  it("emits 1 + N circles centred on the tile, all concentric", () => {
    const m = new RingMarker([0.9, 0.8, 0.7, 0.6, 0.5], "cctag3#0");
    const { canvas, circles } = mockCanvas();
    m.draw(canvas, { x_mm: 10, y_mm: 20, size_mm: 40 });
    expect(circles).toHaveLength(6);
    for (const c of circles) {
      expect(c.cx_mm).toBeCloseTo(30);
      expect(c.cy_mm).toBeCloseTo(40);
    }
  });

  it("outer disk has radius = size/2 and fills black", () => {
    const m = new RingMarker([0.9, 0.8, 0.7, 0.6, 0.5], "cctag3#0");
    const { canvas, circles } = mockCanvas();
    m.draw(canvas, { x_mm: 0, y_mm: 0, size_mm: 40 });
    expect(circles[0]!.radius_mm).toBeCloseTo(20);
    expect(circles[0]!.fill).toEqual(BLACK);
  });

  it("inner ring radii are scaled by outerRadius, fills alternate white/black starting white", () => {
    const m = new RingMarker([0.9, 0.8, 0.7, 0.6, 0.5], "cctag3#0");
    const { canvas, circles } = mockCanvas();
    m.draw(canvas, { x_mm: 0, y_mm: 0, size_mm: 40 });
    const radii = circles.slice(1).map((c) => c.radius_mm);
    expect(radii.map((r) => Number(r.toFixed(6)))).toEqual([18, 16, 14, 12, 10]);
    const fills = circles.slice(1).map((c) => c.fill);
    expect(fills).toEqual([WHITE, BLACK, WHITE, BLACK, WHITE]);
  });

  it("works with 7 rings (4-ring family)", () => {
    const m = new RingMarker(
      [0.92, 0.84, 0.76, 0.68, 0.6, 0.52, 0.44],
      "cctag4#0",
    );
    const { canvas, circles } = mockCanvas();
    m.draw(canvas, { x_mm: 0, y_mm: 0, size_mm: 100 });
    expect(circles).toHaveLength(8);
    const innerFills = circles.slice(1).map((c) => c.fill);
    expect(innerFills).toEqual([WHITE, BLACK, WHITE, BLACK, WHITE, BLACK, WHITE]);
  });

  it("exposes cacheKey on the marker", () => {
    expect(new RingMarker([0.5], "cctag3#7").cacheKey).toBe("cctag3#7");
  });
});
