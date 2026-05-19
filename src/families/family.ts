/**
 * Core marker abstractions. A `Family` is a catalogue of `Marker`s indexed
 * by integer id; a `Marker` knows how to render itself onto a `Canvas`.
 *
 * Design intent — every fiducial type the project wants to support
 * (AprilTag, ArUco, WhyCon, CCTag, STag, Circles Grid, Fourier Tag,
 * user-uploaded PNG sets, …) is expected to slot in as a new `Marker`
 * implementation. Compose / preview / export code never inspects a
 * marker's internals; it only calls `marker.draw(canvas, frame)`. New
 * marker shapes therefore add a class, not a switch arm.
 *
 * Lifecycle — callers must `await family.load()` once before invoking
 * `getMarker`. After that, `getMarker(id)` is synchronous and throws on
 * invalid input rather than returning null. `load()` is idempotent and
 * safe under concurrent calls.
 */
import type { Canvas } from "../render/canvas";

/**
 * Static, per-family geometry. Describes the marker's drawable footprint
 * in dimensionless "cell" units; callers convert cells → millimetres via
 * a user-supplied tag size.
 */
export interface FamilyGeometry {
  /** Edge length of the marker's drawable footprint, in cells. For
   *  bit-grid families this is the bit-grid edge (formerly `tileSize_px`).
   *  For non-bit-grid families it is a notional unit count that relates
   *  user-input size to draw size. */
  readonly edge: number;

  /** Reference length the user-visible "Tag size" input applies to, in
   *  cells. For AprilTag this is the detection-corner span (formerly
   *  `widthAtBorder_modules`), which is smaller than `edge` because the
   *  tile carries a quiet ring outside the detection corners. For
   *  families where the user's "size" input is the full tile extent
   *  (most non-AprilTag fiducials), set equal to `edge`. */
  readonly widthAtBorder: number;

  /** Shape of the cut around each marker — square frame or circular cut.
   *  Square families get a rectangular grid of cuts; circle families get
   *  one circular cut per marker, hex-packed. */
  readonly outerShape: "square" | "circle";

  /** Required when `outerShape === "circle"`. Radius, in cell units, of
   *  the smallest circle centred on the tile centre that encloses every
   *  printed (black) cell across any valid marker in the family. Used to
   *  size the cut circle in millimetres. */
  readonly outerRadiusCells?: number;

  /** Present iff the family supports embedded sub-markers. Identifies the
   *  always-fixed centre block (in cell coordinates, row 0 at top) where
   *  a sub-marker can be inscribed. */
  readonly centerBlock?: { row: number; col: number; size: number };
}

/**
 * Where on the canvas a marker should draw itself. The compose layer
 * computes this from the layout plan; the marker reads it and emits
 * primitives.
 *
 * `size_mm` is the marker's *full* draw extent — compose has already
 * converted the user's "Tag size" input (which applies to
 * `geometry.widthAtBorder`) into the full tile extent (which spans
 * `geometry.edge`). Markers therefore don't need to know about
 * `widthAtBorder`; that's a UI/scaling concern.
 */
export interface MarkerFrame {
  /** Bottom-left of the marker's bounding box in page-space mm
   *  (canvas-space, y-up). */
  x_mm: number;
  y_mm: number;
  /** Edge length of the marker's bounding box in mm. */
  size_mm: number;
}

/**
 * A single marker, ready to draw. Implementations vary by family: bit-
 * grid markers carry a `boolean[][]`; future vector markers carry
 * primitive parameters; raster markers carry pixel data.
 *
 * Callers must never inspect a marker's concrete shape — only call
 * `draw`. This is the open extension point: a new marker type is a new
 * class implementing this interface; compose, preview, PDF and PNG
 * renderers continue to work unchanged.
 */
export interface Marker {
  /** Stable identifier for renderer-side memoisation. The SVG canvas
   *  caches rasterised PNG data URIs under this key; backends without a
   *  cache may ignore it. Conventional form: `"${family}#${id}"` for
   *  the base marker, with suffixes for variant draws (e.g. `"+sub"`
   *  for a centre-block-masked version). */
  readonly cacheKey: string;

