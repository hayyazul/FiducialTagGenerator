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

/** Resolve the effective packing strategy for the given cut shape, applying
 *  defaults and rejecting invalid combinations. */
function resolvePackingStrategy(
  options: LayoutOptions,
  cutShape: CutShape,
): "grid" | "hex" {
  const explicit = options.packingStrategy;
  if (explicit === "hex") {
    require_(
      cutShape.kind === "circle",
      `packingStrategy "hex" is only valid for circle cut shapes (got "${cutShape.kind}")`,
    );
    return "hex";
  }
  if (explicit === "grid") return "grid";
  return cutShape.kind === "circle" ? "hex" : "grid";
}

/** Geometry of a hexagonal close-packing of circles of radius R into a
 *  rectangle. Even rows (r % 2 === 0) start at x = R; odd rows are offset
 *  inward by pitchX/2. Vertical pitch is pitchX · √3/2 so adjacent circles
 *  in neighbouring rows touch with the same gap as same-row neighbours. */
interface HexParams {
  R: number;
  pitchX: number;
  pitchY: number;
  colsEven: number;
  colsOdd: number;
  numRows: number;
  perPage: number;
}

function hexLatticeParams(
  paper: Paper,
  options: LayoutOptions,
  cutShape: CutShape & { kind: "circle" },
): HexParams {
  const R = cutShape.outerRadius_mm + options.quietZone_mm;
  const g = options.cutMargin_mm;
  const pitchX = 2 * R + g;
  const pitchY = pitchX * Math.sqrt(3) / 2;
  const printable_x = paper.width_mm - 2 * options.pageMargin_mm;
  const printable_y = paper.height_mm - 2 * options.pageMargin_mm;
  // Centers along an even row fit when (cols-1)·pitchX + 2R ≤ printable_x.
  const colsEven = printable_x + 1e-9 >= 2 * R
    ? Math.floor((printable_x - 2 * R) / pitchX + 1e-9) + 1
    : 0;
  // Odd rows start half a pitch further right, costing space for one column.
  const colsOdd = printable_x + 1e-9 >= 2 * R + pitchX / 2
    ? Math.floor((printable_x - 2 * R - pitchX / 2) / pitchX + 1e-9) + 1
    : 0;
  const numRows = printable_y + 1e-9 >= 2 * R
    ? Math.floor((printable_y - 2 * R) / pitchY + 1e-9) + 1
    : 0;
  // Sum cols across alternating rows.
  let perPage = 0;
  for (let r = 0; r < numRows; r++) {
    perPage += r % 2 === 0 ? colsEven : colsOdd;
  }
  return { R, pitchX, pitchY, colsEven, colsOdd, numRows, perPage };
}

/** Per-page tag capacity under the given strategy. */
function pageCapacity(
  paper: Paper,
  tileSize_mm: number,
  options: LayoutOptions,
  cutShape: CutShape,
  strategy: "grid" | "hex",
): number {
  if (strategy === "grid") {
    const printable_x = paper.width_mm - 2 * options.pageMargin_mm;
    const printable_y = paper.height_mm - 2 * options.pageMargin_mm;
    const cols = tagsPerAxis(printable_x, tileSize_mm, options, cutShape);
    const rows = tagsPerAxis(printable_y, tileSize_mm, options, cutShape);
    return cols * rows;
  }
  // hex (only ever called with circle cut by resolvePackingStrategy)
  return hexLatticeParams(paper, options, cutShape as CutShape & { kind: "circle" }).perPage;
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
  const strategy = resolvePackingStrategy(options, cutShape);

  const placements: Placement[] =
    strategy === "hex"
      ? placeHex(tags, tileSize_mm, paper, options, cutShape as CutShape & { kind: "circle" })
      : placeGrid(tags, tileSize_mm, paper, options, cutShape);

  const perPage = pageCapacity(paper, tileSize_mm, options, cutShape, strategy);
  const pageCount = tags.length === 0 ? 0 : Math.ceil(tags.length / perPage);

  const cutSegments =
    cutShape.kind === "square"
      ? computePerPlacementCutSegments(placements, tileSize_mm, options, cutShape)
      : [];

  const cutCircles =
    cutShape.kind === "circle"
      ? computeCutCircles(placements, tileSize_mm, cutShape, options)
      : [];

  return { paper, options, tileSize_mm, tagSize_mm, pageCount, placements, cutSegments, cutCircles, subtagLevels: [] };
}

/** Grid placement: tags fill a uniform `cols × rows` lattice, reading order
 *  top-to-bottom and left-to-right. Used for square cut shapes and for
 *  circles when the caller requests `packingStrategy: "grid"`. */
