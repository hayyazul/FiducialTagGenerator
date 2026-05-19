/**
 * Pure parser for the CCTag ring-radii text files (`cctag3.txt`,
 * `cctag4.txt`) shipped under `public/resources/cctag/`. Decoupled from
 * the family object model so it can be unit-tested without fetch / DOM.
 *
 * File format (one marker per line):
 *
 *     R0 R1 R2 …      (whitespace-separated integers in percent of the
 *                      outer disk radius; strictly decreasing)
 *
 * The 3-ring family lists 5 radii per line and the 4-ring family lists 7.
 * The returned arrays normalise the values to the outer disk radius
 * (divide by 100), so `1.0` = outer disk radius and every parsed entry is
 * in `(0, 1)`.
 */

/** Parse the contents of a `cctagN.txt` file into per-id ring-radii
 *  arrays normalised to the outer-disk radius.
 *
 *  Throws if any line has the wrong number of values, contains a
 *  non-integer, has values outside `(0, 100)`, or is not strictly
 *  decreasing. (Per CLAUDE.md "fail loudly": malformed family data is a
 *  programmer or upstream-data error, not a runtime situation to paper
 *  over.) Blank lines are skipped. */
export function parseCCTagData(
  text: string,
  expectedRingsPerLine: number,
): number[][] {
  if (expectedRingsPerLine <= 0) {
    throw new Error(
      `parseCCTagData: expectedRingsPerLine must be > 0, got ${expectedRingsPerLine}`,
    );
  }
  const out: number[][] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw === "") continue;
    const tokens = raw.split(/\s+/);
    if (tokens.length !== expectedRingsPerLine) {
      throw new Error(
        `cctag line ${i + 1}: expected ${expectedRingsPerLine} radii, got ${tokens.length}`,
      );
    }
    const radii: number[] = new Array(expectedRingsPerLine);
    for (let k = 0; k < tokens.length; k++) {
      const tok = tokens[k]!;
      if (!/^\d+$/.test(tok)) {
        throw new Error(
          `cctag line ${i + 1}: non-integer token "${tok}" at position ${k}`,
        );
      }
      const v = Number(tok);
      if (v <= 0 || v >= 100) {
        throw new Error(
          `cctag line ${i + 1}: radius ${v} out of range (0, 100) at position ${k}`,
        );
      }
      if (k > 0 && v >= radii[k - 1]! * 100) {
        throw new Error(
          `cctag line ${i + 1}: radii must be strictly decreasing (got ${tokens[k - 1]}, ${tok})`,
        );
      }
      radii[k] = v / 100;
    }
    out.push(radii);
  }
  return out;
}
