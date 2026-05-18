# Canvas Abstraction + SVG/PNG Exports — Design Spec

**Date:** 2026-05-18
**Status:** Draft, awaiting review
**Branch:** `architecture-refactor-specs` (spec only); implementation branch TBD

## Context

The PDF renderer (`src/render/pdf.ts`, 1.2 KLOC) and the SVG preview
renderer (`src/preview/svg.ts`, 0.6 KLOC) are two implementations of the
same drawing pass. Both walk a `LayoutPlan`, both emit tags, cut lines,
registration marks, captions (linear and curved), back labels, and
sub-tag overlays. Every new rendering feature — circular cut shapes, hex
packing visualization, curved quiet-zone captions, recursive nested tags
— required parallel implementations in both files, with several
near-identical-but-subtly-different code paths.

Two facts make this the right moment to fix it:

1. SVG and PNG **outputs** are coming. The next user-visible feature is a
   download dropdown offering PDF, SVG (packed sheet), SVG (one per tag),
   PNG (packed sheet), PNG (one per tag). Without a refactor, that adds
   3-5 more parallel renderers; with the refactor, each new format is a
   thin backend behind the same canvas interface.

2. The family-abstraction refactor (sibling spec
   [2026-05-18-family-abstraction-design.md](./2026-05-18-family-abstraction-design.md))
   changes how bit grids reach the renderer. Doing the canvas refactor
   on the same code at the same time would couple two refactors that
   could ship cleanly on their own; doing canvas **after** family-
   abstraction lands lets each PR have a single concern.

## Goals

1. A single `Canvas` interface that captures every drawing primitive the
   PDF and SVG renderers currently use.
2. One renderer pass over a `LayoutPlan` that issues canvas calls; the
   backend (SVG / PDF / PNG) is selected per export.
3. Two export modes per vector format:
   - **Packed**: full layout sheet — cuts, registration marks, captions
     — one file per page (PDF) or per-page-zipped (SVG/PNG).
   - **Per-tag**: bare marker artwork — one file per tag, zipped if
     more than one.
4. A single export dropdown in the UI: `PDF / SVG (packed sheet) / SVG
   (one per tag) / PNG (packed sheet) / PNG (one per tag)`.

## Non-goals

- Raster-input families (DL-based markers). All families are vector at
  the geometry layer; per the family-abstraction spec, this stays true
  until a non-bit-grid family actually appears.
- Replacing pdf-lib. The PDF backend is still pdf-lib-based; the
  refactor just moves drawing calls behind the canvas interface.
- A new preview architecture. The preview keeps using the SVG backend
  and renders into the DOM exactly as today; only the implementation
  underneath the preview SVG string-builder changes.
- WebGL / GPU rendering paths. SVG (string) and PDF (pdf-lib) and PNG
  (2D canvas at chosen DPI) are the only backends.

## Design

### The `Canvas` interface

