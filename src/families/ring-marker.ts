/**
 * `Marker` implementation for concentric-ring fiducials (CCTag). The
 * marker is a stack of filled circles centred on the tile centre: a
 * black outer disk plus one filled circle per supplied ring radius,
 * with fills alternating white-then-black inwards. (The Python
 * reference generator, `cctag/generate.py`, behaves identically.)
 *
 * Vector throughout — every backend already implements
 * `Canvas.drawCircle`, so the marker emits a small number of primitive
 * calls and never goes through rasterisation. There is no quiet ring
 * in cell units; geometry sets `widthAtBorder = edge` so the user's
 * "Tag size" input maps directly to the outer disk diameter.
 */
import { BLACK, WHITE, type Canvas, type Color } from "../render/canvas";
import type { Marker, MarkerFrame } from "./family";

export class RingMarker implements Marker {
  readonly cacheKey: string;
  /** Inner ring radii, normalised so `1.0` = outer disk radius. Strictly
   *  decreasing; the outer disk itself is not in this list. */
  readonly ringRadii: readonly number[];

  constructor(ringRadii: readonly number[], cacheKey: string) {
    this.ringRadii = ringRadii;
    this.cacheKey = cacheKey;
  }

  draw(canvas: Canvas, frame: MarkerFrame): void {
    const cx_mm = frame.x_mm + frame.size_mm / 2;
    const cy_mm = frame.y_mm + frame.size_mm / 2;
    const outerRadius_mm = frame.size_mm / 2;
    canvas.drawCircle({ cx_mm, cy_mm, radius_mm: outerRadius_mm, fill: BLACK });
    let fill: Color = WHITE;
    for (const r of this.ringRadii) {
      canvas.drawCircle({
        cx_mm,
        cy_mm,
        radius_mm: outerRadius_mm * r,
        fill,
      });
      fill = fill === WHITE ? BLACK : WHITE;
    }
  }
}
