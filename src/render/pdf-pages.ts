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

const REG_MARK = gray(0.4);
const BOX_BORDER = gray(0.6);
const FOOTER_TEXT = gray(0.35);

const REG_MARK_WIDTH = 0.2;
const BOX_BORDER_WIDTH = 0.2;

// Back-label text-box geometry.
//   - GLYPH_ADVANCE_EM: mono (Courier) advance width per em. The PDF back
//     labels are set in the mono font, whose glyphs are exactly 0.6 em
//     wide, so a line of N glyphs at font size f is N · 0.6 · f wide.
//   - LINE_SPACING: baseline-to-baseline spacing as a multiple of f.
//   - BOX_PAD_EM: padding between the text block and the box edge, per
//     side, as a multiple of f.
const GLYPH_ADVANCE_EM = 0.6;
const LINE_SPACING = 1.4;
const BOX_PAD_EM = 0.4;
// Fraction of the safe footprint the box is allowed to fill — leaves a
// visible gap between the box and the (invisible) cut so the label never
// looks crowded against the tag edge.
const BOX_FILL_FRAC = 0.9;
// Clearance (mm) reserved between the box and the cut to absorb duplex
// front/back misregistration (~1–2 mm on consumer printers, and it
// drifts sheet to sheet). Clamped to a fraction of the tag so an
// absolute 2 mm doesn't swallow the whole label on tiny tags.
const MISREG_CLEARANCE_MM = 2;
const MISREG_CLEARANCE_FRAC = 0.15;

// Duplex alignment check (double-sided only). The reference sizes span the
// containment failure boundary: 10 mm is the worst case — the misreg
// clearance caps at 15% of the tag (1.5 mm) below ~13 mm, tighter than the
// 2 mm budget — while 25 / 50 mm sit comfortably inside it. `size_mm` is the
// outer cut dimension (square edge, or circle diameter). Centres are on the
// A4 calibration page (210×297): a column at x = 160, right of the
// left-shifted square, the group centred on the page's vertical middle.
interface AlignmentTarget {
  size_mm: number;
  cx_mm: number;
  cy_mm: number;
}
const ALIGNMENT_TARGETS: readonly AlignmentTarget[] = [
  { size_mm: 10, cx_mm: 160, cy_mm: 194 },
  { size_mm: 25, cx_mm: 160, cy_mm: 168.5 },
  { size_mm: 50, cx_mm: 160, cy_mm: 123 },
];

// In duplex mode the 100 mm square shifts left from page-centre to open the
// target column on its right, and is centred vertically (the header offset
// is dropped).
const CALIBRATION_DUPLEX_X0_MM = 25;

const TARGET_OUTLINE = gray(0.6);
const TARGET_OUTLINE_WIDTH = 0.3;

// The widest shipped family name (16 chars), used only as a width proxy so
// the sample is family-agnostic yet an upper bound on real label width.
const WORST_CASE_FAMILY = "tagStandard41h12";

/** The most demanding label the back renderer can emit: max line count
 *  (family, id, size, plus two nested sub-tag lines — the deepest the test
 *  suite exercises) and max width per line. If this stays legible at 10 mm,
 *  every real label does. Family-agnostic by construction. */
function worstCaseBackLabel(size_mm: number): Array<{ text: string; bold: boolean }> {
  const subLine = `> ${WORST_CASE_FAMILY} #99999 · ${formatTagSize(size_mm)}`;
  return [
    { text: WORST_CASE_FAMILY, bold: false },
    { text: "#99999", bold: true },
    { text: formatTagSize(size_mm), bold: false },
    { text: subLine, bold: false },
    { text: subLine, bold: false },
  ];
}

/** A 100 × 100 mm reference square plus tick rulers along its left and
 *  bottom edges, with a small header explaining how to use it. When
 *  `duplex` is given (double-sided printing), the square is vertically
 *  centred and shifted left, and reference target outlines are drawn in a
 *  column to its right for the duplex alignment check on the back. */
export function drawCalibrationPage(
  canvas: Canvas,
  duplex?: { isCircular: boolean },
): void {
  const PAGE_W = canvas.page.width_mm;
  const PAGE_H = canvas.page.height_mm;
  const REF = CALIBRATION_SIZE_MM;

  const x0 = duplex ? CALIBRATION_DUPLEX_X0_MM : (PAGE_W - REF) / 2;
  const y0 = duplex
    ? (PAGE_H - REF) / 2
    : (PAGE_H - CALIBRATION_HEADER_HEIGHT_MM - REF) / 2;

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

  if (duplex) {
    for (const t of ALIGNMENT_TARGETS) {
      drawAlignmentTargetOutline(canvas, t, duplex.isCircular);
    }
  }
}

