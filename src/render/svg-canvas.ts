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
 * Rasterises a bit grid to a PNG `data:` URI. Injected into `SvgCanvas`
 * because the production implementation requires `document` (`<canvas>`
 * 2D context) and we want the canvas itself to remain DOM-free for unit
 * tests. When absent, `SvgCanvas.drawBitGrid` falls back to emitting one
 * `<rect>` per black cell — slower for large packed pages but
 * environment-agnostic.
 *
 * `cacheKey`, when supplied, is an opaque tag identifying the bit grid.
 * Rasterisers may use it to memoise. May be omitted; rasterisation is
 * recomputed each call in that case.
 */
export interface BitGridRasterizer {
  rasterize(
    bits: readonly (readonly boolean[])[],
    cacheKey?: string,
  ): string | null;
}

/** DOM-backed rasteriser used in the browser. Reuses a single offscreen
 *  `<canvas>` across calls and caches the resulting data URI under
 *  `cacheKey`. Construct lazily — first use creates the canvas. */
export function createDomRasterizer(): BitGridRasterizer {
  const cache = new Map<string, string>();
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;

  return {
    rasterize(
      bits: readonly (readonly boolean[])[],
      cacheKey?: string,
    ): string | null {
      if (cacheKey !== undefined) {
        const hit = cache.get(cacheKey);
        if (hit !== undefined) return hit;
      }
      const edge = bits.length;
      if (edge === 0) return null;

      if (canvas === null) {
        canvas = document.createElement("canvas");
        ctx = canvas.getContext("2d");
      }
      if (ctx === null) return null;

      canvas.width = edge;
      canvas.height = edge;
      const image = ctx.createImageData(edge, edge);
      image.data.set(bitsToRgba(bits));
      ctx.putImageData(image, 0, 0);
      const href = canvas.toDataURL("image/png");

      if (cacheKey !== undefined) cache.set(cacheKey, href);
      return href;
    },
  };
}

export interface SvgCanvasOptions {
  /** Style attribute on the root `<svg>` element. Used by the preview to
   *  add a border + display:block; an export-mode caller would leave this
   *  blank or pass only `"background:#fff"`. */
  rootStyle?: string;
  /** Bit-grid rasteriser. Optional; without one, `drawBitGrid` falls
   *  back to emitting one `<rect>` per black cell. */
  rasterizer?: BitGridRasterizer;
}

/**
 * SVG-string-building `Canvas`. Calls append elements to an internal
 * array; `toString()` concatenates them into the final document.
 *
 * The y-flip from canvas-space (bottom-left mm) to SVG-space (top-left
 * mm in the viewBox) happens here, on every primitive that takes a
 * y coordinate. Renderers never flip.
 *
 * Width and height units in the viewBox are millimetres; tests assert
 * exact numeric output, so we avoid formatting tricks (no toFixed,
 * no scientific notation).
 */
export class SvgCanvas implements Canvas {
  public readonly page: { width_mm: number; height_mm: number };
  private readonly parts: string[] = [];
  private readonly opts: SvgCanvasOptions;

  constructor(
    width_mm: number,
    height_mm: number,
    options: SvgCanvasOptions = {},
  ) {
    this.page = { width_mm, height_mm };
    this.opts = options;
  }

  drawRect(opts: RectOpts): void {
    const y_svg = this.flipY(opts.y_mm + opts.height_mm);
    const attrs = [
      `x="${opts.x_mm}"`,
      `y="${y_svg}"`,
      `width="${opts.width_mm}"`,
      `height="${opts.height_mm}"`,
      `fill="${opts.fill ? colorToHex(opts.fill) : "none"}"`,
    ];
    if (opts.stroke) {
      attrs.push(`stroke="${colorToHex(opts.stroke)}"`);
      attrs.push(`stroke-width="${opts.strokeWidth_mm ?? 0.25}"`);
    }
    this.parts.push(`<rect ${attrs.join(" ")}/>`);
  }

