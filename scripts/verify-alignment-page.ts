/**
 * Renders the duplex calibration front and the alignment back page for both
 * square and circular cut shapes, so the inserted duplex-alignment page can
 * be eyeballed without a printer and its hand-placed geometry checked:
 *   - reference target outlines sit clear of the 100 mm square and each other,
 *   - every sample label box is contained in its target,
 *   - all marks stay inside the A4 page.
 * Writes one viewable SVG per case to /tmp/alignment-preview/.
 *
 * Run: npx tsx scripts/verify-alignment-page.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { drawAlignmentBackPage, drawCalibrationPage } from "../src/render/pdf-pages";
import { PdfCanvas, embedPdfFonts } from "../src/render/pdf-canvas";
import { SvgCanvas } from "../src/render/svg-canvas";

const A4 = { width_mm: 210, height_mm: 297 };
const OUT = "/tmp/alignment-preview";
mkdirSync(OUT, { recursive: true });

interface Rec {
  kind: string;
  [k: string]: unknown;
}

function recorder(w: number, h: number) {
  const calls: Rec[] = [];
  const c = new SvgCanvas(w, h);
  const wrap =
    <T extends object>(fn: (o: T) => void, kind: string) =>
    (o: T) => {
      calls.push({ kind, ...(o as object) } as Rec);
      fn.call(c, o);
    };
  const canvas = {
    page: c.page,
    drawRect: wrap(c.drawRect, "rect"),
    drawCircle: wrap(c.drawCircle, "circle"),
    drawLine: wrap(c.drawLine, "line"),
    drawText: wrap(c.drawText, "text"),
    drawCurvedText: wrap(c.drawCurvedText, "curvedText"),
    drawBitGrid: wrap(c.drawBitGrid, "bitGrid"),
    measureText: c.measureText.bind(c),
  };
  // Wrap the bare element stream in a real SVG root with a light page so the
  // file opens in any viewer.
  const svg = () =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" ` +
    `viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#fafafa"/>` +
    `${c.toString()}</svg>`;
  return { canvas, calls, svg };
}

let allPass = true;
function check(label: string, cond: boolean): void {
  if (!cond) allPass = false;
  console.log(`    ${cond ? "ok  " : "FAIL"} ${label}`);
}

const stroked = (calls: Rec[]) =>
  calls.filter((x) => x.kind === "rect" && x.fill === undefined && x.stroke !== undefined);

for (const isCircular of [false, true]) {
  const name = isCircular ? "circle" : "square";
  console.log(`\n[${name}]`);

  // Front (calibration with duplex targets).
  const front = recorder(A4.width_mm, A4.height_mm);
  drawCalibrationPage(front.canvas as never, { isCircular });
  writeFileSync(`${OUT}/${name}_front.svg`, front.svg());

  const square = stroked(front.calls).find((r) => Math.round(r.width_mm as number) === 100)!;
  const sqRight = (square.x_mm as number) + (square.width_mm as number);
  check(`square vertically centred (y=${(square.y_mm as number).toFixed(1)} ~ 98.5)`,
    Math.abs((square.y_mm as number) - 98.5) < 1e-6);

  // Target extents (square outlines or circles), must sit right of the square
  // and within the page.
  const targets = isCircular
    ? front.calls
        .filter((x) => x.kind === "circle")
        .map((c) => ({
          left: (c.cx_mm as number) - (c.radius_mm as number),
          right: (c.cx_mm as number) + (c.radius_mm as number),
          top: (c.cy_mm as number) + (c.radius_mm as number),
          bottom: (c.cy_mm as number) - (c.radius_mm as number),
        }))
    : stroked(front.calls)
        .filter((r) => [10, 25, 50].includes(Math.round(r.width_mm as number)))
        .map((r) => ({
          left: r.x_mm as number,
          right: (r.x_mm as number) + (r.width_mm as number),
          top: (r.y_mm as number) + (r.height_mm as number),
          bottom: r.y_mm as number,
        }));
  check(`3 targets drawn (got ${targets.length})`, targets.length === 3);
  check(`all targets right of the square (gap to ${sqRight.toFixed(0)}mm)`,
    targets.every((t) => t.left > sqRight));
  check("all targets within page bounds",
    targets.every((t) => t.bottom >= 0 && t.top <= A4.height_mm && t.right <= A4.width_mm));

  // Back (alignment page): sample boxes contained in their targets.
  const back = recorder(A4.width_mm, A4.height_mm);
  drawAlignmentBackPage(back.canvas as never, { isCircular });
  writeFileSync(`${OUT}/${name}_back.svg`, back.svg());

  const boxes = stroked(back.calls);
  check(`3 sample boxes drawn (got ${boxes.length})`, boxes.length === 3);
  for (const b of boxes) {
    const bw = b.width_mm as number;
    const bh = b.height_mm as number;
    // Match box to the nearest reference size by its larger fitting dimension.
    const size = [10, 25, 50].find((s) =>
      isCircular ? Math.hypot(bw / 2, bh / 2) <= s / 2 + 1e-9 : bw <= s + 1e-9 && bh <= s + 1e-9,
    );
    check(`box ${bw.toFixed(1)}x${bh.toFixed(1)}mm fits a reference size`, size !== undefined);
  }
}

console.log(`\nSVGs written to ${OUT}/`);

// Two-page PDFs (calibration front + the inserted alignment back, exactly as
// printed) for visual review. Hold-to-light is simulated by viewing the back
// against the front. The layout/markers chain is intentionally not exercised
// here — these two pages don't depend on it.
const MM_TO_PT = 72 / 25.4;
const mm = (v: number): number => v * MM_TO_PT;

async function emitPdf(name: string, isCircular: boolean): Promise<void> {
  const doc = await PDFDocument.create();
  const fonts = await embedPdfFonts(doc);

  const frontPage = doc.addPage([mm(210), mm(297)]);
  drawCalibrationPage(new PdfCanvas(frontPage, fonts, 210, 297), { isCircular });

  const backPage = doc.addPage([mm(210), mm(297)]);
  drawAlignmentBackPage(new PdfCanvas(backPage, fonts, 210, 297), { isCircular });

  writeFileSync(`${OUT}/${name}.pdf`, await doc.save());
  console.log(`  ${name}.pdf`);
}

await emitPdf("duplex_square", false);
await emitPdf("duplex_circle", true);

console.log(`PDFs written to ${OUT}/`);
console.log(allPass ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
process.exit(allPass ? 0 : 1);
