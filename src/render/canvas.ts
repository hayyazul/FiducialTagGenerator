/**
 * A 2D drawing surface used by the unified renderer (`compose.ts`). Each
 * output format (SVG preview, PDF, PNG) provides its own `Canvas`
 * implementation; the renderer is written against this interface and never
 * sees backend-specific drawing code.
 *
 * Coordinate system
 *   - millimetres throughout.
 *   - bottom-left origin (matches the layout engine — see
 *     `src/layout/types.ts`).
 *   - Backends that natively use top-left origin (SVG, raster canvas)
 *     apply the y-flip at this boundary; consumers never do it.
 *
 * State model
 *   - Stateless: every primitive carries the style it needs.
 *   - No push/pop, no implicit "current style". This is slightly more
 *     verbose at call-sites but eliminates "forgot to restore" bugs and
 *     keeps backends straightforward.
 */
export interface Canvas {
  /** Page size in mm. Set once at construction; read by primitives that
   *  need to flip y or clip to page bounds. */
  readonly page: { width_mm: number; height_mm: number };

  /** Filled and/or stroked axis-aligned rectangle.
   *  Supplying neither `fill` nor `stroke` is a no-op. */
  drawRect(opts: RectOpts): void;

  /** Filled and/or stroked circle. Used for circular cut lines and
   *  small filled marks. */
  drawCircle(opts: CircleOpts): void;

  /** Open line segment. Closed shapes use drawRect / drawCircle. */
  drawLine(opts: LineOpts): void;

  /** Single-line text. `anchor` controls horizontal alignment relative
   *  to (x, y); the y coordinate is the text baseline. */
  drawText(opts: TextOpts): void;

  /** Text laid out along a circular arc, one glyph at a time. Backends
   *  with native arc-text support (SVG textPath, eventually) may emit
   *  one element; the reference implementations rotate each glyph
   *  independently so the per-glyph behavior is identical everywhere. */
  drawCurvedText(opts: CurvedTextOpts): void;

  /** A marker's bit grid. Each backend chooses how to render: PDF emits
   *  one filled rectangle per black cell; SVG rasterises to a small PNG
   *  data URI and emits a single `<image>` (an order-of-magnitude DOM
   *  size reduction for packed pages); PNG writes pixels directly.
   *
   *  `cacheKey`, when supplied, is an opaque identifier the backend may
   *  use to memoise rasterisation results between calls. Callers
   *  typically pass `"${family}#${id}"`. */
  drawBitGrid(opts: BitGridOpts): void;

  /** Width and vertical metrics of `text` at the given size. Used by
   *  the renderer for centring and arc-text width calculations. */
  measureText(opts: MeasureOpts): TextMetrics;
}

/** RGB color in `[0, 1]` per channel. Matches pdf-lib's `rgb()` convention. */
export interface Color {
  r: number;
  g: number;
  b: number;
}

export type FontFamily = "sans" | "serif" | "mono";
export type FontWeight = "regular" | "bold";
export type TextAnchor = "start" | "middle" | "end";

export interface RectOpts {
  x_mm: number;
  y_mm: number;
  width_mm: number;
  height_mm: number;
  fill?: Color;
  stroke?: Color;
  strokeWidth_mm?: number;
}

export interface CircleOpts {
  cx_mm: number;
  cy_mm: number;
  radius_mm: number;
  fill?: Color;
  stroke?: Color;
  strokeWidth_mm?: number;
}

export interface LineOpts {
  x0_mm: number;
  y0_mm: number;
  x1_mm: number;
  y1_mm: number;
  stroke: Color;
  strokeWidth_mm: number;
}

export interface TextOpts {
  text: string;
  /** Anchor x in mm. Meaning depends on `anchor` (default `"start"`). */
  x_mm: number;
  /** Vertical anchor y in mm. Meaning depends on `verticalAnchor`
   *  (default `"baseline"`). */
  y_mm: number;
  fontSize_mm: number;
  font: FontFamily;
  weight?: FontWeight;
  fill?: Color;
  anchor?: TextAnchor;
  /** Vertical alignment. `"baseline"` (default) means `y_mm` is the
   *  text baseline; `"middle"` means it is the visual centre of the
   *  cap height (used for centring text in a box). */
  verticalAnchor?: "baseline" | "middle";
  /** Rotation in degrees, counter-clockwise, around `(x_mm, y_mm)`. */
  rotation_deg?: number;
}

export interface CurvedTextOpts {
  text: string;
  /** Arc centre. */
  cx_mm: number;
  cy_mm: number;
  /** Distance from `(cx, cy)` to the glyph baseline. */
  radius_mm: number;
  /** Centre of the arc swept by `text`, in degrees. 0° is +x, 90° is +y
   *  (after the bottom-left coordinate convention). Text spreads
   *  symmetrically about this angle. */
  centerAngle_deg: number;
  /** `"cw"` means glyphs progress clockwise from the start of the
   *  string; `"ccw"` means counter-clockwise. */
  direction: "cw" | "ccw";
  /** Hard cap on the total angular span of the text. The renderer
   *  ignores the cap if the text is shorter than it would consume; if
   *  longer, glyph spacing is tightened to fit. */
  maxArc_deg: number;
  fontSize_mm: number;
  font: FontFamily;
  weight?: FontWeight;
  fill?: Color;
}

export interface BitGridOpts {
  /** Row-major, `true` = printed (black). Row 0 is the top row of the
   *  marker; the backend handles any y-flip required for its native
   *  coordinate system. */
  bits: readonly (readonly boolean[])[];
  /** Bottom-left of the grid in page-space mm. */
  x_mm: number;
  y_mm: number;
  /** Edge length of one cell, in mm. Total drawn size is
   *  `cellSize_mm * bits.length` in each dimension. */
  cellSize_mm: number;
  /** Optional circular clip in page-space mm (used by circle families:
   *  cells outside the disk are dropped). */
  clipCircle?: {
    cx_mm: number;
    cy_mm: number;
    radius_mm: number;
  };
  /** Opaque memoisation hint; typically `"${family}#${id}"`. Backends
   *  that rasterise (SVG, PNG) can cache the rasterised bytes under
   *  this key. May be omitted; rasterisation is recomputed each call. */
  cacheKey?: string;
}

export interface MeasureOpts {
  text: string;
  fontSize_mm: number;
  font: FontFamily;
  weight?: FontWeight;
}

export interface TextMetrics {
  width_mm: number;
  ascent_mm: number;
  descent_mm: number;
}

// Convenience colour constants. Backends are free to map these to their
// native colour spaces.
export const BLACK: Color = { r: 0, g: 0, b: 0 };
export const WHITE: Color = { r: 1, g: 1, b: 1 };

export function gray(level: number): Color {
  return { r: level, g: level, b: level };
}
