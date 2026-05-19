import {
  type BitsProvider,
  getFamily,
  isRecursiveFamily,
  listFamilyNames,
  listSquareFamilyNames,
  type TagFamilyDef,
} from "./families";

/** Build the `<select>` markup for the family picker, grouping consecutive
 *  families by their `group` label. Families without a group fall through into
 *  a trailing ungrouped block. Order is the registry's iteration order. */
function buildFamilyOptionsMarkup(): string {
  const items = listFamilyNames()
    .map((n) => getFamily(n))
    .filter((f): f is TagFamilyDef => f !== undefined);
  let out = "";
  let currentGroup: string | undefined;
  let groupOpen = false;
  for (const f of items) {
    if (f.group !== currentGroup) {
      if (groupOpen) out += `</optgroup>`;
      currentGroup = f.group;
      if (f.group !== undefined) {
        out += `<optgroup label="${escapeHtml(f.group)}">`;
        groupOpen = true;
      } else {
        groupOpen = false;
      }
    }
    out += `<option value="${escapeHtml(f.name)}">${escapeHtml(f.name)}</option>`;
  }
  if (groupOpen) out += `</optgroup>`;
  return out;
}
function buildSquareFamilyOptionsMarkup(): string {
  const names = listSquareFamilyNames();
  const items = names
    .map((n) => getFamily(n))
    .filter((f): f is TagFamilyDef => f !== undefined);
  let out = "";
  let currentGroup: string | undefined;
  let groupOpen = false;
  for (const f of items) {
    if (f.group !== currentGroup) {
      if (groupOpen) out += `</optgroup>`;
      currentGroup = f.group;
      if (f.group !== undefined) {
        out += `<optgroup label="${escapeHtml(f.group)}">`;
        groupOpen = true;
      } else {
        groupOpen = false;
      }
    }
    out += `<option value="${escapeHtml(f.name)}">${escapeHtml(f.name)}</option>`;
  }
  if (groupOpen) out += `</optgroup>`;
  return out;
}

const MAX_SUBTAG_DEPTH = 2;

import { type FamilyBitmaps, loadFamily } from "./families/load";
import { formatIdSpec, parseTagIdSpec } from "./ids";
import { planSmallTagLayout, type CutShape } from "./layout/plan";
import type { LayoutOptions, LayoutPlan, Paper, SubtagLevel, TagSpec } from "./layout/types";
import { renderPlanToSvg } from "./preview/svg";
import { createDomRasterizer } from "./render/svg-canvas";
import { subtagSizeLine } from "./tag-caption";

// pdf-lib (~180 KB gzipped) is the bulk of the app's JS and is only needed
// when the user actually downloads. Pull it — and the renderer that depends
// on it — in a dynamic import so the initial page load stays tiny.

// Convention: "Tag size" refers to the AprilTag *canonical* edge — the black
// square that detection libraries expect — not the printed footprint. The
// printed footprint (= canonical + 2× quiet zone + 2× cut margin) is shown
// as a derived line below the form.

const PAPERS: Record<string, Paper> = {
  A4: { width_mm: 210, height_mm: 297 },
  Letter: { width_mm: 215.9, height_mm: 279.4 },
  Square100: { width_mm: 100, height_mm: 100 },
};

const DEFAULT_CUT_MARGIN_MM = 0;

interface FormState {
  family: string;
  idSpec: string;
  tagSize_mm: number;
  paperKey: string;
  paperWidth_mm: number;
  paperHeight_mm: number;
  pageMargin_mm: number;
  overrideAdvanced: boolean;
  quietZone_mm: number;
  cutMargin_mm: number;
}

/** Bounds for custom paper dimensions. 50 mm is roughly a postage stamp;
 *  1200 mm covers oversize plotter paper. Values outside this range are
 *  almost certainly typos rather than legitimate input. */
const CUSTOM_PAPER_MIN_MM = 50;
const CUSTOM_PAPER_MAX_MM = 1200;

const loadedFamilies = new Map<string, FamilyBitmaps>();

const bitsProvider: BitsProvider = {
  bits(family, id) {
    return loadedFamilies.get(family)?.bits(id) ?? null;
  },
};

// SVG preview rasterises bit grids to small PNG <image> elements (one per
// tag) for fast DOM updates on packed pages. The DOM-backed rasteriser is
// stateful — reuses a single offscreen canvas and caches data URIs per
// tag — so we construct it once at startup and pass it to every preview
// render.
const previewRasterizer = createDomRasterizer();

// Cached most recent valid plan, used by the Download button.
let currentPlan: LayoutPlan | null = null;
let currentFamily: string | null = null;

function field(id: string): HTMLInputElement | HTMLSelectElement {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLSelectElement)) {
    throw new Error(`form field #${id} not found`);
  }
  return el;
}

/** The printed tile is wider than the AprilTag-spec tag size whenever the
 *  family carries modules outside its black border (Standard / Custom
 *  families have outer data; tag36h11 has a white outer ring). Tag size
 *  spans `widthAtBorder_modules` modules across; the full tile spans
 *  `tileSize_px` modules. */
function tileSize_mmFromTagSize(tagSize_mm: number, family: TagFamilyDef): number {
  return tagSize_mm * (family.tileSize_px / family.widthAtBorder_modules);
}

/** Largest tag size (canonical edge) that still fits on `paper` after the
 *  current page margins, with the appropriate quiet-zone policy applied.
 *  Used as the upper bound of the size sliders so they can't be dragged to
 *  values the layout engine would reject. The number input is unbounded;
 *  this only constrains the slider's drag range. Closed-form per shape +
 *  override mode — no binary search needed. Returns 0 when the paper is
 *  too small to hold any tag at all. */
