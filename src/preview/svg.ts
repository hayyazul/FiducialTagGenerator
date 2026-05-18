import { getFamily } from "../families";
import type { LayoutPlan, TagSpec } from "../layout/types";
import { tagCaptionLine } from "../tag-caption";

/**
 * A source of per-tag bitmap images for the preview. Each tag is drawn as a
 * single <image> whose href is a small PNG carrying one device pixel per bit
 * (see `preview/tag-images`); the SVG scales it up with nearest-neighbour so
 * the exact bit pattern stays crisp at any zoom. `null` means "not available
 * yet" (mosaic still loading, unknown family/id) — the caller falls back to a
 * labelled placeholder.
 *
 * Why an <image> per tag rather than one <rect> per black bit: a page packed
 * with hundreds of tiny tags has tens of thousands of black bits. As <rect>
 * elements that is a multi-megabyte SVG string and a DOM subtree the browser
 * spends seconds parsing and painting on every edit. One <image> per tag
 * collapses that to a few hundred nodes.
 */
export interface TagImageProvider {
  imageHref(family: string, id: number): string | null;
}

// Colours and line weights mirror what `render/pdf` draws so the preview is a
// faithful render of a printed layout page (everything except the calibration
// sheet). Greys are the PDF's rgb() values scaled to 0–255.
const CUT_LINE = "#8c8c8c"; // rgb(0.55)
const REG_MARK = "#666666"; // rgb(0.4)
const QUIET_LABEL = "#000000"; // rgb(0) — the in-quiet-zone caption

/** Optional, render-only embellishments — they don't change the layout. */
export interface PreviewOptions {
  /** Mirror the PDF's "print tag info in the quiet zone" output option:
   *  draw the "family #id · size" caption in each tag's bottom quiet-zone
   *  band. Default: false. */
  printLabelsInQuietZone?: boolean;
}

/**
 * Render a single page of a LayoutPlan to an SVG string. With
 * `opts.printLabelsInQuietZone` the preview also shows the in-quiet-zone
 * caption, matching a PDF rendered with the same option on.
 *
 * SVG uses top-left origin; the layout engine uses bottom-left. We
 * translate coordinates at this boundary rather than applying an SVG
 * transform, so text labels stay right-side up.
 */
export function renderPlanToSvg(
  plan: LayoutPlan,
  page: number,
  images?: TagImageProvider,
  opts: PreviewOptions = {},
): string {
  const W = plan.paper.width_mm;
  const H = plan.paper.height_mm;
  const tile = plan.tileSize_mm;
  const flipY = (y_mm: number): number => H - y_mm;

  const placements = plan.placements.filter((p) => p.page === page);
  const cuts = plan.cutSegments.filter((c) => c.page === page);
  const circles = plan.cutCircles.filter((c) => c.page === page);

  const tagShapes = placements
    .map((p) => {
      const yTop = flipY(p.y_mm + tile);
      const href = images?.imageHref(p.tag.family, p.tag.id) ?? null;
      const body =
        href !== null
          ? renderTagImage(p.x_mm, yTop, tile, href)
          : renderPlaceholder(p.x_mm, yTop, tile, p.tag.family, p.tag.id);
      const subOverlays = renderSubtagOverlays(p.tag.subtag, p.tag.family, p.x_mm, yTop, tile, images);
      const quietLabel = opts.printLabelsInQuietZone
        ? renderQuietZoneLabel(plan, p.x_mm, p.y_mm, tile, p.tag.family, p.tag.id, p.tag.subtag, flipY)
        : "";
      return body + subOverlays + quietLabel;
    })
    .join("");

  const cutLines = cuts
    .map(
      (c) =>
        `<line x1="${c.x0_mm}" y1="${flipY(c.y0_mm)}" ` +
        `x2="${c.x1_mm}" y2="${flipY(c.y1_mm)}" stroke="${CUT_LINE}" stroke-width="0.25"/>`,
    )
    .join("");

  const cutCirclesSvg = circles
    .map(
      (c) =>
        `<circle cx="${c.cx_mm}" cy="${flipY(c.cy_mm)}" r="${c.radius_mm}" ` +
        `fill="none" stroke="${CUT_LINE}" stroke-width="0.25"/>`,
    )
    .join("");

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" ` +
    `width="100%" style="background:#fff;border:1px solid #999;display:block">` +
    `<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>` +
    renderRegistrationMarks(plan, flipY) +
    tagShapes +
    cutLines +
    cutCirclesSvg +
    `</svg>`
  );
}

/** Place a tag's bitmap PNG (`href`, one pixel per bit) into the `tile_mm`
 *  square whose top-left in SVG coords is `(x_mm, yTop_svg)`. The PNG's
 *  non-bit pixels are opaque white, so the quiet zone around the bits reads as
 *  blank paper — exactly as it prints. `image-rendering: pixelated` makes the
 *  browser upscale with nearest-neighbour, keeping the bit grid crisp. */
function renderTagImage(
  x_mm: number,
  yTop_svg: number,
  tile_mm: number,
  href: string,
): string {
  return (
    `<image x="${x_mm}" y="${yTop_svg}" width="${tile_mm}" height="${tile_mm}" ` +
    `preserveAspectRatio="none" style="image-rendering:pixelated" href="${href}"/>`
  );
}

