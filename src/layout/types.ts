/**
 * Domain types for the small-tag layout engine.
 *
 * Conventions:
 *  - All distances are millimeters; field names carry the `_mm` suffix.
 *  - Page coordinates have origin at the lower-left of the page.
 *  - The layout engine is unaware of PDF, SVG, or rendering — it returns
 *    pure geometry that downstream renderers consume.
 */

/** A specific tag to render. `family` is an AprilTag family identifier
 *  (e.g. "tag36h11"); `id` is the index within that family. For recursive
 *  families, `subtag` holds a nested tag to render inside the center block. */
export interface TagSpec {
  family: string;
  id: number;
  subtag?: TagSpec;
}

export interface Paper {
  width_mm: number;
  height_mm: number;
}

/**
 * Distinct margin parameters. All values are non-negative millimeters; the
 * caller chooses each independently — they are never collapsed into a
 * single "buffer" value.
 *
 *  - pageMargin_mm: paper edge → printable area on every side. Cuts and
 *    tags both stay inside this margin.
 *  - quietZone_mm: required white border around each tag bitmap (AprilTag
 *    detection requires this; cutting must not slice into it).
 *  - cutMargin_mm: paper gap between the cut lines of adjacent tags. With
 *    `cutMargin_mm = 0` (the default), adjacent cuts collapse to a single
 *    shared line; with `> 0`, each tag has its own cut and the gap between
 *    a tag's right cut and its right-neighbour's left cut is exactly this
 *    value. Cuts hug each tag's quiet zone — the margin no longer adds
 *    slack outside the cut line.
 *  - packingStrategy: how tags are arranged on the page. `"grid"` packs
 *    on a square lattice and is the only meaningful strategy for square
 *    cut shapes. `"hex"` packs circles on a hexagonal lattice (~15% more
 *    tags per page) and is only valid for circle cut shapes; passing it
 *    with a square cut shape is rejected. When omitted, the planner
 *    defaults to `"hex"` for circles and `"grid"` for squares.
 */
export interface LayoutOptions {
  pageMargin_mm: number;
  quietZone_mm: number;
  cutMargin_mm: number;
  packingStrategy?: "grid" | "hex";
}

/**
 * One tag's position on a page. (x_mm, y_mm) is the lower-left corner of
 * the printed tile — quiet zone and cut margin extend outward from there.
 */
export interface Placement {
  tag: TagSpec;
  page: number;
  x_mm: number;
  y_mm: number;
}

/** A line segment to cut, in page-space mm. */
export interface CutSegment {
  page: number;
  x0_mm: number;
  y0_mm: number;
  x1_mm: number;
  y1_mm: number;
}

/** A circular cut around a single tag, in page-space mm. Used by the
 *  Circle-family layout; empty for square plans. */
export interface CutCircle {
  page: number;
  cx_mm: number;
  cy_mm: number;
  radius_mm: number;
}

/** One level of sub-tag nesting, carrying the geometry needed for info
 *  display and PDF footer. Computed by the UI; consumed by renderers. */
export interface SubtagLevel {
  familyName: string;
  tileSize_mm: number;
  tagSize_mm: number;
}

export interface LayoutPlan {
  paper: Paper;
  options: LayoutOptions;
  /** Side length of every printed tile on every page — the full mosaic
   *  tile drawn for each tag (data ring, black border, and any white
   *  ring the family ships with). Layout and rendering geometry use
   *  this; small-tag mode is uniform, so the size lives on the plan
   *  rather than per-placement. */
  tileSize_mm: number;
  /** AprilTag-spec "tag size" — the distance between detection corners
   *  (= edge between white border and black border). Strictly smaller
   *  than `tileSize_mm` whenever the tile carries extra modules outside
   *  the black border (Standard / Custom families) or a white outer ring
   *  (tag36h11). Used for the size shown in labels; never for layout
   *  geometry. */
  tagSize_mm: number;
  pageCount: number;
  placements: Placement[];
  cutSegments: CutSegment[];
  /** Empty for square plans; one entry per placement for circle plans. */
  cutCircles: CutCircle[];
  /** Sub-tag nesting levels, outermost first. Empty when no sub-tags. */
  subtagLevels: SubtagLevel[];
}
