/**
 * Parse a tag-ID spec — a comma-separated list of single IDs and inclusive
 * ranges, e.g. `"0-9, 12, 15-20"` → `[0,1,…,9,12,15,…,20]`. IDs come out in
 * the order written (which becomes the page-fill order downstream). Throws an
 * `Error` with a plain, user-facing message on bad syntax, a backwards range,
 * or any repeated ID.
 *
 * Pure; no DOM. The caller is responsible for the family-specific upper bound
 * (an ID may parse fine here yet not exist in the chosen family).
 */
export function parseTagIdSpec(spec: string): number[] {
  const tokens = spec
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    throw new Error("Enter at least one tag ID, e.g. 0-9, 12.");
  }

  const ids: number[] = [];
  const seen = new Set<number>();
  for (const token of tokens) {
    for (const id of expandToken(token)) {
      if (seen.has(id)) {
        throw new Error(`Tag ID ${id} is listed more than once.`);
      }
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

// A single range may not span more than this — guards against a typo like
// "0-99999999" trying to materialise a vast array and freezing the page.
const MAX_RANGE_SPAN = 10000;

function expandToken(token: string): number[] {
  const range = /^(\d+)\s*-\s*(\d+)$/.exec(token);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    if (lo > hi) {
      throw new Error(`Range "${token}" goes backwards — write the smaller number first.`);
    }
    if (hi - lo + 1 > MAX_RANGE_SPAN) {
      throw new Error(`Range "${token}" covers too many IDs — narrow it down.`);
    }
    const out: number[] = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
  }
  if (/^\d+$/.test(token)) {
    return [Number(token)];
  }
  throw new Error(`Couldn't read "${token}" — use whole numbers and ranges like 0-9.`);
}

/** Inverse of `parseTagIdSpec`: turn sorted unique IDs into a compressed string
 *  like "0, 5-6, 10-13". Assumes ids are sorted ascending with no repeats. */
export function formatIdSpec(ids: number[]): string {
  if (ids.length === 0) return "";
  const parts: string[] = [];
  let start = ids[0]!;
  let end = ids[0]!;
  for (let i = 1; i < ids.length; i++) {
    if (ids[i] === end + 1) {
      end = ids[i]!;
    } else {
      parts.push(start === end ? `${start}` : `${start}-${end}`);
      start = ids[i]!;
      end = ids[i]!;
    }
  }
  parts.push(start === end ? `${start}` : `${start}-${end}`);
  return parts.join(", ");
}
