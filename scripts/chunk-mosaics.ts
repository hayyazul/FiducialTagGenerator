/**
 * Split each upstream `<family>_mosaic.png` into one or more chunk PNGs
 * under `public/resources/apriltag/<family>/chunk_NNN.png`. Each chunk is
 * itself a valid mini-mosaic in the same tile + 1-pixel-separator format
 * the runtime decoder already understands, so `MosaicFamily` only needs
 * to know which chunk a tag id lives in, not a new tile layout.
 *
 * Per-family `chunkSize` (tags per chunk) is configured below. Small
 * families use `chunkSize = count` so they collapse to a single chunk —
 * the code path is uniform; only the file count differs.
 *
 * Source mosaics are no longer checked in; run `scripts/fetch-mosaics.ts`
 * first to download them into `public/resources/` (they're git-ignored
 * intermediates), then run this script to regenerate the chunks under
 * `public/resources/apriltag/`. The chunks ARE checked in — they're the
 * artifacts the app ships.
 *
 * Run with:   npx vite-node scripts/chunk-mosaics.ts
 *
 * Verification: after writing each chunk, the script decodes it back and
 * compares every tile against the corresponding tile in the source
 * mosaic. Any mismatch aborts the run.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

interface FamilySpec {
  name: string;
  /** Pixel edge of one tile (matches the upstream mosaic stride convention:
   *  tile_px + 1 = stride). */
  tileSize_px: number;
  /** Number of valid tag IDs. The source mosaic may carry blank trailing
   *  tiles; we don't emit those. */
  count: number;
  /** Tags per chunk file. For families small enough that no benefit comes
   *  from splitting, set this to `count` so the family resolves to a
   *  single chunk. */
  chunkSize: number;
}

const FAMILIES: FamilySpec[] = [
  { name: "tag36h11",         tileSize_px: 10, count:   587, chunkSize:   587 },
  { name: "tagStandard41h12", tileSize_px:  9, count:  2115, chunkSize:  2115 },
  { name: "tagStandard52h13", tileSize_px: 10, count: 48714, chunkSize:   256 },
  { name: "tagCustom48h12",   tileSize_px: 10, count: 42211, chunkSize:   256 },
  { name: "tagCircle21h7",    tileSize_px:  9, count:    38, chunkSize:    38 },
  { name: "tagCircle49h12",   tileSize_px: 11, count: 65535, chunkSize:   256 },
  { name: "tag16h5",          tileSize_px:  8, count:    30, chunkSize:    30 },
  { name: "tag25h9",          tileSize_px:  9, count:    35, chunkSize:    35 },
];

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESOURCES_DIR = path.join(PROJECT_ROOT, "public", "resources");
const APRILTAG_DIR = path.join(RESOURCES_DIR, "apriltag");

/** Grayscale pixel buffer (1 byte/pixel, 0 = black, 255 = white) with
 *  geometry metadata. */
interface GrayImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** PNG → grayscale buffer. We collapse RGBA → red channel; mosaics are
 *  pure B/W so the channel choice is arbitrary. */
async function decodeGrayPng(file: string): Promise<GrayImage> {
  const buf = await readFile(file);
  const png = PNG.sync.read(buf);
  const { width, height, data } = png;
  const pixels = new Uint8Array(width * height);
  if (data.length === width * height) {
    pixels.set(data);
  } else if (data.length === width * height * 4) {
    for (let i = 0; i < width * height; i++) pixels[i] = data[i * 4]!;
  } else {
    throw new Error(
      `unexpected pngjs data length for ${file}: ${data.length} (expected ${width * height} or ${width * height * 4})`,
    );
  }
  return { width, height, pixels };
}

/** Grayscale buffer → 8-bit grayscale PNG bytes. */
function encodeGrayPng(img: GrayImage): Buffer {
  const png = new PNG({
    width: img.width,
    height: img.height,
    colorType: 0,
    bitDepth: 8,
    inputColorType: 0,
    inputHasAlpha: false,
  });
  png.data = Buffer.from(img.pixels.buffer, img.pixels.byteOffset, img.pixels.byteLength);
  return PNG.sync.write(png, { colorType: 0, bitDepth: 8, inputColorType: 0, inputHasAlpha: false });
}

function mosaicCols(tile_px: number, width_px: number): number {
  return Math.floor((width_px + 1) / (tile_px + 1));
}

/** Pick a chunk's internal grid so it stays roughly square. Last chunk
 *  may carry fewer valid tiles, but every chunk in a family uses the same
 *  cols/rows layout so the decoder doesn't need per-chunk metadata. */
function chunkLayout(chunkSize: number): { cols: number; rows: number } {
  const cols = Math.ceil(Math.sqrt(chunkSize));
  const rows = Math.ceil(chunkSize / cols);
  return { cols, rows };
}

