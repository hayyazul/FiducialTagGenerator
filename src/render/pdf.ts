import {
  PDFDocument,
  type PDFFont,
  type PDFPage,
  StandardFonts,
  rgb,
} from "pdf-lib";
import type { BitsProvider } from "../families";
import type { LayoutPlan, Placement } from "../layout/types";
import { formatTagSize, tagCaptionLine } from "../tag-caption";

/**
 * Convert a LayoutPlan into a print-ready PDF byte stream.
 *
 * Output structure (default):
 *   Page 1     calibration sheet (100 mm reference square + tick rulers)
 *   Page 2..N  layout pages — one per plan.pageCount, in plan order
 *
 * With `printLabelsOnBack: true`, every layout page is followed by a "back"
 * page whose tag-info text is laid out mirrored along the page's vertical
 * axis (long-edge / horizontal-flip duplex). Printing the document
 * double-sided produces sheets where each cut tag carries family/id text
 * on its reverse.
 *
 * With `printLabelsInQuietZone: true`, the same caption is set inside each
 * tag's bottom quiet-zone band on the front, so the cut-out tag carries its
 * own identification without needing a duplex print.
 *
 * Tags are drawn as filled vector rectangles, one per black bit, never as
 * rasterized images. Cut lines, registration marks, and per-tag labels are
 * derived from the plan's geometry. The renderer never assumes contiguous
 * tag IDs — it iterates `plan.placements` directly.
 *
 * Coordinate handoff:
 *   - Plan: bottom-left origin, millimetres.
 *   - PDF: bottom-left origin, points (1 mm = 72/25.4 pt).
 *   - Bit grids: bits[row][col] with row 0 at the *top* of the tag, so we
 *     flip rows when emitting them into PDF y-up space.
 *
 * The renderer never throws when a tag is missing from the BitsProvider; it
 * draws a light-bordered placeholder square so the layout is still legible
 * (e.g. if the mosaic is still loading at render time).
 */
export interface RenderOptions {
  /** Emit a mirrored "back" page after every layout page, with each tag's
   *  family/id printed where the tag's reverse will land under long-edge
   *  duplex printing. Default: false. */
  printLabelsOnBack?: boolean;
  /** Set a one-line "family #id · size" caption inside each tag's bottom
   *  quiet-zone band on the front layout page, so the caption stays on the
   *  tag once it is cut out. Sized to the quiet zone (small — best at ~20 mm
   *  tags or larger). Default: false. */
  printLabelsInQuietZone?: boolean;
}

export async function renderPlan(
  plan: LayoutPlan,
  bits: BitsProvider,
  options: RenderOptions = {},
): Promise<Uint8Array> {
  const printBack = options.printLabelsOnBack ?? false;
  const labelInQuietZone = options.printLabelsInQuietZone ?? false;
  const doc = await PDFDocument.create();
  doc.setTitle(`AprilTag layout (${plan.placements.length} tags)`);
  doc.setProducer("AprilTagPDFGenerator");
  const font = await doc.embedFont(StandardFonts.Courier);
  const fontBold = await doc.embedFont(StandardFonts.CourierBold);

  drawCalibrationPage(doc, font);
  for (let p = 0; p < plan.pageCount; p++) {
    drawTagPage(doc, font, plan, p, bits, labelInQuietZone);
    if (printBack) drawBackPage(doc, font, fontBold, plan, p);
  }
  return doc.save();
}

const MM_TO_PT = 72 / 25.4;
const mm = (v: number): number => v * MM_TO_PT;

// -------------------- calibration page --------------------

function drawCalibrationPage(doc: PDFDocument, font: PDFFont): void {
  const PAGE_W_MM = 210;
  const PAGE_H_MM = 297;
  const REF_MM = 100;
  const HEADER_H_MM = 36;
  const page = doc.addPage([mm(PAGE_W_MM), mm(PAGE_H_MM)]);

  // Square centered horizontally, and centered in the space below the header.
  const x0_mm = (PAGE_W_MM - REF_MM) / 2;
  const y0_mm = (PAGE_H_MM - HEADER_H_MM - REF_MM) / 2;
  const sx = mm(x0_mm);
  const sy = mm(y0_mm);
  const side = mm(REF_MM);

  page.drawRectangle({
    x: sx,
    y: sy,
    width: side,
    height: side,
    borderColor: rgb(0, 0, 0),
    borderWidth: 0.6,
  });

  // Tick rulers on the left and bottom edges. Major (10 mm) ticks carry a
  // numeric label so the calibration page doubles as a ruler the user can
  // hold next to a printed tag.
  drawRuler(page, font, "bottom", x0_mm, y0_mm, REF_MM);
  drawRuler(page, font, "left", x0_mm, y0_mm, REF_MM);

  // Header.
  page.drawText("Print calibration", {
    x: mm(20),
    y: mm(PAGE_H_MM - 14),
    font,
    size: 18,
  });
  const headerLines = [
    "The square below is exactly 100 mm × 100 mm. Tick marks at 1 mm; numbered every 10 mm.",
    "If the printed square is the wrong size, disable 'Fit to page' / 'Scale' in your printer",
    "dialog and reprint. You can also use this page as a ruler to verify your printed tags.",
  ];
  for (let i = 0; i < headerLines.length; i++) {
    page.drawText(headerLines[i]!, {
      x: mm(20),
      y: mm(PAGE_H_MM - 22 - i * 4),
      font,
      size: 9,
      color: rgb(0.25, 0.25, 0.25),
    });
  }
}

