# Circular AprilTag families — design

Date: 2026-05-17
Branch: `families/circular-tags` (off `new-families`)
Scope: support the AprilTag *Circle* families (`tagCircle21h7`,
`tagCircle49h12`) end-to-end — registry, layout, PDF, preview, UI — with
circular cut lines and circular quiet zones, while keeping the page
arrangement on a square grid.

## Prerequisite (out of scope for this spec)

A separate branch lands first and redefines `cutMargin_mm` semantics:

- `cutMargin_mm` is the paper gap between adjacent cut shapes. It no
  longer adds to the outer cut frame and no longer adds slack on each
  side of every cut. At `cutMargin_mm = 0`, adjacent cuts share a single
  line.
- Default `cutMargin_mm = 0` (today it is `0.5`).
- The per-tag caption currently drawn in the cut-margin band
  (`render/pdf.ts` `drawTag`'s label block, and the mirrored block in
  `preview/svg.ts` `renderTagLabel`) is removed entirely.

This spec assumes the prerequisite has landed. The cell-pitch formulas
below are stated in terms of the new `cutMargin_mm` semantic.

## Background

The two Circle families ship as the same mosaic format as every other
family: a grid of square `tileSize_px × tileSize_px` tiles separated by
1-pixel black gridlines. The tile bitmap is a low-resolution circle:
black/white modules approximate a circular region, with the **corner
pixels of the tile** as white background that simply does not draw. Inside
the circle, the same canonical AprilTag detection pattern appears as in
square families — a black-bordered square whose edge length is the
family's `widthAtBorder_modules`. The detector reads the inner square; the
outer ring is the family's structural identifier.

Two values fully describe the printed geometry of a Circle family:

- `widthAtBorder_modules` — the canonical detection edge, in module
  units. Already in `TagFamilyDef`; same meaning as for square families.
- `outerRadius_modules` — the radius, in module units, of the smallest
  circle centered on the tile center that encloses every printed (black)
  pixel across all valid tags in the family. Always
  `≤ tileSize_px · √2 / 2`; for the upstream Circle families it is close
  to `tileSize_px / 2` because the design fills the tile.

The cut shape and quiet-zone shape follow the tag shape. The cut is a
circle of radius `outerRadius_mm + quietZone_mm`, where
`outerRadius_mm = outerRadius_modules · (tile_mm / tileSize_px)`. A quiet
zone of 0 mm puts the cut right at the most distant printed pixel; a
quiet zone of 1 mm leaves 1 mm of paper between that pixel and the cut.

Page arrangement stays on a square grid: every tile is square, every
cell is square, and the planner packs cells the same way it does today.

## Decisions

- **Scope** — only the two Circle families. Square families are
  unaffected. The cut shape is determined by the family, not exposed as
  a separate UI option.
- **Tag size input** — unchanged. "Tag size (mm)" is the canonical
  detection edge for every family, square and circle alike.