function maxFittingTagSize_mm(
  paper: Paper,
  pageMargin_mm: number,
  familyDef: TagFamilyDef,
  overrideAdvanced: boolean,
  quietZone_mm: number,
): number {
  const printable = Math.min(
    paper.width_mm - 2 * pageMargin_mm,
    paper.height_mm - 2 * pageMargin_mm,
  );
  if (printable <= 0) return 0;
  const wab = familyDef.widthAtBorder_modules;
  if (familyDef.shape === "circle") {
    const R = familyDef.outerRadius_modules!;
    if (R <= 0) return 0;
    if (overrideAdvanced) {
      return Math.max(0, ((printable / 2) - quietZone_mm) * wab / R);
    }
    return printable * wab / (2 * (R + 0.5));
  }
  const tile = familyDef.tileSize_px;
  if (overrideAdvanced) {
    return Math.max(0, (printable - 2 * quietZone_mm) * wab / tile);
  }
  return printable * wab / (tile + 1);
}

/** Default quiet zone added outside the printed tile: half a module. The
 *  tile already includes whatever white border the family ships with (e.g.
 *  tag36h11's outer ring), so this is just a small cutting buffer.
 *  module_mm = tag size / widthAtBorder_modules. */
function deriveQuietZone_mm(tagSize_mm: number, family: TagFamilyDef): number {
  const wab = family.widthAtBorder_modules;
  if (!Number.isFinite(tagSize_mm) || tagSize_mm <= 0 || wab <= 0) return 0;
  return 0.5 * (tagSize_mm / wab);
}

function readForm(): FormState {
  return {
    family: field("family").value,
    idSpec: field("ids").value,
    tagSize_mm: Number.parseFloat(field("tagSize").value),
    paperKey: field("paper").value,
    paperWidth_mm: Number.parseFloat(field("paperWidth").value),
    paperHeight_mm: Number.parseFloat(field("paperHeight").value),
    pageMargin_mm: Number.parseFloat(field("pageMargin").value),
    overrideAdvanced: (field("overrideAdvanced") as HTMLInputElement).checked,
    quietZone_mm: Number.parseFloat(field("quietZone").value),
    cutMargin_mm: Number.parseFloat(field("cutMargin").value),
  };
}

/** "Total size" = the tag plus its quiet zone on every side. For square
 *  families this is `tileSize + 2·quietZone`; for circle families it is the
 *  cut circle's diameter `2·(outerRadius + quietZone)`. The printed tile is
 *  the full mosaic tile, which is wider than the spec tag size by
 *  `tileSize_px / widthAtBorder_modules`. Returns null when inputs aren't
 *  usable. */
function totalSizeFromTag(s: FormState, familyDef: TagFamilyDef | undefined): number | null {
  if (!familyDef || !Number.isFinite(s.tagSize_mm) || s.tagSize_mm <= 0) return null;
  const qz = s.overrideAdvanced
    ? Number.isFinite(s.quietZone_mm) && s.quietZone_mm >= 0
      ? s.quietZone_mm
      : 0
    : deriveQuietZone_mm(s.tagSize_mm, familyDef);
  if (familyDef.shape === "circle") {
    const outerRadius_mm = familyDef.outerRadius_modules! * s.tagSize_mm / familyDef.widthAtBorder_modules;
    return 2 * (outerRadius_mm + qz);
  }
  const tile_mm = tileSize_mmFromTagSize(s.tagSize_mm, familyDef);
  return tile_mm + 2 * qz;
}

/** Sync derived/dependent fields to the form state:
 *   - quiet zone & cut margin: editable only with the override on; otherwise
 *     refilled with their auto values;
 *   - total size: editable only with the override off (typing into it rescales
 *     the tag size — see `handleTotalSizeInput`); otherwise a read-only mirror
 *     of tag size + quiet zone. Never overwritten while it has focus. */
function syncDependentFields(s: FormState, familyDef: TagFamilyDef | undefined): void {
  const qz = field("quietZone") as HTMLInputElement;
  const cm = field("cutMargin") as HTMLInputElement;
  const total = field("totalSize") as HTMLInputElement;

  qz.disabled = !s.overrideAdvanced;
  cm.disabled = !s.overrideAdvanced;
  total.disabled = s.overrideAdvanced;
  // The total-size slider mirrors the total-size number input — keep them in
  // lockstep so toggling the override greys both out together.
  const totalSlider = document.getElementById("totalSizeSlider") as HTMLInputElement | null;
  if (totalSlider) totalSlider.disabled = s.overrideAdvanced;

  const customRow = document.getElementById("customPaperRow");
  if (customRow) {
    customRow.style.display = s.paperKey === "custom" ? "" : "none";
  }

  if (!s.overrideAdvanced) {
    const auto = familyDef ? deriveQuietZone_mm(s.tagSize_mm, familyDef) : 0;
    qz.value = Number.isFinite(auto) ? auto.toFixed(2) : "";
    cm.value = DEFAULT_CUT_MARGIN_MM.toString();
  }

  if (document.activeElement !== total) {
    const t = totalSizeFromTag(s, familyDef);
    total.value = t === null ? "" : t.toFixed(2);
  }
}

/** When the user edits Total size directly (only possible with the override
 *  off), push the implied tag size back into the Tag size field. For square
 *  families this inverts the tile+2·qz formula; for circle families it
 *  inverts 2·(outerRadius+qz). */
