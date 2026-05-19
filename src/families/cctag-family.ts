/**
 * `Family` implementation for the CCTag concentric-ring fiducials.
 *
 * Each family ships as a single text file under
 * `public/resources/cctag/` (`cctag3.txt`, `cctag4.txt`) listing one
 * marker per line as whitespace-separated integer radii in percent of
 * the outer disk radius. The file is fetched once on first `load()`,
 * parsed into normalised ring radii by `parseCCTagData`, and used to
 * lazily build `RingMarker`s on demand. Shape mirrors `ArucoFamily`:
 * one fetch covers every id, so `load(ids?)` ignores the id list.
 *
 * Geometry: CCTag has no real "cells," but the rest of the code uses
 * `widthAtBorder` as the denominator for the half-module quiet-zone
 * default (`deriveQuietZone_mm`). We pick `edge = widthAtBorder = 5`
 * to match `tagCircle21h7`, so the auto-quiet-zone is 10 % of the tag
 * size — the same fraction the existing AprilTag circle families use.
 * `outerRadiusCells = 2.5` keeps the cut radius at exactly `tagSize/2`
 * (the outer black disk). Both ratios — `edge/widthAtBorder` and
 * `outerRadiusCells/widthAtBorder` — are what flow through the size
 * and layout math; the absolute number is otherwise arbitrary.
 */
import { type Family, type FamilyGeometry, type Marker } from "./family";
import { RingMarker } from "./ring-marker";
import { parseCCTagData } from "./cctag-data";

export interface CCTagFamilyOptions {
  readonly name: string;
  readonly label?: string;
  readonly group?: string;
  /** Number of inner rings declared per marker in the data file. The
   *  3-ring family lists 5 radii per line; the 4-ring family lists 7. */
  readonly ringsPerMarker: number;
  /** Total marker count (= number of non-blank lines expected in the
   *  text file). Sanity-checked against the parsed file at load time. */
  readonly count: number;
  /** URL of the `cctagN.txt` data file. */
  readonly dataPath: string;
}

export class CCTagFamily implements Family {
  readonly name: string;
  readonly label?: string;
  readonly group?: string;
  readonly count: number;
  readonly geometry: FamilyGeometry;
  private readonly ringsPerMarker: number;
  private readonly dataPath: string;

  private loadPromise: Promise<void> | null = null;
  private radii: ReadonlyArray<ReadonlyArray<number>> | null = null;
  private readonly markerCache = new Map<number, RingMarker>();

  constructor(opts: CCTagFamilyOptions) {
    this.name = opts.name;
    this.label = opts.label;
    this.group = opts.group;
    this.count = opts.count;
    this.ringsPerMarker = opts.ringsPerMarker;
    this.dataPath = opts.dataPath;
    this.geometry = {
      edge: 5,
      widthAtBorder: 5,
      outerShape: "circle",
      outerRadiusCells: 2.5,
    };
  }

  load(_ids?: readonly number[]): Promise<void> {
    if (this.loadPromise !== null) return this.loadPromise;
    this.loadPromise = fetchCCTagText(this.dataPath).then((text) => {
      const parsed = parseCCTagData(text, this.ringsPerMarker);
      if (parsed.length !== this.count) {
        throw new Error(
          `${this.name}: registry count=${this.count} but file ${this.dataPath} has ${parsed.length} markers`,
        );
      }
      this.radii = parsed;
    });
    this.loadPromise.catch(() => {
      this.loadPromise = null;
    });
    return this.loadPromise;
  }

  isIdLoaded(id: number): boolean {
    return this.radii !== null && id >= 0 && id < this.count;
  }

  getMarker(id: number): Marker {
    if (this.radii === null) {
      throw new Error(
        `CCTagFamily(${this.name}).getMarker called before load() resolved`,
      );
    }
    if (id < 0 || id >= this.count) {
      throw new RangeError(
        `${this.name}: marker id ${id} out of range (count=${this.count})`,
      );
    }
    const hit = this.markerCache.get(id);
    if (hit) return hit;
    const marker = new RingMarker(this.radii[id]!, `${this.name}#${id}`);
    this.markerCache.set(id, marker);
    return marker;
  }
}

async function fetchCCTagText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to fetch CCTag data: ${url} (${res.status})`);
  }
  return await res.text();
}