function buildChunkImage(
  src: GrayImage,
  srcCols: number,
  tile_px: number,
  chunkSize: number,
  chunkStart: number,
  chunkValidCount: number,
): GrayImage {
  const stride = tile_px + 1;
  const { cols: chunkCols, rows: chunkRows } = chunkLayout(chunkSize);
  const width = chunkCols * stride - 1;
  const height = chunkRows * stride - 1;
  // Init to black: PNG separators are black, and unused trailing tiles
  // are never read by the runtime (id range gates that) — they just need
  // to be valid PNG pixels.
  const pixels = new Uint8Array(width * height); // zero = black
  for (let i = 0; i < chunkValidCount; i++) {
    const globalId = chunkStart + i;
    const srcCol = globalId % srcCols;
    const srcRow = Math.floor(globalId / srcCols);
    const dstCol = i % chunkCols;
    const dstRow = Math.floor(i / chunkCols);
    const sx = srcCol * stride;
    const sy = srcRow * stride;
    const dx = dstCol * stride;
    const dy = dstRow * stride;
    for (let r = 0; r < tile_px; r++) {
      const srcOff = (sy + r) * src.width + sx;
      const dstOff = (dy + r) * width + dx;
      for (let c = 0; c < tile_px; c++) {
        pixels[dstOff + c] = src.pixels[srcOff + c]!;
      }
    }
  }
  return { width, height, pixels };
}

/** Compare every tile-pixel between a freshly-written chunk and the
 *  source mosaic. Aborts the run on the first mismatch. */
function verifyChunk(
  chunk: GrayImage,
  src: GrayImage,
  srcCols: number,
  tile_px: number,
  chunkSize: number,
  chunkStart: number,
  chunkValidCount: number,
  family: string,
  chunkIndex: number,
): void {
  const stride = tile_px + 1;
  const { cols: chunkCols } = chunkLayout(chunkSize);
  for (let i = 0; i < chunkValidCount; i++) {
    const globalId = chunkStart + i;
    const srcCol = globalId % srcCols;
    const srcRow = Math.floor(globalId / srcCols);
    const dstCol = i % chunkCols;
    const dstRow = Math.floor(i / chunkCols);
    for (let r = 0; r < tile_px; r++) {
      for (let c = 0; c < tile_px; c++) {
        const srcByte = src.pixels[(srcRow * stride + r) * src.width + (srcCol * stride + c)]!;
        const dstByte = chunk.pixels[(dstRow * stride + r) * chunk.width + (dstCol * stride + c)]!;
        if ((srcByte < 128) !== (dstByte < 128)) {
          throw new Error(
            `${family} chunk ${chunkIndex}: tile mismatch at local id ${i} (global ${globalId}), pixel (${c},${r})`,
          );
        }
      }
    }
  }
}

interface FamilyResult {
  family: string;
  chunkCount: number;
  totalBytes: number;
  srcBytes: number;
}

async function processFamily(spec: FamilySpec): Promise<FamilyResult> {
  const srcPath = path.join(RESOURCES_DIR, `${spec.name}_mosaic.png`);
  const srcBytes = (await readFile(srcPath)).length;
  const src = await decodeGrayPng(srcPath);
  const srcCols = mosaicCols(spec.tileSize_px, src.width);
  if (srcCols * mosaicCols(spec.tileSize_px, src.height) < spec.count) {
    throw new Error(`${spec.name}: source mosaic has fewer tiles than ${spec.count}`);
  }

  const outDir = path.join(APRILTAG_DIR, spec.name);
  // Clean any previous chunks so a shrunk chunkSize doesn't leave stale files behind.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const numChunks = Math.ceil(spec.count / spec.chunkSize);
  const pad = Math.max(3, String(numChunks - 1).length);
  let totalBytes = 0;

  for (let ci = 0; ci < numChunks; ci++) {
    const chunkStart = ci * spec.chunkSize;
    const chunkValidCount = Math.min(spec.chunkSize, spec.count - chunkStart);
    const chunkImg = buildChunkImage(
      src,
      srcCols,
      spec.tileSize_px,
      spec.chunkSize,
      chunkStart,
      chunkValidCount,
    );
    const pngBytes = encodeGrayPng(chunkImg);
    const fname = `chunk_${String(ci).padStart(pad, "0")}.png`;
    await writeFile(path.join(outDir, fname), pngBytes);
    totalBytes += pngBytes.length;

    // Round-trip verify: decode what we just wrote and compare every
    // tile pixel to the source mosaic.
    const reloaded = await decodeGrayPng(path.join(outDir, fname));
    verifyChunk(
      reloaded,
      src,
      srcCols,
      spec.tileSize_px,
      spec.chunkSize,
      chunkStart,
      chunkValidCount,
      spec.name,
      ci,
    );
  }

  return { family: spec.name, chunkCount: numChunks, totalBytes, srcBytes };
}

async function main(): Promise<void> {
  await mkdir(APRILTAG_DIR, { recursive: true });

  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const only = onlyArg ? onlyArg.slice("--only=".length) : null;
  const targets = only ? FAMILIES.filter((f) => f.name === only) : FAMILIES;
  if (only && targets.length === 0) {
    throw new Error(`unknown family: ${only}`);
  }

  const results: FamilyResult[] = [];
  for (const spec of targets) {
    process.stdout.write(`${spec.name}: chunking (count=${spec.count}, chunkSize=${spec.chunkSize})… `);
    const r = await processFamily(spec);
    results.push(r);
    console.log(`${r.chunkCount} chunks, ${(r.totalBytes / 1024).toFixed(1)}KB (source ${(r.srcBytes / 1024).toFixed(1)}KB)`);
  }

  console.log("\nTotals:");
  let totalNew = 0;
  let totalSrc = 0;
  for (const r of results) {
    totalNew += r.totalBytes;
    totalSrc += r.srcBytes;
  }
  console.log(`  chunked: ${(totalNew / 1024).toFixed(1)}KB`);
  console.log(`  source : ${(totalSrc / 1024).toFixed(1)}KB`);
}

await main();
