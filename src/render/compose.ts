/**
 * Unified renderer pass. Walks one page of a `LayoutPlan` and emits
 * drawing calls to a `Canvas`. Every output format (SVG preview, PDF,
 * PNG, per-tag export) consumes this same function via its backend's
 * `Canvas` implementation; the renderer has no opinion about which
 * backend it is drawing into.
 *
 * Coordinate space throughout is canvas-space: millimetres,
 * bottom-left origin (matches `LayoutPlan`).
 *
 * Drawing order matters — later elements paint on top of earlier ones:
 *   1. Page background (white).
 *   2. Registration corner marks.
 *   3. All markers (with recursive sub-tags).
 *   4. All quiet-zone captions.
 *   5. Cut lines / cut circles.
 * Captions are deliberately a separate pass *after* every marker, not
 * interleaved with the placement that owns them. Without that
 * separation, dense hex-packed circle families produce a neighbour's
 * tile corner overhanging this tag's quiet zone, and the neighbour's
 * rasterised `<image>` (opaque white in unprinted cells) paints over
 * the curved caption emitted moments earlier. Markers-then-captions
 * keeps every caption on top of every marker regardless of spatial
 * overlap. The PDF renderer is immune to this in vector mode (no
 * opaque white fill), but the same ordering is harmless for it.
 */
import { BitGridMarker, type Family, getFamily, type MarkerProvider } from "../families";
import type { LayoutPlan, SubtagLevel, TagSpec } from "../layout/types";
import { formatTagSize, tagCaptionLine } from "../tag-caption";
import type { Canvas, Color } from "./canvas";
import { BLACK, WHITE, gray } from "./canvas";

export interface ComposeOptions {
  /** Mirror the PDF's "print tag info in the quiet zone" output option:
   *  draw the "family #id · size" caption inside each tag's bottom
   *  quiet-zone band (or curved along the inside of a circular tag's
   *  quiet ring). Default: false. */
  printLabelsInQuietZone?: boolean;
}

// Colours shared with the legacy renderers. Defined here so SVG and PDF
// outputs agree on every shade — the SVG preview's whole job is to
// match what the PDF prints.
const CUT_LINE: Color = gray(0.55);
const REG_MARK: Color = gray(0.4);
const PLACEHOLDER_BG: Color = gray(0x22 / 255);
const PLACEHOLDER_FG: Color = WHITE;
const CUT_LINE_WIDTH = 0.25;
/** Dashed pattern (mm) for all cut lines and cut circles. Short dashes
 *  read as "cut here" rather than "border" — a solid border would look
 *  like part of the tag. */
const CUT_LINE_DASH: readonly [number, number] = [1.5, 1];
const REG_MARK_WIDTH = 0.2;
const REG_MARK_ARM = 2;

export function composePage(
  plan: LayoutPlan,
  pageIndex: number,
  canvas: Canvas,
  markers: MarkerProvider,
  opts: ComposeOptions = {},
): void {
  drawPageBackground(canvas);
  drawRegistrationMarks(canvas, plan);

  for (const p of plan.placements) {
    if (p.page !== pageIndex) continue;
    drawMarkerAt(canvas, markers, p.tag, p.x_mm, p.y_mm, plan.tileSize_mm);
  }

  if (opts.printLabelsInQuietZone) {
    for (const p of plan.placements) {
      if (p.page !== pageIndex) continue;
      drawQuietZoneCaption(canvas, plan, p.tag, p.x_mm, p.y_mm);
    }
  }

  for (const c of plan.cutSegments) {
    if (c.page !== pageIndex) continue;
    canvas.drawLine({
      x0_mm: c.x0_mm,
      y0_mm: c.y0_mm,
      x1_mm: c.x1_mm,
      y1_mm: c.y1_mm,
      stroke: CUT_LINE,
      strokeWidth_mm: CUT_LINE_WIDTH,
      dash_mm: CUT_LINE_DASH,
    });
  }
  for (const c of plan.cutCircles) {
    if (c.page !== pageIndex) continue;
    canvas.drawCircle({
      cx_mm: c.cx_mm,
      cy_mm: c.cy_mm,
      radius_mm: c.radius_mm,
      stroke: CUT_LINE,
      strokeWidth_mm: CUT_LINE_WIDTH,
      dash_mm: CUT_LINE_DASH,
    });
  }
}

