/**
 * Fetch upstream `apriltag-imgs` mosaic PNGs into `public/resources/`, then
 * verify each PNG's geometry against the family's expected tile size and
 * tag count. Prints a registry-entry snippet ready to drop into
 * `src/families/index.ts`.
 *
 * Run with:   npx vite-node scripts/fetch-mosaics.ts
 *
 * Idempotent: skips files already present unless `--force` is passed. The
 * geometry check still runs on cached files so registry mistakes surface even
 * when the PNG was downloaded on a previous run.
 *
 * Verification uses the PNG IHDR chunk only (width/height at fixed byte
 * offsets), so the script has no decode dependency. Per-pixel checks live in
 * `src/families/index.test.ts` where they belong.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface ExpectedFamily {
  name: string;
  /** Pixel edge of one tile in the mosaic, including the embedded quiet zone.
   *  Mosaic stride between adjacent tiles is `tileSize_px + 1` (the upstream
   *  generator inserts a 1-pixel black separator). */
  tileSize_px: number;
  /** Width in mosaic pixels of the white border baked into each tile. The
   *  AprilTag bitmap proper is `tileSize_px − 2·embeddedQuietZone_px` on a
   *  side. */
  embeddedQuietZone_px: number;
  /** Number of *valid* tag IDs in the family (the mosaic may contain extra
   *  blank tiles to round out a rectangular grid). */
  validTagCount: number;
}

// Every family in `AprilRobotics/apriltag-imgs` we plan to ship. ArUco is
// out of scope until upstream packages it. Values come from the AprilTag
// spec / upstream READMEs; this script confirms them against the PNG.
const FAMILIES: ExpectedFamily[] = [
  { name: "tag36h11",         tileSize_px: 10, embeddedQuietZone_px: 1, validTagCount: 587 },
  { name: "tagStandard41h12", tileSize_px:  9, embeddedQuietZone_px: 1, validTagCount: 2115 },
  { name: "tagStandard52h13", tileSize_px: 10, embeddedQuietZone_px: 1, validTagCount: 48714 },
  { name: "tagCustom48h12",   tileSize_px: 10, embeddedQuietZone_px: 1, validTagCount: 42211 },
  { name: "tagCircle21h7",    tileSize_px:  9, embeddedQuietZone_px: 1, validTagCount: 38 },
  { name: "tagCircle49h12",   tileSize_px: 11, embeddedQuietZone_px: 1, validTagCount: 65535 },
];

const UPSTREAM_BASE = "https://raw.githubusercontent.com/AprilRobotics/apriltag-imgs/master";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESOURCES_DIR = path.join(PROJECT_ROOT, "public", "resources");

/** Width/height in pixels, parsed from a PNG file's IHDR chunk. The PNG spec
 *  fixes the IHDR position: 8-byte signature, 4-byte length, 4-byte type
 *  ("IHDR"), then width/height as 4-byte big-endian uints at byte offsets
 *  16 and 20. */
function readPngSize(bytes: Uint8Array): { width: number; height: number } {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < sig.length; i++) {
    if (bytes[i] !== sig[i]) throw new Error("not a PNG (signature mismatch)");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** (cols, rows) of a mosaic of `tileSize_px` tiles separated by a 1-pixel
 *  black grid. Matches `mosaicGrid` in `src/families/index.ts`. */
function mosaicGrid(
  family: ExpectedFamily,
  widthPx: number,
  heightPx: number,
): { cols: number; rows: number } {
  const stride = family.tileSize_px + 1;
  return {
    cols: Math.floor((widthPx + 1) / stride),
    rows: Math.floor((heightPx + 1) / stride),
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function fetchMosaic(family: ExpectedFamily, force: boolean): Promise<{ path: string; cached: boolean }> {
  const dest = path.join(RESOURCES_DIR, `${family.name}_mosaic.png`);
  if (!force && (await exists(dest))) return { path: dest, cached: true };
  const url = `${UPSTREAM_BASE}/${family.name}/mosaic.png`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  await mkdir(RESOURCES_DIR, { recursive: true });
  await writeFile(dest, buf);
  return { path: dest, cached: false };
}

interface VerifyResult {
  family: ExpectedFamily;
  widthPx: number;
  heightPx: number;
  cols: number;
  rows: number;
  totalTiles: number;
  ok: boolean;
  cached: boolean;
  sizeKb: number;
}

async function processFamily(family: ExpectedFamily, force: boolean): Promise<VerifyResult> {
  const { path: filePath, cached } = await fetchMosaic(family, force);
  const bytes = await readFile(filePath);
  const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { width: widthPx, height: heightPx } = readPngSize(u8);
  const { cols, rows } = mosaicGrid(family, widthPx, heightPx);
  const totalTiles = cols * rows;
  return {
    family,
    widthPx,
    heightPx,
    cols,
    rows,
    totalTiles,
    ok: totalTiles >= family.validTagCount,
    cached,
    sizeKb: bytes.length / 1024,
  };
}

function snippet(r: VerifyResult): string {
  const f = r.family;
  return (
    `  ${f.name}: {\n` +
    `    name: "${f.name}",\n` +
    `    mosaicPath: \`\${import.meta.env.BASE_URL}resources/${f.name}_mosaic.png\`,\n` +
    `    tileSize_px: ${f.tileSize_px},\n` +
    `    embeddedQuietZone_px: ${f.embeddedQuietZone_px},\n` +
    `    validTagCount: ${f.validTagCount},\n` +
    `  },`
  );
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const results: VerifyResult[] = [];
  for (const family of FAMILIES) {
    try {
      results.push(await processFamily(family, force));
    } catch (e) {
      console.error(`  ${family.name}: FAILED — ${(e as Error).message}`);
    }
  }

  console.log("\nFamily               PNG (px)      tiles   expected   ok   source   size");
  console.log("-".repeat(82));
  for (const r of results) {
    const dim = `${r.widthPx}×${r.heightPx}`;
    const tiles = `${r.cols}×${r.rows}=${r.totalTiles}`;
    const mark = r.ok ? "yes" : "NO ";
    const src = r.cached ? "cached" : "fetched";
    console.log(
      `${r.family.name.padEnd(20)} ${dim.padEnd(13)} ${tiles.padEnd(11)} ${String(r.family.validTagCount).padEnd(10)} ${mark}  ${src.padEnd(7)} ${r.sizeKb.toFixed(1)}KB`,
    );
  }

  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    console.error(
      `\n${failures.length} familia(s) failed verification. Mosaic has fewer tiles than expected — ` +
        `the tileSize_px or validTagCount in this script is likely wrong.`,
    );
    process.exit(1);
  }

  console.log("\nDrop-in entries for src/families/index.ts:\n");
  for (const r of results) console.log(snippet(r));
}

await main();
