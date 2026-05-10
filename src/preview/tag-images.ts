/**
 * Browser-side rasteriser for tag bitmaps. Turns each tag's bit grid into a
 * 1-pixel-per-bit PNG data URI (via an offscreen 2D canvas) that the preview
 * places as a single <image>. Results are cached per (family, id) — a tag's
 * pattern never changes — so re-rendering the preview reuses them.
 *
 * This module touches the DOM (canvas), so it lives apart from the pure
 * string-builder in ./svg.ts. The bit-grid → RGBA mapping is factored out as
 * `bitsToRgba` so it can be unit-tested without a canvas.
 */
import type { BitsProvider } from "../families";
import type { TagImageProvider } from "./svg";

/**
 * RGBA pixel buffer for an `edge × edge` bitmap: a black bit becomes opaque
 * black, an unset bit opaque white. Row 0 of `bits` is the top row of the
 * image. The unset pixels are opaque white (not transparent) so the tag's
 * data area always reads as white and never lets the cream quiet-zone behind
 * it bleed through.
 */
export function bitsToRgba(
  bits: readonly (readonly boolean[])[],
): Uint8ClampedArray {
  const edge = bits.length;
  const out = new Uint8ClampedArray(edge * edge * 4);
  for (let y = 0; y < edge; y++) {
    const row = bits[y]!;
    for (let x = 0; x < edge; x++) {
      const i = (y * edge + x) * 4;
      const v = row[x] ? 0 : 255;
      out[i] = v;
      out[i + 1] = v;
      out[i + 2] = v;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Wrap a `BitsProvider` as a `TagImageProvider`, rasterising on demand and
 *  caching each tag's PNG data URI. A single canvas is reused across tags. */
export function createTagImageProvider(bits: BitsProvider): TagImageProvider {
  const cache = new Map<string, string>();
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;

  return {
    imageHref(family: string, id: number): string | null {
      const key = `${family}#${id}`;
      const cached = cache.get(key);
      if (cached !== undefined) return cached;

      const grid = bits.bits(family, id);
      if (grid === null || grid.length === 0) return null;
      const edge = grid.length;

      if (canvas === null) {
        canvas = document.createElement("canvas");
        ctx = canvas.getContext("2d");
      }
      if (ctx === null) return null;

      canvas.width = edge;
      canvas.height = edge;
      const image = ctx.createImageData(edge, edge);
      image.data.set(bitsToRgba(grid));
      ctx.putImageData(image, 0, 0);
      const href = canvas.toDataURL("image/png");

      cache.set(key, href);
      return href;
    },
  };
}