function placeGrid(
  tags: readonly TagSpec[],
  tileSize_mm: number,
  paper: Paper,
  options: LayoutOptions,
  cutShape: CutShape,
): Placement[] {
  const printable_x_mm = paper.width_mm - 2 * options.pageMargin_mm;
  const printable_y_mm = paper.height_mm - 2 * options.pageMargin_mm;
  const cols = tagsPerAxis(printable_x_mm, tileSize_mm, options, cutShape);
  const rows = tagsPerAxis(printable_y_mm, tileSize_mm, options, cutShape);
  require_(cols >= 1 && rows >= 1, "no tags fit in printable area");

  const perPage = cols * rows;
  const cell = cellWidth_mm(tileSize_mm, options, cutShape);
  const pitch = pitch_mm(tileSize_mm, options, cutShape);
  const block_x0_mm = options.pageMargin_mm;
  const block_y0_mm = options.pageMargin_mm;
  // Tile offset from cell origin — centres the tile within its cell.
  const tileOffset = (cell - tileSize_mm) / 2;

  return tags.map((tag, i) => {
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
}

/** Hex placement: alternating rows are offset by half-pitch in X and a row
 *  pitch of `(2R+cutMargin)·√3/2` brings each circle into contact with six
 *  neighbours at the same gap. Reading order matches grid: row 0 is the
 *  topmost row, columns fill left-to-right within each row. */
function placeHex(
  tags: readonly TagSpec[],
  tileSize_mm: number,
  paper: Paper,
  options: LayoutOptions,
  cutShape: CutShape & { kind: "circle" },
): Placement[] {
  const params = hexLatticeParams(paper, options, cutShape);
  require_(params.perPage >= 1, "no tags fit in printable area");

  const { R, pitchX, pitchY, colsEven, colsOdd, numRows, perPage } = params;
  // Per-row column counts, indexed by row (row 0 is the topmost).
  const colsPerRow: number[] = [];
  for (let r = 0; r < numRows; r++) {
    colsPerRow.push(r % 2 === 0 ? colsEven : colsOdd);
  }
  // Cumulative sums let us map idxOnPage → (row, colInRow) in O(log numRows)
  // — but numRows is small, so linear search is clearer and just as fast.

  const topCenterY = paper.height_mm - options.pageMargin_mm - R;
  const leftCenterX = options.pageMargin_mm + R;

  return tags.map((tag, i) => {
    const page = Math.floor(i / perPage);
    let idxOnPage = i % perPage;
    let row = 0;
    while (idxOnPage >= colsPerRow[row]!) {
      idxOnPage -= colsPerRow[row]!;
      row += 1;
    }
    const colInRow = idxOnPage;
    const offsetX = row % 2 === 1 ? pitchX / 2 : 0;
    const cx_mm = leftCenterX + offsetX + colInRow * pitchX;
    const cy_mm = topCenterY - row * pitchY;
    return {
      tag,
      page,
      x_mm: cx_mm - tileSize_mm / 2,
      y_mm: cy_mm - tileSize_mm / 2,
    };
  });
}

/** Per-placement cut segments: each occupied cell emits its four boundary
 *  segments, deduplicated per page. At `cutMargin_mm = 0` two neighbouring
 *  cells share a coincident edge so dedup keeps a single shared cut; with a
 *  gap each cell carries its own four edges. A partial last page only emits
 *  cuts around the cells that are actually filled — empty cells in the trailing
 *  rows carry no cut lines, matching the per-marker behaviour already used
 *  for circular families. */
function computePerPlacementCutSegments(
  placements: readonly Placement[],
  tileSize_mm: number,
  options: LayoutOptions,
  cutShape: CutShape,
): CutSegment[] {
  if (cutShape.kind !== "square" || placements.length === 0) return [];
  const cell = cellWidth_mm(tileSize_mm, options, cutShape);
  const tileOffset = (cell - tileSize_mm) / 2;
  const seen = new Set<string>();
  const segs: CutSegment[] = [];
  const k = (page: number, x0: number, y0: number, x1: number, y1: number): string =>
    `${page}|${Math.round(x0 * 1e6)}|${Math.round(y0 * 1e6)}|${Math.round(x1 * 1e6)}|${Math.round(y1 * 1e6)}`;
  for (const p of placements) {
    const x0 = p.x_mm - tileOffset;
    const y0 = p.y_mm - tileOffset;
    const x1 = x0 + cell;
    const y1 = y0 + cell;
    const edges: [number, number, number, number][] = [
      [x0, y0, x0, y1],
      [x1, y0, x1, y1],
      [x0, y0, x1, y0],
      [x0, y1, x1, y1],
    ];
    for (const [ax, ay, bx, by] of edges) {
      const key = k(p.page, ax, ay, bx, by);
      if (seen.has(key)) continue;
      seen.add(key);
      segs.push({ page: p.page, x0_mm: ax, y0_mm: ay, x1_mm: bx, y1_mm: by });
    }
  }
  return segs;
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
  const strategy = resolvePackingStrategy(options, cutShape);

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
    const capacity = pageCapacity(paper, mid, options, cutShape, strategy);
    const fits = capacity >= 1 && capacity * maxPages >= count;
    if (fits) lo = mid;
    else hi = mid;
  }
  return lo;
}
