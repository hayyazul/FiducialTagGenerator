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

/** Tiny bit grid for testing — checkerboard 4×4. Same grid for every id. */
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
    // Reparse and verify structure.
    const reloaded = await PDFDocument.load(bytes);
    // 1 calibration page + plan.pageCount layout pages.
    expect(reloaded.getPageCount()).toBe(plan.pageCount + 1);
  });

  it("matches each layout page's paper size in points", async () => {
    const A4: Paper = { width_mm: 210, height_mm: 297 };
    const plan = planSmallTagLayout(makeTags(2), 20, A4, minimalOpts);
    const bytes = await renderPlan(plan, fakeBits);
    const reloaded = await PDFDocument.load(bytes);
    // Calibration is fixed at A4; layout pages use the plan's paper.
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

  it("produces an empty (calibration-only) PDF for a zero-tag plan", async () => {
    const plan = planSmallTagLayout([], 20, square100, minimalOpts);
    const bytes = await renderPlan(plan, fakeBits);
    const reloaded = await PDFDocument.load(bytes);
    // pageCount = 0 ⇒ only the calibration page is emitted.
    expect(reloaded.getPageCount()).toBe(1);
  });
});