  drawCircle(opts: CircleOpts): void {
    const attrs = [
      `cx="${opts.cx_mm}"`,
      `cy="${this.flipY(opts.cy_mm)}"`,
      `r="${opts.radius_mm}"`,
      `fill="${opts.fill ? colorToHex(opts.fill) : "none"}"`,
    ];
    if (opts.stroke) {
      attrs.push(`stroke="${colorToHex(opts.stroke)}"`);
      attrs.push(`stroke-width="${opts.strokeWidth_mm ?? 0.25}"`);
    }
    this.parts.push(`<circle ${attrs.join(" ")}/>`);
  }

  drawLine(opts: LineOpts): void {
    this.parts.push(
      `<line x1="${opts.x0_mm}" y1="${this.flipY(opts.y0_mm)}" ` +
        `x2="${opts.x1_mm}" y2="${this.flipY(opts.y1_mm)}" ` +
        `stroke="${colorToHex(opts.stroke)}" stroke-width="${opts.strokeWidth_mm}"/>`,
    );
  }

  drawText(opts: TextOpts): void {
    const fill = colorToHex(opts.fill ?? { r: 0, g: 0, b: 0 });
    const anchor = svgTextAnchor(opts.anchor ?? "start");
    const fontFamily = svgFontFamily(opts.font);
    const fontWeight =
      opts.weight === "bold" ? ` font-weight="bold"` : "";
    const baseline =
      opts.verticalAnchor === "middle"
        ? ` dominant-baseline="central"`
        : "";
    const x_svg = opts.x_mm;
    const y_svg = this.flipY(opts.y_mm);
    const transform =
      opts.rotation_deg !== undefined && opts.rotation_deg !== 0
        ? ` transform="rotate(${-opts.rotation_deg}, ${x_svg}, ${y_svg})"`
        : "";
    this.parts.push(
      `<text x="${x_svg}" y="${y_svg}" font-size="${opts.fontSize_mm}" ` +
        `text-anchor="${anchor}" fill="${fill}" font-family="${fontFamily}"` +
        fontWeight +
        baseline +
        transform +
        `>${escapeXml(opts.text)}</text>`,
    );
  }

  drawCurvedText(opts: CurvedTextOpts): void {
    if (opts.text.length === 0) return;
    const charWidth_mm = opts.fontSize_mm * 0.6;
    const arc_mm = opts.text.length * charWidth_mm;
    const totalArc_rad = Math.min(
      arc_mm / opts.radius_mm,
      (opts.maxArc_deg * Math.PI) / 180,
    );
    const halfArc_rad = totalArc_rad / 2;

    // Canvas-space (bottom-left, y-up). Convention: angle progresses
    // counter-clockwise in *mathematical* sense. On a y-down display
    // surface (SVG, PDF print) the visual rotation is the opposite, so
    // "visually clockwise text progression" maps to *increasing* alpha
    // in canvas-space. Hence sign = +1 for "cw" visual direction.
    const sign = opts.direction === "cw" ? 1 : -1;

    const centerAngle_rad = (opts.centerAngle_deg * Math.PI) / 180;
    const startAngle_rad = centerAngle_rad - sign * halfArc_rad;
    const angleStep_rad =
      opts.text.length > 1
        ? (sign * totalArc_rad) / (opts.text.length - 1)
        : 0;

    const fill = colorToHex(opts.fill ?? { r: 0, g: 0, b: 0 });
    const fontFamily = svgFontFamily(opts.font);
    const weight = opts.weight === "bold" ? ` font-weight="bold"` : "";

    for (let i = 0; i < opts.text.length; i++) {
      const alpha_canvas = startAngle_rad + i * angleStep_rad;
      const px = opts.cx_mm + opts.radius_mm * Math.cos(alpha_canvas);
      const py_canvas = opts.cy_mm + opts.radius_mm * Math.sin(alpha_canvas);
      const py_svg = this.flipY(py_canvas);
      // Glyph "top" points radially *inward* for sign=+1 (bottom-of-
      // arc text reads upright to a viewer looking at the page) and
      // radially *outward* for sign=-1 (top-of-arc / inside-curve text
      // is intentionally upside-down). Canvas-space (y-up, CCW
      // positive) rotation is `alpha + sign * π/2`; flipping to SVG
      // (y-down, CW positive) negates that, which simplifies to
      // `alpha_svg - sign * π/2` since alpha_svg = -alpha_canvas.
      const alpha_svg = -alpha_canvas;
      const rotDeg = ((alpha_svg - sign * (Math.PI / 2)) * 180) / Math.PI;
      this.parts.push(
        `<text x="${px}" y="${py_svg}" font-size="${opts.fontSize_mm}" ` +
          `text-anchor="middle" fill="${fill}" ` +
          `font-family="${fontFamily}"` +
          weight +
          ` transform="rotate(${rotDeg}, ${px}, ${py_svg})">` +
          `${escapeXml(opts.text[i]!)}</text>`,
      );
    }
  }