function drawRuler(
  page: PDFPage,
  font: PDFFont,
  side: "left" | "bottom",
  x0_mm: number,
  y0_mm: number,
  span_mm: number,
): void {
  const labelSize = 8;
  for (let i = 0; i <= span_mm; i++) {
    const isMajor = i % 10 === 0;
    const isMid = !isMajor && i % 5 === 0;
    const lengthMm = isMajor ? 4 : isMid ? 2 : 1;
    const thickness = isMajor ? 0.5 : isMid ? 0.35 : 0.25;

    if (side === "bottom") {
      const tx = mm(x0_mm + i);
      const ty = mm(y0_mm);
      page.drawLine({
        start: { x: tx, y: ty },
        end: { x: tx, y: ty - mm(lengthMm) },
        thickness,
        color: rgb(0, 0, 0),
      });
      if (isMajor) {
        const label = String(i);
        const w = font.widthOfTextAtSize(label, labelSize);
        page.drawText(label, {
          x: tx - w / 2,
          y: ty - mm(lengthMm) - labelSize - 1,
          font,
          size: labelSize,
          color: rgb(0, 0, 0),
        });
      }
    } else {
      // left
      const tx = mm(x0_mm);
      const ty = mm(y0_mm + i);
      page.drawLine({
        start: { x: tx, y: ty },
        end: { x: tx - mm(lengthMm), y: ty },
        thickness,
        color: rgb(0, 0, 0),
      });
      if (isMajor) {
        const label = String(i);
        const w = font.widthOfTextAtSize(label, labelSize);
        // Vertically centre the digits on the tick (Courier digits sit on
        // the baseline; nudging by ~28 % of font size centres their
        // visual mass).
        page.drawText(label, {
          x: tx - mm(lengthMm) - w - 2,
          y: ty - labelSize * 0.28,
          font,
          size: labelSize,
          color: rgb(0, 0, 0),
        });
      }
    }
  }
}

// -------------------- layout page (front) --------------------

function drawTagPage(
  doc: PDFDocument,
  font: PDFFont,
  plan: LayoutPlan,
  pageIndex: number,
  bits: BitsProvider,
  labelInQuietZone: boolean,
): void {
  const page = doc.addPage([mm(plan.paper.width_mm), mm(plan.paper.height_mm)]);

  for (const c of plan.cutSegments) {
    if (c.page !== pageIndex) continue;
    page.drawLine({
      start: { x: mm(c.x0_mm), y: mm(c.y0_mm) },
      end: { x: mm(c.x1_mm), y: mm(c.y1_mm) },
      color: rgb(0.55, 0.55, 0.55),
      thickness: 0.25,
    });
  }

  drawRegistrationCorners(page, plan);

  for (const placement of plan.placements) {
    if (placement.page !== pageIndex) continue;
    drawTag(page, font, placement, plan, bits);
    if (labelInQuietZone) drawQuietZoneLabel(page, font, placement, plan);
  }

  drawPageFooter(page, font, plan, pageIndex, false);
}

/**
 * Set the tag's caption inside its bottom quiet-zone band on the front, so it
 * survives on the cut-out tag. The text occupies the lower part of the band
 * (~0.6× the band height), leaving the strip next to the bitmap clear; it is
 * shrunk to fit the tag's own width so it never reaches a neighbour's cut
 * line. This does eat into the otherwise-clear quiet zone, hence opt-in.
 */
