import {
  PDFDocument,
  type PDFFont,
  type PDFPage,
  StandardFonts,
  rgb,
} from "pdf-lib";
import type { BitsProvider } from "../families";
import type { LayoutPlan, Placement } from "../layout/types";

/**
 * Convert a LayoutPlan into a print-ready PDF byte stream.
 *
 * Output structure:
 *   Page 1     calibration sheet (100 mm reference square)
 *   Page 2..N  layout pages — one per plan.pageCount, in order
 *
 * Tags are drawn as filled vector rectangles, one per black bit, never as
 * rasterized images. Cut lines, registration marks, and per-tag labels are
 * derived from the plan's geometry.
 *
 * Coordinate handoff:
 *   - The plan uses bottom-left origin and millimetre units.
 *   - PDF uses bottom-left origin and points (1 mm = 72/25.4 pt).
 *   - bit grids are indexed [row][col] with row 0 at the *top* of the tag,
 *     so we flip rows when emitting them into PDF y-up space.
 *
 * The renderer never fails when a tag is missing from the BitsProvider; it
 * draws a light-bordered placeholder square so the layout is still legible
 * (e.g. if the mosaic is still loading).
 */
export async function renderPlan(
  plan: LayoutPlan,
  bits: BitsProvider,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`AprilTag layout (${plan.placements.length} tags)`);
  doc.setProducer("AprilTagPDFGenerator");
  const font = await doc.embedFont(StandardFonts.Courier);

  drawCalibrationPage(doc, font);
  for (let p = 0; p < plan.pageCount; p++) {
    drawTagPage(doc, font, plan, p, bits);
  }
  return doc.save();
}

const MM_TO_PT = 72 / 25.4;
const mm = (v: number): number => v * MM_TO_PT;

function drawCalibrationPage(doc: PDFDocument, font: PDFFont): void {
  // Calibration sheet is always A4 portrait — independent of the plan's
  // paper choice — because it is purely a "did your printer scale?" check.
  const PAGE_W_MM = 210;
  const PAGE_H_MM = 297;
  const REF_MM = 100;
  const page = doc.addPage([mm(PAGE_W_MM), mm(PAGE_H_MM)]);

  const x0_mm = 30;
  const y0_mm = PAGE_H_MM - 50 - REF_MM; // 50 mm header band
  const x = mm(x0_mm);
  const y = mm(y0_mm);
  const side = mm(REF_MM);

  page.drawRectangle({
    x,
    y,
    width: side,
    height: side,
    borderColor: rgb(0, 0, 0),
    borderWidth: 0.6,
  });
  // 10 mm tick marks along the top and right edges of the square.
  for (let i = 0; i <= 10; i++) {
    const tx = x + i * mm(10);
    page.drawLine({
      start: { x: tx, y: y + side },
      end: { x: tx, y: y + side + mm(2) },
      thickness: 0.4,
    });
    const ty = y + i * mm(10);
    page.drawLine({
      start: { x: x + side, y: ty },
      end: { x: x + side + mm(2), y: ty },
      thickness: 0.4,
    });
  }
  page.drawText("Print calibration", {
    x: mm(x0_mm),
    y: mm(PAGE_H_MM - 25),
    font,
    size: 18,
  });
  page.drawText(
    "The square below is exactly 100 mm × 100 mm. Measure it with a ruler before",
    { x: mm(x0_mm), y: mm(PAGE_H_MM - 35), font, size: 10 },
  );
  page.drawText(
    "trusting the layout pages. If it is wrong, disable 'Fit to page' / 'Scale to fit'",
    { x: mm(x0_mm), y: mm(PAGE_H_MM - 39), font, size: 10 },
  );
  page.drawText(
    "in your printer dialog and reprint. Tick marks at 10 mm intervals.",
    { x: mm(x0_mm), y: mm(PAGE_H_MM - 43), font, size: 10 },
  );
}

function drawTagPage(
  doc: PDFDocument,
  font: PDFFont,
  plan: LayoutPlan,
  pageIndex: number,
  bits: BitsProvider,
): void {
  const page = doc.addPage([mm(plan.paper.width_mm), mm(plan.paper.height_mm)]);

  // Cut lines: thin medium-grey, drawn first so tags overlay them.
  for (const c of plan.cutSegments) {
    if (c.page !== pageIndex) continue;
    page.drawLine({
      start: { x: mm(c.x0_mm), y: mm(c.y0_mm) },
      end: { x: mm(c.x1_mm), y: mm(c.y1_mm) },
      color: rgb(0.55, 0.55, 0.55),
      thickness: 0.25,
    });
  }

  // Registration marks at the four corners of the printable area.
  const margin = plan.options.pageMargin_mm;
  if (margin > 0) {
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

  // Tags.
  for (const placement of plan.placements) {
    if (placement.page !== pageIndex) continue;
    drawTag(page, font, placement, plan, bits);
  }

  // Footer: page index, family, id range, sizes.
  const pagePlacements = plan.placements.filter((p) => p.page === pageIndex);
  if (pagePlacements.length > 0) {
    const firstId = pagePlacements[0]!.tag.id;
    const lastId = pagePlacements[pagePlacements.length - 1]!.tag.id;
    const families = new Set(pagePlacements.map((p) => p.tag.family));
    const familyLabel = [...families].join(",");
    const Q = plan.options.quietZone_mm;
    const C = plan.options.cutMargin_mm;
    const cell = plan.tagSize_mm + 2 * (Q + C);
    const footerLine = [
      `Page ${pageIndex + 1}/${plan.pageCount}`,
      `${familyLabel} #${firstId}..${lastId}`,
      `tag ${plan.tagSize_mm} mm, cell ${cell.toFixed(2)} mm`,
    ].join("   ");
    page.drawText(footerLine, {
      x: mm(5),
      y: mm(3),
      font,
      size: 7,
      color: rgb(0.35, 0.35, 0.35),
    });
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
  // Add a tiny overlap (in points) so adjacent black cells don't show
  // hairline seams when the PDF is rasterized at low DPI by viewers/printers.
  const overlap_pt = 0.05;

  for (let row = 0; row < edge; row++) {
    const r = grid[row]!;
    for (let col = 0; col < edge; col++) {
      if (!r[col]) continue;
      // Flip row index: bits[0] is the top row of the tag bitmap, but PDF y
      // increases upward, so the top row is at the highest y.
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

  // Per-tag label: small text in the cut-margin band below the tag bitmap.
  // Sized to fit the cut margin; with a tiny default cut margin the label is
  // microscopic — that's fine, it scales when the user widens the cut margin.
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