function drawPageBackground(canvas: Canvas): void {
  canvas.drawRect({
    x_mm: 0,
    y_mm: 0,
    width_mm: canvas.page.width_mm,
    height_mm: canvas.page.height_mm,
    fill: WHITE,
  });
}

/** Four corner crosshairs, one `pageMargin_mm` in from each corner.
 *  Each mark is two perpendicular `2 mm` strokes. Omitted when there is
 *  no page margin. */
function drawRegistrationMarks(canvas: Canvas, plan: LayoutPlan): void {
  const m = plan.options.pageMargin_mm;
  if (m <= 0) return;
  const W = plan.paper.width_mm;
  const H = plan.paper.height_mm;
  const arm = REG_MARK_ARM;
  for (const [cx, cy] of [
    [m, m],
    [W - m, m],
    [m, H - m],
    [W - m, H - m],
  ] as Array<[number, number]>) {
    canvas.drawLine({
      x0_mm: cx - arm,
      y0_mm: cy,
      x1_mm: cx + arm,
      y1_mm: cy,
      stroke: REG_MARK,
      strokeWidth_mm: REG_MARK_WIDTH,
    });
    canvas.drawLine({
      x0_mm: cx,
      y0_mm: cy - arm,
      x1_mm: cx,
      y1_mm: cy + arm,
      stroke: REG_MARK,
      strokeWidth_mm: REG_MARK_WIDTH,
    });
  }
}

/** Recursive marker draw: outer tag first, then any nested sub-tag
 *  inside its parent's center block. The recursion lives here (rather
 *  than the per-backend code) so every format gets identical nesting
 *  behaviour. When a sub-tag exists, the parent's center-block cells
 *  are masked out before reaching the canvas so vector backends (PDF)
 *  don't paint cells that the sub-tag will immediately cover. SVG
 *  backends are unaffected — the sub-tag's PNG would have covered the
 *  parent's PNG either way — but the cache key differs so the masked
 *  and unmasked versions don't collide. */
function drawMarkerAt(
  canvas: Canvas,
  markers: MarkerProvider,
  tag: TagSpec,
  x_mm: number,
  y_mm: number,
  size_mm: number,
): void {
  const def: Family | undefined = getFamily(tag.family);
  const marker = markers.getMarker(tag.family, tag.id);

  if (marker === null) {
    drawPlaceholder(canvas, x_mm, y_mm, size_mm, tag.family, tag.id);
  } else {
    // When a sub-marker will overlay the parent's centre block, mask
    // those cells out first so vector backends (PDF) don't paint them
    // beneath the sub-marker. Bit-grid markers carry a fast path; any
    // future marker type without one would need an opaque overlay rect
    // emitted here. Today every Marker is a BitGridMarker.
    const cb = tag.subtag ? def?.geometry.centerBlock : undefined;
    const drawMarker =
      cb && marker instanceof BitGridMarker
        ? marker.withMaskedCenterBlock(cb)
        : marker;
    drawMarker.draw(canvas, { x_mm, y_mm, size_mm });
  }

  if (!tag.subtag || !def?.geometry.centerBlock) return;
  const cb = def.geometry.centerBlock;
  const cell_mm = size_mm / def.geometry.edge;
  const subSize_mm = cb.size * cell_mm;
  // centerBlock is given with row 0 at the *top* of the parent tile; in
  // canvas-space (y-up) we measure rows down from the top edge.
  const subX = x_mm + cb.col * cell_mm;
  const subY = y_mm + size_mm - (cb.row + cb.size) * cell_mm;
  drawMarkerAt(canvas, markers, tag.subtag, subX, subY, subSize_mm);
}

function drawPlaceholder(
  canvas: Canvas,
  x_mm: number,
  y_mm: number,
  tile_mm: number,
  family: string,
  id: number,
): void {
  canvas.drawRect({
    x_mm,
    y_mm,
    width_mm: tile_mm,
    height_mm: tile_mm,
    fill: PLACEHOLDER_BG,
  });
  const labelSize = Math.max(1.2, tile_mm * 0.18);
  canvas.drawText({
    text: `${family}#${id}`,
    x_mm: x_mm + tile_mm / 2,
    y_mm: y_mm + tile_mm / 2,
    fontSize_mm: labelSize,
    font: "mono",
    fill: PLACEHOLDER_FG,
    anchor: "middle",
    verticalAnchor: "middle",
  });
}

/** Linear caption for square tags / curved caption for circular tags,
 *  set inside the tag's quiet-zone band. No-op when there is no quiet
 *  zone (nowhere to draw). */
