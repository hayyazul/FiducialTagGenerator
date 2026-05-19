/**
 * `Family` implementation for marker families distributed as PNG mosaics.
 *
 * The on-disk layout splits each family into one or more chunk PNGs
 * (`public/resources/apriltag/<name>/chunk_NNN.png`). Every chunk is
 * itself a valid mosaic in the upstream tile + 1-pixel-separator format,
 * holding up to `chunkSize` tiles in row-major order, indexed locally
 * `0..chunkSize-1`. Global tag id `i` lives in chunk
 * `floor(i / chunkSize)` at local index `i mod chunkSize`. Small families
 * with `chunkSize === count` collapse to a single chunk — same code path,
 * one file.
 *
 * `load(ids)` fetches only the chunks containing the requested ids;
 * repeated calls do not re-fetch and concurrent calls share the same
 * in-flight promise per chunk. `load()` with no `ids` is a no-op:
 * fetching is deferred to the first per-id call.
 */
import { BitGridMarker, type Family, type FamilyGeometry, type Marker } from "./family";
import { applyCircleMask, extractTagBits } from "./mosaic-bits";

export interface MosaicFamilyOptions {
  readonly name: string;
  readonly group?: string;
  readonly count: number;
  readonly geometry: FamilyGeometry;
  /** Maximum tags carried by one chunk file. For small families set to
   *  `count` so the family resolves to a single chunk. */
  readonly chunkSize: number;
  /** Directory URL holding the chunk PNGs, no trailing slash. The chunk
   *  for index `ci` is fetched from `${chunkBasePath}/chunk_NNN.png`
   *  with `NNN` zero-padded to 3 digits. */
  readonly chunkBasePath: string;
}

interface DecodedChunk {
  readonly pixels: Uint8Array;
  readonly width_px: number;
  readonly height_px: number;
}

export class MosaicFamily implements Family {
  readonly name: string;
  readonly group?: string;
  readonly count: number;
  readonly geometry: FamilyGeometry;
  private readonly chunkSize: number;
  private readonly chunkBasePath: string;

  private readonly decodedChunks = new Map<number, DecodedChunk>();
  private readonly loadingChunks = new Map<number, Promise<void>>();
  private readonly markerCache = new Map<number, BitGridMarker>();

  constructor(opts: MosaicFamilyOptions) {
    if (opts.chunkSize <= 0) {
      throw new Error(`${opts.name}: chunkSize must be positive (got ${opts.chunkSize})`);
    }
    this.name = opts.name;
    this.group = opts.group;
    this.count = opts.count;
    this.geometry = opts.geometry;
    this.chunkSize = opts.chunkSize;
    this.chunkBasePath = opts.chunkBasePath;
  }

  load(ids?: readonly number[]): Promise<void> {
    if (ids === undefined) return Promise.resolve();
    const needed = new Set<number>();
    for (const id of ids) {
      if (id < 0 || id >= this.count) continue;
      const ci = Math.floor(id / this.chunkSize);
      if (!this.decodedChunks.has(ci)) needed.add(ci);
    }
    if (needed.size === 0) return Promise.resolve();
    return Promise.all(Array.from(needed, (ci) => this.ensureChunk(ci))).then(
      () => undefined,
    );
  }

  isIdLoaded(id: number): boolean {
    if (id < 0 || id >= this.count) return false;
    return this.decodedChunks.has(Math.floor(id / this.chunkSize));
  }

  getMarker(id: number): Marker {
    if (id < 0 || id >= this.count) {
      throw new RangeError(
        `${this.name}: marker id ${id} out of range (count=${this.count})`,
      );
    }
    const ci = Math.floor(id / this.chunkSize);
    const chunk = this.decodedChunks.get(ci);
    if (!chunk) {
      throw new Error(
        `MosaicFamily(${this.name}).getMarker(${id}): chunk ${ci} not loaded; await load([${id}]) first`,
      );
    }
    const hit = this.markerCache.get(id);
    if (hit) return hit;

    const localId = id - ci * this.chunkSize;
    const raw = extractTagBits(
      chunk.pixels,
      chunk.width_px,
      chunk.height_px,
      this.geometry.edge,
      this.name,
      localId,
    );
    const bits =
      this.geometry.outerShape === "circle"
        ? applyCircleMask(raw, this.geometry.outerRadiusCells!)
        : raw;
    const marker = new BitGridMarker(bits, `${this.name}#${id}`);
    this.markerCache.set(id, marker);
    return marker;
  }

  private ensureChunk(ci: number): Promise<void> {
    if (this.decodedChunks.has(ci)) return Promise.resolve();
    const inflight = this.loadingChunks.get(ci);
    if (inflight) return inflight;
    const url = chunkUrl(this.chunkBasePath, ci);
    const p = decodeChunk(url).then((d) => {
      this.decodedChunks.set(ci, d);
      this.loadingChunks.delete(ci);
    });
    // On failure, clear the in-flight entry so a later retry can fetch fresh.
    p.catch(() => {
      this.loadingChunks.delete(ci);
    });
    this.loadingChunks.set(ci, p);
    return p;
  }
}

/** `${base}/chunk_NNN.png` with `NNN` zero-padded to 3 digits — same
 *  convention as `scripts/chunk-mosaics.ts`. Exported for tests. */
export function chunkUrl(basePath: string, chunkIndex: number): string {
  return `${basePath}/chunk_${String(chunkIndex).padStart(3, "0")}.png`;
}

async function decodeChunk(url: string): Promise<DecodedChunk> {
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

  // Chunk pixels are pure black/white grayscale (encoded as 8-bit gray);
  // getImageData expands them to RGBA. Collapse → red channel.
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
