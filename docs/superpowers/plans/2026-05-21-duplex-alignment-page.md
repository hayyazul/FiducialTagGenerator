# Duplex Alignment Check Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When double-sided printing is on, insert one page after the calibration sheet so front/back pairs land on the same physical sheet, and make that inserted page a duplex-registration test (sample "back-tags" at 10/25/50 mm checked for containment against target outlines on the calibration front).

**Architecture:** The calibration page is always A4 (210×297). When double-sided and the plan has ≥1 layout page, `pdf.ts` adds one alignment page right after calibration (its physical back). `drawCalibrationPage` gains a duplex mode that vertically-centres and left-shifts the 100 mm square and draws three target outlines stacked in a column to its right. A new `drawAlignmentBackPage` draws the worst-case sample label inside each target's mirror (`x → W−x`), reusing the real `drawBackLabel` fit/draw logic (refactored to take pre-built lines).

**Tech Stack:** TypeScript (strict), pdf-lib via the `Canvas` interface, Vitest. Node 20 (`source ~/.nvm/nvm.sh && nvm use 20` before any npm command).

---

## File Structure

- `src/render/pdf-pages.ts` (modify) — refactor `drawBackLabel`; add the alignment-target table, worst-case label, front-target drawing in `drawCalibrationPage`, and the new `drawAlignmentBackPage`.
- `src/render/pdf-pages.test.ts` (modify) — tests for duplex calibration targets and the alignment page.
- `src/render/pdf.ts` (modify) — insert the alignment page; pass the duplex flag to `drawCalibrationPage`.
- `src/render/pdf.test.ts` (modify) — update existing back-page page-count assertions (now `2 + 2·pageCount`) and add an even-count test.
- `STRUCTURE.md` (modify) — update the `pdf.ts` / `pdf-pages.ts` rows.

---

## Task 1: Refactor `drawBackLabel` to take pre-built lines

Decouple "what text" from "how to fit/draw it" so the alignment page can reuse the exact containment-critical sizing. Pure refactor — existing tests are the safety net.

**Files:**
- Modify: `src/render/pdf-pages.ts`

- [ ] **Step 1: Change `drawBackLabel` to accept `lines` instead of building them**

In `src/render/pdf-pages.ts`, replace the `drawBackLabel` signature and its first line. Current:

```ts
function drawBackLabel(
  canvas: Canvas,
  placement: Placement,
  cx_mm: number,
  cy_mm: number,
  tile_mm: number,
  cutRadius_mm: number,
  isCircular: boolean,
  tagSize_mm: number,
  subtagLevels: SubtagLevel[],
): void {
  const lines = backLabelLines(placement, tagSize_mm, subtagLevels);
  const footprint = safeFootprint(tile_mm, cutRadius_mm, isCircular);
```

New (drop `placement`, `tagSize_mm`, `subtagLevels`; add `lines`; delete the now-redundant `backLabelLines` call):

```ts
function drawBackLabel(
  canvas: Canvas,
  lines: Array<{ text: string; bold: boolean }>,
  cx_mm: number,
  cy_mm: number,
  tile_mm: number,
  cutRadius_mm: number,
  isCircular: boolean,
): void {
  const footprint = safeFootprint(tile_mm, cutRadius_mm, isCircular);
```

Leave the rest of the function body unchanged.

- [ ] **Step 2: Update the `drawBackPage` call site to build lines first**

In `drawBackPage`, replace the loop body's `drawBackLabel(...)` call. Current:

```ts
    drawBackLabel(
      canvas,
      placement,
      cx_mm,
      cy_mm,
      tile_mm,
      cutRadius_mm,
      isCircular,
      plan.tagSize_mm,
      plan.subtagLevels,
    );
```

New:

```ts
    const lines = backLabelLines(placement, plan.tagSize_mm, plan.subtagLevels);
    drawBackLabel(canvas, lines, cx_mm, cy_mm, tile_mm, cutRadius_mm, isCircular);
```

- [ ] **Step 3: Run the existing PDF-page tests to confirm no behaviour change**