function renderSubtagOverlays(
  subtag: TagSpec | undefined,
  parentFamilyName: string,
  parentX_mm: number,
  parentYTop_svg: number,
  parentTile_mm: number,
  images: TagImageProvider | undefined,
): string {
  if (!subtag) return "";
  const parentDef = getFamily(parentFamilyName);
  const cb = parentDef?.centerBlock;
  if (!cb) return "";

  const module_mm = parentTile_mm / parentDef.tileSize_px;
  const subTile_mm = cb.size * module_mm;
  const subX = parentX_mm + cb.col * module_mm;
  const subYTop = parentYTop_svg + cb.row * module_mm;

  const href = images?.imageHref(subtag.family, subtag.id) ?? null;
  let svg = href !== null
    ? renderTagImage(subX, subYTop, subTile_mm, href)
    : renderPlaceholder(subX, subYTop, subTile_mm, subtag.family, subtag.id);

  svg += renderSubtagOverlays(subtag.subtag, subtag.family, subX, subYTop, subTile_mm, images);
  return svg;
}

function renderPlaceholder(
  x_mm: number,
  yTop_svg: number,
  tile_mm: number,
  family: string,
  id: number,
): string {
  const labelSize = Math.max(1.2, tile_mm * 0.18);
  return (
    `<rect x="${x_mm}" y="${yTop_svg}" width="${tile_mm}" height="${tile_mm}" fill="#222"/>` +
    `<text x="${x_mm + tile_mm / 2}" y="${yTop_svg + tile_mm / 2}" ` +
    `font-size="${labelSize}" text-anchor="middle" dominant-baseline="central" ` +
    `fill="#fff" font-family="monospace">${escapeXml(`${family}#${id}`)}</text>`
  );
}

/** The "<family> #<id> · <size>" caption `render/pdf` sets inside each tag's
 *  bottom quiet-zone band when the "print tag info in the quiet zone" output
 *  option is on. Sized to ~0.6× the quiet-zone width and shrunk to fit the
 *  tag's own width; omitted when there is no quiet zone. Mirrors
 *  `drawQuietZoneLabel`. */
function renderQuietZoneLabel(
  plan: LayoutPlan,
  x_mm: number,
  y_mm: number,
  tile_mm: number,
  family: string,
  id: number,
  subtag: TagSpec | undefined,
  flipY: (y_mm: number) => number,
): string {
  const Q = plan.options.quietZone_mm;
  if (Q <= 0) return "";
  const mainText = tagCaptionLine(family, id, plan.tagSize_mm);
  const subText = svgSubtagChainLabel(subtag);
  const cx = x_mm + tile_mm / 2;

  if (subText) {
    const halfQ = Q * 0.3;
    let out = "";
    for (const [text, baselineFrac] of [[mainText, 0.52], [subText, 0.12]] as const) {
      const fontSize = Math.max(0.18, Math.min(halfQ, tile_mm / (0.6 * text.length)));
      out +=
        `<text x="${cx}" y="${flipY(y_mm - Q + Q * baselineFrac)}" ` +
        `font-size="${fontSize}" text-anchor="middle" fill="${QUIET_LABEL}" ` +
        `font-family="monospace">${escapeXml(text)}</text>`;
    }
    return out;
  }

  const fontSize_mm = Math.max(0.18, Math.min(Q * 0.6, tile_mm / (0.6 * mainText.length)));
  const baseline_mm = y_mm - Q + 0.28 * Q;
  return (
    `<text x="${cx}" y="${flipY(baseline_mm)}" ` +
    `font-size="${fontSize_mm}" text-anchor="middle" fill="${QUIET_LABEL}" ` +
    `font-family="monospace">${escapeXml(mainText)}</text>`
  );
}

function svgSubtagChainLabel(subtag: TagSpec | undefined): string {
  if (!subtag) return "";
  const parts: string[] = [];
  let s: TagSpec | undefined = subtag;
  while (s) {
    parts.push(`${s.family} #${s.id}`);
    s = s.subtag;
  }
  return "> " + parts.join(" > ");
}

/** Four corner registration crosshairs, one `pageMargin_mm` in from each
 *  corner — the same marks `render/pdf` draws. Each is two perpendicular
 *  2 mm strokes. Omitted when there is no page margin. */
function renderRegistrationMarks(
  plan: LayoutPlan,
  flipY: (y_mm: number) => number,
): string {
  const m = plan.options.pageMargin_mm;
  if (m <= 0) return "";
  const W = plan.paper.width_mm;
  const H = plan.paper.height_mm;
  const arm = 2;
  return ([
    [m, m],
    [W - m, m],
    [m, H - m],
    [W - m, H - m],
  ] as Array<[number, number]>)
    .map(([cx, cy]) => {
      const y = flipY(cy);
      return (
        `<line x1="${cx - arm}" y1="${y}" x2="${cx + arm}" y2="${y}" ` +
        `stroke="${REG_MARK}" stroke-width="0.2"/>` +
        `<line x1="${cx}" y1="${y - arm}" x2="${cx}" y2="${y + arm}" ` +
        `stroke="${REG_MARK}" stroke-width="0.2"/>`
      );
    })
    .join("");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