function handleTotalSizeInput(): void {
  const total = field("totalSize") as HTMLInputElement;
  if (total.disabled) return;
  const familyDef = getFamily(field("family").value);
  const totalVal = Number.parseFloat(total.value);
  if (!familyDef || !Number.isFinite(totalVal) || totalVal <= 0) return;
  const wab = familyDef.widthAtBorder_modules;
  if (wab <= 0) return;
  if (familyDef.shape === "circle") {
    const R = familyDef.outerRadius_modules!;
    const override = (field("overrideAdvanced") as HTMLInputElement).checked;
    let tagSize: number;
    if (override) {
      const qz = Number.parseFloat((field("quietZone") as HTMLInputElement).value) || 0;
      // Total = 2·(R·tagSize/wab + qz) ⇒ tagSize = (Total/2 − qz) · wab / R
      tagSize = Math.max(0, (totalVal / 2 - qz)) * wab / R;
    } else {
      // Total = 2·(R + 0.5) · tagSize / wab ⇒ tagSize = Total · wab / (2·(R+0.5))
      tagSize = (totalVal * wab) / (2 * (R + 0.5));
    }
    (field("tagSize") as HTMLInputElement).value = tagSize.toFixed(2);
    return;
  }
  const tile = familyDef.tileSize_px;
  if (tile <= 0) return;
  // Square: Total = tagSize·(tile/wab) + 2·(0.5·tagSize/wab) = tagSize·((tile+1)/wab)
  (field("tagSize") as HTMLInputElement).value = (
    (totalVal * wab) / (tile + 1)
  ).toFixed(2);
}

/** Form fields that can carry an inline validation error. Each has a sibling
 *  `<span class="field-error" id="${id}-err">` in the markup. */
const ERROR_FIELD_IDS = [
  "family",
  "ids",
  "tagSize",
  "totalSize",
  "paperWidth",
  "paperHeight",
  "pageMargin",
  "quietZone",
  "cutMargin",
] as const;

/** Outline a field red and show `message` beside it; pass `null` to clear. */
function setFieldError(id: string, message: string | null): void {
  const el = document.getElementById(id);
  const errEl = document.getElementById(`${id}-err`);
  if (!el || !errEl) return;
  el.classList.toggle("invalid", message !== null);
  errEl.textContent = message ?? "";
}

function clearFieldErrors(): void {
  for (const id of ERROR_FIELD_IDS) setFieldError(id, null);
  for (let d = 0; d < MAX_SUBTAG_DEPTH; d++) setFieldError(`subIds-${d}`, null);
}

/** Status line under the Download button: a short note, optionally flagged as
 *  a problem (red). */
function showInfo(text: string, isProblem = false): void {
  const info = document.getElementById("info");
  if (info) {
    info.innerHTML = `<p${isProblem ? ' class="problem"' : ""}>${escapeHtml(text)}</p>`;
  }
}

/** Clear the preview and the cached plan after a validation failure. The
 *  caller has already flagged the offending field(s); `note` is the status
 *  line shown under the Download button. */
function failPreview(note: string, isProblem = true): void {
  const preview = document.getElementById("preview");
  if (preview) preview.innerHTML = "";
  showInfo(note, isProblem);
  currentPlan = null;
  currentFamily = null;
  syncDownloadButton();
}

function syncDownloadButton(): void {
  const btn = document.getElementById("downloadBtn") as HTMLButtonElement | null;
  if (!btn) return;
  let allSubsLoaded = true;
  if (currentPlan) {
    for (const lvl of currentPlan.subtagLevels) {
      if (!loadedFamilies.has(lvl.familyName)) { allSubsLoaded = false; break; }
    }
  }
  const ready =
    currentPlan !== null &&
    currentFamily !== null &&
    loadedFamilies.has(currentFamily) &&
    allSubsLoaded;
  btn.disabled = !ready;
  btn.title = ready
    ? ""
    : currentPlan === null
      ? "Adjust the form so a plan is valid."
      : "Waiting for tag bitmaps to finish loading.";
}