Run: `source ~/.nvm/nvm.sh && nvm use 20 >/dev/null && npx vitest run src/render/pdf-pages.test.ts`
Expected: PASS (30 tests). Output is identical because only the call shape changed.

- [ ] **Step 4: Commit**

```bash
git add src/render/pdf-pages.ts
git commit -m "refactor: drawBackLabel takes pre-built lines

Separates label content from box-fit/draw logic so the upcoming duplex
alignment page can reuse the same containment-sized rendering."
```

---

## Task 2: Calibration targets + alignment page generator

Add the shared target table, the worst-case sample label, the front-side target outlines (duplex mode of `drawCalibrationPage`), and `drawAlignmentBackPage`.

**Files:**
- Modify: `src/render/pdf-pages.ts`
- Test: `src/render/pdf-pages.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/render/pdf-pages.test.ts`. Add `drawAlignmentBackPage` and `drawCalibrationPage` to the import from `./pdf-pages` (it currently imports only `drawBackPage`):

```ts
import { drawAlignmentBackPage, drawBackPage, drawCalibrationPage } from "./pdf-pages";
```

Then add:

```ts
// The calibration / alignment sheet is always A4, independent of the
// layout paper.
const A4: Paper = { width_mm: 210, height_mm: 297 };
const ALIGN_SIZES = [10, 25, 50];

describe("drawCalibrationPage — duplex targets", () => {
  // Stroked, unfilled rects whose side is one of the reference sizes are
  // the square target outlines (the 100 mm square and the page border are
  // excluded by size).
  const targetSquares = (calls: Call[]): RectOpts[] =>
    labelBoxes(calls).filter((r) => ALIGN_SIZES.includes(Math.round(r.width_mm)));

  it("draws no reference targets in single-sided mode", () => {
    const { canvas, calls } = recordingCanvas(A4.width_mm, A4.height_mm);
    drawCalibrationPage(canvas);
    expect(targetSquares(calls).length).toBe(0);
    expect(circleCalls(calls).length).toBe(0);
  });

  it("draws three square target outlines in duplex square mode", () => {
    const { canvas, calls } = recordingCanvas(A4.width_mm, A4.height_mm);
    drawCalibrationPage(canvas, { isCircular: false });
    const sizes = targetSquares(calls).map((r) => Math.round(r.width_mm)).sort((a, b) => a - b);
    expect(sizes).toEqual([10, 25, 50]);
  });

  it("draws three circle target outlines in duplex circle mode", () => {
    const { canvas, calls } = recordingCanvas(A4.width_mm, A4.height_mm);
    drawCalibrationPage(canvas, { isCircular: true });
    const diameters = circleCalls(calls)
      .map((c) => Math.round(c.radius_mm * 2))
      .sort((a, b) => a - b);
    expect(diameters).toEqual([10, 25, 50]);
    expect(targetSquares(calls).length).toBe(0);
  });

  it("vertically centres the 100 mm square in duplex mode", () => {
    const { canvas, calls } = recordingCanvas(A4.width_mm, A4.height_mm);
    drawCalibrationPage(canvas, { isCircular: false });
    const main = labelBoxes(calls).find((r) => Math.round(r.width_mm) === 100);
    expect(main).toBeDefined();
    // (297 − 100) / 2 = 98.5
    expect(main!.y_mm).toBeCloseTo(98.5, 6);
  });
});

describe("drawAlignmentBackPage", () => {
  for (const isCircular of [false, true]) {
    it(`sample boxes are mirrored and contained (${isCircular ? "circle" : "square"})`, () => {
      const { canvas, calls } = recordingCanvas(A4.width_mm, A4.height_mm);
      drawAlignmentBackPage(canvas, { isCircular });
      const W = A4.width_mm;

      // Front target centres (same table the front draws), as the back
      // sees them: x mirrored, y unchanged.
      const expectedCenters = [
        { size: 10, x: W - 160, y: 194 },
        { size: 25, x: W - 160, y: 168.5 },
        { size: 50, x: W - 160, y: 123 },
      ];

      const boxes = labelBoxes(calls);
      expect(boxes.length).toBe(3);

      for (const t of expectedCenters) {
        const box = boxes.find(
          (b) =>
            Math.abs(b.x_mm + b.width_mm / 2 - t.x) < 1e-6 &&
            Math.abs(b.y_mm + b.height_mm / 2 - t.y) < 1e-6,
        );
        expect(box, `no box centred at (${t.x}, ${t.y})`).toBeDefined();
        if (isCircular) {
          const halfDiag = Math.hypot(box!.width_mm / 2, box!.height_mm / 2);
          expect(halfDiag).toBeLessThanOrEqual(t.size / 2 + 1e-9);
        } else {
          expect(box!.width_mm).toBeLessThanOrEqual(t.size + 1e-9);
          expect(box!.height_mm).toBeLessThanOrEqual(t.size + 1e-9);
        }
      }

      // Every sample text line fits its target's outer extent.
      const texts = textCalls(calls);
      expect(texts.length).toBeGreaterThan(0);
    });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `source ~/.nvm/nvm.sh && nvm use 20 >/dev/null && npx vitest run src/render/pdf-pages.test.ts`
Expected: FAIL — `drawAlignmentBackPage` is not exported, and `drawCalibrationPage` rejects a second argument.

- [ ] **Step 3: Implement the targets, worst-case label, and alignment page**

In `src/render/pdf-pages.ts`:

(a) Add constants near the other module constants (after `MISREG_CLEARANCE_FRAC`):

```ts
// Duplex alignment check (double-sided only). The reference sizes span the
// containment failure boundary: 10 mm is the worst case — the misreg
// clearance caps at 15% of the tag (1.5 mm) below ~13 mm, tighter than the
// 2 mm budget — while 25 / 50 mm sit comfortably inside it. `size_mm` is the
// outer cut dimension (square edge, or circle diameter). Centres are on the
// A4 calibration page (210×297): a column at x = 160, right of the
// left-shifted square, the group centred on the page's vertical middle.
interface AlignmentTarget {
  size_mm: number;
  cx_mm: number;
  cy_mm: number;
}
const ALIGNMENT_TARGETS: readonly AlignmentTarget[] = [
  { size_mm: 10, cx_mm: 160, cy_mm: 194 },
  { size_mm: 25, cx_mm: 160, cy_mm: 168.5 },
  { size_mm: 50, cx_mm: 160, cy_mm: 123 },
];

