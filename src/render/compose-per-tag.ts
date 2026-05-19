/**
 * Bare-marker renderer for per-tag exports. Skips the layout pipeline
 * entirely — given a single tag (and optional sub-tag chain), it draws
 * just that tag, optionally with a surrounding quiet zone and a caption
 * inside that quiet zone.
 *
 * Coordinate space is the same as `composePage`: millimetres, bottom-
 * left origin. The caller is expected to construct a `Canvas` whose
 * page dimensions equal `perTagCanvasSize_mm(...)` for the inputs it
 * wants to render.
 */
import { type BitsProvider, getFamily } from "../families";
import type { SubtagLevel, TagSpec } from "../layout/types";
import { formatTagSize, tagCaptionLine } from "../tag-caption";
import { BLACK, type Canvas, WHITE } from "./canvas";

export interface PerTagOptions {
  /** Edge length of the marker tile in mm — distance from bottom-left
   *  to top-right of the bit-grid square. */
  tile_mm: number;
  /** Canonical AprilTag "tag size" in mm (used for caption text). */
  tagSize_mm: number;
  /** Quiet-zone thickness in mm. `0` = no quiet zone (bare bits). */
  quietZone_mm: number;
  /** When `true` and `quietZone_mm > 0`, set a caption inside the
   *  bottom quiet-zone band. Honours the same option name as the
   *  packed-mode renderer for consistency. */
  printLabelsInQuietZone: boolean;
  /** Sub-tag chain sizes, outermost first. Matches the field on
   *  `LayoutPlan`. Used by the caption when sub-tags are present. */
  subtagLevels?: SubtagLevel[];
}

/** Page size required to render a single marker plus its quiet zone. */
export function perTagCanvasSize_mm(opts: {
  tile_mm: number;
  quietZone_mm: number;
}): { width_mm: number; height_mm: number } {
  const side = opts.tile_mm + 2 * opts.quietZone_mm;
  return { width_mm: side, height_mm: side };
}

/**
 * Draw a single marker (with optional sub-tags) into `canvas`. Assumes
 * `canvas.page` has the dimensions returned by `perTagCanvasSize_mm`
 * for the same `tile_mm` and `quietZone_mm`.
 */
export function composePerTag(
  canvas: Canvas,
  markers: BitsProvider,
  tag: TagSpec,
  opts: PerTagOptions,
): void {
  // White background — exporters target documents and tools that may
  // composite over arbitrary colours, so the marker should never appear
  // transparent in unprinted regions.
  canvas.drawRect({
    x_mm: 0,
    y_mm: 0,
    width_mm: canvas.page.width_mm,
    height_mm: canvas.page.height_mm,
    fill: WHITE,
  });

  // Marker is centred — the quiet zone is the same thickness on every
  // side.
  const x_mm = opts.quietZone_mm;
  const y_mm = opts.quietZone_mm;
  drawMarkerAt(canvas, markers, tag, x_mm, y_mm, opts.tile_mm);

  if (opts.printLabelsInQuietZone && opts.quietZone_mm > 0) {
    drawCaption(canvas, tag, opts);
  }
}

/** Recursive marker draw — same shape as the one in `compose.ts`,
 *  duplicated here so per-tag mode doesn't transitively pull in
 *  `LayoutPlan` semantics. Masks the parent's centre-block cells when
 *  a sub-tag will cover them, for vector-backend cleanliness. */
