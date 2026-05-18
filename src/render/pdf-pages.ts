/**
 * PDF-specific pages that don't go through `composePage`:
 *
 *  - `drawCalibrationPage` — the 100 mm reference square with tick
 *    rulers. Used as page 1 so the user can verify their printer's
 *    scaling before trusting tag sizes.
 *  - `drawBackPage` — the duplex back-label sheet. Every front
 *    placement maps to a mirrored label block on the back so a
 *    long-edge double-sided print yields cut tags whose reverse carries
 *    family / id / size text.
 *  - `drawPageFooter` — small footer text on every layout / back page.
 *
 * Each function takes a `PdfCanvas` and emits drawing calls through
 * its `Canvas` interface, so the underlying pdf-lib `PDFPage` is
 * touched only via the canvas — no separate PDF-coordinate code path
 * remains in this module.
 */
import { formatTagSize, subtagSizeLine } from "../tag-caption";
import type { LayoutPlan, Placement, SubtagLevel } from "../layout/types";
import { BLACK, type Canvas, gray } from "./canvas";

const CALIBRATION_SIZE_MM = 100;
const CALIBRATION_HEADER_HEIGHT_MM = 36;

const CUT_LINE = gray(0.55);
const REG_MARK = gray(0.4);
const BACK_BORDER = gray(0.75);
const FOOTER_TEXT = gray(0.35);

const CUT_LINE_WIDTH = 0.25;
const REG_MARK_WIDTH = 0.2;
const BACK_BORDER_WIDTH = 0.2;

/** A 100 × 100 mm reference square plus tick rulers along its left and
 *  bottom edges, with a small header explaining how to use it. */
export function drawCalibrationPage(canvas: Canvas): void {
  const PAGE_W = canvas.page.width_mm;
  const PAGE_H = canvas.page.height_mm;
  const REF = CALIBRATION_SIZE_MM;

  const x0 = (PAGE_W - REF) / 2;
  const y0 = (PAGE_H - CALIBRATION_HEADER_HEIGHT_MM - REF) / 2;

  canvas.drawRect({
    x_mm: x0,
    y_mm: y0,
    width_mm: REF,
    height_mm: REF,
    stroke: BLACK,
    strokeWidth_mm: 0.6,
  });

  drawRuler(canvas, "bottom", x0, y0, REF);
  drawRuler(canvas, "left", x0, y0, REF);

  canvas.drawText({
    text: "Print calibration",
    x_mm: 20,
    y_mm: PAGE_H - 14,
    fontSize_mm: ptToMm(18),
    font: "mono",
    fill: BLACK,
  });
  const headerLines = [
    "The square below is exactly 100 mm × 100 mm. Tick marks at 1 mm; numbered every 10 mm.",
    "If the printed square is the wrong size, disable 'Fit to page' / 'Scale' in your printer",
    "dialog and reprint. You can also use this page as a ruler to verify your printed tags.",
  ];
  const headerFont_mm = ptToMm(9);
  for (let i = 0; i < headerLines.length; i++) {
    canvas.drawText({
      text: headerLines[i]!,
      x_mm: 20,
      y_mm: PAGE_H - 22 - i * 4,
      fontSize_mm: headerFont_mm,
      font: "mono",
      fill: gray(0.25),
    });
  }
}

function drawRuler(
  canvas: Canvas,
  side: "left" | "bottom",
  x0_mm: number,
  y0_mm: number,
  span_mm: number,
): void {
  const labelFont_mm = ptToMm(8);
  for (let i = 0; i <= span_mm; i++) {
    const isMajor = i % 10 === 0;
    const isMid = !isMajor && i % 5 === 0;
    const length_mm = isMajor ? 4 : isMid ? 2 : 1;
    const thickness_mm = isMajor ? 0.5 : isMid ? 0.35 : 0.25;

    if (side === "bottom") {
      const tx = x0_mm + i;
      canvas.drawLine({
        x0_mm: tx,
        y0_mm: y0_mm,
        x1_mm: tx,
        y1_mm: y0_mm - length_mm,
        stroke: BLACK,
        strokeWidth_mm: thickness_mm,
      });
      if (isMajor) {
        canvas.drawText({
          text: String(i),
          x_mm: tx,
          y_mm: y0_mm - length_mm - labelFont_mm - ptToMm(1),
          fontSize_mm: labelFont_mm,
          font: "mono",
          fill: BLACK,
          anchor: "middle",
        });
      }
    } else {
      const ty = y0_mm + i;
      canvas.drawLine({
        x0_mm: x0_mm,
        y0_mm: ty,
        x1_mm: x0_mm - length_mm,
        y1_mm: ty,
        stroke: BLACK,
        strokeWidth_mm: thickness_mm,
      });
      if (isMajor) {
        canvas.drawText({
          text: String(i),
          x_mm: x0_mm - length_mm - ptToMm(2),
          y_mm: ty - labelFont_mm * 0.28,
          fontSize_mm: labelFont_mm,
          font: "mono",
          fill: BLACK,
          anchor: "end",
        });
      }
    }
  }
}