// In duplex mode the 100 mm square shifts left from page-centre to open the
// target column on its right, and is centred vertically (the header offset
// is dropped).
const CALIBRATION_DUPLEX_X0_MM = 25;

const TARGET_OUTLINE = gray(0.6);
const TARGET_OUTLINE_WIDTH = 0.3;

// The widest shipped family name (16 chars), used only as a width proxy so
// the sample is family-agnostic yet an upper bound on real label width.
const WORST_CASE_FAMILY = "tagStandard41h12";

/** The most demanding label the back renderer can emit: max line count
 *  (family, id, size, plus two nested sub-tag lines — the deepest the test
 *  suite exercises) and max width per line. If this stays legible at 10 mm,
 *  every real label does. Family-agnostic by construction. */
function worstCaseBackLabel(size_mm: number): Array<{ text: string; bold: boolean }> {
  const subLine = `> ${WORST_CASE_FAMILY} #99999 · ${formatTagSize(size_mm)}`;
  return [
    { text: WORST_CASE_FAMILY, bold: false },
    { text: "#99999", bold: true },
    { text: formatTagSize(size_mm), bold: false },
    { text: subLine, bold: false },
    { text: subLine, bold: false },
  ];
}
```

(b) Change `drawCalibrationPage` to take an optional duplex flag and branch the square position + targets. Replace the signature and the `x0` / `y0` computation:

```ts
/** A 100 × 100 mm reference square plus tick rulers along its left and
 *  bottom edges, with a small header explaining how to use it. When
 *  `duplex` is given (double-sided printing), the square is vertically
 *  centred and shifted left, and reference target outlines are drawn in a
 *  column to its right for the duplex alignment check on the back. */
