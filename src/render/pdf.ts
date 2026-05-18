/**
 * Top-level PDF orchestrator. Embeds fonts once for the document, then
 * for every page constructs a fresh `PdfCanvas` and dispatches to
 * either `composePage` (the shared front-page renderer) or one of the
 * PDF-only page generators in `pdf-pages.ts` (calibration sheet, back
 * sheet). The page footer is layered on top with `drawPageFooter` after
 * each page's main content.
 *
 * Output structure:
 *   Page 1     calibration sheet (100 mm reference square + tick rulers)
 *   Page 2..N  one layout page per `plan.pageCount`. With
 *              `printLabelsOnBack: true`, each layout page is followed
 *              by a back sheet whose labels are mirrored along the
 *              vertical axis for long-edge duplex printing.
 *
 * Drawing of tag bits stays vector — `PdfCanvas.drawBitGrid` emits one
 * filled rectangle per black cell. No raster image embedding.
 */
import { PDFDocument } from "pdf-lib";
import type { BitsProvider } from "../families";
import type { LayoutPlan } from "../layout/types";
import { composePage } from "./compose";
import { PdfCanvas, embedPdfFonts } from "./pdf-canvas";
import { drawBackPage, drawCalibrationPage, drawPageFooter } from "./pdf-pages";

const MM_TO_PT = 72 / 25.4;
const mm = (v: number): number => v * MM_TO_PT;

export interface RenderOptions {
  /** Emit a mirrored "back" page after every layout page so a long-edge
   *  duplex print yields cut tags whose reverse carries family / id /
   *  size text. Default: false. */
  printLabelsOnBack?: boolean;
  /** Set the one-line "family #id · size" caption inside each tag's
   *  bottom quiet-zone band on the front layout page, so the caption
   *  stays on the tag once it is cut out. Sized to the quiet zone
   *  (small — best at ~20 mm tags or larger). Default: false. */
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

  const fonts = await embedPdfFonts(doc);

  const calibrationPage = doc.addPage([mm(210), mm(297)]);
  const calibrationCanvas = new PdfCanvas(calibrationPage, fonts, 210, 297);
  drawCalibrationPage(calibrationCanvas);

  for (let p = 0; p < plan.pageCount; p++) {
    const layoutPage = doc.addPage([mm(plan.paper.width_mm), mm(plan.paper.height_mm)]);
    const layoutCanvas = new PdfCanvas(layoutPage, fonts, plan.paper.width_mm, plan.paper.height_mm);
    composePage(plan, p, layoutCanvas, bits, {
      printLabelsInQuietZone: labelInQuietZone,
    });
    drawPageFooter(layoutCanvas, plan, p, false);

    if (printBack) {
      const backPage = doc.addPage([mm(plan.paper.width_mm), mm(plan.paper.height_mm)]);
      const backCanvas = new PdfCanvas(backPage, fonts, plan.paper.width_mm, plan.paper.height_mm);
      drawBackPage(backCanvas, plan, p);
      drawPageFooter(backCanvas, plan, p, true);
    }
  }

  return doc.save();
}
