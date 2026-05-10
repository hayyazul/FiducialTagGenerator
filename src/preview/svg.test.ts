import { describe, expect, it } from "vitest";
import { planSmallTagLayout } from "../layout/plan";
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
});