/** The mirrored back-label sheet for `pageIndex`. Cut lines, cut
 *  circles, and registration marks are drawn at their front positions
 *  reflected across the page's vertical axis; every placement on the
 *  front becomes a label block on the back at the mirrored position. */
export function drawBackPage(canvas: Canvas, plan: LayoutPlan, pageIndex: number): void {
  const W = plan.paper.width_mm;
  const isCircular = plan.cutCircles.length > 0;

  // Background — keep the page white so the footer / labels read.
  canvas.drawRect({
    x_mm: 0,
    y_mm: 0,
    width_mm: W,
    height_mm: plan.paper.height_mm,
    fill: { r: 1, g: 1, b: 1 },
  });

  for (const c of plan.cutSegments) {
    if (c.page !== pageIndex) continue;
    canvas.drawLine({
      x0_mm: W - c.x0_mm,
      y0_mm: c.y0_mm,
      x1_mm: W - c.x1_mm,
      y1_mm: c.y1_mm,
      stroke: CUT_LINE,
      strokeWidth_mm: CUT_LINE_WIDTH,
    });
  }
  for (const c of plan.cutCircles) {
    if (c.page !== pageIndex) continue;
    canvas.drawCircle({
      cx_mm: W - c.cx_mm,
      cy_mm: c.cy_mm,
      radius_mm: c.radius_mm,
      stroke: CUT_LINE,
      strokeWidth_mm: CUT_LINE_WIDTH,
    });
  }

  // Registration marks: their corner positions are symmetric in x so
  // the same set is correct on the back.
  drawBackRegistrationCorners(canvas, plan);

  const tile_mm = plan.tileSize_mm;
  for (const placement of plan.placements) {
    if (placement.page !== pageIndex) continue;
    const x_back = W - placement.x_mm - tile_mm;
    const y_back = placement.y_mm;
    drawBackLabel(canvas, placement, x_back, y_back, tile_mm, plan.tagSize_mm, plan.subtagLevels, isCircular);
  }
}

function drawBackRegistrationCorners(canvas: Canvas, plan: LayoutPlan): void {
  const m = plan.options.pageMargin_mm;
  if (m <= 0) return;
  const W = plan.paper.width_mm;
  const H = plan.paper.height_mm;
  const arm = 2;
  for (const [cx, cy] of [
    [m, m],
    [W - m, m],
    [m, H - m],
    [W - m, H - m],
  ] as Array<[number, number]>) {
    canvas.drawLine({
      x0_mm: cx - arm, y0_mm: cy, x1_mm: cx + arm, y1_mm: cy,
      stroke: REG_MARK, strokeWidth_mm: REG_MARK_WIDTH,
    });
    canvas.drawLine({
      x0_mm: cx, y0_mm: cy - arm, x1_mm: cx, y1_mm: cy + arm,
      stroke: REG_MARK, strokeWidth_mm: REG_MARK_WIDTH,
    });
  }
}

