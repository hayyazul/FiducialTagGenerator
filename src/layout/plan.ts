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

/** Total side length occupied by one tag including its quiet zone and cut
 *  margin. Adjacent footprints are then separated by `interTagGap_mm`. */
function tagFootprint_mm(tagSize_mm: number, options: LayoutOptions): number {
  return tagSize_mm + 2 * (options.quietZone_mm + options.cutMargin_mm);
}

function tagsPerAxis(printable_mm: number, tagSize_mm: number, options: LayoutOptions): number {
  const footprint = tagFootprint_mm(tagSize_mm, options);
  if (printable_mm < footprint) return 0;
  // n footprints + (n−1) gaps ≤ printable  ⟺  n ≤ (printable + gap) / (footprint + gap).
  const gap = options.interTagGap_mm;
  return Math.floor((printable_mm + gap) / (footprint + gap));
}

function validateInputs(tagSize_mm: number, paper: Paper, options: LayoutOptions): void {
  require_(tagSize_mm > 0, `tagSize_mm must be positive (got ${tagSize_mm})`);
  require_(
    paper.width_mm > 0 && paper.height_mm > 0,
    `paper dimensions must be positive (got ${paper.width_mm} × ${paper.height_mm})`,
  );
  for (const k of [
    "pageMargin_mm",
    "quietZone_mm",
    "cutMargin_mm",
    "interTagGap_mm",
  ] as const) {
    require_(options[k] >= 0, `options.${k} must be non-negative (got ${options[k]})`);
  }
  const minSide_mm = Math.min(paper.width_mm, paper.height_mm);
  const required_mm = tagFootprint_mm(tagSize_mm, options) + 2 * options.pageMargin_mm;
  require_(
    required_mm <= minSide_mm + 1e-9,
    `tag does not fit on paper: footprint + page margins is ${required_mm.toFixed(2)}mm, ` +
      `paper minimum side is ${minSide_mm}mm. ` +
      `Reduce tagSize_mm, quietZone_mm, cutMargin_mm, or pageMargin_mm.`,
  );
}

export function planSmallTagLayout(
  tags: readonly TagSpec[],
  tagSize_mm: number,
  paper: Paper,
  options: LayoutOptions,
): LayoutPlan {
  validateInputs(tagSize_mm, paper, options);

  const printable_x_mm = paper.width_mm - 2 * options.pageMargin_mm;
  const printable_y_mm = paper.height_mm - 2 * options.pageMargin_mm;
  const cols = tagsPerAxis(printable_x_mm, tagSize_mm, options);
  const rows = tagsPerAxis(printable_y_mm, tagSize_mm, options);
  // validateInputs guarantees at least one tag fits along the shorter axis,
  // but re-check for the longer axis to fail cleanly on degenerate inputs.
  require_(cols >= 1 && rows >= 1, "no tags fit in printable area");

  const perPage = cols * rows;
  const f = tagFootprint_mm(tagSize_mm, options);
  const gap = options.interTagGap_mm;
  const block_w_mm = cols * f + Math.max(0, cols - 1) * gap;
  const block_h_mm = rows * f + Math.max(0, rows - 1) * gap;
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
    const cellOrigin_x_mm = block_x0_mm + col * (f + gap);
    const cellOrigin_y_mm = block_y0_mm + row * (f + gap);
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
    gap,
  );

  return { paper, options, tagSize_mm, pageCount, placements, cutSegments };
}

function computeCutSegments(
  pageCount: number,
  cols: number,
  rows: number,
  block_x0_mm: number,
  block_y0_mm: number,
  block_w_mm: number,
  block_h_mm: number,
  footprint_mm: number,
  gap_mm: number,
): CutSegment[] {
  // x positions of every vertical cut. With gap=0 cells share boundaries, so
  // we emit each interior boundary once. With gap>0 each cell contributes
  // both its left and right edges (the strip between is what gets discarded).
  const xs: number[] = [];
  for (let c = 0; c < cols; c++) {
    const left = block_x0_mm + c * (footprint_mm + gap_mm);
    xs.push(left);
    if (gap_mm !== 0 || c === cols - 1) {
      xs.push(left + footprint_mm);
    }
  }
  const ys: number[] = [];
  for (let r = 0; r < rows; r++) {
    const bottom = block_y0_mm + r * (footprint_mm + gap_mm);
    ys.push(bottom);
    if (gap_mm !== 0 || r === rows - 1) {
      ys.push(bottom + footprint_mm);
    }
  }

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
  for (const k of [
    "pageMargin_mm",
    "quietZone_mm",
    "cutMargin_mm",
    "interTagGap_mm",
  ] as const) {
    require_(options[k] >= 0, `options.${k} must be non-negative (got ${options[k]})`);
  }

  const printable_x = paper.width_mm - 2 * options.pageMargin_mm;
  const printable_y = paper.height_mm - 2 * options.pageMargin_mm;
  if (printable_x <= 0 || printable_y <= 0) return 0;

  // Upper bound: a single tag exactly filling the shorter printable axis.
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