```ts
/**
 * A 2D drawing surface. Each backend (SVG, PDF, PNG-bitmap) implements
 * this interface; the renderer is written against the interface and
 * doesn't know which backend it's drawing into.
 *
 * Coordinate system: millimetres, bottom-left origin. Matches the
 * layout engine's coordinate system exactly. SVG (top-left) backends
 * apply a y-flip at the boundary so the interface stays consistent.
 *
 * State model: stateless calls. Style (stroke color, stroke width,
 * fill, font) is passed per call as an options object — no
 * push/pop, no implicit "current style". This is verbose for code
 * that draws many shapes in the same style but eliminates a class of
 * bugs (forgotten resets) and keeps backends simple.
 */
interface Canvas {
  /** Page dimensions in mm. Set once per page; new page resets the surface. */
  readonly page: { width_mm: number; height_mm: number };

  /** Filled or stroked rectangle. Axis-aligned. */
  drawRect(opts: {
    x_mm: number;
    y_mm: number;
    width_mm: number;
    height_mm: number;
    fill?: Color;
    stroke?: Color;
    strokeWidth_mm?: number;
  }): void;

  /** Filled or stroked circle. Used for circular cut lines and registration marks. */
  drawCircle(opts: {
    cx_mm: number;
    cy_mm: number;
    radius_mm: number;
    fill?: Color;
    stroke?: Color;
    strokeWidth_mm?: number;
  }): void;

  /** Open polyline (cut segments). Closed shapes use drawRect or drawPolygon. */
  drawLine(opts: {
    x0_mm: number;
    y0_mm: number;
    x1_mm: number;
    y1_mm: number;
    stroke: Color;
    strokeWidth_mm: number;
    dashed?: boolean;
  }): void;

  /**
   * Linear text. `anchor` controls horizontal alignment relative to (x, y);
   * vertical baseline is the text's baseline by default.
   * `rotation_deg` rotates around (x, y).
   */
  drawText(opts: {
    text: string;
    x_mm: number;
    y_mm: number;
    fontSize_mm: number;
    font: FontFamily;        // "sans" | "serif" | "mono"
    weight?: "regular" | "bold";
    fill?: Color;
    anchor?: "start" | "middle" | "end";
    rotation_deg?: number;
  }): void;

  /**
   * Text along a circular arc (used for quiet-zone captions around
   * circular tags). Single primitive because both SVG (textPath on a
   * circle) and PDF (per-glyph rotation around the arc) have a
   * straightforward implementation, and the geometry math (string →
   * advance widths → angles) is identical across backends. Lowering
   * to drawText in a renderer-side helper would duplicate that math.
   */
  drawCurvedText(opts: {
    text: string;
    cx_mm: number;
    cy_mm: number;
    radius_mm: number;
    startAngle_deg: number;  // 0° = +x axis, counter-clockwise
    direction: "cw" | "ccw"; // text proceeds clockwise or counter-clockwise
    fontSize_mm: number;
    font: FontFamily;
    fill?: Color;
  }): void;

  /**
   * A bit grid drawn as a marker. The backend chooses how: PDF emits
   * one filled rect per black cell; SVG rasterizes to a PNG data URI
   * and embeds as <image> (preserving today's preview performance
   * hack); PNG fills pixels directly.
   *
   * This is the **only** raster-tinged primitive in the interface and
   * it's used solely for marker bodies. Recursive nesting works by
   * issuing nested drawBitGrid calls — outer marker, then inner.
   */
  drawBitGrid(opts: {
    bits: readonly (readonly boolean[])[];
    x_mm: number;          // bottom-left of the grid
    y_mm: number;
    sizePerCell_mm: number;
    /** Optional circular clip (for circle-family markers). */
    clipCircle?: { cx_mm: number; cy_mm: number; radius_mm: number };
  }): void;
}

type Color = { r: number; g: number; b: number };  // 0..1 each
type FontFamily = "sans" | "serif" | "mono";
```

**Style as per-call options, not push/pop state.** Considered the
alternative: a `save() / restore()` stack with implicit current style.
Rejected because most current rendering code already passes style values
per call (each `drawRect` in `pdf.ts` re-specifies its color), and the
state-stack model introduces a bug class — forgetting to restore — that
the stateless model eliminates. Tradeoff: slightly more verbose
call-sites; acceptable.

**Single `drawBitGrid` primitive instead of letting the renderer emit
rects directly.** Considered the alternative: have the renderer flatten
a bit grid into N `drawRect` calls. Rejected because (a) the SVG
performance hack (rasterize-to-PNG-data-URI) lives in tag-images today
exactly because emitting thousands of `<rect>` elements is too slow for
a packed preview page — the canvas interface needs to give backends
permission to make that choice; (b) the PNG backend wants to walk the
bit grid pixel-by-pixel rather than draw N rects via a 2D context.
Treating bit-grid as one primitive lets each backend pick its best
implementation. Cost: one extra method in the interface — paid for by
the use case.

**Backends do not provide their own font metrics.** Text width
measurement is needed for layout decisions (centering, anchoring, wrap
detection). The renderer asks the canvas via:

```ts
interface Canvas {
  // ...
  measureText(opts: {
    text: string;
    fontSize_mm: number;
    font: FontFamily;
    weight?: "regular" | "bold";
  }): { width_mm: number; ascent_mm: number; descent_mm: number };
}
```

Each backend computes this with its native font system (pdf-lib's
`widthOfTextAtSize`, the browser's `<canvas>` `measureText`,
mathematical approximation for the SVG string-builder). The renderer
never sees per-backend variation.