- **Total size sync** — becomes family-aware:
  - Square: `Total = tile + 2·quietZone` (today's formula).
  - Circle: `Total = 2·(outerRadius_mm + quietZone_mm)` (= the cut
    diameter).
- **`printLabelsInQuietZone`** — hidden / disabled when a Circle family
  is selected. The label currently lives in the bottom band of the
  tile's quiet zone; for a Circle family that band falls outside the cut
  circle, so the label would not survive on the cut-out tag.
- **`printLabelsOnBack`** — unchanged behaviour. The per-tile label is
  centered on the tile center, which equals the cut-circle center, so it
  lands inside the cut tag on the back.

## Architecture

### `src/families/index.ts`

Two new fields on `TagFamilyDef`:

```ts
export interface TagFamilyDef {
  // ...existing fields...
  shape: "square" | "circle";
  /** Required when shape === "circle". Radius (in modules) of the
   *  smallest circle, centered on the tile center, that encloses every
   *  printed pixel across all valid tags in the family. Absent for
   *  square families. */
  outerRadius_modules?: number;
}
```

The two circle entries:

```ts
tagCircle21h7: {
  name: "tagCircle21h7",
  mosaicPath: `${import.meta.env.BASE_URL}resources/tagCircle21h7_mosaic.png`,
  tileSize_px: 9,
  widthAtBorder_modules: <measured>,
  outerRadius_modules: <measured>,
  validTagCount: 38,
  shape: "circle",
  group: "Circle",
},
tagCircle49h12: {
  name: "tagCircle49h12",
  mosaicPath: `${import.meta.env.BASE_URL}resources/tagCircle49h12_mosaic.png`,
  tileSize_px: 11,
  widthAtBorder_modules: <measured>,
  outerRadius_modules: <measured>,
  validTagCount: 65535,
  shape: "circle",
  group: "Circle",
},
```

A `shape: "square"` field is added to the four existing families. No
default — existing families opt in explicitly so adding a family forces a
decision about its shape.

`widthAtBorder_modules` for the Circle families is measured the same way
it would be for any new family: by inspecting the printed bitmap and
counting modules between the inner black-bordered square's edges. The
measurement script below records and prints both numbers.

### `scripts/measure-circle-geometry.ts`

One-shot script (similar pattern to `scripts/fetch-mosaics.ts`). For each
Circle family:

1. Load the mosaic PNG and decode it via the same routine
   `src/families/load.ts` uses.
2. For each valid tag (`0 ≤ id < validTagCount`), extract the
   `tileSize_px × tileSize_px` bit grid with `extractTagBits`.
3. Compute `outerRadius_modules` as
   `max over all black pixels (cx, cy) of distance from tile center
   ((tileSize_px − 1) / 2, (tileSize_px − 1) / 2) to the outer corner of
   the pixel`. Pixel (col, row) has outer-corner distance
   `√((|col − cx| + 0.5)² + (|row − cy| + 0.5)²)`.
4. Detect `widthAtBorder_modules` by finding the largest concentric
   solid black axis-aligned square outline shared by all valid tags
   (i.e., the inner detection border). If detection is ambiguous, the
   script prints a diagnostic; the human supplies the value manually.
5. Print a registry-entry snippet ready to drop into
   `src/families/index.ts`, the same way `fetch-mosaics.ts` does.

Output is committed once to the registry; the script is not part of the
runtime build. Re-running it any time the upstream mosaics change is
cheap.

### `src/layout/types.ts`

```ts
/** A circular cut around a single tag, in page-space mm. */
export interface CutCircle {
  page: number;
  cx_mm: number;
  cy_mm: number;
  radius_mm: number;
}

export interface LayoutPlan {
  // ...existing fields...
  /** Empty for square plans. */
  cutCircles: CutCircle[];
}
```

`cutSegments` stays as-is. Square plans set `cutCircles = []`; circle
plans set `cutSegments = []`. Each renderer iterates whichever is
non-empty; no renderer needs to branch on a shape flag.

### `src/layout/plan.ts`

`planSmallTagLayout` gains a `cutShape` parameter:

```ts
export type CutShape =
  | { kind: "square" }
  | { kind: "circle"; outerRadius_mm: number };

export function planSmallTagLayout(
  tags: readonly TagSpec[],
  tileSize_mm: number,
  paper: Paper,
  options: LayoutOptions,
  tagSize_mm: number,
  cutShape: CutShape,
): LayoutPlan { ... }
```

`cutShape` is the only new argument. Defaults are deliberately not
provided — every caller already knows the family and therefore the shape.

Per-tag span and cell pitch:

- Square: span = `tileSize_mm + 2 · quietZone_mm`; pitch =
  `span + cutMargin_mm`.
- Circle: span = `2 · (outerRadius_mm + quietZone_mm)`; pitch =
  `span + cutMargin_mm`.

The square case matches what the post-prerequisite planner does. The
circle case is parallel.

Fit check (existing `validateInputs`) becomes:
`pitch + 2 · pageMargin_mm ≤ min(paper.width_mm, paper.height_mm)`.
Span and pitch come from a small helper `cellGeometry(cutShape,
tileSize_mm, options)` so the formula appears once.

Cut emission:

- Square: existing line-cut grid, post-prerequisite (one cut per tile
  boundary; adjacent boundaries are separated by `cutMargin_mm`, or
  collapsed to a single line at `cutMargin_mm = 0`).
- Circle: one `CutCircle` per `Placement`, centered at the tile center
  (`x_mm + tile_mm/2, y_mm + tile_mm/2`), radius =
  `outerRadius_mm + quietZone_mm`. No deduplication — circles never
  share boundaries.

`maxTagSizeForCount` (the inverse query) takes the same `cutShape`
argument. The binary-search predicate uses the same `cellGeometry`
helper.

### `src/render/pdf.ts`

Inside `drawTagPage`, after the existing `for (const c of
plan.cutSegments)` loop, add:

```ts
for (const c of plan.cutCircles) {
  if (c.page !== pageIndex) continue;
  page.drawCircle({
    x: mm(c.cx_mm),
    y: mm(c.cy_mm),
    size: mm(c.radius_mm),
    borderColor: rgb(0.55, 0.55, 0.55),
    borderWidth: 0.25,
  });
}
```

(pdf-lib's `drawCircle` takes `size` as the radius. Same grey and
thickness as the line cuts so the visual weight matches.)

The back-page mirror (`drawBackPage`) gets the same loop, with the
mirrored x: `cx_back = W − cx_front`, `cy` unchanged.

The bitmap-drawing function (`drawTag`) is unchanged: the tile is square
for every family, and the corner pixels of a Circle tile are background
white that produces no rectangles.

The `drawQuietZoneLabel` call site is guarded by the family shape: skip
for circle families. The label-emission logic itself does not need to
know about shape.

### `src/preview/svg.ts`

After the existing `cutLines` block, build a parallel `cutCirclesSvg`:

```ts
const cutCirclesSvg = plan.cutCircles
  .filter((c) => c.page === page)
  .map(
    (c) =>
      `<circle cx="${c.cx_mm}" cy="${flipY(c.cy_mm)}" r="${c.radius_mm}" ` +
      `fill="none" stroke="${CUT_LINE}" stroke-width="0.25"/>`,
  )
  .join("");
```

Concatenate it into the assembled SVG alongside `cutLines`.

The quiet-zone label (`renderQuietZoneLabel`) suppression is handled at
the call site: pass `opts.printLabelsInQuietZone = false` when the
family is circular. The svg module itself stays family-agnostic.

### `src/main.ts`

- Resolve `cutShape` from the selected family's `shape` and
  `outerRadius_modules`, scaled into `outerRadius_mm` via the same
  `tile_mm / tileSize_px` factor used elsewhere. Pass through to
  `planSmallTagLayout`.
- "Total size" sync (`totalSizeFromTag` and `handleTotalSizeInput`)
  branches on `familyDef.shape`:
  - Square (today's formula): unchanged.
  - Circle:
    - From tag size →
      `outerRadius_mm = outerRadius_modules · (tile_mm / tileSize_px)`,
      with `quietZone_mm` auto-derived as today (`0.5 ·
      tagSize_mm / widthAtBorder_modules`) or read from the override.
      `Total = 2 · (outerRadius_mm + quietZone_mm)`.
    - From total size → solve for `tagSize_mm`. With the auto-derived
      quiet zone the relation is linear in `tagSize_mm`:
      `Total = 2 · (outerRadius_modules + 0.5) · tagSize_mm /
      widthAtBorder_modules`, so
      `tagSize_mm = Total · widthAtBorder_modules /
      (2 · (outerRadius_modules + 0.5))`.
      With the override on (explicit quiet zone), Total →
      `outerRadius_mm = Total/2 − quietZone_mm`, and from there
      `tagSize_mm = outerRadius_mm · widthAtBorder_modules /
      outerRadius_modules`.
- Hide the `printLabelsInQuietZone` row (and uncheck the checkbox) when
  the selected family has `shape: "circle"`. Re-show it when the user
  switches back.
- Status-line summary's "printed cell" reads the same way; the cell
  pitch from `cellGeometry` is suitable for both shapes.

No other UI changes. The form, family picker, and download flow stay
the same.

## Testing

Tests are written before each unit per CLAUDE.md (TDD).

### `src/families/index.test.ts`

- A synthesised mosaic fixture with a known black-pixel pattern produces
  the expected `outerRadius_modules` via the same algorithm the
  measurement script uses (extract that algorithm into a pure helper in
  `families/index.ts` so the test can exercise it without I/O).
- Round-trip: a tile with a single black pixel at the corner gives
  `outerRadius_modules = √((centerOffset + 0.5)² + (centerOffset + 0.5)²)`.

### `src/layout/plan.test.ts`

- Circle plan with N tags on one page emits exactly N `CutCircle`s with
  centers at the expected `(x_mm + tile/2, y_mm + tile/2)` and radius
  `outerRadius_mm + quietZone_mm`. `cutSegments` is empty.
- Cell-pitch formula: for `outerRadius_mm = 10`, `quietZone_mm = 2`,
  `cutMargin_mm = 1`, the pitch is `2·(10+2) + 1 = 25`.
- Fit check: a circle that does not fit on the paper raises the same
  shape of error the square branch raises today (input names; the
  numeric values are the circle ones).
- `maxTagSizeForCount` with `cutShape.kind === "circle"` is monotone and
  finds the largest size that fits.

### `src/render/pdf.test.ts`

- Rendering a circle plan with N placements produces a valid PDF whose
  content stream contains the expected number of circle-painting
  operators (or, more loosely, parses with pdf-lib and reports the right
  page count). Exact byte-level assertion is brittle; assert the
  high-level invariant.
- Back-page mirror: the circle centers on the back are reflected across
  the page's vertical midline.

### `src/preview/svg.test.ts`

- Rendering a circle plan produces SVG with exactly N `<circle>` nodes
  per page.
- The quiet-zone label is absent regardless of
  `opts.printLabelsInQuietZone` when the plan is circular (because the
  call site suppresses it before calling the SVG renderer; this test
  covers `main.ts`, not `svg.ts`).

## Implementation order

1. **Types + measurement script.** Add `CutCircle` and `cutCircles` to
   the layout types, add `shape` + `outerRadius_modules` to
   `TagFamilyDef`, write `scripts/measure-circle-geometry.ts`, run it,
   commit the measured values into the registry. (Square families opt
   in to `shape: "square"` in the same commit.)
2. **Planner.** Extract `cellGeometry`; thread `cutShape` through
   `planSmallTagLayout` and `maxTagSizeForCount`; add circle-branch cut
   emission. Tests first.
3. **Renderers.** Add the circle loops in `render/pdf.ts` (front and
   back) and `preview/svg.ts`. Tests first.
4. **UI.** Family-aware total-size sync, family-aware
   `printLabelsInQuietZone` visibility, derive `cutShape` from the
   family. Manual browser check at this point: pick each Circle family,
   verify cuts look circular, verify the cut diameter shown matches
   Total, verify PDF round-trips.

Each step ends in a green test run and a commit.

## Explicitly out of scope

- Multi-page (large) circular tags. The architecture leaves
  `planSmallTagLayout` named as it is and assumes the future large-tag
  planner will introduce its own shape handling.
- ArUco-style families.
- Circular cuts for square families (a user-toggle decoupled from the
  family). The shape stays family-determined.
- Changes to the calibration page or the registration marks.
