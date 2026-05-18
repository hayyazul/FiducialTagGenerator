import { describe, expect, it } from "vitest";
import { maxTagSizeForCount, planSmallTagLayout, type CutShape } from "./plan";
import type { LayoutOptions, Paper, TagSpec } from "./types";

const A4: Paper = { width_mm: 210, height_mm: 297 };
const square100: Paper = { width_mm: 100, height_mm: 100 };

const noMargins: LayoutOptions = {
  pageMargin_mm: 0,
  quietZone_mm: 0,
  cutMargin_mm: 0,
};

function makeTags(family: string, count: number): TagSpec[] {
  return Array.from({ length: count }, (_, i) => ({ family, id: i }));
}

describe("planSmallTagLayout — grid capacity", () => {
  it("packs uniform tags into a tight grid when there are no margins", () => {
    const plan = planSmallTagLayout(makeTags("tag36h11", 25), 20, square100, noMargins);
    expect(plan.pageCount).toBe(1);
    expect(plan.placements).toHaveLength(25);
    // 5×5 grid; first cell is bottom-left of the row block, last cell top-right.
    expect(plan.placements[0]).toMatchObject({ x_mm: 0, page: 0 });
  });

  it("subtracts page margins from the printable area", () => {
    // 100mm paper, 5mm margin per side → 90mm printable; 20mm tags ⇒ 4 cols.
    const opts: LayoutOptions = { ...noMargins, pageMargin_mm: 5 };
    const plan = planSmallTagLayout(makeTags("tag36h11", 16), 20, square100, opts);
    expect(plan.pageCount).toBe(1);
    expect(plan.placements).toHaveLength(16);
  });

  it("treats quiet zone as part of the tag's footprint", () => {
    // tag 20mm + quiet 2.5mm × 2 sides = 25mm footprint → 4 fit in 100mm.
    const opts: LayoutOptions = { ...noMargins, quietZone_mm: 2.5 };
    const plan = planSmallTagLayout(makeTags("tag36h11", 16), 20, square100, opts);
    expect(plan.placements).toHaveLength(16);
    // Tag bitmap is offset inward by quietZone within its cell.
    expect(plan.placements[0]?.x_mm).toBeCloseTo(2.5, 6);
  });

  it("treats cut margin as the gap between adjacent cells (not per-side slack)", () => {
    // Under the new semantic, cell width = tile + 2*quiet = 22 mm; pitch = cell
    // + cutMargin = 23.5 mm. On 100 mm paper that fits N where
    // N*22 + (N-1)*1.5 ≤ 100 → N = 4. Tile sits at quietZone (1 mm) inside the
    // cell, with no extra cut-margin offset.
    const opts: LayoutOptions = { ...noMargins, quietZone_mm: 1, cutMargin_mm: 1.5 };
    const plan = planSmallTagLayout(makeTags("tag36h11", 16), 20, square100, opts);
    expect(plan.placements).toHaveLength(16);
    expect(plan.placements[0]?.x_mm).toBeCloseTo(1, 6);
    // Pitch is 23.5 mm, so the second tag starts 23.5 mm further over.
    expect(plan.placements[1]?.x_mm).toBeCloseTo(1 + 23.5, 6);
  });

  it("at cutMargin=0, pitch equals cell width and adjacent cuts share a single line", () => {
    const opts: LayoutOptions = { ...noMargins, quietZone_mm: 1, cutMargin_mm: 0 };
    const plan = planSmallTagLayout(makeTags("tag36h11", 16), 20, square100, opts);
    // tile 20 + 2*quiet 1 = 22 mm cell; 4 cells fit in 100 mm with 12 mm slack.
    expect(plan.placements).toHaveLength(16);
    const cuts = plan.cutSegments.filter((c) => c.page === 0);
    const verticals = cuts.filter((c) => c.x0_mm === c.x1_mm);
    // 4 cells share boundaries: 4+1 = 5 unique vertical cuts (the grid).
    expect(verticals.length).toBe(5);
  });

  it("at cutMargin>0, emits two cut lines per interior boundary", () => {
    const opts: LayoutOptions = { ...noMargins, quietZone_mm: 1, cutMargin_mm: 1.5 };
    const plan = planSmallTagLayout(makeTags("tag36h11", 16), 20, square100, opts);
    const cuts = plan.cutSegments.filter((c) => c.page === 0);
    const verticals = cuts.filter((c) => c.x0_mm === c.x1_mm);
    // 4 cells × 2 edges each = 8 vertical cuts (no sharing when there is a gap).
    expect(verticals.length).toBe(8);
    // The gap between cell 0's right cut and cell 1's left cut is cutMargin_mm.
    const xs = [...new Set(verticals.map((c) => c.x0_mm))].sort((a, b) => a - b);
    expect(xs[1]! - xs[0]!).toBeCloseTo(22, 6); // cell width
    expect(xs[2]! - xs[1]!).toBeCloseTo(1.5, 6); // cut margin gap
  });

});

