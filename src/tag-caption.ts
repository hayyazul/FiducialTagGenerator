/**
 * The one-line human caption that identifies a printed tag — family, id, and
 * physical size, e.g. `"tag36h11 #5 · 40 mm"`. This is the same information the
 * back-side labels carry, condensed onto a single line so it can also be set
 * inside a tag's quiet zone on the front. Shared by the PDF renderer and the
 * SVG preview so the two never drift. Pure; no DOM, no pdf-lib.
 */
export function tagCaptionLine(family: string, id: number, size_mm: number): string {
  return `${family} #${id} · ${formatTagSize(size_mm)}`;
}

/** A tag size in millimetres with pointless trailing zeros trimmed and at most
 *  two decimals: 40 → "40 mm", 40.5 → "40.5 mm", 40.125 → "40.13 mm". */
export function formatTagSize(size_mm: number): string {
  return `${Math.round(size_mm * 100) / 100} mm`;
}
