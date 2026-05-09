/**
 * Browser-side loader for tag-family mosaics. Fetches the PNG, decodes it
 * via a 2D canvas, and exposes a per-tag-id bit lookup. Cached per family.
 *
 * This module touches the DOM (Image, canvas), so it lives separately from
 * the pure registry/extractor in `./index.ts`.
 */

import { extractTagBits, getFamily, mosaicGrid, tagBitmapEdge_px, type TagFamilyDef } from ".";

export interface FamilyBitmaps {
  family: TagFamilyDef;
  /** Edge length in cells of each tag's bit grid. */
  edge: number;
  /** Total tiles in the mosaic (≥ valid tag count). */
  totalTiles: number;
  /** Bit grid for tag `id`, or null if id is out of mosaic range. */
  bits(id: number): boolean[][] | null;
}

const cache = new Map<string, Promise<FamilyBitmaps>>();

export function loadFamily(name: string): Promise<FamilyBitmaps> {
  const cached = cache.get(name);
  if (cached) return cached;
  const family = getFamily(name);
  if (!family) {
    return Promise.reject(new Error(`unknown tag family: ${name}`));
  }
  const promise = decode(family);
  cache.set(name, promise);
  // If the load fails, drop the cache entry so a later attempt can retry.
  promise.catch(() => cache.delete(name));
  return promise;
}

async function decode(family: TagFamilyDef): Promise<FamilyBitmaps> {
  const img = await loadImage(family.mosaicPath);
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

  const { cols, rows } = mosaicGrid(family, W, H);
  const totalTiles = cols * rows;
  const edge = tagBitmapEdge_px(family);
  const bitsCache = new Map<number, boolean[][]>();
  return {
    family,
    edge,
    totalTiles,
    bits(id: number): boolean[][] | null {
      if (id < 0 || id >= totalTiles) return null;
      const hit = bitsCache.get(id);
      if (hit) return hit;
      const b = extractTagBits(gray, W, H, family, id);
      bitsCache.set(id, b);
      return b;
    },
  };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = (): void => resolve(img);
    img.onerror = (): void => reject(new Error(`failed to load image: ${url}`));
    img.src = url;
  });
}