### Renderer

A single function consumes a `LayoutPlan` and a `Canvas`, emitting all
drawing calls:

```ts
// src/render/compose.ts
export function composePage(
  plan: LayoutPlan,
  pageIndex: number,
  canvas: Canvas,
  markers: MarkerProvider,
  options: ComposeOptions,
): void;

interface MarkerProvider {
  /** Lookup is sync because the family-abstraction refactor moved load()
   *  to a separate step before rendering begins. */
  getBits(family: string, id: number): readonly (readonly boolean[])[];
}

interface ComposeOptions {
  printLabelsInQuietZone?: boolean;
  drawCalibration?: boolean;        // only true for PDF page 1
  drawCutLines?: boolean;           // false for per-tag exports
  drawRegistrationMarks?: boolean;  // false for per-tag exports
  drawCaptions?: boolean;           // false for per-tag exports
}
```

This replaces both the page-emitting logic in `render/pdf.ts` and the
page-emitting logic in `preview/svg.ts`. They become orchestrators that
construct a backend, call `composePage` for each page, and assemble the
output (one PDF document with N pages, or N separate SVG strings, etc.).

The current PDF "back page" (mirrored label sheet for duplex printing)
is its own composer function, `composeBackPage`, since it doesn't
mirror `LayoutPlan` semantically — it's a derived sheet.

### Backends

#### `SvgCanvas`

- Holds an array of SVG element strings. Calls append to the array.
- Coordinate flip: `y_svg = page.height_mm - y_mm`.
- `drawBitGrid`: rasterizes the bit grid to a PNG data URI (existing
  `bitsToRgba` + offscreen canvas, today in `preview/tag-images.ts`),
  emits one `<image>`.
- `drawCurvedText`: emits `<defs><path>` + `<text><textPath>`.
- `measureText`: in-browser uses `CanvasRenderingContext2D.measureText`;
  in Node tests, falls back to a heuristic (`text.length * fontSize *
  0.6`) that's good enough for layout decisions. Same heuristic is
  used as a fallback when no DOM is available.
- Output: a single SVG string. The container `<svg>` element wraps the
  appended children.

Replaces the current `src/preview/svg.ts` content.

#### `PdfCanvas`

- Holds a reference to a pdf-lib `PDFPage` (and the parent `PDFDocument`
  for embedded fonts / images).
- Coordinate translation: `mm → pt` (`1 mm = 72/25.4 pt`); origin
  unchanged (both bottom-left).
- `drawBitGrid`: emits one filled rect per black cell via `page.drawRectangle`.
- `drawCurvedText`: emits per-glyph `drawText` calls with rotation
  angles computed from the arc geometry. (Existing pdf.ts code for the
  circular caption is the source.)
- `measureText`: uses `font.widthOfTextAtSize` (pdf-lib).
- Output: the `PDFPage` is mutated in place; the caller flushes the
  parent document with `doc.save()`.

Replaces the inline drawing functions in `src/render/pdf.ts` (everything
under "drawTagPage", "drawBackPage", "drawCalibrationPage").

#### `PngCanvas`

- Holds an offscreen `<canvas>` element at a configurable DPI (default
  300; user-overridable in export options).
- Coordinate translation: `mm → px` (`px = mm * dpi / 25.4`); y-flip
  because `<canvas>` 2D context is top-left origin.
- `drawBitGrid`: writes pixels directly via `ImageData` for top
  performance, or via stacked `fillRect` for simplicity. Default:
  `ImageData`.
- `drawCurvedText`: per-glyph `ctx.fillText` with `ctx.translate +
  ctx.rotate` around each glyph position.
- `measureText`: `ctx.measureText`.
- Output: `canvas.toBlob("image/png")` → Blob, ready to download.

New file: `src/render/png-canvas.ts`.

### Export modes

The export pipeline is two steps: **compose** (renderer pass) and
**package** (file or zip).

