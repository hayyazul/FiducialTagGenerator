import {
  type BitsProvider,
  getFamily,
  listFamilyNames,
  tagBitmapEdge_px,
  type TagFamilyDef,
} from "./families";
import { type FamilyBitmaps, loadFamily } from "./families/load";
import { parseTagIdSpec } from "./ids";
import { planSmallTagLayout } from "./layout/plan";
import type { LayoutOptions, LayoutPlan, Paper, TagSpec } from "./layout/types";
import { renderPlanToSvg } from "./preview/svg";
import { createTagImageProvider } from "./preview/tag-images";

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

const DEFAULT_CUT_MARGIN_MM = 0.5;

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

/** Recommended quiet zone per AprilTag spec: 1 module wide.
 *  module_mm = canonical tag size / bitmap edge in modules. */
function deriveQuietZone_mm(tagSize_mm: number, family: TagFamilyDef): number {
  const edgeModules = tagBitmapEdge_px(family);
  if (!Number.isFinite(tagSize_mm) || tagSize_mm <= 0 || edgeModules <= 0) return 0;
  return tagSize_mm / edgeModules;
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

/** "Total size" = tag size + the quiet zone on every side. With the override
 *  off the quiet zone is the auto 1-module width, so total is a fixed multiple
 *  of the tag size; with it on, total is tag size + 2× the user's quiet zone.
 *  Returns null when the tag size isn't a usable number. */
function totalSizeFromTag(s: FormState, familyDef: TagFamilyDef | undefined): number | null {
  if (!familyDef || !Number.isFinite(s.tagSize_mm) || s.tagSize_mm <= 0) return null;
  if (s.overrideAdvanced) {
    const qz = Number.isFinite(s.quietZone_mm) && s.quietZone_mm >= 0 ? s.quietZone_mm : 0;
    return s.tagSize_mm + 2 * qz;
  }
  const edge = tagBitmapEdge_px(familyDef);
  if (edge <= 0) return null;
  return s.tagSize_mm * (1 + 2 / edge);
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
 *  off), push the implied tag size back into the Tag size field. `recompute`
 *  then re-reads the form and renders from that. */
function handleTotalSizeInput(): void {
  const total = field("totalSize") as HTMLInputElement;
  if (total.disabled) return;
  const familyDef = getFamily(field("family").value);
  const totalVal = Number.parseFloat(total.value);
  if (!familyDef || !Number.isFinite(totalVal) || totalVal <= 0) return;
  const edge = tagBitmapEdge_px(familyDef);
  if (edge <= 0) return;
  (field("tagSize") as HTMLInputElement).value = (totalVal / (1 + 2 / edge)).toFixed(2);
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
  const ready =
    currentPlan !== null &&
    currentFamily !== null &&
    loadedFamilies.has(currentFamily);
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
    const { renderPlan } = await import("./render/pdf");
    const bytes = await renderPlan(currentPlan, bitsProvider, {
      printLabelsOnBack,
    });
    // Copy into a fresh ArrayBuffer-backed Uint8Array; pdf-lib's return type
    // is `Uint8Array<ArrayBufferLike>` which Blob's typing rejects directly.
    const buf = new Uint8Array(bytes.length);
    buf.set(bytes);
    const blob = new Blob([buf], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `apriltags-${currentFamily}-${currentPlan.placements.length}.pdf`;
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

  const tags: TagSpec[] = tagIds.map((id) => ({ family: effective.family, id }));
  const paper = PAPERS[effective.paperKey] ?? PAPERS.A4!;
  const options: LayoutOptions = {
    pageMargin_mm: effective.pageMargin_mm,
    quietZone_mm: effective.quietZone_mm,
    cutMargin_mm: effective.cutMargin_mm,
  };

  let plan: LayoutPlan;
  try {
    plan = planSmallTagLayout(tags, effective.tagSize_mm, paper, options);
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

  const loaded = loadedFamilies.has(effective.family);
  const footprint =
    effective.tagSize_mm + 2 * (effective.quietZone_mm + effective.cutMargin_mm);
  const summary =
    `${plan.placements.length} tag${plan.placements.length === 1 ? "" : "s"} ` +
    `across ${plan.pageCount} page${plan.pageCount === 1 ? "" : "s"} on ` +
    `${paper.width_mm} × ${paper.height_mm} mm paper.${loaded ? "" : " (Loading bitmaps…)"}`;
  const detail =
    `Tag size ${effective.tagSize_mm.toFixed(2)} mm; ` +
    `quiet zone ${effective.quietZone_mm.toFixed(2)} mm; ` +
    `cut margin ${effective.cutMargin_mm.toFixed(2)} mm; ` +
    `printed cell ${footprint.toFixed(2)} mm.`;
  const info = document.getElementById("info");
  if (info) {
    info.innerHTML =
      `<p class="summary">${escapeHtml(summary)}</p>` +
      `<p>${escapeHtml(detail)}</p>`;
  }
  preview.innerHTML =
    Array.from({ length: plan.pageCount }, (_, p) => {
      return `<section><h3>Page ${p + 1} / ${plan.pageCount}</h3>${renderPlanToSvg(
        plan,
        p,
        tagImageProvider,
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

function bootstrap(): void {
  const app = document.getElementById("app");
  if (!app) return;
  const familyOptions = listFamilyNames()
    .map((n) => `<option value="${n}">${n}</option>`)
    .join("");
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
                <span style="color:#888;font-size:0.85em">blade slack on each side of every cut</span>
              </div>
              <div>
                <label>Page margin (mm) <input id="pageMargin" type="number" value="10" step="0.5" min="0"><span class="field-error" id="pageMargin-err"></span></label>
                <span style="color:#888;font-size:0.85em">unprintable border around each page</span>
              </div>
            </details>
          </fieldset>
          <fieldset>
            <legend>Output</legend>
            <label><input type="checkbox" id="printLabelsOnBack"> Print tag info on backside</label>
            <span style="color:#888;font-size:0.85em">for double-sided printing (long-edge / horizontal flip)</span>
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
