/**
 * Public download API used by the UI. Owns the format × mode dispatch
 * matrix, zip bundling for multi-file outputs, and filename generation.
 * Production callers go through `runExport`; the underlying renderers
 * (`renderPlan` for PDF, `composePage` + `SvgCanvas` / `PngCanvas` for
 * SVG / PNG, `composePerTag` for the bare-marker variants) stay
 * separately testable.
 *
 * The five surfaced combinations:
 *
 *   PDF + packed      -> single file via the existing pdf-lib pipeline
 *   SVG + packed      -> one SVG per layout page; zip when >1 page
 *   SVG + per-tag     -> one SVG per placement; zip when >1 tag
 *   PNG + packed      -> one PNG per layout page; zip when >1 page
 *   PNG + per-tag     -> one PNG per placement; zip when >1 tag
 *
 * `printLabelsOnBack` and `printLabelsInQuietZone` apply across
 * formats. `printLabelsOnBack` is currently packed-only — per-tag
 * back-label files are a follow-up if anyone asks.
 */
import { zipSync, strToU8, type Zippable } from "fflate";
import type { BitsProvider } from "./families";
import type { LayoutPlan, Placement } from "./layout/types";
import { composePage } from "./render/compose";
import { composePerTag, perTagCanvasSize_mm } from "./render/compose-per-tag";
import { PngCanvas } from "./render/png-canvas";
import { drawBackPage, drawPageFooter } from "./render/pdf-pages";
import { renderPlan, type RenderOptions } from "./render/pdf";
import { createDomRasterizer, SvgCanvas } from "./render/svg-canvas";

export type ExportFormat = "pdf" | "svg" | "png";
export type ExportMode = "packed" | "per-tag";

export interface ExportOptions {
  printLabelsInQuietZone?: boolean;
  printLabelsOnBack?: boolean;
  /** Resolution for PNG output. Ignored for PDF and SVG. Default 300. */
  pngDpi?: number;
}

export interface ExportRequest {
  plan: LayoutPlan;
  markers: BitsProvider;
  format: ExportFormat;
  mode: ExportMode;
  options?: ExportOptions;
}

export interface ExportResult {
  blob: Blob;
  filename: string;
}

export async function runExport(req: ExportRequest): Promise<ExportResult> {
  const opts: ExportOptions = req.options ?? {};
  if (req.format === "pdf" && req.mode === "per-tag") {
    throw new Error("per-tag mode is not supported for PDF; use packed PDF or per-tag SVG/PNG.");
  }
  if (req.format === "pdf") return runPdfPacked(req, opts);
  if (req.format === "svg") {
    return req.mode === "packed"
      ? runSvgPacked(req, opts)
      : runSvgPerTag(req, opts);
  }
  return req.mode === "packed"
    ? await runPngPacked(req, opts)
    : await runPngPerTag(req, opts);
}

// -------------------- PDF (packed only) --------------------

async function runPdfPacked(
  req: ExportRequest,
  opts: ExportOptions,
): Promise<ExportResult> {
  const renderOpts: RenderOptions = {
    printLabelsInQuietZone: opts.printLabelsInQuietZone,
    printLabelsOnBack: opts.printLabelsOnBack,
  };
  const bytes = await renderPlan(req.plan, req.markers, renderOpts);
  return { blob: bytesToBlob(bytes, "application/pdf"), filename: "tags.pdf" };
}

// -------------------- SVG --------------------

function runSvgPacked(
  req: ExportRequest,
  opts: ExportOptions,
): ExportResult {
  const rasterizer = createDomRasterizer();
  const pages: Array<{ name: string; svg: string }> = [];
  for (let p = 0; p < req.plan.pageCount; p++) {
    const front = renderSvgFrontPage(req.plan, p, req.markers, opts, rasterizer);
    pages.push({ name: `page-${p + 1}.svg`, svg: front });
    if (opts.printLabelsOnBack) {
      const back = renderSvgBackPage(req.plan, p);
      pages.push({ name: `page-${p + 1}-back.svg`, svg: back });
    }
  }
  if (pages.length === 0) {
    // Empty plan — surface an empty SVG rather than a useless zip.
    return {
      blob: new Blob(
        [emptySvg(req.plan.paper.width_mm, req.plan.paper.height_mm)],
        { type: "image/svg+xml" },
      ),
      filename: "tags.svg",
    };
  }
  if (pages.length === 1) {
    return {
      blob: new Blob([pages[0]!.svg], { type: "image/svg+xml" }),
      filename: "tags.svg",
    };
  }
  return zipResult(pages.map((p) => ({ name: p.name, data: strToU8(p.svg) })), "tags-svg.zip");
}

