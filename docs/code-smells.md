# Code smells

Living list of smells noticed in passing. Each entry says *where* and
*why* it smells; fixes are deferred until the right branch comes
around. Remove entries here when the underlying issue lands fixed on
`main`.

## 2026-05-17 — noticed while planning circular tags

1. **Footprint formula has three copies.**
   `tileSize + 2·(quiet + cut)` lives at `src/layout/plan.ts:18`
   (`tagFootprint_mm`), `src/main.ts:397` (status-line `footprint`), and
   `src/render/pdf.ts:480` (footer `cell`). After the cut-margin
   prerequisite changes the formula, three copies must change together.
   Should be derivable once from the plan (e.g. expose pitch on
   `LayoutPlan` or via a helper) and reused.

2. **Preview-side label geometry hand-mirrors PDF constants.**
   `src/preview/svg.ts:144-153` and `:170-180` reproduce `0.7·cutMargin`,
   `0.15·cutMargin`, `0.6·quietZone`, `0.28·quietZone` magic numbers
   from `src/render/pdf.ts:347-358` and `:250-258`. The comments
   literally read "Matches `render/pdf`'s baseline" — a
   fragile-by-acknowledgement coupling. The cut-margin prerequisite
   kills half of this immediately; the quiet-zone half persists. Worth
   a shared "label-geometry" helper.

3. **Two escape helpers.**
   `escapeHtml` (`src/main.ts:432`) and `escapeXml`
   (`src/preview/svg.ts:213`) are the same function modulo one extra
   replacement. Single shared helper would do.

4. **`src/main.ts` is 526 lines and mixes too much.**
   Form-rendering (a giant template-string literal), validation, plan
   computation, lazy-loading orchestration, and download all live in
   one module. Per CLAUDE.md's "when a file grows large, that's often a
   signal it's doing too much." Worth a future split (e.g. separate
   form/state, validation, presenter modules).

5. **Function declared before its module's imports.**
   `buildFamilyOptionsMarkup` is declared at `main.ts:11-33` before the
   `import` block continues at line 34. Legal but surprising; routine
   reorder would help.

6. **BitsProvider conflates two failure modes.**
   `getFamily(name)?.bits(id) ?? null` returns `null` both for "family
   not loaded" and "id out of range". The doc says this is intentional,
   but consumers can't distinguish — flagging for awareness.

7. **`DEFAULT_CUT_MARGIN_MM` lives in `main.ts`.**
   The constant `0.5` is set in the UI module while the layout planner
   has no defaults. The cut-margin prerequisite branch should pick one
   home (and the value itself changes to 0 per the new semantic).