/** A faint outline marking where a reference tag of `t.size_mm` sits on the
 *  calibration front, with its size captioned above it. Square cuts get a
 *  square; circular cuts get a circle of diameter `size_mm`. */
function drawAlignmentTargetOutline(
  canvas: Canvas,
  t: AlignmentTarget,
  isCircular: boolean,
): void {
  if (isCircular) {
    canvas.drawCircle({
      cx_mm: t.cx_mm,
      cy_mm: t.cy_mm,
      radius_mm: t.size_mm / 2,
      stroke: TARGET_OUTLINE,
      strokeWidth_mm: TARGET_OUTLINE_WIDTH,
    });
  } else {
    canvas.drawRect({
      x_mm: t.cx_mm - t.size_mm / 2,
      y_mm: t.cy_mm - t.size_mm / 2,
      width_mm: t.size_mm,
      height_mm: t.size_mm,
      stroke: TARGET_OUTLINE,
      strokeWidth_mm: TARGET_OUTLINE_WIDTH,
    });
  }
  canvas.drawText({
    text: `${t.size_mm} mm`,
    x_mm: t.cx_mm,
    y_mm: t.cy_mm + t.size_mm / 2 + 2,
    fontSize_mm: ptToMm(8),
    font: "mono",
    fill: gray(0.4),
    anchor: "middle",
  });
}

/** The duplex alignment check, printed on the back of the calibration
 *  sheet. For each reference target, a worst-case sample label is drawn at
 *  the mirror (x → W − x) of the target's front centre, so a long-edge
 *  duplex flip lands each box behind its target outline. Holding the sheet
 *  to the light shows whether the user's printer keeps the back image
 *  registered inside the tag at each size. No registration corner marks:
 *  the calibration front has none, so the target outlines + the 1 mm grid
 *  are the alignment reference. */