function runSvgPerTag(
  req: ExportRequest,
  opts: ExportOptions,
): ExportResult {
  const rasterizer = createDomRasterizer();
  const files = perTagFilenames(req.plan).map((entry, i) => {
    const svg = renderPerTagSvg(entry.placement, req.plan, req.markers, opts, rasterizer);
    return { name: `${entry.name}.svg`, data: strToU8(svg), idx: i };
  });
  if (files.length === 0) {
    return {
      blob: new Blob(
        [emptySvg(req.plan.tileSize_mm, req.plan.tileSize_mm)],
        { type: "image/svg+xml" },
      ),
      filename: "tags.svg",
    };
  }
  if (files.length === 1) {
    const f = files[0]!;
    const svg = new TextDecoder().decode(f.data);
    return {
      blob: new Blob([svg], { type: "image/svg+xml" }),
      filename: f.name,
    };
  }
  return zipResult(files.map((f) => ({ name: f.name, data: f.data })), "tags-per-tag-svg.zip");
}

// -------------------- PNG --------------------

async function runPngPacked(
  req: ExportRequest,
  opts: ExportOptions,
): Promise<ExportResult> {
  const dpi = opts.pngDpi ?? 300;
  const files: Array<{ name: string; data: Uint8Array }> = [];
  for (let p = 0; p < req.plan.pageCount; p++) {
    const front = await renderPngFrontPage(req.plan, p, req.markers, opts, dpi);
    files.push({ name: `page-${p + 1}.png`, data: front });
    if (opts.printLabelsOnBack) {
      const back = await renderPngBackPage(req.plan, p, dpi);
      files.push({ name: `page-${p + 1}-back.png`, data: back });
    }
  }
  if (files.length === 0) {
    return { blob: bytesToBlob(new Uint8Array(), "image/png"), filename: "tags.png" };
  }
  if (files.length === 1) {
    return {
      blob: bytesToBlob(files[0]!.data, "image/png"),
      filename: "tags.png",
    };
  }
  return zipResult(files, "tags-png.zip");
}

async function runPngPerTag(
  req: ExportRequest,
  opts: ExportOptions,
): Promise<ExportResult> {
  const dpi = opts.pngDpi ?? 300;
  const files: Array<{ name: string; data: Uint8Array }> = [];
  for (const entry of perTagFilenames(req.plan)) {
    const data = await renderPerTagPng(entry.placement, req.plan, req.markers, opts, dpi);
    files.push({ name: `${entry.name}.png`, data });
  }
  if (files.length === 0) {
    return { blob: bytesToBlob(new Uint8Array(), "image/png"), filename: "tags.png" };
  }
  if (files.length === 1) {
    const f = files[0]!;
    return { blob: bytesToBlob(f.data, "image/png"), filename: f.name };
  }
  return zipResult(files, "tags-per-tag-png.zip");
}

// -------------------- page renderers --------------------

function renderSvgFrontPage(
  plan: LayoutPlan,
  pageIndex: number,
  markers: BitsProvider,
  opts: ExportOptions,
  rasterizer: ReturnType<typeof createDomRasterizer>,
): string {
  const canvas = new SvgCanvas(plan.paper.width_mm, plan.paper.height_mm, {
    rasterizer,
  });
  composePage(plan, pageIndex, canvas, markers, {
    printLabelsInQuietZone: opts.printLabelsInQuietZone,
  });
  return canvas.toString();
}

function renderSvgBackPage(plan: LayoutPlan, pageIndex: number): string {
  const canvas = new SvgCanvas(plan.paper.width_mm, plan.paper.height_mm);
  drawBackPage(canvas, plan, pageIndex);
  drawPageFooter(canvas, plan, pageIndex, true);
  return canvas.toString();
}

