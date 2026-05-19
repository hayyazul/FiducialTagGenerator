# Plan: UI adjustments

## Context

The CLAUDE.md improvements list has four remaining items (the UX/UI polish
layer — no behavior changes). Branch: `ui-adjustments` off `canvas-refactor`.

Each is small on its own; bundling them into one branch avoids churn.

---

## 1. Rebalance panes: shrink form, grow preview

**Current:** both `.form-pane` and `.preview-pane` are `flex: 1` (50/50).
The form is sparse at ~320px content width; the preview is squashed and
further capped by `max-width: 600px`.

**Plan:**
- `.form-pane` → `flex: 0 0 320px; min-width: 280px;` — fixed sidebar.
  The form controls are already narrow; 320px gives them breathing room
  without wasting space.
- `.preview-pane` → `flex: 1 1 0;` — takes remaining space. On a 1440px
  screen this means ~1100px for the preview (vs. ~700px before).
- Remove `max-width: 600px` on `#preview` (or raise it to
  `min(100%, 1200px)`) so wide multi-column sheets fully use the pane.
- One media query at ~640px: stack panes vertically (`flex: 0 0 auto;
  width: 100%` each) for phones.

**Files:** `index.html` (CSS only — `.form-pane`, `.preview-pane`,
`#preview`, new media query).

---

## 2. Custom paper dimensions

**Current:** hardcoded `PAPERS` map with A4, Letter, Square100. The
`<select id="paper">` shows these three + no "custom" option.

**Plan:**
- Add a fourth `<option value="custom">` to the paper select.
- When "Custom" is selected, show two number inputs (width, height in mm)
  next to the paper select, hidden otherwise.
- Wire `recompute()` to read custom width/height when paper is "custom".
  **Reject bogus values** (negative, NaN, <50mm or >1200mm) with a
  visible field error — no silent fallback to A4.
- No changes to `Paper` type or layout engine — custom paper is just a
  UI-level alternative to picking a preset.

**Files:** `src/main.ts` (template + recompute logic), `index.html`
(optional CSS for the custom-paper row).

---

## 3. Tag size slider

**Current:** `<input type="number" id="tagSize">` with step=0.5. No
slider.

**Plan:**
- Add `<input type="range" id="tagSizeSlider">` alongside the existing
  number input. Range: 10–200 mm, step 0.5.
- The slider and number input stay in sync: changing either updates the
  other, then triggers recompute. Use `requestAnimationFrame` to batch
  slider `input` events — the preview updates every frame during a drag,
  staying smooth without redundant re-renders between frames.
- Keep the existing number input — the slider is the primary control but
  the number box stays for precise entry (CLAUDE.md says so).
- The `totalSize` field gets the same slider treatment.

**Files:** `src/main.ts` (template + sync handlers), `index.html`
(slider CSS — track/thumb styling to match the existing minimal look).

---

## 4. Visual polish — "sharp, powerful tool"

**Constraint from user:** the look should be sharp and precise, not
"plain" or "boring." No glossy AI aesthetic, no gradients, no card
layouts, no icon libraries. The design communicates *power through
clarity* — like a well-made instrument panel, not a brochure.

**Plan (four restrained changes):**
- **Active fieldset indicator:** thin accent line (2px, `#222`) on the
  left edge of whichever `<fieldset>` contains a focused input. Uses
  `:focus-within` — pure CSS, no JS. Gives spatial grounding.
- **Fieldset legend weight:** 0.95rem → 1rem, weight 600. Clearer
  visual sections without extra decoration.
- **Vertical rhythm:** fieldset margin-bottom 0.75rem → 1rem; label
  margin-bottom 0.25rem → 0.35rem. More breathing room.
- **Input focus style:** swap the default browser outline for a 1px
  `#222` border with a subtle box-shadow — sharper and more deliberate
  than the fuzzy blue ring.

**Files:** `index.html` (CSS only).

---

## Workflow

Each change gets its own commit on `ui-adjustments` (no sub-branches).
A commit-per-change keeps the history clean and the review surface small
without the overhead of merging sub-branches back and forth.

---

## Verification

1. `npm run dev` — smoke test: form is ~320px sidebar, preview fills
   remaining space; resize below 640px → stacked layout.
2. Custom paper: select "Custom", enter 150×150, verify tags pack into a
   150mm square.
3. Slider: drag tag size slider, verify number box updates and preview
   re-renders after debounce; type in number box, verify slider updates.
4. `npm test` — full suite passes (no behavior changes to layout/render).
5. `npm run lint` — clean.
6. `npm run build` — clean. Inspect `dist/index.html` for new CSS.
