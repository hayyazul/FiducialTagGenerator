import type { LayoutPlan } from "../layout/types";

/**
 * Caller supplies tag bitmaps if it has them. Returning null (or omitting
 * the provider entirely) yields the placeholder rendering — a solid black
 * square with the tag id printed in white — which is useful when the
 * mosaic is still loading or for an unknown family.
 */
export interface BitsProvider {
  bits(family: string, id: number): boolean[][] | null;
}

/**
 * Render a single page of a LayoutPlan to an SVG string.
 *
 * SVG uses top-left origin; the layout engine uses bottom-left. We
 * translate coordinates at this boundary rather than applying an SVG
 * transform, so text labels stay right-side up.
 */
export function renderPlanToSvg(
  plan: LayoutPlan,
  page: number,
  bitsProvider?: BitsProvider,
): string {
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
      const yTop = flipY(p.y_mm + tag);
      const qzX = p.x_mm - opts.quietZone_mm;
      const qzY = flipY(p.y_mm + tag + opts.quietZone_mm);
      const qzSize = tag + 2 * opts.quietZone_mm;
      const quietZoneRect =
        opts.quietZone_mm > 0
          ? `<rect x="${qzX}" y="${qzY}" width="${qzSize}" height="${qzSize}" fill="#fff8d6"/>`
          : "";
      const bits = bitsProvider?.bits(p.tag.family, p.tag.id) ?? null;
      const body = bits
        ? renderBits(p.x_mm, yTop, tag, bits)
        : renderPlaceholder(p.x_mm, yTop, tag, p.tag.family, p.tag.id);
      return quietZoneRect + body;
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

/** Render an `edge × edge` boolean grid as one black <rect> per black bit.
 *  `(x_mm, yTop_svg)` is the top-left of the tag bitmap in SVG coords. */
function renderBits(
  x_mm: number,
  yTop_svg: number,
  tagSize_mm: number,
  bits: boolean[][],
): string {
  const edge = bits.length;
  if (edge === 0) return "";
  const cell = tagSize_mm / edge;
  // White underlay so the tag bitmap area is opaque white between bits
  // (it sits on top of the cream quiet-zone rectangle).
  let s = `<rect x="${x_mm}" y="${yTop_svg}" width="${tagSize_mm}" height="${tagSize_mm}" fill="#fff"/>`;
  for (let y = 0; y < edge; y++) {
    const row = bits[y]!;
    for (let x = 0; x < edge; x++) {
      if (!row[x]) continue;
      const sx = x_mm + x * cell;
      const sy = yTop_svg + y * cell;
      // Tiny epsilon overlap eliminates hairline seams when the SVG is
      // scaled in the browser.
      s += `<rect x="${sx}" y="${sy}" width="${cell + 0.01}" height="${cell + 0.01}" fill="#000"/>`;
    }
  }
  return s;
}

function renderPlaceholder(
  x_mm: number,
  yTop_svg: number,
  tagSize_mm: number,
  family: string,
  id: number,
): string {
  const labelSize = Math.max(1.2, tagSize_mm * 0.18);
  return (
    `<rect x="${x_mm}" y="${yTop_svg}" width="${tagSize_mm}" height="${tagSize_mm}" fill="#222"/>` +
    `<text x="${x_mm + tagSize_mm / 2}" y="${yTop_svg + tagSize_mm / 2}" ` +
    `font-size="${labelSize}" text-anchor="middle" dominant-baseline="central" ` +
    `fill="#fff" font-family="monospace">${escapeXml(`${family}#${id}`)}</text>`
  );
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