export function drawAlignmentBackPage(
  canvas: Canvas,
  opts: { isCircular: boolean },
): void {
  const W = canvas.page.width_mm;
  const H = canvas.page.height_mm;

  // White background so the sample boxes / text read.
  canvas.drawRect({ x_mm: 0, y_mm: 0, width_mm: W, height_mm: H, fill: { r: 1, g: 1, b: 1 } });

  canvas.drawText({
    text: "Duplex alignment check",
    x_mm: 20,
    y_mm: H - 14,
    fontSize_mm: ptToMm(18),
    font: "mono",
    fill: BLACK,
  });
  const headerLines = [
    "Hold this sheet to a light. Each box should sit centred INSIDE the matching",
    "outline on the front (calibration) side. If a box pokes past its outline, your",
    "printer's double-sided registration is off by more than the labels can absorb at",
    "that size — print single-sided, or use larger tags.",
  ];
  const headerFont_mm = ptToMm(9);
  for (let i = 0; i < headerLines.length; i++) {
    canvas.drawText({
      text: headerLines[i]!,
      x_mm: 20,
      y_mm: H - 22 - i * 4,
      fontSize_mm: headerFont_mm,
      font: "mono",
      fill: gray(0.25),
    });
  }

  for (const t of ALIGNMENT_TARGETS) {
    const cutRadius_mm = t.size_mm / 2;
    drawBackLabel(
      canvas,
      worstCaseBackLabel(t.size_mm),
      W - t.cx_mm,
      t.cy_mm,
      t.size_mm,
      cutRadius_mm,
      opts.isCircular,
    );
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

/** The back-label sheet for `pageIndex`, for long-edge duplex printing.
 *
 *  Each front placement becomes a small text box on the back, centred on
 *  the placement's tag centre reflected across the page's vertical axis
 *  (x → W − x) so it lands behind the tag after the sheet is flipped.
 *
 *  Deliberately draws **no** tag-boundary geometry — no cut lines, no
 *  cut circles, no full-tile outline. Those edges sit on or near the
 *  cut, so any duplex front/back misregistration leaves them partly cut
 *  off and partly remaining, which looks broken. The cut is guided
 *  entirely by the front sheet; the back only needs to carry the label,
 *  boxed well inside the (now invisible) tag bounds. Registration marks
 *  stay — they sit in the page corners, far from any cut. */
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

  // Registration marks: their corner positions are symmetric in x so
  // the same set is correct on the back.
  drawBackRegistrationCorners(canvas, plan);

  const tile_mm = plan.tileSize_mm;
  // Uniform plan: every tag shares one cut radius (circle families only).
  const cutRadius_mm = plan.cutCircles[0]?.radius_mm ?? tile_mm / 2;
  for (const placement of plan.placements) {
    if (placement.page !== pageIndex) continue;
    const cx_mm = W - placement.x_mm - tile_mm / 2;
    const cy_mm = placement.y_mm + tile_mm / 2;
    const lines = backLabelLines(placement, plan.tagSize_mm, plan.subtagLevels);
    drawBackLabel(canvas, lines, cx_mm, cy_mm, tile_mm, cutRadius_mm, isCircular);
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
  lines: Array<{ text: string; bold: boolean }>,
  cx_mm: number,
  cy_mm: number,
  tile_mm: number,
  cutRadius_mm: number,
  isCircular: boolean,
): void {
  const footprint = safeFootprint(tile_mm, cutRadius_mm, isCircular);

  // Largest font that fits both the widest line and the full stack of
  // lines (plus box padding) inside the safe footprint. No floor: on a
  // tiny tag the text shrinks rather than overflowing the tag bounds.
  const maxGlyphs = Math.max(1, ...lines.map((l) => l.text.length));
  const boxWidthEm = GLYPH_ADVANCE_EM * maxGlyphs + 2 * BOX_PAD_EM;
  const boxHeightEm = LINE_SPACING * lines.length + 2 * BOX_PAD_EM;
  const fontSize_mm = Math.min(footprint.width / boxWidthEm, footprint.height / boxHeightEm);

  const boxW = fontSize_mm * boxWidthEm;
  const boxH = fontSize_mm * boxHeightEm;
  canvas.drawRect({
    x_mm: cx_mm - boxW / 2,
    y_mm: cy_mm - boxH / 2,
    width_mm: boxW,
    height_mm: boxH,
    stroke: BOX_BORDER,
    strokeWidth_mm: BOX_BORDER_WIDTH,
  });

  const pad = BOX_PAD_EM * fontSize_mm;
  const lineHeight = LINE_SPACING * fontSize_mm;
  const interiorTop = cy_mm + boxH / 2 - pad;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    canvas.drawText({
      text: ln.text,
      x_mm: cx_mm,
      y_mm: interiorTop - (i + 0.5) * lineHeight,
      fontSize_mm,
      font: "mono",
      weight: ln.bold ? "bold" : "regular",
      fill: BLACK,
      anchor: "middle",
      verticalAnchor: "middle",
    });
  }
}

/** The lines printed on the back of one tag: family, id, size, then one
 *  line per nested sub-tag. */
function backLabelLines(
  placement: Placement,
  tagSize_mm: number,
  subtagLevels: SubtagLevel[],
): Array<{ text: string; bold: boolean }> {
  const lines = [
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
  return lines;
}

/** A rectangle, centred on the tag, guaranteed to stay clear of the cut
 *  even under duplex misregistration — the box and text are sized to fit
 *  inside it. For square cuts the footprint sits inside the printed tile
 *  (already inset from the cut by the quiet zone); for circular cuts it
 *  is the square inscribed in the cut disk. In both cases an extra
 *  clearance absorbs front/back misregistration, and `BOX_FILL_FRAC`
 *  keeps a visible margin. */
function safeFootprint(
  tile_mm: number,
  cutRadius_mm: number,
  isCircular: boolean,
): { width: number; height: number } {
  if (isCircular) {
    const clearance = Math.min(MISREG_CLEARANCE_MM, 2 * cutRadius_mm * MISREG_CLEARANCE_FRAC);
    const safeRadius = Math.max(0, cutRadius_mm - clearance);
    const side = safeRadius * Math.SQRT2 * BOX_FILL_FRAC;
    return { width: side, height: side };
  }
  const clearance = Math.min(MISREG_CLEARANCE_MM, tile_mm * MISREG_CLEARANCE_FRAC);
  const side = Math.max(0, tile_mm - 2 * clearance) * BOX_FILL_FRAC;
  return { width: side, height: side };
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