async function handleDownload(): Promise<void> {
  if (!currentPlan || !currentFamily || !loadedFamilies.has(currentFamily)) return;
  const btn = document.getElementById("downloadBtn") as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  try {
    const formatMode = (field("downloadFormat") as HTMLSelectElement).value;
    const [format, mode] = formatMode.split(",") as [
      "pdf" | "svg" | "png",
      "packed" | "per-tag",
    ];
    const printLabelsOnBack =
      (field("printLabelsOnBack") as HTMLInputElement).checked;
    const printLabelsInQuietZone =
      (field("printLabelsInQuietZone") as HTMLInputElement).checked;
    const pngDpi = Math.max(
      72,
      Math.min(1200, parseInt((field("pngDpi") as HTMLInputElement).value, 10) || 300),
    );
    // Lazy-import so the pdf-lib + fflate bundle (~200 KB combined) is not
    // pulled into the initial page load.
    const { runExport } = await import("./export");
    const result = await runExport({
      plan: currentPlan,
      markers: bitsProvider,
      format,
      mode,
      options: { printLabelsOnBack, printLabelsInQuietZone, pngDpi },
    });
    const url = URL.createObjectURL(result.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = result.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    showInfo(`Download failed: ${e instanceof Error ? e.message : String(e)}`, true);
  } finally {
    syncDownloadButton();
  }
}

/** rAF-batched recompute: at most one run per animation frame, regardless of
 *  how many input events arrive between frames. The slider in particular
 *  fires many input events per second during a drag; batching keeps the
 *  preview smooth without queueing redundant renders. */
let recomputeFramePending = false;
function scheduleRecompute(): void {
  if (recomputeFramePending) return;
  recomputeFramePending = true;
  requestAnimationFrame(() => {
    recomputeFramePending = false;
    recompute();
  });
}

/** Wire a range slider to a number input so the two mirror each other.
 *
 *  Slider → number: write the slider value into the number box, run any
 *  pre-recompute side effect, then schedule a recompute on the next frame.
 *  Number → slider: only mirror when the typed value falls in the slider's
 *  declared range. Outside that range we leave the slider where it is — the
 *  number box stays authoritative for precise / out-of-range entry, and we
 *  never silently clamp it. */
function bindSliderToNumber(
  numberId: string,
  sliderId: string,
  onSliderInput?: () => void,
): void {
  const num = document.getElementById(numberId) as HTMLInputElement | null;
  const slider = document.getElementById(sliderId) as HTMLInputElement | null;
  if (!num || !slider) return;
  const sliderMin = Number.parseFloat(slider.min);
  const sliderMax = Number.parseFloat(slider.max);
  const initial = Number.parseFloat(num.value);
  if (Number.isFinite(initial) && initial >= sliderMin && initial <= sliderMax) {
    slider.value = String(initial);
  }
  slider.addEventListener("input", () => {
    num.value = slider.value;
    onSliderInput?.();
    scheduleRecompute();
  });
  num.addEventListener("input", () => {
    const v = Number.parseFloat(num.value);
    if (Number.isFinite(v) && v >= sliderMin && v <= sliderMax) {
      slider.value = String(v);
    }
  });
}

/** Slider lower bound — small enough to cover postage-stamp tags but not
 *  pointless. Number input is unbounded. */
const SIZE_SLIDER_MIN_MM = 10;

/** Update the `max` attribute on the tag-size and total-size sliders to
 *  reflect the largest tag that fits the current paper. The sliders shouldn't
 *  let the user drag to a value that immediately fails layout. The number
 *  input remains authoritative (it can hold values outside this range);
 *  setting `slider.max` below `slider.value` clamps the slider without
 *  firing input, so the number box is not silently rewritten. */
function updateSliderMaxes(paper: Paper, options: LayoutOptions, familyDef: TagFamilyDef | undefined, overrideAdvanced: boolean): void {
  const tagSlider = document.getElementById("tagSizeSlider") as HTMLInputElement | null;
  const totalSlider = document.getElementById("totalSizeSlider") as HTMLInputElement | null;
  if (!tagSlider && !totalSlider) return;

  const printable = Math.min(
    paper.width_mm - 2 * options.pageMargin_mm,
    paper.height_mm - 2 * options.pageMargin_mm,
  );
  // Round down to slider step so the printed `max` is a clean value.
  const round = (v: number): number => Math.max(SIZE_SLIDER_MIN_MM, Math.floor(v * 2) / 2);

  if (tagSlider && familyDef) {
    const maxTag = maxFittingTagSize_mm(paper, options.pageMargin_mm, familyDef, overrideAdvanced, options.quietZone_mm);
    tagSlider.max = String(round(maxTag));
  }
  if (totalSlider && printable > 0) {
    totalSlider.max = String(round(printable));
  }
}

/** Mirror the tag-size and total-size sliders back to their number boxes
 *  whenever recompute() changes those values (e.g. typing in Total size
 *  rewrites Tag size, which should drag the tag-size slider with it). */
function syncSlidersFromInputs(): void {
  for (const [numberId, sliderId] of [
    ["tagSize", "tagSizeSlider"],
    ["totalSize", "totalSizeSlider"],
  ] as const) {
    const num = document.getElementById(numberId) as HTMLInputElement | null;
    const slider = document.getElementById(sliderId) as HTMLInputElement | null;
    if (!num || !slider) continue;
    const v = Number.parseFloat(num.value);
    const sMin = Number.parseFloat(slider.min);
    const sMax = Number.parseFloat(slider.max);
    if (Number.isFinite(v) && v >= sMin && v <= sMax && String(v) !== slider.value) {
      slider.value = String(v);
    }
  }
}

function recompute(): void {
  const preview = document.getElementById("preview");
  if (!preview) return;
  clearFieldErrors();

  const s = readForm();
  const familyDef = getFamily(s.family);
  syncDependentFields(s, familyDef);
  // Update slider maxima now (using whatever paper / margins the user has set
  // so far) so the sliders track the current paper even while the form has
  // validation errors elsewhere. Skip when the custom paper has invalid
  // dimensions — the previous max stays in place.
  const previewPaper: Paper | null =
    s.paperKey === "custom"
      ? (Number.isFinite(s.paperWidth_mm) && Number.isFinite(s.paperHeight_mm) &&
         s.paperWidth_mm > 0 && s.paperHeight_mm > 0
          ? { width_mm: s.paperWidth_mm, height_mm: s.paperHeight_mm }
          : null)
      : (PAPERS[s.paperKey] ?? null);
  if (previewPaper && familyDef) {
    const previewOptions: LayoutOptions = {
      pageMargin_mm: Number.isFinite(s.pageMargin_mm) && s.pageMargin_mm >= 0 ? s.pageMargin_mm : 0,
      quietZone_mm: Number.isFinite(s.quietZone_mm) && s.quietZone_mm >= 0 ? s.quietZone_mm : 0,
      cutMargin_mm: Number.isFinite(s.cutMargin_mm) && s.cutMargin_mm >= 0 ? s.cutMargin_mm : 0,
    };
    updateSliderMaxes(previewPaper, previewOptions, familyDef, s.overrideAdvanced);
  }
  syncSlidersFromInputs();

  // Re-read after syncDependentFields, which may have refreshed the values.
  const effective = readForm();

  // Lazy-load the family the first time it's selected.
  if (s.family && familyDef && !loadedFamilies.has(s.family)) {
    void loadFamily(s.family).then(
      (bm) => {
        loadedFamilies.set(s.family, bm);
        syncDownloadButton();
        recompute();
      },
      (err: unknown) => {
        console.error("failed to load family", s.family, err);
      },
    );
  }

  syncSubtagChain();

  if (!familyDef) {
    setFieldError("family", "Pick a tag family.");
    failPreview("Pick a tag family to see a preview.");
    return;
  }

  let tagIds: number[];
  try {
    tagIds = parseTagIdSpec(effective.idSpec);
  } catch (e) {
    setFieldError("ids", e instanceof Error ? e.message : String(e));
    failPreview("Fix the tag IDs to see a preview.");
    return;
  }

  let bad = false;
  if (!Number.isFinite(effective.tagSize_mm) || effective.tagSize_mm <= 0) {
    setFieldError("tagSize", "Enter a size in mm greater than 0.");
    bad = true;
  }
  if (!effective.overrideAdvanced) {
    const totalVal = Number.parseFloat((field("totalSize") as HTMLInputElement).value);
    if (!Number.isFinite(totalVal) || totalVal <= 0) {
      setFieldError("totalSize", "Enter a size in mm greater than 0.");
      bad = true;
    }
  }
  if (!Number.isFinite(effective.pageMargin_mm) || effective.pageMargin_mm < 0) {
    setFieldError("pageMargin", "Enter 0 or more.");
    bad = true;
  }
  if (effective.overrideAdvanced) {
    if (!Number.isFinite(effective.quietZone_mm) || effective.quietZone_mm < 0) {
      setFieldError("quietZone", "Enter 0 or more.");
      bad = true;
    }
    if (!Number.isFinite(effective.cutMargin_mm) || effective.cutMargin_mm < 0) {
      setFieldError("cutMargin", "Enter 0 or more.");
      bad = true;
    }
  }
  if (effective.paperKey === "custom") {
    const range = `${CUSTOM_PAPER_MIN_MM}–${CUSTOM_PAPER_MAX_MM} mm.`;
    if (
      !Number.isFinite(effective.paperWidth_mm) ||
      effective.paperWidth_mm < CUSTOM_PAPER_MIN_MM ||
      effective.paperWidth_mm > CUSTOM_PAPER_MAX_MM
    ) {
      setFieldError("paperWidth", `Enter ${range}`);
      bad = true;
    }
    if (
      !Number.isFinite(effective.paperHeight_mm) ||
      effective.paperHeight_mm < CUSTOM_PAPER_MIN_MM ||
      effective.paperHeight_mm > CUSTOM_PAPER_MAX_MM
    ) {
      setFieldError("paperHeight", `Enter ${range}`);
      bad = true;
    }
  }
  const maxId = tagIds.reduce((m, x) => Math.max(m, x), 0);
  if (maxId >= familyDef.validTagCount) {
    setFieldError(
      "ids",
      `This family has ${familyDef.validTagCount} tags (IDs 0–${familyDef.validTagCount - 1}); ` +
        `ID ${maxId} doesn't exist.`,
    );
    bad = true;
  }
  if (bad) {
    failPreview("Fix the highlighted fields to see a preview.");
    return;
  }

  const tileSize_mm_pre = tileSize_mmFromTagSize(effective.tagSize_mm, familyDef);
  const subtagResult = readSubtagChain(tagIds, tileSize_mm_pre, effective.family);
  if (!subtagResult) {
    failPreview("Fix the highlighted sub-tag fields to see a preview.");
    return;
  }

  const tags: TagSpec[] = tagIds.map((id, i) => ({
    family: effective.family,
    id,
    subtag: subtagResult.subtagForIndex(i),
  }));
  const paper: Paper =
    effective.paperKey === "custom"
      ? { width_mm: effective.paperWidth_mm, height_mm: effective.paperHeight_mm }
      : (PAPERS[effective.paperKey] ?? PAPERS.A4!);
  const options: LayoutOptions = {
    pageMargin_mm: effective.pageMargin_mm,
    quietZone_mm: effective.quietZone_mm,
    cutMargin_mm: effective.cutMargin_mm,
  };

  const tileSize_mm = tileSize_mmFromTagSize(effective.tagSize_mm, familyDef);
  const cutShape: CutShape =
    familyDef.shape === "circle"
      ? {
          kind: "circle",
          outerRadius_mm:
            (familyDef.outerRadius_modules! * tileSize_mm) / familyDef.tileSize_px,
        }
      : { kind: "square" };
  // All families now support quiet-zone labels (square: linear, circle: curved).

  let plan: LayoutPlan;
  try {
    plan = planSmallTagLayout(tags, tileSize_mm, paper, options, effective.tagSize_mm, cutShape);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/does not fit on paper|no tags fit/i.test(message)) {
      const tooBig = "Too big for this paper — shrink the tag size or reduce the page margin.";
      setFieldError("tagSize", tooBig);
      setFieldError("pageMargin", tooBig);
      if (effective.overrideAdvanced) {
        setFieldError("quietZone", tooBig);
        setFieldError("cutMargin", tooBig);
      } else {
        setFieldError("totalSize", tooBig);
      }
      failPreview("These tags don't fit on the chosen paper.");
    } else {
      failPreview(`Couldn't lay out the tags: ${message}`);
    }
    return;
  }

  plan.subtagLevels = subtagResult.levels;

  const loaded = loadedFamilies.has(effective.family) && subtagResult.allFamiliesLoaded;
  const cellWidth_mm =
    cutShape.kind === "circle"
      ? 2 * (cutShape.outerRadius_mm + effective.quietZone_mm)
      : tileSize_mm + 2 * effective.quietZone_mm;
  const summary =
    `${plan.placements.length} tag${plan.placements.length === 1 ? "" : "s"} ` +
    `across ${plan.pageCount} page${plan.pageCount === 1 ? "" : "s"} on ` +
    `${paper.width_mm} × ${paper.height_mm} mm paper.${loaded ? "" : " (Loading bitmaps…)"}`;
  const detail =
    `Tag size ${effective.tagSize_mm.toFixed(2)} mm ` +
    `(printed tile ${tileSize_mm.toFixed(2)} mm); ` +
    `quiet zone ${effective.quietZone_mm.toFixed(2)} mm; ` +
    `cut margin ${effective.cutMargin_mm.toFixed(2)} mm; ` +
    `printed cell ${cellWidth_mm.toFixed(2)} mm.`;
  const subLine = subtagSizeLine(subtagResult.levels);
  const info = document.getElementById("info");
  if (info) {
    info.innerHTML =
      `<p class="summary">${escapeHtml(summary)}</p>` +
      `<p>${escapeHtml(detail)}</p>` +
      (subLine ? `<p>${escapeHtml(subLine)}</p>` : "");
  }
  const previewOpts = {
    printLabelsInQuietZone:
      (field("printLabelsInQuietZone") as HTMLInputElement).checked,
  };
  preview.innerHTML =
    Array.from({ length: plan.pageCount }, (_, p) => {
      return `<section><h3>Page ${p + 1} / ${plan.pageCount}</h3>${renderPlanToSvg(
        plan,
        p,
        bitsProvider,
        { ...previewOpts, rasterizer: previewRasterizer },
      )}</section>`;
    }).join("") || `<p style="color:#888">No pages — add some tags.</p>`;
  currentPlan = plan;
  currentFamily = effective.family;
  syncDownloadButton();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Ensure the sub-tag chain UI matches the current family selection chain.
 *  Called from `recompute()`. Builds or tears down sub-tag pickers as needed. */
function syncSubtagChain(): void {
  const container = document.getElementById("subtag-chain");
  if (!container) return;

  const ancestorFamilies = new Set<string>();
  ancestorFamilies.add(field("family").value);

  let depth = 0;
  let parentFamilyName = field("family").value;
  let parentDef = getFamily(parentFamilyName);

  while (depth < MAX_SUBTAG_DEPTH) {
    if (!parentDef || !isRecursiveFamily(parentDef)) {
      removeSubtagLevelsFrom(container, depth);
      return;
    }
    let levelEl = container.querySelector(`[data-depth="${depth}"]`) as HTMLElement | null;
    if (!levelEl) {
      levelEl = createSubtagLevel(depth);
      container.appendChild(levelEl);
    }
    const subFamilySelect = document.getElementById(`subFamily-${depth}`) as HTMLSelectElement | null;
    if (!subFamilySelect) return;
    const subFamilyName = subFamilySelect.value;
    const subDef = getFamily(subFamilyName);

    const inheritBox = document.getElementById(`subInherit-${depth}`) as HTMLInputElement | null;
    const subIdsInput = document.getElementById(`subIds-${depth}`) as HTMLInputElement | null;
    if (inheritBox && subIdsInput) {
      subIdsInput.disabled = inheritBox.checked;
      if (inheritBox.checked) {
        const rootSpec = field("ids").value;
        let rootIds: number[];
        try {
          rootIds = parseTagIdSpec(rootSpec);
        } catch {
          rootIds = [];
        }
        if (ancestorFamilies.has(subFamilyName)) {
          const assigned = assignDissimilarIds(rootIds, subDef?.validTagCount ?? 0);
          subIdsInput.value = formatIdSpec(assigned);
        } else {
          subIdsInput.value = rootSpec;
        }
        subIdsInput.style.color = "#999";
      } else {
        subIdsInput.style.color = "";
      }
    }

    ancestorFamilies.add(subFamilyName);
    parentFamilyName = subFamilyName;
    parentDef = subDef;
    depth++;
  }
  removeSubtagLevelsFrom(container, depth);
}

function createSubtagLevel(depth: number): HTMLElement {
  const div = document.createElement("div");
  div.dataset.depth = String(depth);
  div.style.marginLeft = "1.5rem";
  div.style.marginTop = "0.5rem";
  div.style.borderLeft = "2px solid #ccc";
  div.style.paddingLeft = "0.75rem";
  const sqOpts = buildSquareFamilyOptionsMarkup();
  div.innerHTML = `
    <label style="font-weight:600;font-size:0.9em">Sub-tag (level ${depth + 1})</label>
    <label>Family
      <select id="subFamily-${depth}">${sqOpts}</select>
    </label>
    <label style="font-size:0.85em">
      <input type="checkbox" id="subInherit-${depth}" checked> Inherit tag IDs from outer tag
    </label>
    <label>Tag IDs
      <input id="subIds-${depth}" type="text" value="0-19" disabled style="color:#999">
      <span class="field-error" id="subIds-${depth}-err"></span>
    </label>
  `;
  return div;
}

function removeSubtagLevelsFrom(container: HTMLElement, fromDepth: number): void {
  const toRemove: HTMLElement[] = [];
  container.querySelectorAll("[data-depth]").forEach((el) => {
    if (Number((el as HTMLElement).dataset.depth) >= fromDepth) {
      toRemove.push(el as HTMLElement);
    }
  });
  for (const el of toRemove) el.remove();
}

interface SubtagChainResult {
  subtagForIndex: (i: number) => TagSpec | undefined;
  levels: SubtagLevel[];
  allFamiliesLoaded: boolean;
}

/** Assign one unique sub-tag ID per parent tag, picking the smallest IDs
 *  not present in `parentIds`. Returns fewer than `parentIds.length` entries
 *  when the family doesn't have enough unused IDs. */
function assignDissimilarIds(parentIds: number[], validTagCount: number): number[] {
  const parentSet = new Set(parentIds);
  const result: number[] = [];
  for (let id = 0; id < validTagCount && result.length < parentIds.length; id++) {
    if (!parentSet.has(id)) result.push(id);
  }
  return result;
}

/** Read the sub-tag chain from the form, validate, and return a function that
 *  builds the subtag for each parent index. Returns undefined on validation failure. */
function readSubtagChain(parentIds: number[], parentTile_mm: number, parentFamilyName: string): SubtagChainResult | null {
  let depth = 0;
  let curFamilyName = parentFamilyName;
  let curDef = getFamily(curFamilyName);
  let curIds = parentIds;
  let curTile_mm = parentTile_mm;

  const levels: SubtagLevel[] = [];
  const idChains: number[][] = [];
  const ancestorFamilies = new Set<string>([parentFamilyName]);
  let allLoaded = true;

  while (depth < MAX_SUBTAG_DEPTH && curDef && isRecursiveFamily(curDef)) {
    const subSelect = document.getElementById(`subFamily-${depth}`) as HTMLSelectElement | null;
    if (!subSelect) break;
    const subFamilyName = subSelect.value;
    const subDef = getFamily(subFamilyName);
    if (!subDef) break;

    const inheritBox = document.getElementById(`subInherit-${depth}`) as HTMLInputElement | null;
    const subIdsInput = document.getElementById(`subIds-${depth}`) as HTMLInputElement | null;
    const inheriting = inheritBox?.checked ?? true;

    let subIds: number[];
    if (inheriting) {
      if (ancestorFamilies.has(subFamilyName)) {
        subIds = assignDissimilarIds(curIds, subDef.validTagCount);
        if (subIds.length < curIds.length) {
          setFieldError(`subIds-${depth}`,
            `${subFamilyName} only has ${subDef.validTagCount} tags, but ${curIds.length - subIds.length} ` +
            `of the parent's ${curIds.length} IDs cannot be assigned a unique sub-tag ID.`);
          return null;
        }
      } else {
        subIds = parentIds;
      }
    } else {
      try {
        subIds = parseTagIdSpec(subIdsInput?.value ?? "");
      } catch (e) {
        setFieldError(`subIds-${depth}`, e instanceof Error ? e.message : String(e));
        return null;
      }
      if (subIds.length !== curIds.length) {
        setFieldError(`subIds-${depth}`,
          `Must have exactly ${curIds.length} IDs to match the ${depth === 0 ? "outer" : "level " + depth} tag count.`);
        return null;
      }
      if (ancestorFamilies.has(subFamilyName)) {
        const parentSet = new Set(curIds);
        const overlap = subIds.find((id) => parentSet.has(id));
        if (overlap !== undefined) {
          setFieldError(`subIds-${depth}`,
            `Sub-tag IDs must differ from parent IDs when the same family is nested. ` +
            `ID ${overlap} appears in both levels.`);
          return null;
        }
      }
    }
    ancestorFamilies.add(subFamilyName);

    const maxSubId = subIds.reduce((m, x) => Math.max(m, x), 0);
    if (maxSubId >= subDef.validTagCount) {
      setFieldError(`subIds-${depth}`,
        `${subFamilyName} has ${subDef.validTagCount} tags (IDs 0–${subDef.validTagCount - 1}); ID ${maxSubId} doesn't exist.`);
      return null;
    }

    const cb = curDef.centerBlock!;
    const module_mm = curTile_mm / curDef.tileSize_px;
    const subTile_mm = cb.size * module_mm;
    const subTagSize_mm = subTile_mm * (subDef.widthAtBorder_modules / subDef.tileSize_px);

    levels.push({ familyName: subFamilyName, tileSize_mm: subTile_mm, tagSize_mm: subTagSize_mm });
    idChains.push(subIds);

    if (!loadedFamilies.has(subFamilyName)) {
      allLoaded = false;
      void loadFamily(subFamilyName).then(
        (bm) => { loadedFamilies.set(subFamilyName, bm); syncDownloadButton(); recompute(); },
        (err: unknown) => { console.error("failed to load sub-family", subFamilyName, err); },
      );
    }

    curFamilyName = subFamilyName;
    curDef = subDef;
    curIds = subIds;
    curTile_mm = subTile_mm;
    depth++;
  }

  if (levels.length === 0) {
    return { subtagForIndex: () => undefined, levels: [], allFamiliesLoaded: true };
  }

  return {
    subtagForIndex(i: number): TagSpec | undefined {
      let spec: TagSpec | undefined;
      for (let d = levels.length - 1; d >= 0; d--) {
        spec = { family: levels[d]!.familyName, id: idChains[d]![i]!, subtag: spec };
      }
      return spec;
    },
    levels,
    allFamiliesLoaded: allLoaded,
  };
}

function bootstrap(): void {
  const app = document.getElementById("app");
  if (!app) return;
  const familyOptions = buildFamilyOptionsMarkup();
  app.innerHTML = `
    <div class="form-pane">
        <form id="form">
          <fieldset>
            <legend>Tags</legend>
            <label>Family
              <select id="family">${familyOptions}</select><span class="field-error" id="family-err"></span>
            </label>
            <label>Tag IDs <input id="ids" type="text" value="0-19"><span class="field-error" id="ids-err"></span></label>
            <span class="note">single IDs and ranges, e.g. 0-9, 12, 15-20</span>
            <div id="subtag-chain"></div>
          </fieldset>
          <fieldset>
            <legend>Paper</legend>
            <label>Paper
              <select id="paper">
                <option value="A4" selected>A4 (210 × 297 mm)</option>
                <option value="Letter">US Letter (215.9 × 279.4 mm)</option>
                <option value="Square100">100 × 100 mm</option>
                <option value="custom">Custom…</option>
              </select>
            </label>
            <div id="customPaperRow" style="display:none;margin-top:0.35rem">
              <label>Width (mm)
                <input id="paperWidth" type="number" value="210" step="1" min="${CUSTOM_PAPER_MIN_MM}" max="${CUSTOM_PAPER_MAX_MM}" style="width:5em"><span class="field-error" id="paperWidth-err"></span>
              </label>
              <label>Height (mm)
                <input id="paperHeight" type="number" value="297" step="1" min="${CUSTOM_PAPER_MIN_MM}" max="${CUSTOM_PAPER_MAX_MM}" style="width:5em"><span class="field-error" id="paperHeight-err"></span>
              </label>
              <span class="note">${CUSTOM_PAPER_MIN_MM}–${CUSTOM_PAPER_MAX_MM} mm each side</span>
            </div>
          </fieldset>
          <fieldset class="tag-dim">
            <legend>Tag Dimensions</legend>
            <label>Tag size (mm)
              <input id="tagSize" class="no-spin" type="number" value="40" step="0.5" min="1">
              <input id="tagSizeSlider" class="slider" type="range" min="10" max="200" step="0.5" value="40" aria-label="Tag size slider">
              <span class="field-error" id="tagSize-err"></span>
            </label>
            <span class="note">canonical (black-border) edge — what detectors expect</span>
            <label>Total size (mm)
              <input id="totalSize" class="no-spin" type="number" step="0.5" min="1">
              <input id="totalSizeSlider" class="slider" type="range" min="10" max="300" step="0.5" value="40" aria-label="Total size slider">
              <span class="field-error" id="totalSize-err"></span>
            </label>
            <span class="note">tag plus its quiet zone on every side; edit either, the other follows</span>
            <details style="margin-top:0.5rem">
              <summary style="cursor:pointer">Advanced</summary>
              <div style="margin-top:0.4rem">
                <label><input type="checkbox" id="overrideAdvanced"> Override defaults</label>
              </div>
              <div style="margin-top:0.3rem">
                <label>Quiet zone (mm) <input id="quietZone" type="number" step="0.1" min="0" disabled><span class="field-error" id="quietZone-err"></span></label>
                <span class="note">auto = 1 module = tagSize / bitmap edge</span>
              </div>
              <div>
                <label>Cut margin (mm) <input id="cutMargin" type="number" step="0.1" min="0" value="${DEFAULT_CUT_MARGIN_MM}" disabled><span class="field-error" id="cutMargin-err"></span></label>
                <span class="note">paper gap between cuts of adjacent tags (0 = shared cut line)</span>
              </div>
              <div>
                <label>Page margin (mm) <input id="pageMargin" type="number" value="10" step="0.5" min="0"><span class="field-error" id="pageMargin-err"></span></label>
                <span class="note">unprintable border around each page</span>
              </div>
            </details>
          </fieldset>
          <fieldset>
            <legend>Output</legend>
            <div>
              <label><input type="checkbox" id="printLabelsOnBack"> Print tag info on backside</label>
              <span class="note">for double-sided printing (long-edge / horizontal flip)</span>
            </div>
            <div id="quietLabelRow" style="margin-top:0.3rem">
              <label><input type="checkbox" id="printLabelsInQuietZone"> Print tag info in the quiet zone (front)</label>
              <span class="note">stays on the cut-out tag; small print — best at ~20 mm tags or larger</span>
            </div>
          </fieldset>
        </form>
        <div class="download-row">
          <label>Download as
            <select id="downloadFormat">
              <option value="pdf,packed">PDF</option>
              <option value="svg,packed">SVG (packed sheet)</option>
              <option value="svg,per-tag">SVG (one per tag)</option>
              <option value="png,packed">PNG (packed sheet)</option>
              <option value="png,per-tag">PNG (one per tag)</option>
            </select>
          </label>
          <button id="downloadBtn" type="button" disabled>Download</button>
          <details id="downloadAdvanced">
            <summary>Advanced</summary>
            <label>PNG resolution
              <input type="number" id="pngDpi" value="300" min="72" max="1200" step="1" style="width:5em"> DPI
            </label>
          </details>
        </div>
        <div id="info"></div>
    </div>
    <div class="preview-pane">
      <div id="preview"></div>
    </div>
  `;
  const form = document.getElementById("form");
  // Runs before the form-level `recompute` (event reaches the target first),
  // so the rescaled tag size is in place by the time `recompute` reads it.
  document.getElementById("totalSize")?.addEventListener("input", handleTotalSizeInput);
  bindSliderToNumber("tagSize", "tagSizeSlider");
  bindSliderToNumber("totalSize", "totalSizeSlider", handleTotalSizeInput);
  form?.addEventListener("input", scheduleRecompute);
  form?.addEventListener("change", scheduleRecompute);
  document.getElementById("downloadBtn")?.addEventListener("click", () => {
    void handleDownload();
  });
  recompute();
}

bootstrap();