```ts
// Public API consumed by main.ts
export interface ExportRequest {
  plan: LayoutPlan;            // ignored by per-tag modes
  markers: MarkerProvider;
  format: "pdf" | "svg" | "png";
  mode: "packed" | "per-tag";
  options: {
    printLabelsInQuietZone?: boolean;
    printLabelsOnBack?: boolean;   // PDF packed only
    pngDpi?: number;                // PNG only; default 300
    perTagQuietZone?: boolean;      // per-tag only; default true
  };
}

export async function runExport(req: ExportRequest): Promise<{
  filename: string;
  blob: Blob;
}>;
```

The five user-facing options collapse to two enums (format + mode) on
this interface.

#### Packed mode

For PDF, SVG, PNG. Walks the whole `LayoutPlan` exactly as `pdf.ts`
does today.

- PDF: one document with N pages (calibration sheet + N layout pages +
  optional back pages).
- SVG: N SVG strings, one per layout page. Bundled into a `.zip` with
  names `page-1.svg` ... `page-N.svg`. If N=1, the lone SVG is offered
  directly (no zip).
- PNG: N PNGs, same packaging rule. Calibration sheet is included as
  `calibration.png` when N>1 (so the user gets it); skipped for N=1
  to avoid forcing a zip for one tag.

#### Per-tag mode

For SVG and PNG only (PDF stays packed-only — a per-tag PDF is a
several-MB document of mostly-empty pages, useless). Skips the layout
pipeline entirely:

```ts
function composePerTag(
  family: string,
  id: number,
  bits: readonly (readonly boolean[])[],
  canvas: Canvas,
  options: { withQuietZone: boolean }
): void;
```

Each marker is drawn at its natural size into a canvas sized to fit
exactly the marker (plus optional quiet zone). One file per
marker, named `${family}-${id}.svg` or `.png`. Always zipped if
more than one tag was requested, even for two.

#### Zip implementation

Add `fflate` as a dependency. It's 15 KB minified, has a synchronous
zip API, and is well-maintained. The alternative, JSZip, is ~25 KB and
async-by-default; fflate is the better fit for browser-only use.

Justification for the dep: the alternative is "no zip, multi-page SVG
in a single `<g>`-per-page document, no per-tag mode at all" — which
loses one of the two motivations for this refactor. fflate's footprint
is acceptable.

### UI: the export dropdown

In `src/main.ts`, the current "Download PDF" button becomes a small
dropdown:

```
Download as: [ PDF ▾ ]
             PDF
             SVG (packed sheet)
             SVG (one per tag)
             PNG (packed sheet)
             PNG (one per tag)
```

PNG mode reveals a "Resolution" sub-input (default 300 DPI). Per-tag
modes reveal a "Include quiet zone" checkbox (default on).

The existing "print labels on back" / "print labels in quiet zone"
checkboxes stay where they are; they're disabled when the selected mode
doesn't support them (per-tag, non-PDF).

### Coordinate system: bottom-left mm, justified

The layout engine is bottom-left mm. PDF is bottom-left points
(perfect match modulo unit scale). SVG and `<canvas>` are top-left.
The choice for the interface is bottom-left because:

1. Two of three backends naturally use it.
2. The renderer reads from `LayoutPlan` whose coordinates are
   bottom-left; pass-through requires no conversion.
3. The current SVG renderer already applies a `flipY` at the boundary
   (see `preview/svg.ts:56`); we're keeping that approach.

The flip happens once, inside `SvgCanvas` and `PngCanvas`, never in the
renderer.

## Files changed