function drawBackLabel(
  canvas: Canvas,
  placement: Placement,
  x_mm: number,
  y_mm: number,
  tile_mm: number,
  tagSize_mm: number,
  subtagLevels: SubtagLevel[],
  isCircular: boolean,
): void {
  // Faint outline so the user can see the bounds of each tag on the
  // back (there's no bitmap to give it shape). Circular tags get a
  // matching circle.
  if (isCircular) {
    const radius = tile_mm / 2;
    canvas.drawCircle({
      cx_mm: x_mm + radius,
      cy_mm: y_mm + radius,
      radius_mm: radius,
      stroke: BACK_BORDER,
      strokeWidth_mm: BACK_BORDER_WIDTH,
    });
  } else {
    canvas.drawRect({
      x_mm,
      y_mm,
      width_mm: tile_mm,
      height_mm: tile_mm,
      stroke: BACK_BORDER,
      strokeWidth_mm: BACK_BORDER_WIDTH,
    });
  }

  const lines: Array<{ text: string; bold: boolean }> = [
    { text: placement.tag.family, bold: false },
    { text: `#${placement.tag.id}`, bold: true },
    { text: formatTagSize(tagSize_mm), bold: false },
  ];
  let sub = placement.tag.subtag;
  let levelIdx = 0;
  while (sub) {
    const lvl = subtagLevels[levelIdx];
    const size = lvl ? formatTagSize(lvl.tagSize_mm) : "";
    lines.push({
      text: `> ${sub.family} #${sub.id}${size ? ` · ${size}` : ""}`,
      bold: false,
    });
    sub = sub.subtag;
    levelIdx++;
  }

  // Pick a font size that lets the whole block fit vertically and no
  // line overflow horizontally. Floor at ~1.5 mm so it stays legible.
  const maxGlyphs = Math.max(1, ...lines.map((l) => l.text.length));
  let fontSize_mm = tile_mm * Math.min(
    0.18,
    0.85 / (1.4 * lines.length),
    0.9 / (0.6 * maxGlyphs),
  );
  fontSize_mm = Math.max(fontSize_mm, 1.5);
  const lineHeight = fontSize_mm * 1.4;
  const blockHeight = lineHeight * lines.length;
  const tagCenterY = y_mm + tile_mm / 2;
  const tagCenterX = x_mm + tile_mm / 2;
  // Baseline of the topmost line.
  const topBaseline = tagCenterY + blockHeight / 2 - fontSize_mm;

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    canvas.drawText({
      text: ln.text,
      x_mm: tagCenterX,
      y_mm: topBaseline - i * lineHeight,
      fontSize_mm,
      font: "mono",
      weight: ln.bold ? "bold" : "regular",
      fill: BLACK,
      anchor: "middle",
    });
  }
}

/** Small grey footer on every page that carries page index, the
 *  families and ids on this page, the canonical tag size, and the
 *  printed cell pitch (tile + 2 × quiet zone). */
export function drawPageFooter(
  canvas: Canvas,
  plan: LayoutPlan,
  pageIndex: number,
  isBack: boolean,
): void {
  const pagePlacements = plan.placements.filter((p) => p.page === pageIndex);
  if (pagePlacements.length === 0) return;
  const families = [...new Set(pagePlacements.map((p) => p.tag.family))];
  const ids = pagePlacements.map((p) => p.tag.id).slice().sort((a, b) => a - b);
  const contiguous =
    ids.length > 0 && ids.every((id, i) => i === 0 || id === ids[i - 1]! + 1);
  const idLabel =
    pagePlacements.length === 1
      ? `#${pagePlacements[0]!.tag.id}`
      : contiguous
        ? `#${ids[0]}..${ids[ids.length - 1]}`
        : `${pagePlacements.length} tags`;
  const Q = plan.options.quietZone_mm;
  const cell = plan.tileSize_mm + 2 * Q;
  const parts = [
    `Page ${pageIndex + 1}/${plan.pageCount}${isBack ? " (back)" : ""}`,
    `${families.join(",")} ${idLabel}`,
    `tag ${plan.tagSize_mm} mm, cell ${cell.toFixed(2)} mm`,
  ];
  const subLine = subtagSizeLine(plan.subtagLevels);
  if (subLine) parts.push(subLine);

  canvas.drawText({
    text: parts.join("   "),
    x_mm: 5,
    y_mm: 3,
    fontSize_mm: ptToMm(7),
    font: "mono",
    fill: FOOTER_TEXT,
  });
}

/** Convenience for layout values that the legacy code expressed in
 *  points; keeps numerical output identical to the pre-refactor PDF. */
function ptToMm(pt: number): number {
  return (pt * 25.4) / 72;
}
