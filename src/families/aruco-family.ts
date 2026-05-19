/**
 * `Family` implementation for ArUco marker dictionaries distributed as
 * JSON files. Each dictionary file contains a flat `markers` array where
 * entry `i` is the row-major bit pattern for marker id `i`.
 *
 * ArUco markers, unlike AprilTag, carry their outer black border as part
 * of the marker itself rather than as a quiet zone. The drawable
 * footprint is therefore `gridSize + 2` cells per side: a one-cell black
 * ring around the `gridSize × gridSize` data grid. The user's "Tag size"
 * input applies to the *full* marker including the border, so
 * `widthAtBorder === edge` for every ArUco family.
 *
 * Bit convention in the source data is `0 = black, 1 = white`. The
 * project's `BitGridMarker` convention is `true = black`, so the data
 * cells are inverted on extraction.
 *
 * `gridSize` and `count` (= numMarkers) are baked into the registry
 * entries rather than discovered from the JSON, mirroring `MosaicFamily`:
 * geometry is known statically and the loader only fills in the bit
 * tables. The values are sanity-checked against the file on load.
 */
import { BitGridMarker, type Family, type FamilyGeometry, type Marker } from "./family";

export interface ArucoFamilyOptions {
  readonly name: string;
  readonly label?: string;
  readonly group?: string;
  readonly gridSize: number;
  readonly count: number;
  readonly jsonPath: string;
}

interface ArucoDictionary {
  readonly name: string;
  readonly gridSize: number;
  readonly numMarkers: number;
  readonly markers: ReadonlyArray<ReadonlyArray<number>>;
}

export class ArucoFamily implements Family {
  readonly name: string;
  readonly label?: string;
  readonly group?: string;
  readonly count: number;
  readonly geometry: FamilyGeometry;
  private readonly gridSize: number;
  private readonly jsonPath: string;

  private loadPromise: Promise<void> | null = null;
  private markers: ReadonlyArray<ReadonlyArray<number>> | null = null;
  private readonly markerCache = new Map<number, BitGridMarker>();

  constructor(opts: ArucoFamilyOptions) {
    this.name = opts.name;
    this.label = opts.label;
    this.group = opts.group;
    this.count = opts.count;
    this.gridSize = opts.gridSize;
    this.jsonPath = opts.jsonPath;
    const edge = opts.gridSize + 2;
    this.geometry = { edge, widthAtBorder: edge, outerShape: "square" };
  }

  load(_ids?: readonly number[]): Promise<void> {
    // ArUco dictionaries ship as a single JSON file holding every
    // marker, so per-id loading collapses to the same one-shot fetch.
    if (this.loadPromise !== null) return this.loadPromise;
    this.loadPromise = fetchDictionary(this.jsonPath).then((d) => {
      if (d.gridSize !== this.gridSize) {
        throw new Error(
          `${this.name}: registry gridSize=${this.gridSize} but file reports gridSize=${d.gridSize}`,
        );
      }
      if (d.numMarkers !== this.count) {
        throw new Error(
          `${this.name}: registry count=${this.count} but file reports numMarkers=${d.numMarkers}`,
        );
      }
      if (d.markers.length !== d.numMarkers) {
        throw new Error(
          `${this.name}: header reports ${d.numMarkers} markers but markers array has ${d.markers.length}`,
        );
      }
      this.markers = d.markers;
    });
    this.loadPromise.catch(() => {
      this.loadPromise = null;
    });
    return this.loadPromise;
  }

  isIdLoaded(id: number): boolean {
    return this.markers !== null && id >= 0 && id < this.count;
  }

  getMarker(id: number): Marker {
    if (this.markers === null) {
      throw new Error(
        `ArucoFamily(${this.name}).getMarker called before load() resolved`,
      );
    }
    if (id < 0 || id >= this.count) {
      throw new RangeError(
        `${this.name}: marker id ${id} out of range (count=${this.count})`,
      );
    }
    const hit = this.markerCache.get(id);
    if (hit) return hit;

    const bits = buildArucoBits(this.gridSize, this.markers[id]!, id);
    const marker = new BitGridMarker(bits, `${this.name}#${id}`);
    this.markerCache.set(id, marker);
    return marker;
  }
}

/** Build the `(gridSize+2) × (gridSize+2)` bit grid for one ArUco marker:
 *  an outer black ring wrapping the flat row-major data array, with the
 *  source's `0 = black` convention inverted to the project's
 *  `true = black`. */
export function buildArucoBits(
  gridSize: number,
  flat: ReadonlyArray<number>,
  id: number,
): boolean[][] {
  if (flat.length !== gridSize * gridSize) {
    throw new Error(
      `marker ${id} has ${flat.length} bits, expected ${gridSize * gridSize} (gridSize=${gridSize})`,
    );
  }
  const edge = gridSize + 2;
  const out: boolean[][] = [];
  for (let r = 0; r < edge; r++) {
    const row: boolean[] = new Array(edge);
    const isBorderRow = r === 0 || r === edge - 1;
    for (let c = 0; c < edge; c++) {
      if (isBorderRow || c === 0 || c === edge - 1) {
        row[c] = true;
      } else {
        // Source: 0 = black = true, 1 = white = false.
        row[c] = flat[(r - 1) * gridSize + (c - 1)] === 0;
      }
    }
    out.push(row);
  }
  return out;
}

async function fetchDictionary(url: string): Promise<ArucoDictionary> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to fetch ArUco dictionary: ${url} (${res.status})`);
  }
  const json = (await res.json()) as Partial<ArucoDictionary>;
  if (
    typeof json.name !== "string" ||
    typeof json.gridSize !== "number" ||
    typeof json.numMarkers !== "number" ||
    !Array.isArray(json.markers)
  ) {
    throw new Error(`malformed ArUco dictionary at ${url}`);
  }
  return json as ArucoDictionary;
}
