/**
 * Marker family registry. Re-exports the core abstractions defined in
 * `./family.ts` and instantiates one `Family` per shipped family.
 *
 * Adding a new family is one entry in this file plus dropping its mosaic
 * (for `MosaicFamily`) or implementing a new `Family` subclass (for
 * procedural / vector / raster backings) and listing the instance here.
 *
 * Display order is the iteration order of `FAMILIES`. The UI groups
 * consecutive entries by `group`; keep families intended for the same
 * `<optgroup>` adjacent below.
 */
export {
  BitGridMarker,
  type Family,
  type FamilyGeometry,
  type Marker,
  type MarkerFrame,
  type MarkerProvider,
} from "./family";

import type { Family } from "./family";
import { MosaicFamily } from "./mosaic-family";

const FAMILIES: Family[] = [
  new MosaicFamily({
    name: "tag36h11",
    group: "Classic",
    count: 587,
    geometry: { edge: 10, widthAtBorder: 8, outerShape: "square" },
    mosaicPath: `${import.meta.env.BASE_URL}resources/tag36h11_mosaic.png`,
  }),
  new MosaicFamily({
    name: "tagStandard41h12",
    group: "Standard",
    count: 2115,
    geometry: { edge: 9, widthAtBorder: 5, outerShape: "square" },
    mosaicPath: `${import.meta.env.BASE_URL}resources/tagStandard41h12_mosaic.png`,
  }),
  new MosaicFamily({
    name: "tagStandard52h13",
    group: "Standard",
    count: 48714,
    geometry: { edge: 10, widthAtBorder: 6, outerShape: "square" },
    mosaicPath: `${import.meta.env.BASE_URL}resources/tagStandard52h13_mosaic.png`,
  }),
  new MosaicFamily({
    name: "tagCustom48h12",
    group: "Custom",
    count: 42211,
    geometry: {
      edge: 10,
      widthAtBorder: 6,
      outerShape: "square",
      centerBlock: { row: 4, col: 4, size: 2 },
    },
    mosaicPath: `${import.meta.env.BASE_URL}resources/tagCustom48h12_mosaic.png`,
  }),
  new MosaicFamily({
    name: "tagCircle21h7",
    group: "Circle",
    count: 38,
    geometry: {
      edge: 9,
      widthAtBorder: 5,
      outerShape: "circle",
      // Smallest circle centred on the tile that encloses every occupied
      // cell of any tag in the family. See scripts/measure-circle-geometry.py.
      outerRadiusCells: 4.949747468305833,
    },
    mosaicPath: `${import.meta.env.BASE_URL}resources/tagCircle21h7_mosaic.png`,
  }),
  new MosaicFamily({
    name: "tagCircle49h12",
    group: "Circle",
    count: 65535,
    geometry: {
      edge: 11,
      widthAtBorder: 5,
      outerShape: "circle",
      outerRadiusCells: 5.70087712549569,
    },
    mosaicPath: `${import.meta.env.BASE_URL}resources/tagCircle49h12_mosaic.png`,
  }),
];

const FAMILIES_BY_NAME = new Map(FAMILIES.map((f) => [f.name, f]));

export function getFamily(name: string): Family | undefined {
  return FAMILIES_BY_NAME.get(name);
}

/** All families in display order. */
export function listFamilies(): Family[] {
  return FAMILIES.slice();
}

/** All family names in display order. */
export function listFamilyNames(): string[] {
  return FAMILIES.map((f) => f.name);
}

/** Families grouped by `group`. Iteration order matches display order;
 *  the ungrouped bucket (key `""`) sorts wherever its first member
 *  falls. */
export function listFamiliesByGroup(): Map<string, Family[]> {
  const out = new Map<string, Family[]>();
  for (const f of FAMILIES) {
    const key = f.group ?? "";
    const bucket = out.get(key);
    if (bucket) bucket.push(f);
    else out.set(key, [f]);
  }
  return out;
}

/** True iff the family supports embedded sub-markers (has a center block). */
export function isRecursiveFamily(family: Family): boolean {
  return family.geometry.centerBlock !== undefined;
}

/** Family names whose cut shape is a square — used by the UI to populate
 *  the sub-tag family picker, which today only supports square families. */
export function listSquareFamilyNames(): string[] {
  return FAMILIES.filter((f) => f.geometry.outerShape === "square").map((f) => f.name);
}