function drawQuietZoneCaption(
  canvas: Canvas,
  plan: LayoutPlan,
  tag: TagSpec,
  x_mm: number,
  y_mm: number,
): void {
  const Q = plan.options.quietZone_mm;
  if (Q <= 0) return;
  if (plan.cutCircles.length > 0) {
    drawCircularQuietZoneCaption(canvas, plan, tag, x_mm, y_mm);
    return;
  }

  const tile_mm = plan.tileSize_mm;
  const mainText = tagCaptionLine(tag.family, tag.id, plan.tagSize_mm);
  const subText = subtagChainLabel(tag.subtag, plan.subtagLevels);
  const cx = x_mm + tile_mm / 2;

  if (subText) {
    const halfQ = Q * 0.3;
    for (const [text, baselineFrac] of [
      [mainText, 0.52],
      [subText, 0.12],
    ] as const) {
      const fontSize_mm = Math.max(
        0.18,
        Math.min(halfQ, tile_mm / (0.6 * text.length)),
      );
      canvas.drawText({
        text,
        x_mm: cx,
        y_mm: y_mm - Q + baselineFrac * Q,
        fontSize_mm,
        font: "mono",
        fill: BLACK,
        anchor: "middle",
      });
    }
    return;
  }

  const fontSize_mm = Math.max(
    0.18,
    Math.min(Q * 0.6, tile_mm / (0.6 * mainText.length)),
  );
  canvas.drawText({
    text: mainText,
    x_mm: cx,
    y_mm: y_mm - Q + 0.28 * Q,
    fontSize_mm,
    font: "mono",
    fill: BLACK,
    anchor: "middle",
  });
}

function drawCircularQuietZoneCaption(
  canvas: Canvas,
  plan: LayoutPlan,
  tag: TagSpec,
  x_mm: number,
  y_mm: number,
): void {
  const Q = plan.options.quietZone_mm;
  const tile_mm = plan.tileSize_mm;
  const cutRadius =
    plan.cutCircles[0]?.radius_mm ?? tile_mm / 2 + Q;
  const cx = x_mm + tile_mm / 2;
  const cy = y_mm + tile_mm / 2;

  const mainText = tagCaptionLine(tag.family, tag.id, plan.tagSize_mm);
  const subText = subtagChainLabel(tag.subtag, plan.subtagLevels);
  const maxArc_deg = 120;

  if (subText) {
    const outerRadius = cutRadius - Q * 0.3;
    const innerRadius = cutRadius - Q * 0.8;
    const maxFontH = Q * 0.35;
    for (const [text, radius] of [
      [mainText, outerRadius],
      [subText, innerRadius],
    ] as const) {
      const maxFontArc =
        (radius * maxArc_deg * Math.PI) / 180 / (text.length * 0.6);
      const fontSize_mm = Math.max(0.18, Math.min(maxFontH, maxFontArc));
      canvas.drawCurvedText({
        text,
        cx_mm: cx,
        cy_mm: cy,
        radius_mm: radius,
        centerAngle_deg: -90,
        direction: "cw",
        maxArc_deg,
        fontSize_mm,
        font: "mono",
        fill: BLACK,
      });
    }
    return;
  }

  const textRadius = cutRadius - Q * 0.5;
  const maxFontH = Q * 0.7;
  const maxFontArc =
    (textRadius * maxArc_deg * Math.PI) / 180 / (mainText.length * 0.6);
  const fontSize_mm = Math.max(0.18, Math.min(maxFontH, maxFontArc));
  canvas.drawCurvedText({
    text: mainText,
    cx_mm: cx,
    cy_mm: cy,
    radius_mm: textRadius,
    centerAngle_deg: -90,
    direction: "cw",
    maxArc_deg,
    fontSize_mm,
    font: "mono",
    fill: BLACK,
  });
}

function subtagChainLabel(
  subtag: TagSpec | undefined,
  levels: SubtagLevel[],
): string {
  if (!subtag) return "";
  const parts: string[] = [];
  let s: TagSpec | undefined = subtag;
  let i = 0;
  while (s) {
    const lvl = levels[i];
    const size = lvl ? ` · ${formatTagSize(lvl.tagSize_mm)}` : "";
    parts.push(`> ${s.family} #${s.id}${size}`);
    s = s.subtag;
    i++;
  }
  return parts.join("  ");
}
