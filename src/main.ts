import { listFamilyNames } from "./families";
import { type FamilyBitmaps, loadFamily } from "./families/load";
import { planSmallTagLayout } from "./layout/plan";
import type { LayoutOptions, Paper, TagSpec } from "./layout/types";
import { type BitsProvider, renderPlanToSvg } from "./preview/svg";

// Crude preview UI for Part 1. No PDF download yet; that arrives with Part 2.

const PAPERS: Record<string, Paper> = {
  A4: { width_mm: 210, height_mm: 297 },
  Letter: { width_mm: 215.9, height_mm: 279.4 },
  Square100: { width_mm: 100, height_mm: 100 },
};

interface FormState {
  family: string;
  startId: number;
  count: number;
  tagSize_mm: number;
  paperKey: string;
  pageMargin_mm: number;
  quietZone_mm: number;
  cutMargin_mm: number;
  interTagGap_mm: number;
}

const loadedFamilies = new Map<string, FamilyBitmaps>();

const bitsProvider: BitsProvider = {
  bits(family, id) {
    return loadedFamilies.get(family)?.bits(id) ?? null;
  },
};

function readForm(): FormState {
  const v = (id: string): string => {
    const el = document.getElementById(id);
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLSelectElement)) {
      throw new Error(`form field #${id} not found`);
    }
    return el.value;
  };
  return {
    family: v("family"),
    startId: Number.parseInt(v("startId"), 10),
    count: Number.parseInt(v("count"), 10),
    tagSize_mm: Number.parseFloat(v("tagSize")),
    paperKey: v("paper"),
    pageMargin_mm: Number.parseFloat(v("pageMargin")),
    quietZone_mm: Number.parseFloat(v("quietZone")),
    cutMargin_mm: Number.parseFloat(v("cutMargin")),
    interTagGap_mm: Number.parseFloat(v("interTagGap")),
  };
}

function recompute(): void {
  const out = document.getElementById("preview");
  if (!out) return;
  const s = readForm();

  // Kick off a load for any family the form mentions but we haven't loaded.
  if (s.family && !loadedFamilies.has(s.family) && listFamilyNames().includes(s.family)) {
    void loadFamily(s.family).then(
      (bm) => {
        loadedFamilies.set(s.family, bm);
        recompute();
      },
      (err: unknown) => {
        console.error("failed to load family", s.family, err);
      },
    );
  }

  if (
    !Number.isFinite(s.count) ||
    !Number.isFinite(s.tagSize_mm) ||
    s.count < 1 ||
    s.tagSize_mm <= 0
  ) {
    out.innerHTML = `<p>Fill in count and tag size to see a preview.</p>`;
    return;
  }
  const tags: TagSpec[] = Array.from({ length: s.count }, (_, i) => ({
    family: s.family,
    id: s.startId + i,
  }));
  const paper = PAPERS[s.paperKey] ?? PAPERS.A4!;
  const options: LayoutOptions = {
    pageMargin_mm: s.pageMargin_mm,
    quietZone_mm: s.quietZone_mm,
    cutMargin_mm: s.cutMargin_mm,
    interTagGap_mm: s.interTagGap_mm,
  };

  try {
    const plan = planSmallTagLayout(tags, s.tagSize_mm, paper, options);
    const loaded = loadedFamilies.has(s.family);
    const summary = `${plan.placements.length} tag${
      plan.placements.length === 1 ? "" : "s"
    } across ${plan.pageCount} page${plan.pageCount === 1 ? "" : "s"} on ${
      paper.width_mm
    } × ${paper.height_mm} mm paper.${loaded ? "" : " (Loading bitmaps…)"}`;
    const pages = Array.from({ length: plan.pageCount }, (_, p) => {
      return `<section><h3>Page ${p + 1} / ${plan.pageCount}</h3>${renderPlanToSvg(
        plan,
        p,
        bitsProvider,
      )}</section>`;
    }).join("");
    out.innerHTML = `<p>${summary}</p>${pages || "<p>(no pages)</p>"}`;
  } catch (e) {
    out.innerHTML = `<p style="color:#c00">Cannot lay out tags: ${
      e instanceof Error ? e.message : String(e)
    }</p>`;
  }
}

function bootstrap(): void {
  const app = document.getElementById("app");
  if (!app) return;
  const familyOptions = listFamilyNames()
    .map((n) => `<option value="${n}">${n}</option>`)
    .join("");
  app.innerHTML = `
    <h1>AprilTag PDF Generator <small style="font-weight:normal;color:#888">— layout preview</small></h1>
    <p style="color:#666">PDF download arrives in Part 2; this view shows
       only layout, quiet zones (cream), cut lines (red), and the page-margin
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
        <legend>Tag geometry (mm)</legend>
        <label>Tag size <input id="tagSize" type="number" value="40" step="0.5" min="1"></label>
        <label>Quiet zone <input id="quietZone" type="number" value="2" step="0.1" min="0"></label>
        <label>Cut margin <input id="cutMargin" type="number" value="1" step="0.1" min="0"></label>
        <label>Inter-tag gap <input id="interTagGap" type="number" value="0" step="0.5" min="0"></label>
      </fieldset>
    </form>
    <hr>
    <div id="preview"></div>
  `;
  const form = document.getElementById("form");
  form?.addEventListener("input", recompute);
  form?.addEventListener("change", recompute);
  recompute();
}

bootstrap();