describe("planSmallTagLayout — page assignment", () => {
  it("spills onto additional pages when tags exceed per-page capacity", () => {
    const plan = planSmallTagLayout(makeTags("tag36h11", 30), 20, square100, noMargins);
    expect(plan.pageCount).toBe(2);
    const onPage0 = plan.placements.filter((p) => p.page === 0);
    const onPage1 = plan.placements.filter((p) => p.page === 1);
    expect(onPage0).toHaveLength(25);
    expect(onPage1).toHaveLength(5);
  });

  it("returns an empty plan for an empty tag list", () => {
    const plan = planSmallTagLayout([], 20, square100, noMargins);
    expect(plan.pageCount).toBe(0);
    expect(plan.placements).toEqual([]);
    expect(plan.cutSegments).toEqual([]);
  });

  it("places the first tag at the top-left of the page (highest y)", () => {
    // Bottom-left origin convention, but reading order should fill top-left first.
    const plan = planSmallTagLayout(makeTags("tag36h11", 10), 20, square100, noMargins);
    // 5 cols × 5 rows. Tags 0..4 fill the top row; tags 5..9 the next row down.
    const topRow = plan.placements[0]!;
    const secondRow = plan.placements[5]!;
    expect(topRow.y_mm).toBeGreaterThan(secondRow.y_mm);
    // Within the top row, the first tag is leftmost.
    expect(plan.placements[0]!.x_mm).toBeLessThan(plan.placements[1]!.x_mm);
  });
});

describe("planSmallTagLayout — cut segments", () => {
  it("emits a shared grid at cutMargin=0 (rows+1 horizontals, cols+1 verticals)", () => {
    // 2×2 grid: 50mm paper with 25mm cell = 2 cols. cutMargin=0 collapses
    // adjacent boundaries to a single shared line.
    const paper: Paper = { width_mm: 50, height_mm: 50 };
    const plan = planSmallTagLayout(makeTags("tag36h11", 4), 25, paper, noMargins);
    const cuts = plan.cutSegments.filter((c) => c.page === 0);
    const verticals = cuts.filter((c) => c.x0_mm === c.x1_mm);
    const horizontals = cuts.filter((c) => c.y0_mm === c.y1_mm);
    expect(verticals).toHaveLength(3); // cols+1
    expect(horizontals).toHaveLength(3); // rows+1
  });
});

describe("planSmallTagLayout — circle cut shape", () => {
  const circleShape: CutShape = { kind: "circle", outerRadius_mm: 10 };

  it("uses 2*(outerRadius+quiet) as the cell width and pitch for circle cells", () => {
    const opts: LayoutOptions = { ...noMargins, quietZone_mm: 2, cutMargin_mm: 1 };
    const plan = planSmallTagLayout(
      makeTags("tagCircle21h7", 1), 20, square100, opts, 20, circleShape,
    );
    // cell = 2*(10 + 2) = 24, pitch = 24 + 1 = 25.
    // tileOffset = (24 - 20)/2 = 2 (happens to equal quietZone here).
    expect(plan.placements).toHaveLength(1);
    expect(plan.placements[0]!.x_mm).toBeCloseTo(2, 6);
    expect(plan.cutSegments).toEqual([]);
    expect(plan.cutCircles).toHaveLength(1);
  });

  it("centers the tile within the cell when outerRadius differs from tileSize/2", () => {
    // outerRadius=15, quietZone=2, tileSize=20 → cell = 2*(15+2) = 34.
    // tileOffset = (34 - 20)/2 = 7 (not quietZone=2).
    const shape: CutShape = { kind: "circle", outerRadius_mm: 15 };
    const opts: LayoutOptions = { ...noMargins, quietZone_mm: 2 };
    const plan = planSmallTagLayout(
      makeTags("tagCircle21h7", 1), 20, square100, opts, 20, shape,
    );
    expect(plan.placements[0]!.x_mm).toBeCloseTo(7, 6);
    // Cut circle centre matches tile centre.
    expect(plan.cutCircles[0]!.cx_mm).toBeCloseTo(7 + 10, 6);
    // Cut circle exactly touches cell edges.
    expect(plan.cutCircles[0]!.cx_mm - plan.cutCircles[0]!.radius_mm).toBeCloseTo(0, 4);
    expect(plan.cutCircles[0]!.cx_mm + plan.cutCircles[0]!.radius_mm).toBeCloseTo(34, 4);
  });

  it("keeps square family placement unchanged (tileOffset equals quietZone)", () => {
    const opts: LayoutOptions = { ...noMargins, quietZone_mm: 3 };
    const plan = planSmallTagLayout(makeTags("tag36h11", 1), 20, square100, opts);
    expect(plan.placements[0]!.x_mm).toBeCloseTo(3, 6);
  });

  it("emits one CutCircle per placement at the tile centre with correct radius", () => {
    const opts: LayoutOptions = { ...noMargins, quietZone_mm: 2, cutMargin_mm: 1 };
    const tileSize = 20;
    const plan = planSmallTagLayout(
      makeTags("tagCircle21h7", 4), tileSize, square100, opts, tileSize, circleShape,
    );
    expect(plan.cutCircles).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      const p = plan.placements[i]!;
      const c = plan.cutCircles[i]!;
      expect(c.page).toBe(p.page);
      expect(c.cx_mm).toBeCloseTo(p.x_mm + tileSize / 2, 6);
      expect(c.cy_mm).toBeCloseTo(p.y_mm + tileSize / 2, 6);
      expect(c.radius_mm).toBeCloseTo(10 + 2, 6); // outerRadius + quietZone
    }
  });

  it("sets cutSegments empty for circle plans", () => {
    const plan = planSmallTagLayout(
      makeTags("tagCircle21h7", 6), 20, square100, noMargins, 20, circleShape,
    );
    expect(plan.cutSegments).toEqual([]);
  });

  it("rejects a circle that does not fit on the paper", () => {
    // 100 mm paper, 5 mm pageMargin per side → 90 mm printable.
    // circle cell = 2*(55 + 0) = 110 > 90 → error.
    const bigCircle: CutShape = { kind: "circle", outerRadius_mm: 55 };
    const opts: LayoutOptions = { ...noMargins, pageMargin_mm: 5 };
    expect(() =>
      planSmallTagLayout([], 50, square100, opts, 50, bigCircle),
    ).toThrow(/does not fit/);
  });

  it("returns an empty plan with empty cutCircles for an empty tag list", () => {
    const plan = planSmallTagLayout([], 20, square100, noMargins, 20, circleShape);
    expect(plan.pageCount).toBe(0);
    expect(plan.cutCircles).toEqual([]);
    expect(plan.cutSegments).toEqual([]);
  });

  it("places circle cells across pages", () => {
    // cell = 2*(20+0) = 40 mm; 100×190 mm paper, zero margins → 2 cols × 4 rows
    // = 8 per page; 30 tags → 4 pages.
    const plan = planSmallTagLayout(
      makeTags("tagCircle21h7", 30), 20, { width_mm: 100, height_mm: 190 },
      noMargins, 20, { kind: "circle", outerRadius_mm: 20 },
    );
    expect(plan.pageCount).toBe(4);
    const onPage1 = plan.cutCircles.filter((c) => c.page === 1);
    expect(onPage1.length).toBe(8);
  });
});

