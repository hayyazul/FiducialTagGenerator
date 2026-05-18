import { describe, expect, it } from "vitest";
import type { BitsProvider } from "../families";
import { planSmallTagLayout, type CutShape } from "../layout/plan";
import type { LayoutOptions, Paper } from "../layout/types";
import type { BitGridRasterizer } from "../render/svg-canvas";
import { renderPlanToSvg } from "./svg";

const square100: Paper = { width_mm: 100, height_mm: 100 };
const minimalOpts: LayoutOptions = {
  pageMargin_mm: 0,
  quietZone_mm: 0,
  cutMargin_mm: 0,
};

const HREF = "data:image/png;base64,AAAA";
const stubBits: BitsProvider = { bits: (): boolean[][] => [[true]] };
const stubRasterizer: BitGridRasterizer = { rasterize: (): string => HREF };
const everyBitNull: BitsProvider = { bits: (): null => null };

describe("renderPlanToSvg", () => {
  it("falls back to a labelled placeholder per tag when no marker provider is given", () => {
    const plan = planSmallTagLayout(
      [
        { family: "tag36h11", id: 0 },
        { family: "tag36h11", id: 1 },
      ],
      50,
      square100,
      minimalOpts,
    );
    const svg = renderPlanToSvg(plan, 0);
    expect(svg).toContain("<svg");
    expect(svg).toContain("viewBox=\"0 0 100 100\"");
    // Both tags render as placeholder rects (no marker source available).
    const placeholderCount = (svg.match(/fill="#222222"/g) ?? []).length;
    expect(placeholderCount).toBe(2);
    expect(svg).not.toContain("<image ");
    // Cut grid should appear as <line> elements.
    expect(svg).toContain("<line");
  });

  it("renders each tag as a pixelated <image> when a rasterizer supplies an href", () => {
    const plan = planSmallTagLayout(
      [
        { family: "tag36h11", id: 0 },
        { family: "tag36h11", id: 1 },
      ],
      50,
      square100,
      minimalOpts,
    );
    const svg = renderPlanToSvg(plan, 0, stubBits, { rasterizer: stubRasterizer });
    const imageCount = (svg.match(/<image /g) ?? []).length;
    expect(imageCount).toBe(2);
    expect(svg).toContain(`href="${HREF}"`);
    expect(svg).toContain("image-rendering:pixelated");
    // No placeholder boxes when images are available.
    expect(svg).not.toContain("fill=\"#222222\"");
  });

  it("falls back to a placeholder for any tag whose bits are not yet available", () => {
    const plan = planSmallTagLayout(
      [{ family: "tag36h11", id: 0 }],
      50,
      square100,
      minimalOpts,
    );
    const svg = renderPlanToSvg(plan, 0, everyBitNull, { rasterizer: stubRasterizer });
    expect(svg).toContain("fill=\"#222222\"");
    expect(svg).not.toContain("<image ");
  });

  it("escapes XML-unsafe characters in tag family names", () => {
    const plan = planSmallTagLayout(
      [{ family: "<bad&family>", id: 0 }],
      50,
      square100,
      minimalOpts,
    );
    const svg = renderPlanToSvg(plan, 0);
    expect(svg).not.toContain("<bad&family>");
    expect(svg).toContain("&lt;bad&amp;family&gt;");
  });

  it("paints only what the PDF prints: no cream quiet zones, no dashed margin guide, grey cut lines", () => {
    const opts: LayoutOptions = { pageMargin_mm: 5, quietZone_mm: 1, cutMargin_mm: 0 };
    const plan = planSmallTagLayout([{ family: "tag36h11", id: 0 }], 20, square100, opts);
    const svg = renderPlanToSvg(plan, 0);
    expect(svg).not.toContain("#fff8d6");
    expect(svg).not.toContain("stroke-dasharray");
    expect(svg).not.toContain('stroke="#c00"');
    expect(svg).toContain('stroke="#8c8c8c"'); // PDF cut-line grey
  });

  it("draws the four corner registration marks when there is a page margin", () => {
    const opts: LayoutOptions = { pageMargin_mm: 5, quietZone_mm: 0, cutMargin_mm: 0 };
    const plan = planSmallTagLayout([{ family: "tag36h11", id: 0 }], 20, square100, opts);
    const svg = renderPlanToSvg(plan, 0);
    // Two strokes per mark, four corners → eight reg-mark lines.
    const regMarkLines = (svg.match(/stroke="#666666"/g) ?? []).length;
    expect(regMarkLines).toBe(8);
  });

  it("omits registration marks when there is no page margin", () => {
    const plan = planSmallTagLayout([{ family: "tag36h11", id: 0 }], 50, square100, minimalOpts);
    const svg = renderPlanToSvg(plan, 0);
    expect(svg).not.toContain('stroke="#666666"');
  });

  it("draws no caption in the cut band — that text was removed when cut margin became a paper gap", () => {
    const opts: LayoutOptions = { pageMargin_mm: 0, quietZone_mm: 1, cutMargin_mm: 2 };
    const plan = planSmallTagLayout([{ family: "tag36h11", id: 7 }], 20, square100, opts);
    const svg = renderPlanToSvg(plan, 0, stubBits, { rasterizer: stubRasterizer });
    expect(svg).not.toContain("tag36h11 #7");
    expect(svg).not.toContain(`fill="#4d4d4d"`);
  });

  it("sets the family/id/size caption in the quiet zone when that option is on", () => {
    const opts: LayoutOptions = { pageMargin_mm: 0, quietZone_mm: 1, cutMargin_mm: 0 };
    const plan = planSmallTagLayout([{ family: "tag36h11", id: 5 }], 20, square100, opts);
    expect(
      renderPlanToSvg(plan, 0, stubBits, { rasterizer: stubRasterizer }),
    ).not.toContain("tag36h11 #5 · 20 mm");
    const svg = renderPlanToSvg(plan, 0, stubBits, {
      rasterizer: stubRasterizer,
      printLabelsInQuietZone: true,
    });
    expect(svg).toContain("tag36h11 #5 · 20 mm");
    expect(svg).toContain(`fill="#000000"`);
  });

  it("draws no quiet-zone caption when there is no quiet zone, even with the option on", () => {
    const opts: LayoutOptions = { pageMargin_mm: 0, quietZone_mm: 0, cutMargin_mm: 0 };
    const plan = planSmallTagLayout([{ family: "tag36h11", id: 5 }], 20, square100, opts);
    const svg = renderPlanToSvg(plan, 0, stubBits, {
      rasterizer: stubRasterizer,
      printLabelsInQuietZone: true,
    });
    expect(svg).not.toContain("tag36h11 #5 · 20 mm");
  });

  it("shows sub-tag info in the quiet-zone caption when a subtag is present", () => {
    const opts: LayoutOptions = { pageMargin_mm: 0, quietZone_mm: 2, cutMargin_mm: 0 };
    const plan = planSmallTagLayout(
      [{ family: "tagCustom48h12", id: 0, subtag: { family: "tag36h11", id: 5 } }],
      20,
      square100,
      opts,
    );
    const svg = renderPlanToSvg(plan, 0, stubBits, {
      rasterizer: stubRasterizer,
      printLabelsInQuietZone: true,
    });
    expect(svg).toContain("tagCustom48h12 #0");
    // subtagLevels is empty in the minimal plan, so no size suffix.
    expect(svg).toContain("&gt; tag36h11 #5");
  });

  it("shows sub-tag sizes in quiet-zone caption when subtagLevels is populated", () => {
    const opts: LayoutOptions = { pageMargin_mm: 0, quietZone_mm: 2, cutMargin_mm: 0 };
    const plan = planSmallTagLayout(
      [{ family: "tagCustom48h12", id: 0, subtag: { family: "tag36h11", id: 5 } }],
      20,
      square100,
      opts,
    );
    plan.subtagLevels = [{ familyName: "tag36h11", tileSize_mm: 4, tagSize_mm: 3.2 }];
    const svg = renderPlanToSvg(plan, 0, stubBits, {
      rasterizer: stubRasterizer,
      printLabelsInQuietZone: true,
    });
    expect(svg).toContain("&gt; tag36h11 #5 · 3.2 mm");
  });

  it("renders curved quiet-zone text for circular tags with per-character rotation", () => {
    const circleShape: CutShape = { kind: "circle", outerRadius_mm: 10 };
    const plan = planSmallTagLayout(
      [{ family: "tagCircle21h7", id: 0 }],
      20,
      square100,
      { pageMargin_mm: 5, quietZone_mm: 2, cutMargin_mm: 0 },
      20,
      circleShape,
    );
    const svg = renderPlanToSvg(plan, 0, stubBits, {
      rasterizer: stubRasterizer,
      printLabelsInQuietZone: true,
    });
    // Curved text places each character individually along the arc, so the
    // full caption string won't appear contiguously. Check for individual chars.
    expect(svg).toContain(">t<");
    expect(svg).toContain(">0<");
    // Each character is rotated tangent to the circle.
    expect(svg).toContain('transform="rotate(');
    const rotateCount = (svg.match(/transform="rotate\(/g) ?? []).length;
    expect(rotateCount).toBeGreaterThan(10);
  });

  it("suppresses curved quiet-zone text when there is no quiet zone even for circles", () => {
    const circleShape: CutShape = { kind: "circle", outerRadius_mm: 10 };
    const plan = planSmallTagLayout(
      [{ family: "tagCircle21h7", id: 0 }],
      20,
      square100,
      { pageMargin_mm: 5, quietZone_mm: 0, cutMargin_mm: 0 },
      20,
      circleShape,
    );
    const svg = renderPlanToSvg(plan, 0, stubBits, {
      rasterizer: stubRasterizer,
      printLabelsInQuietZone: true,
    });
    expect(svg).not.toContain("tagCircle21h7 #0");
  });

  it("draws circle cuts for a circular plan and no line cuts", () => {
    const circleShape: CutShape = { kind: "circle", outerRadius_mm: 10 };
    const plan = planSmallTagLayout(
      [{ family: "tagCircle21h7", id: 0 }],
      20,
      square100,
      minimalOpts,
      20,
      circleShape,
    );
    const svg = renderPlanToSvg(plan, 0);
    expect(svg).toContain("<circle");
    expect(svg).toContain(`stroke="${"#8c8c8c"}"`);
    expect(svg).not.toContain("<line");
  });

  it("filters circle cuts to the requested page only", () => {
    const circleShape: CutShape = { kind: "circle", outerRadius_mm: 15 };
    const plan = planSmallTagLayout(
      Array.from({ length: 9 }, (_, i) => ({ family: "tagCircle21h7", id: i })),
      15,
      { width_mm: 100, height_mm: 100 },
      minimalOpts,
      15,
      circleShape,
    );
    expect(plan.pageCount).toBeGreaterThanOrEqual(1);
    const placementsOnPage0 = plan.placements.filter((p) => p.page === 0).length;
    const svg = renderPlanToSvg(plan, 0);
    const circleCount = (svg.match(/<circle /g) ?? []).length;
    expect(circleCount).toBe(placementsOnPage0);
  });

  it("draws circle cuts with correct radius in the SVG", () => {
    const circleShape: CutShape = { kind: "circle", outerRadius_mm: 10 };
    const opts: LayoutOptions = { pageMargin_mm: 0, quietZone_mm: 2, cutMargin_mm: 0 };
    const plan = planSmallTagLayout(
      [{ family: "tagCircle21h7", id: 0 }],
      20,
      square100,
      opts,
      20,
      circleShape,
    );
    const svg = renderPlanToSvg(plan, 0);
    // radius = outerRadius + quietZone = 12
    expect(svg).toContain('r="12"');
  });

  it("renders sub-tag overlays as additional images within the parent tile", () => {
    const plan = planSmallTagLayout(
      [{ family: "tagCustom48h12", id: 0, subtag: { family: "tag36h11", id: 0 } }],
      50,
      square100,
      minimalOpts,
    );
    const svg = renderPlanToSvg(plan, 0, stubBits, { rasterizer: stubRasterizer });
    // Two images: one for the outer tag, one for the sub-tag overlay.
    const imageCount = (svg.match(/<image /g) ?? []).length;
    expect(imageCount).toBe(2);
  });

  it("renders no sub-tag overlay for non-recursive families", () => {
    const plan = planSmallTagLayout(
      [{ family: "tag36h11", id: 0 }],
      50,
      square100,
      minimalOpts,
    );
    const svg = renderPlanToSvg(plan, 0, stubBits, { rasterizer: stubRasterizer });
    const imageCount = (svg.match(/<image /g) ?? []).length;
    expect(imageCount).toBe(1);
  });

  it("renders multiple nesting levels as stacked images", () => {
    const plan = planSmallTagLayout(
      [{
        family: "tagCustom48h12", id: 0,
        subtag: { family: "tagCustom48h12", id: 1, subtag: { family: "tag36h11", id: 2 } },
      }],
      50,
      square100,
      minimalOpts,
    );
    const svg = renderPlanToSvg(plan, 0, stubBits, { rasterizer: stubRasterizer });
    // Three images: outer + level 1 subtag + level 2 subtag.
    const imageCount = (svg.match(/<image /g) ?? []).length;
    expect(imageCount).toBe(3);
  });
});
