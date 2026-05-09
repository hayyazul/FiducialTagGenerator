import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type { BitsProvider } from "../families";
import { planSmallTagLayout } from "../layout/plan";
import type { LayoutOptions, Paper, TagSpec } from "../layout/types";
import { renderPlan } from "./pdf";

const square100: Paper = { width_mm: 100, height_mm: 100 };
const minimalOpts: LayoutOptions = {
  pageMargin_mm: 5,
  quietZone_mm: 2,
  cutMargin_mm: 1,
};

const fakeBits: BitsProvider = {
  bits(_family, _id) {
    return [
      [true, false, true, false],
      [false, true, false, true],
      [true, false, true, false],
      [false, true, false, true],
    ];
  },
};

const noBits: BitsProvider = {
  bits(_family, _id) {
    return null;
  },
};

function makeTags(count: number): TagSpec[] {
  return Array.from({ length: count }, (_, i) => ({ family: "tag36h11", id: i }));
}

describe("renderPlan", () => {
  it("emits a valid PDF byte stream that pdf-lib can parse back", async () => {
    const plan = planSmallTagLayout(makeTags(4), 20, square100, minimalOpts);
    const bytes = await renderPlan(plan, fakeBits);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(100);
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBe(plan.pageCount + 1);
  });

  it("matches each layout page's paper size in points", async () => {
    const A4: Paper = { width_mm: 210, height_mm: 297 };
    const plan = planSmallTagLayout(makeTags(2), 20, A4, minimalOpts);
    const bytes = await renderPlan(plan, fakeBits);
    const reloaded = await PDFDocument.load(bytes);
    const calibration = reloaded.getPage(0);
    expect(calibration.getWidth()).toBeCloseTo((210 * 72) / 25.4, 3);
    expect(calibration.getHeight()).toBeCloseTo((297 * 72) / 25.4, 3);
    const layout = reloaded.getPage(1);
    expect(layout.getWidth()).toBeCloseTo((210 * 72) / 25.4, 3);
    expect(layout.getHeight()).toBeCloseTo((297 * 72) / 25.4, 3);
  });

  it("emits a PDF even when bits are unavailable (placeholder rendering)", async () => {
    const plan = planSmallTagLayout(makeTags(3), 25, square100, minimalOpts);
    const bytes = await renderPlan(plan, noBits);
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBe(plan.pageCount + 1);
  });

  it("produces a calibration-only PDF for an empty plan", async () => {
    const plan = planSmallTagLayout([], 20, square100, minimalOpts);
    const bytes = await renderPlan(plan, fakeBits);
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBe(1);
  });

  it("inserts a back page after every layout page when printLabelsOnBack is on", async () => {
    // Two pages-worth of tags: 30 tags × 25 mm tag on a 100 mm square paper
    // with the chosen margins fits 9 per page (3×3 grid), giving 4 pages —
    // enough to verify the alternating front/back pattern across multiple
    // layout pages.
    const plan = planSmallTagLayout(makeTags(30), 25, square100, minimalOpts);
    expect(plan.pageCount).toBeGreaterThanOrEqual(2);
    const bytes = await renderPlan(plan, fakeBits, { printLabelsOnBack: true });
    const reloaded = await PDFDocument.load(bytes);
    // 1 calibration + 2 × layout pages.
    expect(reloaded.getPageCount()).toBe(1 + 2 * plan.pageCount);
  });

  it("does not insert back pages by default", async () => {
    const plan = planSmallTagLayout(makeTags(4), 20, square100, minimalOpts);
    const bytes = await renderPlan(plan, fakeBits);
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBe(1 + plan.pageCount);
  });

  it("renders cleanly when tag IDs are non-contiguous", async () => {
    // Arbitrary scattered ids (the future 'arbitrary tags' UI option).
    const tags: TagSpec[] = [13, 0, 587 - 1, 200, 42].map((id) => ({
      family: "tag36h11",
      id,
    }));
    const plan = planSmallTagLayout(tags, 25, square100, minimalOpts);
    const bytes = await renderPlan(plan, fakeBits, { printLabelsOnBack: true });
    const reloaded = await PDFDocument.load(bytes);
    // 1 calibration + N layout fronts + N layout backs.
    expect(reloaded.getPageCount()).toBe(1 + 2 * plan.pageCount);
    // The placements survived in the order the caller provided them.
    expect(plan.placements.map((p) => p.tag.id)).toEqual([13, 0, 586, 200, 42]);
  });
});
