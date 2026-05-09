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
 *  (e.g. "tag36h11"); `id` is the index within that family. */
export interface TagSpec {
  family: string;
  id: number;
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
 *  - cutMargin_mm: extra white paper outside the quiet zone where the
 *    blade travels. After trimming, the tag retains its quiet zone and
 *    loses (most of) the cut margin. Adjacent tags share a single cut
 *    line through the boundary between their cut-margin regions.
 */
export interface LayoutOptions {
  pageMargin_mm: number;
  quietZone_mm: number;
  cutMargin_mm: number;
}

/**
 * One tag's position on a page. (x_mm, y_mm) is the lower-left corner of
 * the tag *bitmap* — quiet zone and cut margin extend outward from there.
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

export interface LayoutPlan {
  paper: Paper;
  options: LayoutOptions;
  /** Side length of every tag bitmap on every page. Small-tag mode is
   *  uniform — all tags share one size — so the size lives on the plan
   *  rather than per-placement. */
  tagSize_mm: number;
  pageCount: number;
  placements: Placement[];
  cutSegments: CutSegment[];
}
