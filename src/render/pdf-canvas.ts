import {
  type PDFDocument,
  type PDFFont,
  type PDFPage,
  StandardFonts,
  degrees,
  rgb,
} from "pdf-lib";
import type {
  BitGridOpts,
  Canvas,
  CircleOpts,
  Color,
  CurvedTextOpts,
  FontFamily,
  FontWeight,
  LineOpts,
  MeasureOpts,
  RectOpts,
  TextMetrics,
  TextOpts,
} from "./canvas";

const MM_TO_PT = 72 / 25.4;
const PT = (mm: number): number => mm * MM_TO_PT;

/**
 * Pre-embedded fonts for `PdfCanvas`. The renderer holds one of these
 * for the whole document and reuses it across pages — embedding a font
 * is a Promise-returning operation in pdf-lib but drawing is sync, so
 * we resolve the embeddings up front and the `Canvas` interface stays
 * synchronous.
 */
export interface PdfCanvasFonts {
  sans: PDFFont;
  sansBold: PDFFont;
  serif: PDFFont;
  serifBold: PDFFont;
  mono: PDFFont;
  monoBold: PDFFont;
}

/** Embed Helvetica, Times, and Courier (regular + bold) in `doc` so they
 *  can be handed to every `PdfCanvas` instance over the document. */
export async function embedPdfFonts(doc: PDFDocument): Promise<PdfCanvasFonts> {
  const [sans, sansBold, serif, serifBold, mono, monoBold] = await Promise.all([
    doc.embedFont(StandardFonts.Helvetica),
    doc.embedFont(StandardFonts.HelveticaBold),
    doc.embedFont(StandardFonts.TimesRoman),
    doc.embedFont(StandardFonts.TimesRomanBold),
    doc.embedFont(StandardFonts.Courier),
    doc.embedFont(StandardFonts.CourierBold),
  ]);
  return { sans, sansBold, serif, serifBold, mono, monoBold };
}

/**
 * pdf-lib-backed `Canvas`. One instance per `PDFPage`; the renderer
 * constructs a fresh `PdfCanvas` for each page it wants to draw into.
 *
 * Coordinates: PDF natively uses points with a bottom-left origin —
 * exactly matching the `Canvas` convention — so the only conversion is
 * a scale of `72/25.4` from mm to pt. No y-flip.
 *
 * `drawBitGrid` emits one filled rectangle per black cell, never a
 * rasterised image. The PDF stays a true vector document; printers
 * scale to any size with no aliasing.
 */
export class PdfCanvas implements Canvas {
  public readonly page: { width_mm: number; height_mm: number };
  private readonly pdfPage: PDFPage;
  private readonly fonts: PdfCanvasFonts;

  constructor(pdfPage: PDFPage, fonts: PdfCanvasFonts, width_mm: number, height_mm: number) {
    this.pdfPage = pdfPage;
    this.fonts = fonts;
    this.page = { width_mm, height_mm };
  }

  drawRect(opts: RectOpts): void {
    const args: Parameters<PDFPage["drawRectangle"]>[0] = {
      x: PT(opts.x_mm),
      y: PT(opts.y_mm),
      width: PT(opts.width_mm),
      height: PT(opts.height_mm),
    };
    if (opts.fill) args.color = toPdfColor(opts.fill);
    if (opts.stroke) {
      args.borderColor = toPdfColor(opts.stroke);
      args.borderWidth = opts.strokeWidth_mm ?? 0.25;
      if (opts.dash_mm) args.borderDashArray = [PT(opts.dash_mm[0]), PT(opts.dash_mm[1])];
    }
    this.pdfPage.drawRectangle(args);
  }

  drawCircle(opts: CircleOpts): void {
    const args: Parameters<PDFPage["drawCircle"]>[0] = {
      x: PT(opts.cx_mm),
      y: PT(opts.cy_mm),
      size: PT(opts.radius_mm),
    };
    if (opts.fill) args.color = toPdfColor(opts.fill);
    if (opts.stroke) {
      args.borderColor = toPdfColor(opts.stroke);
      args.borderWidth = opts.strokeWidth_mm ?? 0.25;
      if (opts.dash_mm) args.borderDashArray = [PT(opts.dash_mm[0]), PT(opts.dash_mm[1])];
    }
    this.pdfPage.drawCircle(args);
  }

  drawLine(opts: LineOpts): void {
    const args: Parameters<PDFPage["drawLine"]>[0] = {
      start: { x: PT(opts.x0_mm), y: PT(opts.y0_mm) },
      end: { x: PT(opts.x1_mm), y: PT(opts.y1_mm) },
      color: toPdfColor(opts.stroke),
      thickness: opts.strokeWidth_mm,
    };
    if (opts.dash_mm) args.dashArray = [PT(opts.dash_mm[0]), PT(opts.dash_mm[1])];
    this.pdfPage.drawLine(args);
  }

