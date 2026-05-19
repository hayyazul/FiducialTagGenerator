/**
 * `Family` implementation for marker families distributed as a single PNG
 * mosaic (the format used by upstream `apriltag-imgs`). On `load()`,
 * fetches the PNG and decodes it through a 2D canvas. On `getMarker()`,
 * extracts the tag's cells from the cached pixel buffer and (for circle
 * families) masks the cells outside the disk.
 *
 * One `MosaicFamily` instance per registry entry; instances own their own
 * lifecycle and caching. No module-level state.
 */
import { BitGridMarker, type Family, type FamilyGeometry, type Marker } from "./family";
import { applyCircleMask, extractTagBits } from "./mosaic-bits";

export interface MosaicFamilyOptions {
  readonly name: string;
  readonly group?: string;
  readonly count: number;
  readonly geometry: FamilyGeometry;
  readonly mosaicPath: string;
}

interface DecodedMosaic {
  readonly pixels: Uint8Array;
  readonly width_px: number;
  readonly height_px: number;
}

export class MosaicFamily implements Family {
  readonly name: string;
  readonly group?: string;
  readonly count: number;
  readonly geometry: FamilyGeometry;
  private readonly mosaicPath: string;

  private loadPromise: Promise<void> | null = null;
  private decoded: DecodedMosaic | null = null;
  private readonly markerCache = new Map<number, BitGridMarker>();

  constructor(opts: MosaicFamilyOptions) {
    this.name = opts.name;
    this.group = opts.group;
    this.count = opts.count;
    this.geometry = opts.geometry;
    this.mosaicPath = opts.mosaicPath;
  }

  load(): Promise<void> {
    if (this.loadPromise !== null) return this.loadPromise;
    this.loadPromise = decodeMosaic(this.mosaicPath).then((d) => {
      this.decoded = d;
    });
    // On failure, clear the promise so a later retry can fetch fresh.
    this.loadPromise.catch(() => {
      this.loadPromise = null;
    });
    return this.loadPromise;
  }

  getMarker(id: number): Marker {
    if (this.decoded === null) {
      throw new Error(
        `MosaicFamily(${this.name}).getMarker called before load() resolved`,
      );
    }
    if (id < 0 || id >= this.count) {
      throw new RangeError(
        `${this.name}: marker id ${id} out of range (count=${this.count})`,
      );
    }
    const hit = this.markerCache.get(id);
    if (hit) return hit;

    const raw = extractTagBits(
      this.decoded.pixels,
      this.decoded.width_px,
      this.decoded.height_px,
      this.geometry.edge,
      this.name,
      id,
    );
    const bits =
      this.geometry.outerShape === "circle"
        ? applyCircleMask(raw, this.geometry.outerRadiusCells!)
        : raw;
    const marker = new BitGridMarker(bits, `${this.name}#${id}`);
    this.markerCache.set(id, marker);
    return marker;
  }
}

async function decodeMosaic(url: string): Promise<DecodedMosaic> {
  const img = await loadImage(url);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, W, H).data;

  // Mosaic pixels are pure black/white; collapse RGBA → red channel.
  const gray = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) gray[i] = data[i * 4]!;
  return { pixels: gray, width_px: W, height_px: H };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = (): void => resolve(img);
    img.onerror = (): void => reject(new Error(`failed to load image: ${url}`));
    img.src = url;
  });
}