  drawBitGrid(opts: BitGridOpts): void {
    const edge = opts.bits.length;
    if (edge === 0) return;
    const size_mm = opts.cellSize_mm * edge;

    if (this.opts.rasterizer) {
      const href = this.opts.rasterizer.rasterize(opts.bits, opts.cacheKey);
      if (href !== null) {
        const y_svg_top = this.flipY(opts.y_mm + size_mm);
        // The `<image>` does not natively round-corner / clip to a
        // circle in SVG. For circle families, render the same way
        // (full square) — the PDF renderer also draws the full tile;
        // any masking is handled at the cut-line layer.
        this.parts.push(
          `<image x="${opts.x_mm}" y="${y_svg_top}" ` +
            `width="${size_mm}" height="${size_mm}" ` +
            `preserveAspectRatio="none" style="image-rendering:pixelated" ` +
            `href="${href}"/>`,
        );
        return;
      }
    }

    // Fallback: emit one filled rect per black cell. Slow for packed
    // pages — used in test environments without a DOM, or when the
    // rasteriser explicitly returns null.
    for (let row = 0; row < edge; row++) {
      const r = opts.bits[row]!;
      const yTopOfCell_canvas =
        opts.y_mm + (edge - row) * opts.cellSize_mm;
      const y_svg = this.flipY(yTopOfCell_canvas);
      for (let col = 0; col < r.length; col++) {
        if (!r[col]) continue;
        const x = opts.x_mm + col * opts.cellSize_mm;
        this.parts.push(
          `<rect x="${x}" y="${y_svg}" width="${opts.cellSize_mm}" ` +
            `height="${opts.cellSize_mm}" fill="#000000"/>`,
        );
      }
    }
  }

  measureText(opts: MeasureOpts): TextMetrics {
    // Heuristic: monospace ~0.6 em advance, ~0.8 em ascent, ~0.2 em
    // descent. Matches the constants used inline today in svg.ts and is
    // accurate enough for layout-time centring decisions.
    const width_mm = opts.text.length * opts.fontSize_mm * 0.6;
    return {
      width_mm,
      ascent_mm: opts.fontSize_mm * 0.8,
      descent_mm: opts.fontSize_mm * 0.2,
    };
  }

  /** Serialise to an SVG document string. */
  toString(): string {
    const styleAttr = this.opts.rootStyle
      ? ` style="${this.opts.rootStyle}"`
      : "";
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" ` +
      `viewBox="0 0 ${this.page.width_mm} ${this.page.height_mm}" ` +
      `width="100%"` +
      styleAttr +
      `>` +
      this.parts.join("") +
      `</svg>`
    );
  }

  private flipY(y_mm: number): number {
    return this.page.height_mm - y_mm;
  }
}

function colorToHex(c: Color): string {
  const r = clampByte(Math.round(c.r * 255));
  const g = clampByte(Math.round(c.g * 255));
  const b = clampByte(Math.round(c.b * 255));
  return `#${byteHex(r)}${byteHex(g)}${byteHex(b)}`;
}

function clampByte(n: number): number {
  if (n < 0) return 0;
  if (n > 255) return 255;
  return n;
}

function byteHex(n: number): string {
  return n.toString(16).padStart(2, "0");
}

function svgTextAnchor(a: "start" | "middle" | "end"): string {
  return a;
}

function svgFontFamily(f: FontFamily): string {
  switch (f) {
    case "sans":
      return "sans-serif";
    case "serif":
      return "serif";
    case "mono":
      return "monospace";
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