function drawMarkerAt(
  canvas: Canvas,
  markers: BitsProvider,
  tag: TagSpec,
  x_mm: number,
  y_mm: number,
  tile_mm: number,
): void {
  const def = getFamily(tag.family);
  const bits = markers.bits(tag.family, tag.id);

  if (bits === null || bits.length === 0) {
    canvas.drawRect({
      x_mm,
      y_mm,
      width_mm: tile_mm,
      height_mm: tile_mm,
      fill: { r: 0x22 / 255, g: 0x22 / 255, b: 0x22 / 255 },
    });
    canvas.drawText({
      text: `${tag.family}#${tag.id}`,
      x_mm: x_mm + tile_mm / 2,
      y_mm: y_mm + tile_mm / 2,
      fontSize_mm: Math.max(1.2, tile_mm * 0.18),
      font: "mono",
      fill: WHITE,
      anchor: "middle",
      verticalAnchor: "middle",
    });
  } else {
    const cb = tag.subtag ? def?.centerBlock : undefined;
    const drawBits = cb ? maskCenterBlock(bits, cb) : bits;
    canvas.drawBitGrid({
      bits: drawBits,
      x_mm,
      y_mm,
      cellSize_mm: tile_mm / bits.length,
      cacheKey: cb
        ? `${tag.family}#${tag.id}+sub`
        : `${tag.family}#${tag.id}`,
    });
  }

  if (!tag.subtag || !def?.centerBlock) return;
  const cb = def.centerBlock;
  const module_mm = tile_mm / def.tileSize_px;
  const subTile_mm = cb.size * module_mm;
  const subX = x_mm + cb.col * module_mm;
  const subY = y_mm + tile_mm - (cb.row + cb.size) * module_mm;
  drawMarkerAt(canvas, markers, tag.subtag, subX, subY, subTile_mm);
}

function maskCenterBlock(
  bits: readonly (readonly boolean[])[],
  cb: { row: number; col: number; size: number },
): boolean[][] {
  const out: boolean[][] = [];
  for (let r = 0; r < bits.length; r++) {
    const row = bits[r]!;
    if (r < cb.row || r >= cb.row + cb.size) {
      out.push([...row]);
      continue;
    }
    const next: boolean[] = [];
    for (let c = 0; c < row.length; c++) {
      next.push(c >= cb.col && c < cb.col + cb.size ? false : row[c]!);
    }
    out.push(next);
  }
  return out;
}

function drawCaption(
  canvas: Canvas,
  tag: TagSpec,
  opts: PerTagOptions,
): void {
  const Q = opts.quietZone_mm;
  const tile = opts.tile_mm;
  const cx = Q + tile / 2;
  const mainText = tagCaptionLine(tag.family, tag.id, opts.tagSize_mm);
  const subText = subtagChainLabel(tag.subtag, opts.subtagLevels ?? []);

  // Caption sits in the *bottom* quiet-zone band. In canvas-space the
  // marker bottom is at y = Q; the band runs from y = 0 to y = Q.
  if (subText) {
    const halfQ = Q * 0.3;
    for (const [text, baselineFrac] of [
      [mainText, 0.52],
      [subText, 0.12],
    ] as const) {
      const fontSize_mm = Math.max(
        0.18,
        Math.min(halfQ, tile / (0.6 * text.length)),
      );
      canvas.drawText({
        text,
        x_mm: cx,
        y_mm: baselineFrac * Q,
        fontSize_mm,
        font: "mono",
        fill: BLACK,
        anchor: "middle",
      });
    }
    return;
  }

  const fontSize_mm = Math.max(
    0.18,
    Math.min(Q * 0.6, tile / (0.6 * mainText.length)),
  );
  canvas.drawText({
    text: mainText,
    x_mm: cx,
    y_mm: 0.28 * Q,
    fontSize_mm,
    font: "mono",
    fill: BLACK,
    anchor: "middle",
  });
}

function subtagChainLabel(
  subtag: TagSpec | undefined,
  levels: SubtagLevel[],
): string {
  if (!subtag) return "";
  const parts: string[] = [];
  let s: TagSpec | undefined = subtag;
  let i = 0;
  while (s) {
    const lvl = levels[i];
    const size = lvl ? ` · ${formatTagSize(lvl.tagSize_mm)}` : "";
    parts.push(`> ${s.family} #${s.id}${size}`);
    s = s.subtag;
    i++;
  }
  return parts.join("  ");
}
