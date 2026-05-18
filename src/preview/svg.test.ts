import { describe, expect, it } from "vitest";
import { planSmallTagLayout, type CutShape } from "../layout/plan";
import type { LayoutOptions, Paper } from "../layout/types";
import { renderPlanToSvg } from "./svg";

const square100: Paper = { width_mm: 100, height_mm: 100 };
const minimalOpts: LayoutOptions = {
  pageMargin_mm: 0,
  quietZone_mm: 0,
  cutMargin_mm: 0,
};

describe("renderPlanToSvg", () => {
  it("falls back to a labelled placeholder per tag when no image provider is given", () => {
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
    // Both tags render as placeholder rects (no image source available).
    const placeholderCount = (svg.match(/fill="#222"/g) ?? []).length;
    expect(placeholderCount).toBe(2);
    expect(svg).not.toContain("<image ");
    // Cut grid should appear as <line> elements.
    expect(svg).toContain("<line");
  });

  it("renders each tag as a pixelated <image> when a TagImageProvider supplies an href", () => {
    const plan = planSmallTagLayout(
      [
        { family: "tag36h11", id: 0 },
        { family: "tag36h11", id: 1 },
      ],
      50,
      square100,
      minimalOpts,
    );
    const href = "data:image/png;base64,AAAA";
    const svg = renderPlanToSvg(plan, 0, { imageHref: () => href });
    const imageCount = (svg.match(/<image /g) ?? []).length;
    expect(imageCount).toBe(2);
    expect(svg).toContain(`href="${href}"`);
    expect(svg).toContain("image-rendering:pixelated");
    // No placeholder boxes when images are available.
    expect(svg).not.toContain("fill=\"#222\"");
  });

  it("falls back to a placeholder for any tag whose image is not yet available", () => {
    const plan = planSmallTagLayout(
      [{ family: "tag36h11", id: 0 }],
      50,
      square100,
      minimalOpts,
    );
    const svg = renderPlanToSvg(plan, 0, { imageHref: () => null });
    expect(svg).toContain("fill=\"#222\"");
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
    const svg = renderPlanToSvg(plan, 0, { imageHref: () => "data:image/png;base64,AAAA" });
    expect(svg).not.toContain("tag36h11 #7");
    expect(svg).not.toContain(`fill="#4d4d4d"`);
  });

  it("sets the family/id/size caption in the quiet zone when that option is on", () => {
    const opts: LayoutOptions = { pageMargin_mm: 0, quietZone_mm: 1, cutMargin_mm: 0 };
    const plan = planSmallTagLayout([{ family: "tag36h11", id: 5 }], 20, square100, opts);
    const provider = { imageHref: () => "data:image/png;base64,AAAA" };
    expect(renderPlanToSvg(plan, 0, provider)).not.toContain("tag36h11 #5 · 20 mm");
    const svg = renderPlanToSvg(plan, 0, provider, { printLabelsInQuietZone: true });
    expect(svg).toContain("tag36h11 #5 · 20 mm");
    expect(svg).toContain(`fill="#000000"`);
  });

  it("draws no quiet-zone caption when there is no quiet zone, even with the option on", () => {
    const opts: LayoutOptions = { pageMargin_mm: 0, quietZone_mm: 0, cutMargin_mm: 0 };
    const plan = planSmallTagLayout([{ family: "tag36h11", id: 5 }], 20, square100, opts);
    const svg = renderPlanToSvg(
      plan,
      0,
      { imageHref: () => "data:image/png;base64,AAAA" },
      { printLabelsInQuietZone: true },
    );
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
    const svg = renderPlanToSvg(
      plan,
      0,
      { imageHref: () => "data:image/png;base64,AAAA" },
      { printLabelsInQuietZone: true },
    );
    expect(svg).toContain("tagCustom48h12 #0");
    expect(svg).toContain("&gt; tag36h11 #5");
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
    // Multiple pages; page 0 should still only have its own circles.
    expect(plan.pageCount).toBeGreaterThanOrEqual(1);
    // Count circle elements: on a single-page render, exactly the per-page count.
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
    const href = "data:image/png;base64,AAAA";
    const svg = renderPlanToSvg(plan, 0, { imageHref: () => href });
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
    const href = "data:image/png;base64,AAAA";
    const svg = renderPlanToSvg(plan, 0, { imageHref: () => href });
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
    const href = "data:image/png;base64,AAAA";
    const svg = renderPlanToSvg(plan, 0, { imageHref: () => href });
    // Three images: outer + level 1 subtag + level 2 subtag.
    const imageCount = (svg.match(/<image /g) ?? []).length;
    expect(imageCount).toBe(3);
  });
});