  /** Render this marker filling the box `(x_mm, y_mm, size_mm)` on
   *  `canvas`. Stateless — the marker emits one or more primitive calls
   *  and returns. Style is the marker's responsibility. */
  draw(canvas: Canvas, frame: MarkerFrame): void;
}

/**
 * A marker family — a catalogue of markers indexed by integer id.
 *
 * Instantiation is cheap and happens at module load; the heavy work
 * (mosaic fetch + decode, table generation) happens in `load()`, called
 * lazily by the UI when a family is first selected.
 *
 * Error policy (per CLAUDE.md "fail loudly"):
 *   - `getMarker(id)` throws `RangeError` on invalid id and `Error` on
 *     use-before-load. No silent nulls — the soft "not ready" return
 *     lives at the `MarkerProvider` layer, not here.
 */
export interface Family {
  /** Stable registry key. Matches the family-picker `<option>` value. */
  readonly name: string;

  /** Optional UI grouping label. Families with the same `group` appear
   *  under one `<optgroup>` in the family picker. */
  readonly group?: string;

  /** Number of valid marker ids. Ids are `0..count - 1`. */
  readonly count: number;

  /** Static, per-family geometry shared by every marker in the family. */
  readonly geometry: FamilyGeometry;

  /** Idempotent. Returns the same resolved promise for every call. After
   *  it resolves, `getMarker` is safe to call. */
  load(): Promise<void>;

  /** Marker for `id`. Throws `RangeError` if `id < 0 || id >= count`.
   *  Throws `Error` if called before `load()` resolves. */
  getMarker(id: number): Marker;
}

/**
 * Renderer-facing seam: look up a marker by family name + id. The renderer
 * doesn't hold `Family` instances directly — the UI owns the lifecycle —
 * so this thin lookup layer is what flows through compose / pdf / export.
 *
 * Returns `null` if the family is unknown or not yet loaded, so the
 * preview can draw placeholder rectangles while mosaics are still
 * fetching. If the family is loaded but the id is out of range, the
 * underlying `Family.getMarker` throws — that's a programmer error, not
 * a loading state, and propagates up loudly.
 */
export interface MarkerProvider {
  getMarker(family: string, id: number): Marker | null;
}

/**
 * A marker that is a bit grid. Covers every family shipped today plus
 * ArUco and any future bit-grid family (Checkerboard, ChArUco's ArUco
 * squares, etc.). Renders as a single `drawBitGrid` call; SVG and PNG
 * backends rasterise that under the hood, PDF emits one rect per black
 * cell.
 */
export class BitGridMarker implements Marker {
  readonly cacheKey: string;
  readonly bits: readonly (readonly boolean[])[];

  constructor(bits: readonly (readonly boolean[])[], cacheKey: string) {
    this.bits = bits;
    this.cacheKey = cacheKey;
  }

  /** Edge length of the bit grid in cells. */
  get edge(): number {
    return this.bits.length;
  }

  draw(canvas: Canvas, frame: MarkerFrame): void {
    const edge = this.bits.length;
    if (edge === 0) return;
    canvas.drawBitGrid({
      bits: this.bits,
      x_mm: frame.x_mm,
      y_mm: frame.y_mm,
      cellSize_mm: frame.size_mm / edge,
      cacheKey: this.cacheKey,
    });
  }

  /** Return a copy of this marker with the cells inside `cb` zeroed out.
   *  Used by compose when a sub-marker will cover the parent's centre
   *  block: masking the parent first keeps vector backends (PDF) from
   *  painting cells the sub-marker immediately overlays. The new marker
   *  carries a distinct cache key so the SVG rasteriser doesn't collide
   *  the masked and unmasked variants. */
  withMaskedCenterBlock(cb: { row: number; col: number; size: number }): BitGridMarker {
    const masked: boolean[][] = [];
    for (let r = 0; r < this.bits.length; r++) {
      const row = this.bits[r]!;
      if (r < cb.row || r >= cb.row + cb.size) {
        masked.push([...row]);
        continue;
      }
      const next: boolean[] = [];
      for (let c = 0; c < row.length; c++) {
        next.push(c >= cb.col && c < cb.col + cb.size ? false : row[c]!);
      }
      masked.push(next);
    }
    return new BitGridMarker(masked, this.cacheKey + "+sub");
  }
}
