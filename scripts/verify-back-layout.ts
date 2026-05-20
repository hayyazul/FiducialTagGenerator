/**
 * Renders the duplex back sheet across tag sizes and cut shapes and
 * reports the label geometry, so the redesign can be checked without a
 * printer:
 *   - box dimensions vs the tag bounds (must be strictly inside),
 *   - font size and the longest line's true on-page width vs the bounds
 *     (must not overflow at any scale),
 *   - that no boundary/cut geometry is emitted on the back.
 * Also writes one SVG per case to /tmp/back-preview/ for visual review.
 *
 * Run: npx tsx scripts/verify-back-layout.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { planSmallTagLayout, type CutShape } from "../src/layout/plan";
import type { LayoutOptions, LayoutPlan, Paper, TagSpec } from "../src/layout/types";
import { drawBackPage } from "../src/render/pdf-pages";
import { SvgCanvas } from "../src/render/svg-canvas";

const LETTER: Paper = { width_mm: 215.9, height_mm: 279.4 };
const GLYPH_ADVANCE_EM = 0.6; // mono advance per em — true Courier width

const OUT = "/tmp/back-preview";
mkdirSync(OUT, { recursive: true });

function buildPlan(
  family: string,
  tile_mm: number,
  cut: CutShape,
  withSub: boolean,
): LayoutPlan {
  const opts: LayoutOptions = { pageMargin_mm: 5, quietZone_mm: 2, cutMargin_mm: 0 };
  const tags: TagSpec[] = Array.from({ length: 4 }, (_, i) =>
    withSub ? { family, id: i, subtag: { family, id: i + 100 } } : { family, id: i },
  );
  const plan = planSmallTagLayout(tags, tile_mm, LETTER, opts, tile_mm * 0.8, cut);
  if (withSub) {
    plan.subtagLevels = [
      { familyName: family, tileSize_mm: tile_mm * 0.4, tagSize_mm: tile_mm * 0.32 },
    ];
  }
  return plan;
}

interface Rec {
  kind: string;
  [k: string]: unknown;
}

function recorder(w: number, h: number) {
  const calls: Rec[] = [];
  const c = new SvgCanvas(w, h);
  // Wrap to also record numeric calls.
  const wrap = <T extends object>(fn: (o: T) => void, kind: string) => (o: T) => {
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
  return { canvas, calls, svg: () => c.toString() };
}

let allPass = true;

function check(label: string, cond: boolean): void {
  if (!cond) allPass = false;
  console.log(`    ${cond ? "ok  " : "FAIL"} ${label}`);
}

for (const cut of [
  { name: "square", shape: { kind: "square" } as CutShape, family: "tag36h11" },
  { name: "circle", family: "tagCircle21h7", radiusFrac: 0.45 },
] as const) {
  for (const tile of [10, 20, 60, 100]) {
    for (const withSub of [false, true]) {
      const shape: CutShape =
        cut.name === "circle"
          ? { kind: "circle", outerRadius_mm: tile * 0.45 }
          : { kind: "square" };
      const plan = buildPlan(cut.family, tile, shape, withSub);
      const cutRadius = plan.cutCircles[0]?.radius_mm ?? tile / 2;
      const r = recorder(LETTER.width_mm, LETTER.height_mm);
      drawBackPage(r.canvas as never, plan, 0);

      const boxes = r.calls.filter(
        (x) => x.kind === "rect" && x.fill === undefined && x.stroke !== undefined,
      );
      const texts = r.calls.filter((x) => x.kind === "text");
      const circles = r.calls.filter((x) => x.kind === "circle");
      const box = boxes[0]!;
      const bw = box.width_mm as number;
      const bh = box.height_mm as number;
      const font = (texts[0]!.fontSize_mm as number) ?? 0;
      const widest = Math.max(
        ...texts.map((t) => (t.text as string).length * GLYPH_ADVANCE_EM * (t.fontSize_mm as number)),
      );

      console.log(
        `\n[${cut.name}] tile=${tile}mm sub=${withSub}  font=${font.toFixed(2)}mm ` +
          `box=${bw.toFixed(1)}x${bh.toFixed(1)}mm widestLine=${widest.toFixed(1)}mm`,
      );
      check(`no circles drawn on back (got ${circles.length})`, circles.length === 0);
      if (cut.name === "square") {
        check(`box inside tile (${bw.toFixed(1)} < ${tile})`, bw < tile && bh < tile);
        check(`widest line <= tile (${widest.toFixed(1)} <= ${tile})`, widest <= tile + 1e-9);
      } else {
        const halfDiag = Math.hypot(bw / 2, bh / 2);
        check(
          `box inside cut disk (halfDiag ${halfDiag.toFixed(1)} <= R ${cutRadius.toFixed(1)})`,
          halfDiag <= cutRadius + 1e-9,
        );
        check(
          `widest line <= cut diameter (${widest.toFixed(1)} <= ${(2 * cutRadius).toFixed(1)})`,
          widest <= 2 * cutRadius + 1e-9,
        );
      }

      const file = `${OUT}/${cut.name}_${tile}mm_${withSub ? "sub" : "plain"}.svg`;
      writeFileSync(file, r.svg());
    }
  }
}

console.log(`\nSVGs written to ${OUT}/`);
console.log(allPass ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
process.exit(allPass ? 0 : 1);