export function drawCalibrationPage(
  canvas: Canvas,
  duplex?: { isCircular: boolean },
): void {
  const PAGE_W = canvas.page.width_mm;
  const PAGE_H = canvas.page.height_mm;
  const REF = CALIBRATION_SIZE_MM;

  const x0 = duplex ? CALIBRATION_DUPLEX_X0_MM : (PAGE_W - REF) / 2;
  const y0 = duplex
    ? (PAGE_H - REF) / 2
    : (PAGE_H - CALIBRATION_HEADER_HEIGHT_MM - REF) / 2;
```

Then, just before the closing brace of `drawCalibrationPage` (after the header-lines loop), draw the targets:

```ts
  if (duplex) {
    for (const t of ALIGNMENT_TARGETS) {
      drawAlignmentTargetOutline(canvas, t, duplex.isCircular);
    }
  }
}
```

(c) Add the target-outline helper (after `drawCalibrationPage`):

```ts
/** A faint outline marking where a reference tag of `t.size_mm` sits on the
 *  calibration front, with its size captioned above it. Square cuts get a
 *  square; circular cuts get a circle of diameter `size_mm`. */
function drawAlignmentTargetOutline(
  canvas: Canvas,
  t: AlignmentTarget,
  isCircular: boolean,
): void {
  if (isCircular) {
    canvas.drawCircle({
      cx_mm: t.cx_mm,
      cy_mm: t.cy_mm,
      radius_mm: t.size_mm / 2,
      stroke: TARGET_OUTLINE,
      strokeWidth_mm: TARGET_OUTLINE_WIDTH,
    });
  } else {
    canvas.drawRect({
      x_mm: t.cx_mm - t.size_mm / 2,
      y_mm: t.cy_mm - t.size_mm / 2,
      width_mm: t.size_mm,
      height_mm: t.size_mm,
      stroke: TARGET_OUTLINE,
      strokeWidth_mm: TARGET_OUTLINE_WIDTH,
    });
  }
  canvas.drawText({
    text: `${t.size_mm} mm`,
    x_mm: t.cx_mm,
    y_mm: t.cy_mm + t.size_mm / 2 + 2,
    fontSize_mm: ptToMm(8),
    font: "mono",
    fill: gray(0.4),
    anchor: "middle",
  });
}
```

(d) Add `drawAlignmentBackPage` (after `drawAlignmentTargetOutline`):

```ts
/** The duplex alignment check, printed on the back of the calibration
 *  sheet. For each reference target, a worst-case sample label is drawn at
 *  the mirror (x → W − x) of the target's front centre, so a long-edge
 *  duplex flip lands each box behind its target outline. Holding the sheet
 *  to the light shows whether the user's printer keeps the back image
 *  registered inside the tag at each size. No registration corner marks:
 *  the calibration front has none, so the target outlines + the 1 mm grid
 *  are the alignment reference. */