async function renderPngFrontPage(
  plan: LayoutPlan,
  pageIndex: number,
  markers: BitsProvider,
  opts: ExportOptions,
  dpi: number,
): Promise<Uint8Array> {
  const canvas = new PngCanvas(plan.paper.width_mm, plan.paper.height_mm, { dpi });
  composePage(plan, pageIndex, canvas, markers, {
    printLabelsInQuietZone: opts.printLabelsInQuietZone,
  });
  drawPageFooter(canvas, plan, pageIndex, false);
  return await blobToBytes(await canvas.toBlob());
}

async function renderPngBackPage(
  plan: LayoutPlan,
  pageIndex: number,
  dpi: number,
): Promise<Uint8Array> {
  const canvas = new PngCanvas(plan.paper.width_mm, plan.paper.height_mm, { dpi });
  drawBackPage(canvas, plan, pageIndex);
  drawPageFooter(canvas, plan, pageIndex, true);
  return await blobToBytes(await canvas.toBlob());
}

function renderPerTagSvg(
  placement: Placement,
  plan: LayoutPlan,
  markers: BitsProvider,
  opts: ExportOptions,
  rasterizer: ReturnType<typeof createDomRasterizer>,
): string {
  const tile_mm = plan.tileSize_mm;
  const quietZone_mm = plan.options.quietZone_mm;
  const size = perTagCanvasSize_mm({ tile_mm, quietZone_mm });
  const canvas = new SvgCanvas(size.width_mm, size.height_mm, { rasterizer });
  composePerTag(canvas, markers, placement.tag, {
    tile_mm,
    tagSize_mm: plan.tagSize_mm,
    quietZone_mm,
    printLabelsInQuietZone: opts.printLabelsInQuietZone ?? false,
    subtagLevels: plan.subtagLevels,
  });
  return canvas.toString();
}

async function renderPerTagPng(
  placement: Placement,
  plan: LayoutPlan,
  markers: BitsProvider,
  opts: ExportOptions,
  dpi: number,
): Promise<Uint8Array> {
  const tile_mm = plan.tileSize_mm;
  const quietZone_mm = plan.options.quietZone_mm;
  const size = perTagCanvasSize_mm({ tile_mm, quietZone_mm });
  const canvas = new PngCanvas(size.width_mm, size.height_mm, { dpi });
  composePerTag(canvas, markers, placement.tag, {
    tile_mm,
    tagSize_mm: plan.tagSize_mm,
    quietZone_mm,
    printLabelsInQuietZone: opts.printLabelsInQuietZone ?? false,
    subtagLevels: plan.subtagLevels,
  });
  return await blobToBytes(await canvas.toBlob());
}

// -------------------- helpers --------------------

/** Per-tag filename per placement, deduplicating by appending the
 *  placement index when two placements share a family/id. */
export function perTagFilenames(plan: LayoutPlan): Array<{ placement: Placement; name: string }> {
  const seen = new Map<string, number>();
  const out: Array<{ placement: Placement; name: string }> = [];
  for (let i = 0; i < plan.placements.length; i++) {
    const placement = plan.placements[i]!;
    const base = `${placement.tag.family}-${placement.tag.id}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const name = count === 1 ? base : `${base}-${count}`;
    out.push({ placement, name });
  }
  return out;
}

function zipResult(
  files: Array<{ name: string; data: Uint8Array }>,
  zipName: string,
): ExportResult {
  const entries: Zippable = {};
  for (const f of files) entries[f.name] = f.data;
  const buf = zipSync(entries);
  return {
    blob: new Blob([buf], { type: "application/zip" }),
    filename: zipName,
  };
}

function bytesToBlob(bytes: Uint8Array, type: string): Blob {
  // pdf-lib returns `Uint8Array<ArrayBufferLike>` which Blob's typing
  // rejects; copy to a plain `Uint8Array<ArrayBuffer>`.
  const buf = new Uint8Array(bytes.byteLength);
  buf.set(bytes);
  return new Blob([buf], { type });
}

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function emptySvg(width_mm: number, height_mm: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `viewBox="0 0 ${width_mm} ${height_mm}" width="100%">` +
    `<rect x="0" y="0" width="${width_mm}" height="${height_mm}" fill="#ffffff"/>` +
    `</svg>`
  );
}
