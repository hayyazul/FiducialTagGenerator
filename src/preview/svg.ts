import type { LayoutPlan } from "../layout/types";

/**
 * Render a single page of a LayoutPlan to an SVG string. Visual placeholder
 * only — actual tag bitmaps come from the apriltag-imgs source in Part 2.
 * Each tag is shown as a solid black square with the tag id centered on it,
 * the quiet zone as a faint cream box, page margin as a dashed gray
 * rectangle, and cut lines as red strokes.
 *
 * SVG uses top-left origin; the layout engine uses bottom-left. We translate
 * coordinates at the boundary rather than applying an SVG transform, so
 * text labels remain right-side up.
 */
export function renderPlanToSvg(plan: LayoutPlan, page: number): string {
  const W = plan.paper.width_mm;
  const H = plan.paper.height_mm;
  const tag = plan.tagSize_mm;
  const opts = plan.options;
  const flipY = (y_mm: number): number => H - y_mm;

  const placements = plan.placements.filter((p) => p.page === page);
  const cuts = plan.cutSegments.filter((c) => c.page === page);

  const margin = opts.pageMargin_mm;
  const marginRect =
    margin > 0
      ? `<rect x="${margin}" y="${margin}" width="${W - 2 * margin}" ` +
        `height="${H - 2 * margin}" fill="none" stroke="#bbb" ` +
        `stroke-dasharray="1 1" stroke-width="0.2"/>`
      : "";

  const tagShapes = placements
    .map((p) => {
      // SVG y of the *top* edge of the tag (since SVG y grows downward).
      const yTop = flipY(p.y_mm + tag);
      const qzX = p.x_mm - opts.quietZone_mm;
      const qzY = flipY(p.y_mm + tag + opts.quietZone_mm);
      const qzSize = tag + 2 * opts.quietZone_mm;
      const labelSize = Math.max(1.2, tag * 0.18);
      const labelText = escapeXml(`${p.tag.family}#${p.tag.id}`);
      return (
        `<rect x="${qzX}" y="${qzY}" width="${qzSize}" height="${qzSize}" fill="#fff8d6"/>` +
        `<rect x="${p.x_mm}" y="${yTop}" width="${tag}" height="${tag}" fill="#222"/>` +
        `<text x="${p.x_mm + tag / 2}" y="${yTop + tag / 2}" ` +
        `font-size="${labelSize}" text-anchor="middle" dominant-baseline="central" ` +
        `fill="#fff" font-family="monospace">${labelText}</text>`
      );
    })
    .join("");

  const cutLines = cuts
    .map(
      (c) =>
        `<line x1="${c.x0_mm}" y1="${flipY(c.y0_mm)}" ` +
        `x2="${c.x1_mm}" y2="${flipY(c.y1_mm)}" stroke="#c00" stroke-width="0.25"/>`,
    )
    .join("");

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" ` +
    `width="100%" style="max-width:560px;background:#fff;border:1px solid #999;display:block">` +
    `<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>` +
    marginRect +
    tagShapes +
    cutLines +
    `</svg>`
  );
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
