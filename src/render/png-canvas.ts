import { bitsToRgba } from "./bits-to-rgba";
import type {
  BitGridOpts,
  Canvas,
  CircleOpts,
  Color,
  CurvedTextOpts,
  FontFamily,
  LineOpts,
  MeasureOpts,
  RectOpts,
  TextMetrics,
  TextOpts,
} from "./canvas";

/**
 * Raster `Canvas` backend. Renders into a single `HTMLCanvasElement`
 * at a fixed DPI (default 300 — print-standard, ~12 px/mm). Browser-
 * only: depends on `document.createElement("canvas")` and the 2D
 * rendering context. Not usable in Node test environments; tested
 * via integration through `runExport` in a browser smoke check.
 *
 * Coordinate flow:
 *   canvas-space (mm, bottom-left, y-up)
 *   → pixel-space (px, top-left, y-down)
 *
 * `drawBitGrid` rasterises each bit grid to a tiny intermediate canvas
 * (one pixel per bit) and then `drawImage`s it into the main canvas
 * with `imageSmoothingEnabled = false`, giving exact nearest-neighbour
 * upscaling. This is much faster than `fillRect`-per-bit for packed
 * sheets and keeps the bit edges hard.
 */
export interface PngCanvasOptions {
  /** Dots per inch. Default 300. Higher values produce sharper but
   *  larger PNGs; 600 is fine for small labels, 150 is acceptable for
   *  preview / on-screen review. */
  dpi?: number;
}

export class PngCanvas implements Canvas {
  public readonly page: { width_mm: number; height_mm: number };
  private readonly dpi: number;
  private readonly element: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly scratch: HTMLCanvasElement;
  private readonly scratchCtx: CanvasRenderingContext2D;

  constructor(
    width_mm: number,
    height_mm: number,
    options: PngCanvasOptions = {},
  ) {
    this.dpi = options.dpi ?? 300;
    this.page = { width_mm, height_mm };

    this.element = document.createElement("canvas");
    this.element.width = Math.round(this.toPx(width_mm));
    this.element.height = Math.round(this.toPx(height_mm));
    const ctx = this.element.getContext("2d");
    if (ctx === null) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;

    this.scratch = document.createElement("canvas");
    const sctx = this.scratch.getContext("2d");
    if (sctx === null) throw new Error("2D canvas context unavailable");
    this.scratchCtx = sctx;
  }

  /** Convert a `[dash, gap]` mm pattern to a Canvas2D pixel pattern. */
  private dashPx(dash: readonly [number, number] | undefined): number[] {
    return dash ? [this.toPx(dash[0]), this.toPx(dash[1])] : [];
  }

  drawRect(opts: RectOpts): void {
    const x = this.toPx(opts.x_mm);
    const y = this.flipY(opts.y_mm + opts.height_mm);
    const w = this.toPx(opts.width_mm);
    const h = this.toPx(opts.height_mm);
    if (opts.fill) {
      this.ctx.fillStyle = colorToCss(opts.fill);
      this.ctx.fillRect(x, y, w, h);
    }
    if (opts.stroke) {
      this.ctx.save();
      this.ctx.setLineDash(this.dashPx(opts.dash_mm));
      this.ctx.strokeStyle = colorToCss(opts.stroke);
      this.ctx.lineWidth = this.toPx(opts.strokeWidth_mm ?? 0.25);
      this.ctx.strokeRect(x, y, w, h);
      this.ctx.restore();
    }
  }

  drawCircle(opts: CircleOpts): void {
    this.ctx.beginPath();
    this.ctx.arc(
      this.toPx(opts.cx_mm),
      this.flipY(opts.cy_mm),
      this.toPx(opts.radius_mm),
      0,
      Math.PI * 2,
    );
    if (opts.fill) {
      this.ctx.fillStyle = colorToCss(opts.fill);
      this.ctx.fill();
    }
    if (opts.stroke) {
      this.ctx.save();
      this.ctx.setLineDash(this.dashPx(opts.dash_mm));
      this.ctx.strokeStyle = colorToCss(opts.stroke);
      this.ctx.lineWidth = this.toPx(opts.strokeWidth_mm ?? 0.25);
      this.ctx.stroke();
      this.ctx.restore();
    }
  }

  drawLine(opts: LineOpts): void {
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.moveTo(this.toPx(opts.x0_mm), this.flipY(opts.y0_mm));
    this.ctx.lineTo(this.toPx(opts.x1_mm), this.flipY(opts.y1_mm));
    this.ctx.setLineDash(this.dashPx(opts.dash_mm));
    this.ctx.strokeStyle = colorToCss(opts.stroke);
    this.ctx.lineWidth = this.toPx(opts.strokeWidth_mm);
    this.ctx.stroke();
    this.ctx.restore();
  }

  drawText(opts: TextOpts): void {
    this.ctx.save();
    const x = this.toPx(opts.x_mm);
    const y = this.flipY(opts.y_mm);
    const sizePx = this.toPx(opts.fontSize_mm);
    this.ctx.font = `${opts.weight === "bold" ? "bold " : ""}${sizePx}px ${cssFont(opts.font)}`;
    this.ctx.fillStyle = colorToCss(opts.fill ?? { r: 0, g: 0, b: 0 });
    this.ctx.textAlign = cssTextAlign(opts.anchor ?? "start");
    this.ctx.textBaseline =
      opts.verticalAnchor === "middle" ? "middle" : "alphabetic";

    if (opts.rotation_deg !== undefined && opts.rotation_deg !== 0) {
      // Canvas 2D rotate() is CW for positive deg (y-down). Our
      // rotation convention (canvas.ts) is CCW positive in y-up. Flip
      // sign when emitting.
      this.ctx.translate(x, y);
      this.ctx.rotate(-((opts.rotation_deg * Math.PI) / 180));
      this.ctx.fillText(opts.text, 0, 0);
    } else {
      this.ctx.fillText(opts.text, x, y);
    }
    this.ctx.restore();
  }