describe("planSmallTagLayout — input validation (fail loudly)", () => {
  it("rejects non-positive tile size", () => {
    expect(() => planSmallTagLayout([], 0, square100, noMargins)).toThrow(/tileSize_mm/);
    expect(() => planSmallTagLayout([], -1, square100, noMargins)).toThrow(/tileSize_mm/);
  });

  it("rejects non-positive paper dimensions", () => {
    expect(() =>
      planSmallTagLayout([], 10, { width_mm: 0, height_mm: 100 }, noMargins),
    ).toThrow(/paper/);
  });

  it("rejects negative margin values", () => {
    expect(() =>
      planSmallTagLayout([], 10, square100, { ...noMargins, quietZone_mm: -1 }),
    ).toThrow(/quietZone_mm/);
  });

  it("rejects a tag that does not fit on the paper", () => {
    // 100mm paper, 10mm pageMargin per side → 80mm printable; 90mm tag is too big.
    const opts: LayoutOptions = { ...noMargins, pageMargin_mm: 10 };
    expect(() => planSmallTagLayout([], 90, square100, opts)).toThrow(/does not fit/);
  });
});

describe("maxTagSizeForCount", () => {
  it("returns the largest size such that all tags fit on one page", () => {
    // 100mm paper, 25 tags, no margins ⇒ 5×5 grid, each cell 20mm.
    const size = maxTagSizeForCount(25, square100, noMargins, 1);
    expect(size).toBeCloseTo(20, 4);
  });

  it("scales up when more pages are allowed", () => {
    const oneSize = maxTagSizeForCount(50, square100, noMargins, 1);
    const twoSize = maxTagSizeForCount(50, square100, noMargins, 2);
    expect(twoSize).toBeGreaterThan(oneSize);
  });

  it("returns a positive size for a typical A4 layout", () => {
    const opts: LayoutOptions = {
      pageMargin_mm: 10,
      quietZone_mm: 2,
      cutMargin_mm: 1,
    };
    const size = maxTagSizeForCount(20, A4, opts, 1);
    expect(size).toBeGreaterThan(0);
    // Sanity: 20 tags of that size really do fit.
    expect(() => planSmallTagLayout(makeTags("tag36h11", 20), size - 0.01, A4, opts))
      .not.toThrow();
  });

  it("handles circular cut shape: monotone and finds a positive size", () => {
    const opts: LayoutOptions = { pageMargin_mm: 10, quietZone_mm: 2, cutMargin_mm: 1 };
    const circleShape: CutShape = { kind: "circle", outerRadius_mm: 10 };
    const size = maxTagSizeForCount(20, A4, opts, 1, circleShape);
    expect(size).toBeGreaterThan(0);
    expect(() =>
      planSmallTagLayout(makeTags("tagCircle21h7", 20), size - 0.01, A4, opts, size - 0.01, circleShape),
    ).not.toThrow();
  });
});
