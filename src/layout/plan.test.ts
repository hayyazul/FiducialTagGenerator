import { describe, expect, it } from "vitest";
import { maxTagSizeForCount, planSmallTagLayout } from "./plan";
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

  it("treats cut margin like quiet zone for sizing purposes", () => {
    // tag 20 + 2*(quiet 1 + cut 1.5) = 25mm footprint → 4 cols.
    const opts: LayoutOptions = { ...noMargins, quietZone_mm: 1, cutMargin_mm: 1.5 };
    const plan = planSmallTagLayout(makeTags("tag36h11", 16), 20, square100, opts);
    expect(plan.placements).toHaveLength(16);
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
  it("emits a shared grid (rows+1 horizontals, cols+1 verticals)", () => {
    // 2×2 grid: 50mm paper with 25mm tag footprint = (50/25) = 2 cols.
    const paper: Paper = { width_mm: 50, height_mm: 50 };
    const plan = planSmallTagLayout(makeTags("tag36h11", 4), 25, paper, noMargins);
    const cuts = plan.cutSegments.filter((c) => c.page === 0);
    const verticals = cuts.filter((c) => c.x0_mm === c.x1_mm);
    const horizontals = cuts.filter((c) => c.y0_mm === c.y1_mm);
    expect(verticals).toHaveLength(3); // cols+1
    expect(horizontals).toHaveLength(3); // rows+1
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
});