function drawQuietZoneLabel(
  page: PDFPage,
  font: PDFFont,
  placement: Placement,
  plan: LayoutPlan,
): void {
  const Q_mm = plan.options.quietZone_mm;
  if (Q_mm <= 0) return;
  const tagSize_mm = plan.tagSize_mm;
  const text = tagCaptionLine(placement.tag.family, placement.tag.id, tagSize_mm);
  // Courier's advance width is 0.6 em per glyph, so a line of `n` glyphs is
  // `0.6 · size · n` wide; pick the largest size that is both ≤ 0.6× the
  // quiet-zone band and narrow enough to stay within the tag's width.
  const natural_mm = Q_mm * 0.6;
  const widthLimited_mm = tagSize_mm / (0.6 * text.length);
  const fontPt = Math.max(0.5, mm(Math.min(natural_mm, widthLimited_mm)));
  const w = font.widthOfTextAtSize(text, fontPt);
  const x = mm(placement.x_mm + tagSize_mm / 2) - w / 2;
  // Baseline ~28 % up from the cut line, putting the glyph body in the lower
  // ~60 % of the band.
  const y = mm(placement.y_mm - Q_mm + Q_mm * 0.28);
  page.drawText(text, { x, y, font, size: fontPt, color: rgb(0, 0, 0) });
}

function drawRegistrationCorners(page: PDFPage, plan: LayoutPlan): void {
  const margin = plan.options.pageMargin_mm;
  if (margin <= 0) return;
  const W = plan.paper.width_mm;
  const H = plan.paper.height_mm;
  for (const [cx, cy] of [
    [margin, margin],
    [W - margin, margin],
    [margin, H - margin],
    [W - margin, H - margin],
  ] as Array<[number, number]>) {
    drawRegistrationMark(page, cx, cy);
  }
}

function drawRegistrationMark(page: PDFPage, x_mm: number, y_mm: number): void {
  const armPt = mm(2);
  const x = mm(x_mm);
  const y = mm(y_mm);
  page.drawLine({
    start: { x: x - armPt, y },
    end: { x: x + armPt, y },
    thickness: 0.4,
    color: rgb(0.4, 0.4, 0.4),
  });
  page.drawLine({
    start: { x, y: y - armPt },
    end: { x, y: y + armPt },
    thickness: 0.4,
    color: rgb(0.4, 0.4, 0.4),
  });
}

function drawTag(
  page: PDFPage,
  font: PDFFont,
  placement: Placement,
  plan: LayoutPlan,
  bits: BitsProvider,
): void {
  const tagSize_mm = plan.tagSize_mm;
  const grid = bits.bits(placement.tag.family, placement.tag.id);

  if (grid === null) {
    page.drawRectangle({
      x: mm(placement.x_mm),
      y: mm(placement.y_mm),
      width: mm(tagSize_mm),
      height: mm(tagSize_mm),
      borderColor: rgb(0.5, 0.5, 0.5),
      borderWidth: 0.4,
    });
    return;
  }

  const edge = grid.length;
  if (edge === 0) return;
  const cell_mm = tagSize_mm / edge;
  const cell_pt = mm(cell_mm);
  // Tiny overlap (in points) to suppress hairline seams when the PDF is
  // rasterized at low DPI by viewers/printers.
  const overlap_pt = 0.05;

  for (let row = 0; row < edge; row++) {
    const r = grid[row]!;
    for (let col = 0; col < edge; col++) {
      if (!r[col]) continue;
      // bits[0] is the top row of the bitmap; PDF y increases upward, so
      // flip the row index when computing y.
      const x_mm_local = placement.x_mm + col * cell_mm;
      const y_mm_local = placement.y_mm + (edge - 1 - row) * cell_mm;
      page.drawRectangle({
        x: mm(x_mm_local),
        y: mm(y_mm_local),
        width: cell_pt + overlap_pt,
        height: cell_pt + overlap_pt,
        color: rgb(0, 0, 0),
      });
    }
  }

  // Per-tag label below the bitmap, in the cut-margin band. Sized to fit the
  // cut margin; with the default 0.5 mm cut margin the label is microscopic
  // by design — widening the cut margin (Advanced options) makes it legible.
  const C_mm = plan.options.cutMargin_mm;
  if (C_mm > 0) {
    const fontPt = Math.max(0.5, mm(C_mm * 0.7));
    const label = `${placement.tag.family} #${placement.tag.id}`;
    const textWidth = font.widthOfTextAtSize(label, fontPt);
    const tagCenter_pt = mm(placement.x_mm + tagSize_mm / 2);
    const baseline_pt =
      mm(placement.y_mm - plan.options.quietZone_mm - C_mm) + mm(C_mm * 0.15);
    page.drawText(label, {
      x: tagCenter_pt - textWidth / 2,
      y: baseline_pt,
      font,
      size: fontPt,
      color: rgb(0.3, 0.3, 0.3),
    });
  }
}

// -------------------- back page (mirrored labels) --------------------

