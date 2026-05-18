import type {
  CutCircle,
  CutSegment,
  LayoutOptions,
  LayoutPlan,
  Paper,
  Placement,
  TagSpec,
} from "./types";

function require_(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** The cut shape determines how each cell's boundary is drawn on the page.
 *  Square families get line-cut grids; Circle families get one circular cut
 *  per placement. */
export type CutShape =
  | { kind: "square" }
  | { kind: "circle"; outerRadius_mm: number };

/**
 * Cell geometry helpers. For a square family the cell width is
 * `tileSize + 2·quietZone` and the cut follows the cell boundary. For a
 * circle family the cell is the smallest axis-aligned square that contains
 * the circular cut — `2·(outerRadius + quietZone)` — so the pitch stays
 * `cellWidth + cutMargin` in both cases and the page grid is uniform.
 */
function cellWidth_mm(
  tileSize_mm: number,
  options: LayoutOptions,
  cutShape: CutShape,
): number {
  if (cutShape.kind === "circle") {
    return 2 * (cutShape.outerRadius_mm + options.quietZone_mm);
  }
  return tileSize_mm + 2 * options.quietZone_mm;
}

function pitch_mm(
  tileSize_mm: number,
  options: LayoutOptions,
  cutShape: CutShape,
): number {
  return cellWidth_mm(tileSize_mm, options, cutShape) + options.cutMargin_mm;
}

/** Largest N such that `N · cellWidth + (N − 1) · cutMargin ≤ printable`. */
function tagsPerAxis(
  printable_mm: number,
  tileSize_mm: number,
  options: LayoutOptions,
  cutShape: CutShape,
): number {
  const cell = cellWidth_mm(tileSize_mm, options, cutShape);
  if (printable_mm < cell) return 0;
  const pitch = pitch_mm(tileSize_mm, options, cutShape);
  return Math.floor((printable_mm + options.cutMargin_mm) / pitch);
}

function validateInputs(
  tileSize_mm: number,
  paper: Paper,
  options: LayoutOptions,
  cutShape: CutShape,
): void {
  require_(tileSize_mm > 0, `tileSize_mm must be positive (got ${tileSize_mm})`);
  require_(
    paper.width_mm > 0 && paper.height_mm > 0,
    `paper dimensions must be positive (got ${paper.width_mm} × ${paper.height_mm})`,
  );
  for (const k of ["pageMargin_mm", "quietZone_mm", "cutMargin_mm"] as const) {
    require_(options[k] >= 0, `options.${k} must be non-negative (got ${options[k]})`);
  }
  if (cutShape.kind === "circle") {
    require_(
      cutShape.outerRadius_mm >= 0,
      `outerRadius_mm must be non-negative (got ${cutShape.outerRadius_mm})`,
    );
  }
  const minSide_mm = Math.min(paper.width_mm, paper.height_mm);
  const required_mm = cellWidth_mm(tileSize_mm, options, cutShape) + 2 * options.pageMargin_mm;
  require_(
    required_mm <= minSide_mm + 1e-9,
    `tag does not fit on paper: cell + page margins is ${required_mm.toFixed(2)}mm, ` +
      `paper minimum side is ${minSide_mm}mm. ` +
      `Reduce tileSize_mm, quietZone_mm, or pageMargin_mm.`,
  );
}

/**
 * Lay out `tags` onto pages of `paper` with the given margins.
 *
 * `tileSize_mm` is the printed dimension of each tag's tile (the bitmap
 * pulled from the mosaic, including any white ring). For circle families the
 * tile is square; the circular cut and its enclosing cell are derived from
 * `cutShape.outerRadius_mm + quietZone_mm`.
 *
 * `tagSize_mm` is the AprilTag-spec tag size between detection corners; used
 * only for labels. Defaults to `tileSize_mm` so existing callers that don't
 * separate the two keep working.
 */
export function planSmallTagLayout(
  tags: readonly TagSpec[],
  tileSize_mm: number,
  paper: Paper,
  options: LayoutOptions,
  tagSize_mm: number = tileSize_mm,
  cutShape: CutShape = { kind: "square" },
): LayoutPlan {
  validateInputs(tileSize_mm, paper, options, cutShape);

  const printable_x_mm = paper.width_mm - 2 * options.pageMargin_mm;
  const printable_y_mm = paper.height_mm - 2 * options.pageMargin_mm;
  const cols = tagsPerAxis(printable_x_mm, tileSize_mm, options, cutShape);
  const rows = tagsPerAxis(printable_y_mm, tileSize_mm, options, cutShape);
  require_(cols >= 1 && rows >= 1, "no tags fit in printable area");

  const perPage = cols * rows;
  const cell = cellWidth_mm(tileSize_mm, options, cutShape);
  const pitch = pitch_mm(tileSize_mm, options, cutShape);
  // Block bounds: N cells with (N−1) cutMargin gaps between them.
  const block_w_mm = cols * cell + (cols - 1) * options.cutMargin_mm;
  const block_h_mm = rows * cell + (rows - 1) * options.cutMargin_mm;
  const block_x0_mm = options.pageMargin_mm;
  const block_y0_mm = options.pageMargin_mm;
  // Tile offset from cell origin — centres the tile within its cell.
  // For squares this equals quietZone_mm; for circles it is larger, centering
  // the cut circle within the cell.
  const tileOffset = (cell - tileSize_mm) / 2;

  const pageCount = tags.length === 0 ? 0 : Math.ceil(tags.length / perPage);
  const placements: Placement[] = tags.map((tag, i) => {
    const page = Math.floor(i / perPage);
    const idxOnPage = i % perPage;
    const col = idxOnPage % cols;
    // Reading order: first tag goes top-left. Origin is bottom-left, so the
    // top row is the highest row index.
    const row = rows - 1 - Math.floor(idxOnPage / cols);
    const cellOrigin_x_mm = block_x0_mm + col * pitch;
    const cellOrigin_y_mm = block_y0_mm + row * pitch;
    return {
      tag,
      page,
      x_mm: cellOrigin_x_mm + tileOffset,
      y_mm: cellOrigin_y_mm + tileOffset,
    };
  });

  const cutSegments =
    cutShape.kind === "square"
      ? computeCutSegments(
          pageCount,
          cols,
          rows,
          block_x0_mm,
          block_y0_mm,
          block_w_mm,
          block_h_mm,
          cell,
          pitch,
        )
      : [];

  const cutCircles =
    cutShape.kind === "circle"
      ? computeCutCircles(placements, tileSize_mm, cutShape, options)
      : [];

  return { paper, options, tileSize_mm, tagSize_mm, pageCount, placements, cutSegments, cutCircles };
}

/** One CutCircle per placement: centre at the tile centre, radius from the
 *  outer edge of the quiet zone. */
function computeCutCircles(
  placements: readonly Placement[],
  tileSize_mm: number,
  cutShape: { kind: "circle"; outerRadius_mm: number },
  options: LayoutOptions,
): CutCircle[] {
  const radius = cutShape.outerRadius_mm + options.quietZone_mm;
  return placements.map((p) => ({
    page: p.page,
    cx_mm: p.x_mm + tileSize_mm / 2,
    cy_mm: p.y_mm + tileSize_mm / 2,
    radius_mm: radius,
  }));
}

/** Emit a cut grid spanning the block. Each cell contributes a left and a
 *  right cut, and likewise top and bottom; when `cutMargin_mm = 0` the
 *  pitch equals the cell width and adjacent boundaries collapse to a single
 *  shared line. */
function computeCutSegments(
  pageCount: number,
  cols: number,
  rows: number,
  block_x0_mm: number,
  block_y0_mm: number,
  block_w_mm: number,
  block_h_mm: number,
  cellWidth: number,
  pitch: number,
): CutSegment[] {
  const xs = uniqueAxisPositions(block_x0_mm, cols, cellWidth, pitch);
  const ys = uniqueAxisPositions(block_y0_mm, rows, cellWidth, pitch);
  const segs: CutSegment[] = [];
  for (let p = 0; p < pageCount; p++) {
    for (const x of xs) {
      segs.push({
        page: p,
        x0_mm: x,
        y0_mm: block_y0_mm,
        x1_mm: x,
        y1_mm: block_y0_mm + block_h_mm,
      });
    }
    for (const y of ys) {
      segs.push({
        page: p,
        x0_mm: block_x0_mm,
        y0_mm: y,
        x1_mm: block_x0_mm + block_w_mm,
        y1_mm: y,
      });
    }
  }
  return segs;
}

/** Cell-boundary positions along one axis: each cell's left edge plus its
 *  right edge, deduplicated. Returned in ascending order. */
function uniqueAxisPositions(
  origin_mm: number,
  count: number,
  cellWidth: number,
  pitch: number,
): number[] {
  const seen = new Set<number>();
  const positions: number[] = [];
  const key = (v: number): number => Math.round(v * 1e6);
  for (let i = 0; i < count; i++) {
    const left = origin_mm + i * pitch;
    const right = left + cellWidth;
    for (const pos of [left, right]) {
      const k = key(pos);
      if (!seen.has(k)) {
        seen.add(k);
        positions.push(pos);
      }
    }
  }
  positions.sort((a, b) => a - b);
  return positions;
}

/**
 * Inverse of `planSmallTagLayout`: largest tag size such that `count` tags
 * fit within `maxPages` pages of the given paper and margins. Returns 0 if
 * nothing positive fits (e.g. margins consume the whole printable area).
 *
 * Tag count is monotonically non-increasing in tag size, so a binary search
 * over a continuous size domain is well-defined.
 */
export function maxTagSizeForCount(
  count: number,
  paper: Paper,
  options: LayoutOptions,
  maxPages: number,
  cutShape: CutShape = { kind: "square" },
): number {
  require_(count > 0, `count must be positive (got ${count})`);
  require_(maxPages >= 1, `maxPages must be at least 1 (got ${maxPages})`);
  for (const k of ["pageMargin_mm", "quietZone_mm", "cutMargin_mm"] as const) {
    require_(options[k] >= 0, `options.${k} must be non-negative (got ${options[k]})`);
  }
  if (cutShape.kind === "circle") {
    require_(
      cutShape.outerRadius_mm >= 0,
      `outerRadius_mm must be non-negative (got ${cutShape.outerRadius_mm})`,
    );
  }

  const printable_x = paper.width_mm - 2 * options.pageMargin_mm;
  const printable_y = paper.height_mm - 2 * options.pageMargin_mm;
  if (printable_x <= 0 || printable_y <= 0) return 0;

  const fixedOverhead =
    cutShape.kind === "circle"
      ? 2 * cutShape.outerRadius_mm + 2 * options.quietZone_mm
      : 2 * options.quietZone_mm;
  const upper = Math.min(printable_x, printable_y) - fixedOverhead;
  if (upper <= 0) return 0;

  let lo = 0;
  let hi = upper;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    const cols = tagsPerAxis(printable_x, mid, options, cutShape);
    const rows = tagsPerAxis(printable_y, mid, options, cutShape);
    const fits = cols >= 1 && rows >= 1 && cols * rows * maxPages >= count;
    if (fits) lo = mid;
    else hi = mid;
  }
  return lo;
}