  drawText(opts: TextOpts): void {
    const font = this.pickFont(opts.font, opts.weight);
    const sizePt = PT(opts.fontSize_mm);
    const width_pt = font.widthOfTextAtSize(opts.text, sizePt);

    // `x_mm` is the anchor; map it to the PDF's "start of glyphs" by
    // subtracting the leading offset that the chosen anchor implies.
    let x_pt = PT(opts.x_mm);
    if (opts.anchor === "middle") x_pt -= width_pt / 2;
    else if (opts.anchor === "end") x_pt -= width_pt;

    // Vertical anchor: "baseline" (the default) means `y_mm` IS the
    // baseline. "middle" means `y_mm` is the visual centre of the
    // capital-letter band; shift baseline down by ~28% of font size to
    // line up with how SVG's `dominant-baseline="central"` lands.
    let y_pt = PT(opts.y_mm);
    if (opts.verticalAnchor === "middle") y_pt -= sizePt * 0.28;

    const args: NonNullable<Parameters<PDFPage["drawText"]>[1]> = {
      x: x_pt,
      y: y_pt,
      font,
      size: sizePt,
      color: toPdfColor(opts.fill ?? { r: 0, g: 0, b: 0 }),
    };
    if (opts.rotation_deg !== undefined && opts.rotation_deg !== 0) {
      args.rotate = degrees(opts.rotation_deg);
    }
    this.pdfPage.drawText(opts.text, args);
  }

  drawCurvedText(opts: CurvedTextOpts): void {
    if (opts.text.length === 0) return;
    const font = this.pickFont(opts.font, opts.weight);
    const fontPt = PT(opts.fontSize_mm);

    const charWidth_mm = opts.fontSize_mm * 0.6;
    const totalArc_mm = opts.text.length * charWidth_mm;
    const totalArc_rad = Math.min(
      totalArc_mm / opts.radius_mm,
      (opts.maxArc_deg * Math.PI) / 180,
    );
    const halfArc_rad = totalArc_rad / 2;

    // Same canvas-space (y-up) convention as SvgCanvas: "cw" visual
    // direction = increasing alpha in y-up (because y-up flips the
    // visual rotation sense). PDF is natively y-up, so there's no
    // further conversion at this step — just compute positions and
    // glyph rotation directly.
    const sign = opts.direction === "cw" ? 1 : -1;
    const centerAngle_rad = (opts.centerAngle_deg * Math.PI) / 180;
    const startAngle_rad = centerAngle_rad - sign * halfArc_rad;
    const angleStep_rad =
      opts.text.length > 1
        ? (sign * totalArc_rad) / (opts.text.length - 1)
        : 0;

    const fill = toPdfColor(opts.fill ?? { r: 0, g: 0, b: 0 });

    for (let i = 0; i < opts.text.length; i++) {
      const alpha = startAngle_rad + i * angleStep_rad;
      const px = opts.cx_mm + opts.radius_mm * Math.cos(alpha);
      const py = opts.cy_mm + opts.radius_mm * Math.sin(alpha);
      // Glyph "top" points radially inward for sign=+1 (the common
      // case: bottom-of-arc caption read upright by a viewer looking at
      // the page) and radially outward for sign=-1. Canvas-space (y-up,
      // CCW positive) rotation = `alpha + sign * π/2`. PDF is natively
      // y-up so this maps straight onto pdf-lib's degrees() with no
      // sign flip.
      const rotation_rad = alpha + sign * (Math.PI / 2);
      const rot_deg = (rotation_rad * 180) / Math.PI;
      const glyph = opts.text[i]!;
      const w = font.widthOfTextAtSize(glyph, fontPt);
      this.pdfPage.drawText(glyph, {
        x: PT(px) - w / 2,
        y: PT(py) - fontPt * 0.25,
        font,
        size: fontPt,
        rotate: degrees(rot_deg),
        color: fill,
      });
    }
  }

  drawBitGrid(opts: BitGridOpts): void {
    const edge = opts.bits.length;
    if (edge === 0) return;
    const cell_pt = PT(opts.cellSize_mm);
    // A hairline overlap on each cell hides the seam between adjacent
    // black cells under sub-pixel rasterisation in some PDF viewers.
    const overlap_pt = 0.05;
    for (let row = 0; row < edge; row++) {
      const r = opts.bits[row]!;
      for (let col = 0; col < r.length; col++) {
        if (!r[col]) continue;
        // Bit grid row 0 is the *top* of the marker; in y-up canvas
        // space, the bottom of the row is `(edge - 1 - row)` cells
        // above the marker's bottom edge.
        const x_mm_cell = opts.x_mm + col * opts.cellSize_mm;
        const y_mm_cell = opts.y_mm + (edge - 1 - row) * opts.cellSize_mm;
        this.pdfPage.drawRectangle({
          x: PT(x_mm_cell),
          y: PT(y_mm_cell),
          width: cell_pt + overlap_pt,
          height: cell_pt + overlap_pt,
          color: rgb(0, 0, 0),
        });
      }
    }
  }

  measureText(opts: MeasureOpts): TextMetrics {
    const font = this.pickFont(opts.font, opts.weight);
    const sizePt = PT(opts.fontSize_mm);
    const width_pt = font.widthOfTextAtSize(opts.text, sizePt);
    const height_pt = font.heightAtSize(sizePt);
    return {
      width_mm: width_pt / MM_TO_PT,
      ascent_mm: (height_pt * 0.8) / MM_TO_PT,
      descent_mm: (height_pt * 0.2) / MM_TO_PT,
    };
  }

  private pickFont(family: FontFamily, weight: FontWeight = "regular"): PDFFont {
    const bold = weight === "bold";
    switch (family) {
      case "sans":
        return bold ? this.fonts.sansBold : this.fonts.sans;
      case "serif":
        return bold ? this.fonts.serifBold : this.fonts.serif;
      case "mono":
        return bold ? this.fonts.monoBold : this.fonts.mono;
    }
  }
}

function toPdfColor(c: Color): ReturnType<typeof rgb> {
  return rgb(clamp01(c.r), clamp01(c.g), clamp01(c.b));
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