| File | Change |
|------|--------|
| `src/render/canvas.ts` | New. The `Canvas` interface, `Color`, `FontFamily` types. |
| `src/render/svg-canvas.ts` | New. SvgCanvas implementation. |
| `src/render/pdf-canvas.ts` | New. PdfCanvas implementation. |
| `src/render/png-canvas.ts` | New. PngCanvas implementation. |
| `src/render/compose.ts` | New. The single `composePage` renderer; replaces the page-emitting code in pdf.ts and svg.ts. |
| `src/render/compose-per-tag.ts` | New. `composePerTag` for the per-tag export mode. |
| `src/render/pdf.ts` | Drastically thinned: just the top-level `renderPlan` orchestrator that constructs a `PdfDocument`, iterates pages, instantiates `PdfCanvas` per page, calls `composePage`. All drawing logic moves to `compose.ts` and `pdf-canvas.ts`. |
| `src/preview/svg.ts` | Drastically thinned: just instantiates `SvgCanvas` and calls `composePage`. The current page-walking logic moves to `compose.ts`. |
| `src/preview/tag-images.ts` | Deleted. Its rasterize-bit-grid-to-PNG logic moves into `SvgCanvas.drawBitGrid`. The `bitsToRgba` helper moves to `src/render/bits-to-rgba.ts` as a pure utility shared by `SvgCanvas` and `PngCanvas`. |
| `src/export.ts` | New. The `ExportRequest` / `runExport` public API. Owns the format-and-mode switch, the zip bundling, and filename generation. |
| `src/main.ts` | Replaces the existing download button + handler with the dropdown + sub-options. Calls `runExport` instead of `renderPlan` directly. |
| `package.json` | Adds `fflate` dependency. |
| `src/render/pdf.test.ts` | Adjusts to test the new orchestration. Drawing primitives are tested via the canvas backends instead. |
| `src/render/canvas.test.ts` | New. Per-backend property tests: drawing the same primitive into all three backends produces output with consistent geometry (rect at (x,y) with width w produces output whose bounding box matches, within rounding). |
| `src/render/compose.test.ts` | New. Tests for the unified renderer pass. |

### Files NOT changed

- `src/families/*` — separate refactor. The MarkerProvider interface
  in `composePage` is just a thin wrapper around the post-refactor
  `Family.getMarker`.
- `src/layout/*` — pure geometry, unchanged.
- `src/ids.ts`, `src/tag-caption.ts` — unchanged.

## Testing

