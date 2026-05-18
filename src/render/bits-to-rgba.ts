/**
 * RGBA pixel buffer for an `edge × edge` bit grid: a black bit becomes
 * opaque black, an unset bit opaque white. Row 0 of `bits` is the top
 * row of the image. Unset pixels are opaque white (not transparent) so
 * the data area always reads as white and never lets the page background
 * bleed through.
 *
 * Pure function; tested without a DOM. Shared by every renderer backend
 * that needs a rasterised marker (SVG: feeds the 2D-canvas data URI hack;
 * PNG: feeds the offscreen canvas directly).
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