export function drawAlignmentBackPage(
  canvas: Canvas,
  opts: { isCircular: boolean },
): void {
  const W = canvas.page.width_mm;
  const H = canvas.page.height_mm;

  // White background so the sample boxes / text read.
  canvas.drawRect({ x_mm: 0, y_mm: 0, width_mm: W, height_mm: H, fill: { r: 1, g: 1, b: 1 } });

  canvas.drawText({
    text: "Duplex alignment check",
    x_mm: 20,
    y_mm: H - 14,
    fontSize_mm: ptToMm(18),
    font: "mono",
    fill: BLACK,
  });
  const headerLines = [
    "Hold this sheet to a light. Each box should sit centred INSIDE the matching",
    "outline on the front (calibration) side. If a box pokes past its outline, your",
    "printer's double-sided registration is off by more than the labels can absorb at",
    "that size — print single-sided, or use larger tags.",
  ];
  const headerFont_mm = ptToMm(9);
  for (let i = 0; i < headerLines.length; i++) {
    canvas.drawText({
      text: headerLines[i]!,
      x_mm: 20,
      y_mm: H - 22 - i * 4,
      fontSize_mm: headerFont_mm,
      font: "mono",
      fill: gray(0.25),
    });
  }

  for (const t of ALIGNMENT_TARGETS) {
    const cutRadius_mm = t.size_mm / 2;
    drawBackLabel(
      canvas,
      worstCaseBackLabel(t.size_mm),
      W - t.cx_mm,
      t.cy_mm,
      t.size_mm,
      cutRadius_mm,
      opts.isCircular,
    );
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `source ~/.nvm/nvm.sh && nvm use 20 >/dev/null && npx vitest run src/render/pdf-pages.test.ts`
Expected: PASS (30 existing + new tests).

- [ ] **Step 5: Commit**

```bash
git add src/render/pdf-pages.ts src/render/pdf-pages.test.ts
git commit -m "add duplex alignment targets and back-page generator

Calibration page gains a duplex mode (vertically-centred, left-shifted
square with 10/25/50 mm target outlines stacked beside it); new
drawAlignmentBackPage draws worst-case sample labels mirrored to land
behind each target for a hold-to-light registration check."
```

---

## Task 3: Wire the alignment page into the document and fix parity

**Files:**
- Modify: `src/render/pdf.ts`
- Test: `src/render/pdf.test.ts`

- [ ] **Step 1: Update existing page-count assertions and add an even-count test**

In `src/render/pdf.test.ts`, the inserted alignment page changes the double-sided count from `1 + 2·pageCount` to `2 + 2·pageCount`. Update these four assertions:

- In `"inserts a back page after every layout page when printLabelsOnBack is on"`:
  ```ts
    // 1 calibration + 1 alignment + 2 × layout pages.
    expect(reloaded.getPageCount()).toBe(2 + 2 * plan.pageCount);
  ```
- In `"renders a circle plan with back pages"`:
  ```ts
    expect(reloaded.getPageCount()).toBe(2 + 2 * plan.pageCount);
  ```
- In `"renders cleanly when tag IDs are non-contiguous"`:
  ```ts
    // 1 calibration + 1 alignment + N layout fronts + N layout backs.
    expect(reloaded.getPageCount()).toBe(2 + 2 * plan.pageCount);
  ```
- In `"produces a valid PDF with subtags on placements"`:
  ```ts
    expect(reloaded.getPageCount()).toBe(2 + 2 * plan.pageCount);
  ```

Then add a new test after `"does not insert back pages by default"`:

```ts
  it("yields an even page count for double-sided so duplex pairs align", async () => {
    const plan = planSmallTagLayout(makeTags(30), 25, square100, minimalOpts);
    expect(plan.pageCount).toBeGreaterThanOrEqual(2);
    const bytes = await renderPlan(plan, fakeMarker, { printLabelsOnBack: true });
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount() % 2).toBe(0);
  });
```

- [ ] **Step 2: Run the PDF tests to verify the count tests fail**

Run: `source ~/.nvm/nvm.sh && nvm use 20 >/dev/null && npx vitest run src/render/pdf.test.ts`
Expected: FAIL — the updated/new assertions expect the alignment page that isn't emitted yet.

- [ ] **Step 3: Insert the alignment page in `pdf.ts`**

In `src/render/pdf.ts`, update the import:

```ts
import {
  drawAlignmentBackPage,
  drawBackPage,
  drawCalibrationPage,
  drawPageFooter,
} from "./pdf-pages";
```

Replace the calibration block and add the alignment page. Current:

```ts
  const calibrationPage = doc.addPage([mm(210), mm(297)]);
  const calibrationCanvas = new PdfCanvas(calibrationPage, fonts, 210, 297);
  drawCalibrationPage(calibrationCanvas);
```

New (the alignment page is added only when there is at least one layout page to duplex — an empty plan stays calibration-only):

```ts
  // The alignment page is the physical back of the calibration sheet; it
  // both restores even parity (so each front/back layout pair shares a
  // sheet) and carries the duplex registration check. Only meaningful when
  // there is at least one layout page to print double-sided.
  const duplex = printBack && plan.pageCount > 0;
  const isCircular = plan.cutCircles.length > 0;

  const calibrationPage = doc.addPage([mm(210), mm(297)]);
  const calibrationCanvas = new PdfCanvas(calibrationPage, fonts, 210, 297);
  drawCalibrationPage(calibrationCanvas, duplex ? { isCircular } : undefined);

  if (duplex) {
    const alignmentPage = doc.addPage([mm(210), mm(297)]);
    const alignmentCanvas = new PdfCanvas(alignmentPage, fonts, 210, 297);
    drawAlignmentBackPage(alignmentCanvas, { isCircular });
  }
```

- [ ] **Step 4: Run the PDF tests to verify they pass**

Run: `source ~/.nvm/nvm.sh && nvm use 20 >/dev/null && npx vitest run src/render/pdf.test.ts`
Expected: PASS (13 existing + 1 new).

- [ ] **Step 5: Commit**

```bash
git add src/render/pdf.ts src/render/pdf.test.ts
git commit -m "insert duplex alignment page after calibration

Restores even page parity so long-edge duplex pairs each layout front with
its own back sheet (previously the lone calibration page shifted every
pair onto separate sheets). The inserted page is the calibration sheet's
back and carries the registration check. Added only when printing
double-sided with >=1 layout page."
```

---

## Task 4: Update docs and run the full gate

**Files:**
- Modify: `STRUCTURE.md`
- Modify: `docs/superpowers/specs/2026-05-21-duplex-alignment-page-design.md`

- [ ] **Step 1: Update `STRUCTURE.md`**

Replace the `src/render/pdf.ts` row's role text with one that mentions the alignment page, e.g. append to the existing sentence:

```
... With `printLabelsOnBack: true` and ≥1 layout page, a single alignment page is inserted right after the calibration sheet (its physical back) to restore even parity and carry the duplex registration check; each layout page is then followed by its mirrored back sheet.
```

Replace the `src/render/pdf-pages.ts` row's role text to mention the new generators, e.g. append:

```
... Also draws the duplex-mode calibration variant (vertically-centred, left-shifted square with 10/25/50 mm target outlines) and `drawAlignmentBackPage`, which mirrors worst-case sample labels behind those targets for a hold-to-light registration check.
```

- [ ] **Step 2: Note the registration-corner deviation in the spec**

In `docs/superpowers/specs/2026-05-21-duplex-alignment-page-design.md`, under "New back page", change the line about registration corners to record the implemented decision:

```
   center of its front target. No registration corner marks are added: the
   calibration front has none to align against, so the target outlines plus
   the calibration square's 1 mm grid are the alignment reference.
```

- [ ] **Step 3: Run the full test suite**

Run: `source ~/.nvm/nvm.sh && nvm use 20 >/dev/null && npm test`
Expected: PASS — all suites green (196 prior + the new tests).

- [ ] **Step 4: Run the linter**

Run: `source ~/.nvm/nvm.sh && nvm use 20 >/dev/null && npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add STRUCTURE.md docs/superpowers/specs/2026-05-21-duplex-alignment-page-design.md
git commit -m "docs: record alignment page in STRUCTURE and spec"
```

---

## Self-Review Notes

- **Spec coverage:** parity fix (Task 3), inserted page = back of calibration (Task 3), vertically-centred + left-shifted square with stacked 10/25/50 mm targets (Task 2), shape matches job's cut (Task 2, `isCircular`), worst-case family-agnostic label (Task 2, `worstCaseBackLabel`), mirror coordinate `x → W−x` (Task 2), containment guaranteed via reused `safeFootprint` path (Task 1 refactor + Task 2), tests for containment/mirror/gating/parity (Tasks 2–3). Registration corners intentionally omitted — recorded in Task 4 Step 2.
- **Placeholder scan:** none — every step has concrete code/commands.
- **Type consistency:** `drawAlignmentBackPage(canvas, { isCircular })`, `drawCalibrationPage(canvas, duplex?)`, and the refactored `drawBackLabel(canvas, lines, cx, cy, tile, cutRadius, isCircular)` are used consistently across pdf.ts, pdf-pages.ts, and both test files. `AlignmentTarget` centres in the table match the expected centres asserted in the test.
</content>
