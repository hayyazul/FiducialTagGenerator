/**
 * Live SVG preview of one page of a `LayoutPlan`.
 *
 * The renderer is `compose.composePage`, which is shared with every
 * other output format. This module is the thin shell that constructs an
 * `SvgCanvas`, runs `composePage` against it, and returns the SVG
 * document as a string for direct injection into the page.
 *
 * Note the preview-specific border + background styling on the root
 * `<svg>` element. It is preview-only chrome — an export-mode caller
 * (the eventual "Download as SVG" feature) constructs its own
 * `SvgCanvas` without these styles.
 */
import type { BitsProvider } from "../families";
import type { LayoutPlan } from "../layout/types";
import type { ComposeOptions } from "../render/compose";
import { composePage } from "../render/compose";
import type { BitGridRasterizer } from "../render/svg-canvas";
import { SvgCanvas } from "../render/svg-canvas";

const PREVIEW_ROOT_STYLE = "background:#fff;border:1px solid #999;display:block";

export interface PreviewOptions extends ComposeOptions {
  /** Bit-grid → PNG data URI rasteriser. In the browser this is a
   *  DOM-backed implementation (see `createDomRasterizer`). In unit
   *  tests, a stub is injected so the preview can be rendered without
   *  a DOM (the resulting SVG embeds the stub's data URI). When
   *  omitted, `SvgCanvas` falls back to one `<rect>` per black cell. */
  rasterizer?: BitGridRasterizer;
}

export function renderPlanToSvg(
  plan: LayoutPlan,
  page: number,
  markers?: BitsProvider,
  opts: PreviewOptions = {},
): string {
  const canvas = new SvgCanvas(plan.paper.width_mm, plan.paper.height_mm, {
    rasterizer: opts.rasterizer,
    rootStyle: PREVIEW_ROOT_STYLE,
  });
  const bits: BitsProvider = markers ?? { bits: (): null => null };
  composePage(plan, page, canvas, bits, {
    printLabelsInQuietZone: opts.printLabelsInQuietZone,
  });
  return canvas.toString();
}