| Layer | Test type | Notes |
|-------|-----------|-------|
| Each canvas backend | Per-primitive tests | Each backend's `drawRect` produces an output whose bounding box / pixel sum / element count matches expectations. |
| Canvas conformance | Cross-backend property test | Given identical inputs, all three backends produce outputs that agree on geometric properties — same number of distinct drawn shapes, same bounding boxes (within rounding). Catches a backend drifting from the spec. |
| `composePage` | Snapshot tests | One per representative `LayoutPlan` (square family / circle family / recursive nested / multi-page). Snapshots are SVG strings (smallest, most diff-friendly). |
| `composePerTag` | Per-format tests | A 2-tag request produces a 2-file zip; a 1-tag request produces a single file; quiet-zone option is honored. |
| `runExport` end-to-end | Integration tests | Build a small plan, request each format/mode combo, assert the right MIME type and filename pattern. PDF parse-round-trip stays (it's the load-bearing PDF correctness check). |
| Legacy | Existing PDF + SVG tests | Migrated to call the new composer; outputs must remain byte-identical or visually identical. **Acceptance criterion: zero regressions in the existing 109-test suite (some tests will be rewritten, but expected outputs are unchanged).** |

## Verification before opening a PR

1. `npm test` — all existing + new tests pass.
2. `npm run lint` — clean.
3. `npm run build` — clean. Bundle size should grow by ~15 KB (fflate)
   plus the new code; verify the growth is in that range.
4. Manual `npm run dev` smoke test:
   - PDF download still works, matches the pre-refactor PDF visually.
   - SVG (packed) downloads a zip; opens correctly in Inkscape.
   - SVG (per-tag) for 1 tag → single .svg; for >1 tag → zip; each
     individual SVG opens cleanly.
   - PNG (packed) downloads a zip; image dimensions match (mm × DPI / 25.4).
   - PNG (per-tag) similarly.
   - Recursive nested tags render correctly in every format.

## Implementation order (within the canvas+exports PR)

This sub-sequence keeps the working tree green throughout:

1. Introduce `canvas.ts` with the `Canvas` interface and helper types.
   Empty `SvgCanvas`, `PdfCanvas` skeletons — no behavior.
2. Migrate one primitive at a time (drawRect → drawCircle → drawLine →
   drawText → drawCurvedText → drawBitGrid → measureText) into both
   backends. After each, write the conformance test for that primitive.
3. Build `composePage`. Wire it into a new "canvas-mode" code path in
   `render/pdf.ts` alongside the existing legacy code path, gated by a
   compile-time constant. Tests pass on both paths.
4. Flip the constant; legacy path becomes unreachable. Run full test
   suite.
5. Delete the legacy drawing code. Delete `src/preview/tag-images.ts`
   and move `bitsToRgba` to its new home.
6. Add `PngCanvas`. New tests.
7. Add `composePerTag` and `src/export.ts`. New tests.
8. Add `fflate`. Add the export dropdown UI in `main.ts`.
9. Final manual smoke test.

## Dependency on family-abstraction refactor

This refactor consumes the post-family-abstraction `Family` interface
(via the thin `MarkerProvider` wrapper). It must land **after** the
family-abstraction PR to avoid a midflight rewrite of how bit grids
reach the renderer. Sequencing:

```
improvements
└── family-abstraction-impl     (depends on: family-abstraction spec)
    └── aruco-implementation    (depends on: family-abstraction-impl)
└── canvas-and-exports-impl     (depends on: family-abstraction-impl)
    └── any future format       (e.g. EPS, DXF — same canvas trick)
```

`aruco-implementation` and `canvas-and-exports-impl` are independent
once family-abstraction is in; they can land in either order.

## Open questions

These need user input before implementation starts.

1. **Calibration sheet in non-PDF exports.** Today the PDF starts with
   a calibration sheet (a 100mm reference square + rulers, used to
   verify printer scaling). Options:
   - PDF only: keep the calibration sheet as today, omit from SVG/PNG packed exports.
   - All formats: include it as `calibration.svg` / `calibration.png` in the zip.
   - User toggle: a "Include calibration sheet" checkbox.

   **Recommendation:** PDF-only. The calibration sheet exists to detect
   printer auto-scaling, which is mostly a PDF-print-driver concern;
   someone using SVG or PNG is feeding the artwork into a different
   pipeline that doesn't have the same risk. Simpler.

2. **PNG DPI default and range.** Default 300 DPI is print-standard;
   range cap matters because high DPI on a packed sheet blows up the
   PNG.
   - Lo (150) – Mid (300) – Hi (600) preset buttons.
   - Numeric input with a default of 300 and a soft warning above 1200.

   **Recommendation:** numeric input with default 300, soft warning
   when the projected file size > 50 MB.

3. **Per-tag SVG/PNG: include caption?** Today's PDF lets the user toggle
   "print labels in quiet zone". The per-tag export could:
   - Always include the caption (legible artwork).
   - Never include it (bare marker, for embedding).
   - Toggle.

   **Recommendation:** toggle, default off. Per-tag exports are
   typically used for embedding into documents or robot configs where
   a caption is unwanted; users who want labels can turn it on.

4. **PDF size and back-label modes in non-PDF formats.** Both today's
   PDF-only options (`printLabelsOnBack`, `printLabelsInQuietZone`)
   should be exposed differently for the new formats. Proposed:
   - `printLabelsOnBack`: PDF only; greyed out in dropdown when SVG/PNG.
   - `printLabelsInQuietZone`: works in packed mode for any format;
     in per-tag mode is the same as the per-tag-caption toggle above.

   **Recommendation:** as proposed. Confirm or correct.

5. **Filename conventions.** Suggested:
   - `tags.pdf`
   - `tags-svg.zip` (or single `tags.svg` for one page)
   - `tags-png.zip` (or single `tags.png` for one page)
   - `tags-per-tag-svg.zip`
   - `tags-per-tag-png.zip`
   - Inside zip: `page-1.svg`, `tag36h11-0.svg`, etc.

   Open to renaming. Confirm or suggest alternatives.

6. **fflate vs JSZip vs no-zip.** Confirmed during questions that we
   want zip packaging. Recording the dep choice (fflate) here for
   review; flag if you'd prefer JSZip or a vendored implementation.

## Follow-ups (separate branches)

1. **Family-abstraction refactor must land first**
   ([2026-05-18-family-abstraction-design.md](./2026-05-18-family-abstraction-design.md)).

2. **EPS / DXF outputs**, if anyone asks. They'd be one more canvas
   backend each — under 200 lines apiece given the interface this
   spec establishes.

3. **Live SVG export from the preview**. The preview already has an
   `SvgCanvas` instance (post-refactor); exposing "save current
   preview as SVG" is one button. Decide whether that obviates the
   "SVG (packed sheet)" download or is a complement.