  drawCurvedText(opts: CurvedTextOpts): void {
    if (opts.text.length === 0) return;
    const charWidth_mm = opts.fontSize_mm * 0.6;
    const totalArc_mm = opts.text.length * charWidth_mm;
    const totalArc_rad = Math.min(
      totalArc_mm / opts.radius_mm,
      (opts.maxArc_deg * Math.PI) / 180,
    );
    const halfArc_rad = totalArc_rad / 2;

    // Same canvas-space (y-up) sign convention as SvgCanvas / PdfCanvas.
    const sign = opts.direction === "cw" ? 1 : -1;
    const centerAngle_rad = (opts.centerAngle_deg * Math.PI) / 180;
    const startAngle_rad = centerAngle_rad - sign * halfArc_rad;
    const angleStep_rad =
      opts.text.length > 1
        ? (sign * totalArc_rad) / (opts.text.length - 1)
        : 0;

    const sizePx = this.toPx(opts.fontSize_mm);
    const fill = colorToCss(opts.fill ?? { r: 0, g: 0, b: 0 });

    for (let i = 0; i < opts.text.length; i++) {
      const alpha = startAngle_rad + i * angleStep_rad;
      const px = opts.cx_mm + opts.radius_mm * Math.cos(alpha);
      const py_canvas = opts.cy_mm + opts.radius_mm * Math.sin(alpha);
      // Rotation in canvas-space (y-up CCW positive): alpha + sign*π/2.
      const rotation_canvas_rad = alpha + sign * (Math.PI / 2);
      const x_px = this.toPx(px);
      const y_px = this.flipY(py_canvas);

      this.ctx.save();
      this.ctx.font = `${opts.weight === "bold" ? "bold " : ""}${sizePx}px ${cssFont(opts.font)}`;
      this.ctx.fillStyle = fill;
      this.ctx.textAlign = "center";
      this.ctx.textBaseline = "alphabetic";
      this.ctx.translate(x_px, y_px);
      // Canvas 2D rotate() is CW for positive arg (y-down). Flip sign.
      this.ctx.rotate(-rotation_canvas_rad);
      // Baseline correction so the glyph sits *on* the arc (the
      // legacy PDF code shifted by `fontPt * 0.25`).
      this.ctx.fillText(opts.text[i]!, 0, sizePx * 0.25);
      this.ctx.restore();
    }
  }

  drawBitGrid(opts: BitGridOpts): void {
    const edge = opts.bits.length;
    if (edge === 0) return;

    // Build a 1-px-per-bit raster on the scratch canvas, then draw it
    // scaled (nearest-neighbour) into the main canvas. Much faster than
    // looping fillRect when packed pages have thousands of cells.
    this.scratch.width = edge;
    this.scratch.height = edge;
    const image = this.scratchCtx.createImageData(edge, edge);
    image.data.set(bitsToRgba(opts.bits));
    this.scratchCtx.putImageData(image, 0, 0);

    const size_mm = opts.cellSize_mm * edge;
    const x_px = this.toPx(opts.x_mm);
    const y_top_px = this.flipY(opts.y_mm + size_mm);
    const size_px = this.toPx(size_mm);
    this.ctx.drawImage(this.scratch, x_px, y_top_px, size_px, size_px);
  }

  measureText(opts: MeasureOpts): TextMetrics {
    this.ctx.save();
    const sizePx = this.toPx(opts.fontSize_mm);
    this.ctx.font = `${opts.weight === "bold" ? "bold " : ""}${sizePx}px ${cssFont(opts.font)}`;
    const m = this.ctx.measureText(opts.text);
    this.ctx.restore();
    const width_mm = m.width / (this.dpi / 25.4);
    return {
      width_mm,
      ascent_mm:
        (m.actualBoundingBoxAscent ?? sizePx * 0.8) / (this.dpi / 25.4),
      descent_mm:
        (m.actualBoundingBoxDescent ?? sizePx * 0.2) / (this.dpi / 25.4),
    };
  }

  /** Promise of a PNG `Blob`. The caller is responsible for the lifetime
   *  of the canvas DOM element (it's held by this instance until GC). */
  async toBlob(): Promise<Blob> {
    return await new Promise<Blob>((resolve, reject) => {
      this.element.toBlob((blob) => {
        if (blob === null) {
          reject(new Error("canvas.toBlob returned null"));
          return;
        }
        resolve(blob);
      }, "image/png");
    });
  }

  /** Raw underlying element, in case the caller wants to display it
   *  directly rather than serialise. */
  get domElement(): HTMLCanvasElement {
    return this.element;
  }

  private toPx(mm: number): number {
    return (mm * this.dpi) / 25.4;
  }

  private flipY(y_mm: number): number {
    return this.toPx(this.page.height_mm - y_mm);
  }
}

function colorToCss(c: Color): string {
  const r = Math.round(clamp01(c.r) * 255);
  const g = Math.round(clamp01(c.g) * 255);
  const b = Math.round(clamp01(c.b) * 255);
  return `rgb(${r},${g},${b})`;
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function cssFont(f: FontFamily): string {
  switch (f) {
    case "sans":
      return "sans-serif";
    case "serif":
      return "serif";
    case "mono":
      return "monospace";
  }
}

function cssTextAlign(a: "start" | "middle" | "end"): CanvasTextAlign {
  switch (a) {
    case "start":
      return "start";
    case "middle":
      return "center";
    case "end":
      return "end";
  }
}
