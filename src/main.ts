import { getFamily, listFamilyNames, tagBitmapEdge_px, type TagFamilyDef } from "./families";
import { type FamilyBitmaps, loadFamily } from "./families/load";
import { planSmallTagLayout } from "./layout/plan";
import type { LayoutOptions, LayoutPlan, Paper, TagSpec } from "./layout/types";
import { type BitsProvider, renderPlanToSvg } from "./preview/svg";
import { renderPlan } from "./render/pdf";

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
  startId: number;
  count: number;
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
    startId: Number.parseInt(field("startId").value, 10),
    count: Number.parseInt(field("count").value, 10),
    tagSize_mm: Number.parseFloat(field("tagSize").value),
    paperKey: field("paper").value,
    pageMargin_mm: Number.parseFloat(field("pageMargin").value),
    overrideAdvanced: (field("overrideAdvanced") as HTMLInputElement).checked,
    quietZone_mm: Number.parseFloat(field("quietZone").value),
    cutMargin_mm: Number.parseFloat(field("cutMargin").value),
  };
}

/** Sync the disabled-state of advanced inputs to the override checkbox, and
 *  refill them with the auto-derived values when the override is off. */
function syncAdvancedFields(s: FormState, familyDef: TagFamilyDef | undefined): void {
  const qz = field("quietZone") as HTMLInputElement;
  const cm = field("cutMargin") as HTMLInputElement;
  qz.disabled = !s.overrideAdvanced;
  cm.disabled = !s.overrideAdvanced;
  if (!s.overrideAdvanced) {
    const auto = familyDef ? deriveQuietZone_mm(s.tagSize_mm, familyDef) : 0;
    qz.value = Number.isFinite(auto) ? auto.toFixed(2) : "";
    cm.value = DEFAULT_CUT_MARGIN_MM.toString();
  }
}

