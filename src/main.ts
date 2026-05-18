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
  return listSquareFamilyNames()
    .map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`)
    .join("");
}

const MAX_SUBTAG_DEPTH = 5;

import { type FamilyBitmaps, loadFamily } from "./families/load";
import { parseTagIdSpec } from "./ids";
import { planSmallTagLayout, type CutShape } from "./layout/plan";
import type { LayoutOptions, LayoutPlan, Paper, SubtagLevel, TagSpec } from "./layout/types";
import { renderPlanToSvg } from "./preview/svg";
import { createTagImageProvider } from "./preview/tag-images";
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
  pageMargin_mm: number;
  overrideAdvanced: boolean;
  quietZone_mm: number;
  cutMargin_mm: number;
}

const loadedFamilies = new Map<string, FamilyBitmaps>();

const bitsProvider: BitsProvider = {
  bits(family, id) {
    return loadedFamilies.get(family)?.bits(id) ?? null;
  },
};

// The PDF renderer draws tags as vector rects straight from `bitsProvider`;
// the preview shows each tag as a PNG <image> via this rasterising view.
const tagImageProvider = createTagImageProvider(bitsProvider);

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
  const btn = document.getElementById("downloadPdf") as HTMLButtonElement | null;
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
  const btn = document.getElementById("downloadPdf") as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  try {
    const printLabelsOnBack =
      (field("printLabelsOnBack") as HTMLInputElement).checked;
    const printLabelsInQuietZone =
      (field("printLabelsInQuietZone") as HTMLInputElement).checked;
    const { renderPlan } = await import("./render/pdf");
    const bytes = await renderPlan(currentPlan, bitsProvider, {
      printLabelsOnBack,
      printLabelsInQuietZone,
    });
    // Copy into a fresh ArrayBuffer-backed Uint8Array; pdf-lib's return type
    // is `Uint8Array<ArrayBufferLike>` which Blob's typing rejects directly.
    const buf = new Uint8Array(bytes.length);
    buf.set(bytes);
    const blob = new Blob([buf], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const subNames = currentPlan.subtagLevels.map((l) => l.familyName).join("+");
    const nameParts = subNames ? `${currentFamily}+${subNames}` : currentFamily;
    a.download = `apriltags-${nameParts}-${currentPlan.placements.length}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    showInfo(`PDF render failed: ${e instanceof Error ? e.message : String(e)}`, true);
  } finally {
    syncDownloadButton();
  }
}

function recompute(): void {
  const preview = document.getElementById("preview");
  if (!preview) return;
  clearFieldErrors();

  const s = readForm();
  const familyDef = getFamily(s.family);
  syncDependentFields(s, familyDef);

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
  const paper = PAPERS[effective.paperKey] ?? PAPERS.A4!;
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
  // Hide the front quiet-zone label option for circle families — the label
  // sits outside the cut circle and would not survive trimming.
  const elQuietLabel = document.getElementById("quietLabelRow");
  if (elQuietLabel) elQuietLabel.style.display = familyDef.shape === "circle" ? "none" : "";

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
        tagImageProvider,
        previewOpts,
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

  let depth = 0;
  let parentFamilyName = field("family").value;
  let parentDef = getFamily(parentFamilyName);

  while (depth < MAX_SUBTAG_DEPTH) {
    if (!parentDef || !isRecursiveFamily(parentDef)) {
      // Remove this depth and all deeper ones.
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
        const parentIds = depth === 0
          ? field("ids").value
          : (document.getElementById(`subIds-${depth - 1}`) as HTMLInputElement | null)?.value ?? "";
        subIdsInput.value = parentIds;
      }
    }

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
      subIds = curIds;
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
    }

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
        <h1>AprilTag PDF Generator</h1>
        <form id="form">
          <fieldset>
            <legend>Tags</legend>
            <label>Family
              <select id="family">${familyOptions}</select><span class="field-error" id="family-err"></span>
            </label>
            <label>Tag IDs <input id="ids" type="text" value="0-19"><span class="field-error" id="ids-err"></span></label>
            <span style="color:#888;font-size:0.85em">single IDs and ranges, e.g. 0-9, 12, 15-20</span>
            <div id="subtag-chain"></div>
          </fieldset>
          <fieldset>
            <legend>Paper</legend>
            <label>Paper
              <select id="paper">
                <option value="A4" selected>A4 (210 × 297 mm)</option>
                <option value="Letter">US Letter (215.9 × 279.4 mm)</option>
                <option value="Square100">100 × 100 mm</option>
              </select>
            </label>
          </fieldset>
          <fieldset>
            <legend>Tag</legend>
            <label>Tag size (mm)
              <input id="tagSize" type="number" value="40" step="0.5" min="1"><span class="field-error" id="tagSize-err"></span>
            </label>
            <span style="color:#888;font-size:0.85em">canonical (black-border) edge — what detectors expect</span>
            <label>Total size (mm)
              <input id="totalSize" type="number" step="0.5" min="1"><span class="field-error" id="totalSize-err"></span>
            </label>
            <span style="color:#888;font-size:0.85em">tag plus its quiet zone on every side; edit either, the other follows</span>
            <details style="margin-top:0.5rem">
              <summary style="cursor:pointer">Advanced</summary>
              <div style="margin-top:0.4rem">
                <label><input type="checkbox" id="overrideAdvanced"> Override defaults</label>
              </div>
              <div style="margin-top:0.3rem">
                <label>Quiet zone (mm) <input id="quietZone" type="number" step="0.1" min="0" disabled><span class="field-error" id="quietZone-err"></span></label>
                <span style="color:#888;font-size:0.85em">auto = 1 module = tagSize / bitmap edge</span>
              </div>
              <div>
                <label>Cut margin (mm) <input id="cutMargin" type="number" step="0.1" min="0" value="${DEFAULT_CUT_MARGIN_MM}" disabled><span class="field-error" id="cutMargin-err"></span></label>
                <span style="color:#888;font-size:0.85em">paper gap between cuts of adjacent tags (0 = shared cut line)</span>
              </div>
              <div>
                <label>Page margin (mm) <input id="pageMargin" type="number" value="10" step="0.5" min="0"><span class="field-error" id="pageMargin-err"></span></label>
                <span style="color:#888;font-size:0.85em">unprintable border around each page</span>
              </div>
            </details>
          </fieldset>
          <fieldset>
            <legend>Output</legend>
            <div>
              <label><input type="checkbox" id="printLabelsOnBack"> Print tag info on backside</label>
              <span style="color:#888;font-size:0.85em">for double-sided printing (long-edge / horizontal flip)</span>
            </div>
            <div id="quietLabelRow" style="margin-top:0.3rem">
              <label><input type="checkbox" id="printLabelsInQuietZone"> Print tag info in the quiet zone (front)</label>
              <span style="color:#888;font-size:0.85em">stays on the cut-out tag; small print — best at ~20 mm tags or larger</span>
            </div>
          </fieldset>
        </form>
        <p><button id="downloadPdf" type="button" disabled>Download PDF</button></p>
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
  form?.addEventListener("input", recompute);
  form?.addEventListener("change", recompute);
  document.getElementById("downloadPdf")?.addEventListener("click", () => {
    void handleDownload();
  });
  recompute();
}

bootstrap();
