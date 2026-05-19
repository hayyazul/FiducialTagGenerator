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
import { ArucoFamily } from "./aruco-family";
import { CCTagFamily } from "./cctag-family";
import { MosaicFamily } from "./mosaic-family";

const ARUCO_DICT_BASE = `${import.meta.env.BASE_URL}resources/aruco_dictionaries`;
const APRILTAG_BASE = `${import.meta.env.BASE_URL}resources/apriltag`;
const CCTAG_BASE = `${import.meta.env.BASE_URL}resources/cctag`;

/** ArUco dictionaries shipped under `public/resources/aruco_dictionaries/`.
 *
 *  For each grid size we ship only the 1000-marker dictionary: in the
 *  upstream OpenCV ArUco design the smaller 50/100/250 dictionaries are
 *  prefixes of the 1000 dictionary, so a user who wants e.g. the 4×4_50
 *  set just uses IDs 0–49 of `aruco_4x4`. The size-list parenthetical in
 *  the UI label flags this for users who recognise the standard size
 *  buckets.
 *
 *  `aruco_original` and `aruco_mip_36h12` don't follow that prefix
 *  scheme, so they're shipped as standalone entries. */
interface ArucoDictEntry {
  name: string;
  label?: string;
  gridSize: number;
  count: number;
  /** Filename stem under `public/resources/aruco_dictionaries/`. Defaults
   *  to `name`; specify when the registry name and source file diverge. */
  fileStem?: string;
}

const ARUCO_DICTS: ReadonlyArray<ArucoDictEntry> = [
  { name: "aruco_original", gridSize: 5, count: 1024 },
  { name: "aruco_4x4", label: "aruco_4x4 (50, 100, 250, 1000)", gridSize: 4, count: 1000, fileStem: "aruco_4x4_1000" },
  { name: "aruco_5x5", label: "aruco_5x5 (50, 100, 250, 1000)", gridSize: 5, count: 1000, fileStem: "aruco_5x5_1000" },
  { name: "aruco_6x6", label: "aruco_6x6 (50, 100, 250, 1000)", gridSize: 6, count: 1000, fileStem: "aruco_6x6_1000" },
  { name: "aruco_7x7", label: "aruco_7x7 (50, 100, 250, 1000)", gridSize: 7, count: 1000, fileStem: "aruco_7x7_1000" },
  { name: "aruco_mip_36h12", gridSize: 6, count: 250 },
];

const FAMILIES: Family[] = [
  new MosaicFamily({
    name: "tag16h5",
    group: "AprilTag",
    count: 30,
    chunkSize: 30,
    geometry: { edge: 8, widthAtBorder: 6, outerShape: "square" },
    chunkBasePath: `${APRILTAG_BASE}/tag16h5`,
  }),
  new MosaicFamily({
    name: "tag25h9",
    group: "AprilTag",
    count: 35,
    chunkSize: 35,
    geometry: { edge: 9, widthAtBorder: 7, outerShape: "square" },
    chunkBasePath: `${APRILTAG_BASE}/tag25h9`,
  }),
  new MosaicFamily({
    name: "tag36h11",
    group: "AprilTag",
    count: 587,
    chunkSize: 587,
    geometry: { edge: 10, widthAtBorder: 8, outerShape: "square" },
    chunkBasePath: `${APRILTAG_BASE}/tag36h11`,
  }),
  new MosaicFamily({
    name: "tagStandard41h12",
    group: "AprilTag",
    count: 2115,
    chunkSize: 2115,
    geometry: { edge: 9, widthAtBorder: 5, outerShape: "square" },
    chunkBasePath: `${APRILTAG_BASE}/tagStandard41h12`,
  }),
  new MosaicFamily({
    name: "tagStandard52h13",
    group: "AprilTag",
    count: 48714,
    chunkSize: 256,
    geometry: { edge: 10, widthAtBorder: 6, outerShape: "square" },
    chunkBasePath: `${APRILTAG_BASE}/tagStandard52h13`,
  }),
  new MosaicFamily({
    name: "tagCustom48h12",
    group: "AprilTag",
    count: 42211,
    chunkSize: 256,
    geometry: {
      edge: 10,
      widthAtBorder: 6,
      outerShape: "square",
      centerBlock: { row: 4, col: 4, size: 2 },
    },
    chunkBasePath: `${APRILTAG_BASE}/tagCustom48h12`,
  }),
  new MosaicFamily({
    name: "tagCircle21h7",
    group: "AprilTag",
    count: 38,
    chunkSize: 38,
    geometry: {
      edge: 9,
      widthAtBorder: 5,
      outerShape: "circle",
      // Smallest circle centred on the tile that encloses every occupied
      // cell of any tag in the family. See scripts/measure-circle-geometry.py.
      outerRadiusCells: 4.949747468305833,
    },
    chunkBasePath: `${APRILTAG_BASE}/tagCircle21h7`,
  }),
  new MosaicFamily({
    name: "tagCircle49h12",
    group: "AprilTag",
    count: 65535,
    chunkSize: 256,
    geometry: {
      edge: 11,
      widthAtBorder: 5,
      outerShape: "circle",
      outerRadiusCells: 5.70087712549569,
    },
    chunkBasePath: `${APRILTAG_BASE}/tagCircle49h12`,
  }),
  ...ARUCO_DICTS.map(
    (d) =>
      new ArucoFamily({
        name: d.name,
        label: d.label,
        group: "ArUco",
        gridSize: d.gridSize,
        count: d.count,
        jsonPath: `${ARUCO_DICT_BASE}/${d.fileStem ?? d.name}.min.json`,
      }),
  ),
  new CCTagFamily({
    name: "cctag3",
    group: "CCTag",
    ringsPerMarker: 5,
    count: 32,
    dataPath: `${CCTAG_BASE}/cctag3.txt`,
  }),
  new CCTagFamily({
    name: "cctag4",
    group: "CCTag",
    ringsPerMarker: 7,
    count: 128,
    dataPath: `${CCTAG_BASE}/cctag4.txt`,
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