function renderError(message: string): void {
  const out = document.getElementById("preview");
  if (out) out.innerHTML = `<p style="color:#c00">${escapeHtml(message)}</p>`;
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
    const bytes = await renderPlan(currentPlan, bitsProvider);
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
    renderError(`PDF render failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    syncDownloadButton();
  }
}

function recompute(): void {
  const out = document.getElementById("preview");
  if (!out) return;
  const s = readForm();
  const familyDef = getFamily(s.family);
  syncAdvancedFields(s, familyDef);

  // Re-read after syncAdvancedFields, which may have refreshed the values.
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

  if (
    !Number.isFinite(effective.count) ||
    !Number.isFinite(effective.tagSize_mm) ||
    effective.count < 1 ||
    effective.tagSize_mm <= 0
  ) {
    out.innerHTML = `<p>Fill in count and tag size to see a preview.</p>`;
    return;
  }

  if (!familyDef) {
    renderError(`Unknown tag family "${s.family}".`);
    return;
  }

  // Bounds check: the family only has validTagCount valid tag IDs.
  const lastId = effective.startId + effective.count - 1;
  if (effective.startId < 0) {
    renderError(`Start ID must be ≥ 0 (got ${effective.startId}).`);
    return;
  }
  if (lastId >= familyDef.validTagCount) {
    renderError(
      `Requested ids ${effective.startId}..${lastId} exceed family ${familyDef.name}, ` +
        `which has only ${familyDef.validTagCount} valid tags (max id ${
          familyDef.validTagCount - 1
        }). Reduce Count or Start ID.`,
    );
    return;
  }

  const tags: TagSpec[] = Array.from({ length: effective.count }, (_, i) => ({
    family: effective.family,
    id: effective.startId + i,
  }));
  const paper = PAPERS[effective.paperKey] ?? PAPERS.A4!;
  const options: LayoutOptions = {
    pageMargin_mm: effective.pageMargin_mm,
    quietZone_mm: effective.quietZone_mm,
    cutMargin_mm: effective.cutMargin_mm,
  };

  try {
    const plan = planSmallTagLayout(tags, effective.tagSize_mm, paper, options);
    const loaded = loadedFamilies.has(effective.family);
    const footprint =
      effective.tagSize_mm + 2 * (effective.quietZone_mm + effective.cutMargin_mm);
    const summary =
      `${plan.placements.length} tag${plan.placements.length === 1 ? "" : "s"} ` +
      `across ${plan.pageCount} page${plan.pageCount === 1 ? "" : "s"} on ` +
      `${paper.width_mm} × ${paper.height_mm} mm paper.${loaded ? "" : " (Loading bitmaps…)"}`;
    const detail =
      `Canonical tag size ${effective.tagSize_mm.toFixed(2)} mm; ` +
      `quiet zone ${effective.quietZone_mm.toFixed(2)} mm; ` +
      `cut margin ${effective.cutMargin_mm.toFixed(2)} mm; ` +
      `printed cell ${footprint.toFixed(2)} mm.`;
    const pages = Array.from({ length: plan.pageCount }, (_, p) => {
      return `<section><h3>Page ${p + 1} / ${plan.pageCount}</h3>${renderPlanToSvg(
        plan,
        p,
        bitsProvider,
      )}</section>`;
    }).join("");
    out.innerHTML =
      `<p>${escapeHtml(summary)}</p>` +
      `<p style="color:#666;font-size:0.9em">${escapeHtml(detail)}</p>` +
      (pages || "<p>(no pages)</p>");
    currentPlan = plan;
    currentFamily = effective.family;
    syncDownloadButton();
  } catch (e) {
    renderError(
      `Cannot lay out tags: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
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
    <h1>AprilTag PDF Generator <small style="font-weight:normal;color:#888">— layout preview</small></h1>
    <p style="color:#666">PDF download arrives in Part 2. This view shows
       layout, quiet zones (cream), cut lines (red), and the page-margin
       guide (dashed). Real tag bitmaps are loaded from the family mosaic.</p>
    <form id="form">
      <fieldset>
        <legend>Tags</legend>
        <label>Family
          <select id="family">${familyOptions}</select>
        </label>
        <label>Start ID <input id="startId" type="number" value="0" min="0"></label>
        <label>Count <input id="count" type="number" value="20" min="1"></label>
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
        <label>Page margin (mm) <input id="pageMargin" type="number" value="10" step="0.5" min="0"></label>
      </fieldset>
      <fieldset>
        <legend>Tag</legend>
        <label>Tag size (mm)
          <input id="tagSize" type="number" value="40" step="0.5" min="1">
        </label>
        <span style="color:#888;font-size:0.85em">canonical (black-border) edge — what detectors expect</span>
        <details style="margin-top:0.5rem">
          <summary style="cursor:pointer">Advanced</summary>
          <div style="margin-top:0.4rem">
            <label><input type="checkbox" id="overrideAdvanced"> Override defaults</label>
          </div>
          <div style="margin-top:0.3rem">
            <label>Quiet zone (mm) <input id="quietZone" type="number" step="0.1" min="0" disabled></label>
            <span style="color:#888;font-size:0.85em">auto = 1 module = tagSize / bitmap edge</span>
          </div>
          <div>
            <label>Cut margin (mm) <input id="cutMargin" type="number" step="0.1" min="0" value="${DEFAULT_CUT_MARGIN_MM}" disabled></label>
            <span style="color:#888;font-size:0.85em">blade slack on each side of every cut</span>
          </div>
        </details>
      </fieldset>
    </form>
    <p><button id="downloadPdf" type="button" disabled>Download PDF</button></p>
    <hr>
    <div id="preview"></div>
  `;
  const form = document.getElementById("form");
  form?.addEventListener("input", recompute);
  form?.addEventListener("change", recompute);
  document.getElementById("downloadPdf")?.addEventListener("click", () => {
    void handleDownload();
  });
  recompute();
}

bootstrap();