function drawBackPage(
  doc: PDFDocument,
  font: PDFFont,
  fontBold: PDFFont,
  plan: LayoutPlan,
  pageIndex: number,
): void {
  const W_mm = plan.paper.width_mm;
  const page = doc.addPage([mm(W_mm), mm(plan.paper.height_mm)]);

  // Cut lines mirrored along the vertical axis: x' = W − x. y is unchanged.
  for (const c of plan.cutSegments) {
    if (c.page !== pageIndex) continue;
    page.drawLine({
      start: { x: mm(W_mm - c.x0_mm), y: mm(c.y0_mm) },
      end: { x: mm(W_mm - c.x1_mm), y: mm(c.y1_mm) },
      color: rgb(0.55, 0.55, 0.55),
      thickness: 0.25,
    });
  }
  // Registration marks: corner positions are symmetric in x (margin /
  // W−margin), so the same set of points is correct on the back.
  drawRegistrationCorners(page, plan);

  // For every front placement, draw a back-side label at its mirrored
  // position. The tag bounds on the back are:
  //   x_back = W − x_front − tagSize     (tag-size wide)
  //   y_back = y_front                    (unchanged)
  const tagSize_mm = plan.tagSize_mm;
  for (const placement of plan.placements) {
    if (placement.page !== pageIndex) continue;
    const x_back_mm = W_mm - placement.x_mm - tagSize_mm;
    const y_back_mm = placement.y_mm;
    drawBackLabel(page, font, fontBold, placement, x_back_mm, y_back_mm, tagSize_mm);
  }

  drawPageFooter(page, font, plan, pageIndex, true);
}

function drawBackLabel(
  page: PDFPage,
  font: PDFFont,
  fontBold: PDFFont,
  placement: Placement,
  x_mm: number,
  y_mm: number,
  size_mm: number,
): void {
  // Faint border so the user can see the bounds of each tag on the back side
  // (no bitmap to give it shape).
  page.drawRectangle({
    x: mm(x_mm),
    y: mm(y_mm),
    width: mm(size_mm),
    height: mm(size_mm),
    borderColor: rgb(0.75, 0.75, 0.75),
    borderWidth: 0.2,
  });

  const lines: Array<{ text: string; bold: boolean }> = [
    { text: placement.tag.family, bold: false },
    { text: `#${placement.tag.id}`, bold: true },
    { text: formatTagSize(size_mm), bold: false },
  ];

  // Each line takes ~18 % of tag size in font height; line spacing is 1.4×
  // the line size. Centre the resulting block in the tag's bounding box.
  const fontPt = mm(size_mm * 0.18);
  const lineHeight = fontPt * 1.4;
  const blockHeight = lineHeight * lines.length;
  const tagCenterY = mm(y_mm + size_mm / 2);
  const tagCenterX = mm(x_mm + size_mm / 2);
  // Baseline of the topmost line.
  const topBaseline = tagCenterY + blockHeight / 2 - fontPt;

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    const f = ln.bold ? fontBold : font;
    const w = f.widthOfTextAtSize(ln.text, fontPt);
    page.drawText(ln.text, {
      x: tagCenterX - w / 2,
      y: topBaseline - i * lineHeight,
      font: f,
      size: fontPt,
      color: rgb(0, 0, 0),
    });
  }
}

// -------------------- footer --------------------

function drawPageFooter(
  page: PDFPage,
  font: PDFFont,
  plan: LayoutPlan,
  pageIndex: number,
  isBack: boolean,
): void {
  const pagePlacements = plan.placements.filter((p) => p.page === pageIndex);
  if (pagePlacements.length === 0) return;
  const families = [...new Set(pagePlacements.map((p) => p.tag.family))];
  const ids = pagePlacements.map((p) => p.tag.id).slice().sort((a, b) => a - b);
  const contiguous =
    ids.length > 0 &&
    ids.every((id, i) => i === 0 || id === ids[i - 1]! + 1);
  const idLabel =
    pagePlacements.length === 1
      ? `#${pagePlacements[0]!.tag.id}`
      : contiguous
        ? `#${ids[0]}..${ids[ids.length - 1]}`
        : `${pagePlacements.length} tags`;
  const Q = plan.options.quietZone_mm;
  const C = plan.options.cutMargin_mm;
  const cell = plan.tagSize_mm + 2 * (Q + C);
  const parts = [
    `Page ${pageIndex + 1}/${plan.pageCount}${isBack ? " (back)" : ""}`,
    `${families.join(",")} ${idLabel}`,
    `tag ${plan.tagSize_mm} mm, cell ${cell.toFixed(2)} mm`,
  ];
  page.drawText(parts.join("   "), {
    x: mm(5),
    y: mm(3),
    font,
    size: 7,
    color: rgb(0.35, 0.35, 0.35),
  });
}
