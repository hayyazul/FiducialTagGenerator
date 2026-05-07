import { describe, expect, it } from "vitest";
import { planSmallTagLayout } from "../layout/plan";
import type { LayoutOptions, Paper } from "../layout/types";
import { renderPlanToSvg } from "./svg";

const square100: Paper = { width_mm: 100, height_mm: 100 };
const minimalOpts: LayoutOptions = {
  pageMargin_mm: 0,
  quietZone_mm: 0,
  cutMargin_mm: 0,
  interTagGap_mm: 0,
};

describe("renderPlanToSvg", () => {
  it("emits one tag rect and the cut grid for a simple plan", () => {
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
    // Two tag bitmaps drawn as filled rects.
    const tagRectCount = (svg.match(/fill="#222"/g) ?? []).length;
    expect(tagRectCount).toBe(2);
    // Cut grid should appear as <line> elements.
    expect(svg).toContain("<line");
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
