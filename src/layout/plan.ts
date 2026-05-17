import type {
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

/** Total side length occupied by one tag, including its quiet zone and cut
 *  margin. Adjacent footprints share their cut-margin boundary, so the
 *  pitch between two tags equals the footprint. */
function tagFootprint_mm(tileSize_mm: number, options: LayoutOptions): number {
  return tileSize_mm + 2 * (options.quietZone_mm + options.cutMargin_mm);
}

function tagsPerAxis(printable_mm: number, tileSize_mm: number, options: LayoutOptions): number {
  const footprint = tagFootprint_mm(tileSize_mm, options);
  if (printable_mm < footprint) return 0;
  return Math.floor(printable_mm / footprint);
}

function validateInputs(tileSize_mm: number, paper: Paper, options: LayoutOptions): void {
  require_(tileSize_mm > 0, `tileSize_mm must be positive (got ${tileSize_mm})`);
  require_(
    paper.width_mm > 0 && paper.height_mm > 0,
    `paper dimensions must be positive (got ${paper.width_mm} × ${paper.height_mm})`,
  );
  for (const k of ["pageMargin_mm", "quietZone_mm", "cutMargin_mm"] as const) {
    require_(options[k] >= 0, `options.${k} must be non-negative (got ${options[k]})`);
  }
  const minSide_mm = Math.min(paper.width_mm, paper.height_mm);
  const required_mm = tagFootprint_mm(tileSize_mm, options) + 2 * options.pageMargin_mm;
  require_(
    required_mm <= minSide_mm + 1e-9,
    `tag does not fit on paper: footprint + page margins is ${required_mm.toFixed(2)}mm, ` +
      `paper minimum side is ${minSide_mm}mm. ` +
      `Reduce tileSize_mm, quietZone_mm, cutMargin_mm, or pageMargin_mm.`,
  );
}

/**
 * Lay out `tags` onto pages of `paper` with the given margins.
 *
 * `tileSize_mm` is the printed dimension of each tag's tile (the bitmap
 * pulled from the mosaic, including any white ring). `tagSize_mm` is the
 * AprilTag-spec tag size — between detection corners — used only for the
 * size shown in labels; defaults to `tileSize_mm` so existing call sites
 * that don't separate the two keep working.
 */
export function planSmallTagLayout(
  tags: readonly TagSpec[],
  tileSize_mm: number,
  paper: Paper,
  options: LayoutOptions,
  tagSize_mm: number = tileSize_mm,
): LayoutPlan {
  validateInputs(tileSize_mm, paper, options);

  const printable_x_mm = paper.width_mm - 2 * options.pageMargin_mm;
  const printable_y_mm = paper.height_mm - 2 * options.pageMargin_mm;
  const cols = tagsPerAxis(printable_x_mm, tileSize_mm, options);
  const rows = tagsPerAxis(printable_y_mm, tileSize_mm, options);
  require_(cols >= 1 && rows >= 1, "no tags fit in printable area");

  const perPage = cols * rows;
  const f = tagFootprint_mm(tileSize_mm, options);
  const block_w_mm = cols * f;
  const block_h_mm = rows * f;
  const block_x0_mm = options.pageMargin_mm;
  const block_y0_mm = options.pageMargin_mm;

  const pageCount = tags.length === 0 ? 0 : Math.ceil(tags.length / perPage);
  const placements: Placement[] = tags.map((tag, i) => {
    const page = Math.floor(i / perPage);
    const idxOnPage = i % perPage;
    const col = idxOnPage % cols;
    // Reading order: first tag goes top-left. Origin is bottom-left, so the
    // top row is the highest row index.
    const row = rows - 1 - Math.floor(idxOnPage / cols);
    const cellOrigin_x_mm = block_x0_mm + col * f;
    const cellOrigin_y_mm = block_y0_mm + row * f;
    return {
      tag,
      page,
      x_mm: cellOrigin_x_mm + options.quietZone_mm + options.cutMargin_mm,
      y_mm: cellOrigin_y_mm + options.quietZone_mm + options.cutMargin_mm,
    };
  });

  const cutSegments = computeCutSegments(
    pageCount,
    cols,
    rows,
    block_x0_mm,
    block_y0_mm,
    block_w_mm,
    block_h_mm,
    f,
  );

  return { paper, options, tileSize_mm, tagSize_mm, pageCount, placements, cutSegments };
}

/** Emit a uniform grid of cuts: (cols+1) verticals and (rows+1) horizontals
 *  per page, each spanning the full block. Adjacent tags share their
 *  cut-margin boundary, so each interior boundary is a single line. */
function computeCutSegments(
  pageCount: number,
  cols: number,
  rows: number,
  block_x0_mm: number,
  block_y0_mm: number,
  block_w_mm: number,
  block_h_mm: number,
  footprint_mm: number,
): CutSegment[] {
  const segs: CutSegment[] = [];
  for (let p = 0; p < pageCount; p++) {
    for (let c = 0; c <= cols; c++) {
      const x = block_x0_mm + c * footprint_mm;
      segs.push({
        page: p,
        x0_mm: x,
        y0_mm: block_y0_mm,
        x1_mm: x,
        y1_mm: block_y0_mm + block_h_mm,
      });
    }
    for (let r = 0; r <= rows; r++) {
      const y = block_y0_mm + r * footprint_mm;
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
): number {
  require_(count > 0, `count must be positive (got ${count})`);
  require_(maxPages >= 1, `maxPages must be at least 1 (got ${maxPages})`);
  for (const k of ["pageMargin_mm", "quietZone_mm", "cutMargin_mm"] as const) {
    require_(options[k] >= 0, `options.${k} must be non-negative (got ${options[k]})`);
  }

  const printable_x = paper.width_mm - 2 * options.pageMargin_mm;
  const printable_y = paper.height_mm - 2 * options.pageMargin_mm;
  if (printable_x <= 0 || printable_y <= 0) return 0;

  const fixedOverhead = 2 * (options.quietZone_mm + options.cutMargin_mm);
  const upper = Math.min(printable_x, printable_y) - fixedOverhead;
  if (upper <= 0) return 0;

  let lo = 0;
  let hi = upper;
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    const cols = tagsPerAxis(printable_x, mid, options);
    const rows = tagsPerAxis(printable_y, mid, options);
    const fits = cols >= 1 && rows >= 1 && cols * rows * maxPages >= count;
    if (fits) lo = mid;
    else hi = mid;
  }
  return lo;
}
