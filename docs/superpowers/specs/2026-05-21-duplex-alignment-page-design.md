# Duplex alignment check page — design

Date: 2026-05-21
Status: approved (pending spec review)

## Problem

When double-sided printing is enabled (`printLabelsOnBack`), the PDF emits
pages in the order:

```
[calib]  [front0]  [back0]  [front1]  [back1] …
```

That is `1 + 2·pageCount` pages — always **odd**. Long-edge duplex printing
pairs pages onto physical sheets as `(1,2), (3,4), (5,6), …`, so the leading
calibration page shifts every pair by one:

```
sheet 1: (calib,  front0)   ← front0 is on the BACK of the calibration sheet
sheet 2: (back0,  front1)   ← back0 (front0's labels) is on a DIFFERENT sheet
sheet 3: (back1,  front2)
```

Every front layout page and the back-label page that belongs to it land on
different physical sheets. Double-sided output is therefore wrong by default:
the labels never end up behind their tags.

## Fix

Insert exactly **one** page immediately after the calibration page (only when
`printLabelsOnBack` is set). This restores parity and re-pairs every sheet:

```
[calib]  [NEW align]  [front0]  [back0]  [front1]  [back1] …
   └────sheet 1────┘  └──sheet 2──┘     └──sheet 3──┘
```

`2 + 2·pageCount` pages (even). The inserted page is physically the **reverse
of the calibration sheet**, so it is the natural home for a duplex
registration test that the user can verify on a single sheet — the same sheet
they already print first to check scale — before committing to the full run.

## The inserted page: "Duplex alignment check"

Rather than a blank filler, the page carries a real test for the failure mode
duplex printing introduces: front/back **misregistration**. Consumer duplex
printers offset the back image from the front by ~1–2 mm, drifting sheet to
sheet. `drawBackPage` already sizes label boxes (`safeFootprint`) to survive a
2 mm budget (capped at 15% of the tag), but the user has no way to know whether
*their* printer stays within that budget — especially for small tags, where the
absolute budget shrinks. This page lets them measure it.

### What it tests

Reference "back-tags" (sample label boxes, drawn through the same
`drawBackLabel` path as the real `drawBackPage` output) at **fixed sizes and
fixed positions**, registered against the calibration square's existing 1 mm
tick grid. The user holds the printed sheet to the light: each back-tag box
should sit centered **inside** its target outline on the front. If a box spills
past its outline, the printer's duplex offset exceeds the safe margin for that
size.

### Worst-case label text (family-agnostic)

The box-in-target containment is guaranteed by `safeFootprint` regardless of
the text — the box never exceeds the safe footprint, and the font shrinks to
fit. What the text actually affects is **legibility**: more/longer lines force a
smaller font, and on a 10 mm tag that font can become unreadable. So the test
must render the *most demanding* label the renderer can emit, using neutral
placeholder glyphs rather than any real family:

- **Maximum line count** the back-label path can produce: the top family line,
  `#id`, the size line, plus the deepest nested sub-tag chain the recursive UI
  allows. The sample uses that full line count.
- **Maximum line width**: each line is padded to the widest a real line of its
  kind can be (longest family-name length, max id digits, max size string). The
  mono font is fixed-width, so width is purely a glyph count; neutral filler
  glyphs (e.g. `X`) at that count reproduce the worst-case width without naming
  a family.

If the user can read this sample at 10 mm after printing, every real label on a
real job is at least as legible.

Reference tags are **fixed sizes, not the job's actual tag size** — a real tag
can occupy most of a page, which is useless as a compact registration target.
Fixed sizes also let the user see the failure boundary directly regardless of
their job.

- **Sizes: 10 / 25 / 50 mm.** 10 mm is the worst case: the misregistration
  clearance caps at 15% of the tag (= 1.5 mm) below ~13 mm, tighter than the
  2 mm budget, so small-tag labels are the first to spill. 25 and 50 mm show
  the comfortable zone.
- **Shape matches the job's cut** (square for square cuts, circle for circular
  families such as CCTag / tagCircle). Containment geometry differs between
  shapes — circular cuts constrain the label to the inscribed square of the cut
  disk — so matching the shape keeps the test representative.

### Layout

When double-sided, the calibration square is **centered vertically** on the
page (the current header-offset shift is dropped) and moved left of center to
open a column on its right for the three targets, **stacked vertically** (10 /
25 / 50 mm) and centered as a group on the same vertical middle as the square.
The header text stays at the top of the page as today. The single-sided
calibration page is unchanged.

```
   FRONT (calibration sheet)        BACK (new alignment page)
  ┌─────────────────────────┐      ┌─────────────────────────┐
  │ Print calibration  …    │      │ Duplex alignment check … │
  │ ┌──── 100 mm ───┐  ┌──┐ │ flip │ ┌──┐  ┌──── 100 mm ───┐  │
  │ │               │  │□ │10│ ───►│10│ □│  │               │  │
  │ │   (square)    │  ├──┤ │      │ ├──┤  │   (mirror of   │  │
  │ │               │  │□ │25│     │25│ □│  │    front)      │  │
  │ │               │  ├──┤ │      │ ├──┤  │               │  │
  │ └─ ticks ───────┘  │◻ │50│     │50│ ◻│  └───────────────┘  │
  │                    └──┘ │      │ └──┘                      │
  └─────────────────────────┘      └─────────────────────────┘
   targets right of square          back-tags mirrored to the
   front center cx                  left, at x → W − cx
```

A front target at center `(cx, cy)` (right of the square) maps to a back label
at `(W − cx, cy)` (left of center on the back page); flipping the sheet about
its long edge brings the two into coincidence.

## Components and changes

### `src/render/pdf.ts`

When `printBack` is true, after `drawCalibrationPage`, add one page and call a
new `drawAlignmentBackPage(canvas, plan)`. This is the only change to the page
loop; the per-layout-page front/back loop is unchanged.

### `src/render/pdf-pages.ts`

1. **`drawCalibrationPage` gains an optional set of front targets.** When
   double-sided, center the square vertically (drop the header offset), shift it
   left of center, and draw the 3 reference target outlines (faint, captioned
   with their size) **stacked vertically in a column to the right of the
   square**, in the job's cut shape, centered as a group on the same vertical
   middle. When single-sided, the calibration page is unchanged. The cut shape
   and the "double-sided" flag are passed in (the function currently takes only
   a `Canvas`).

2. **New `drawAlignmentBackPage(canvas, plan)`.** For each reference target,
   draw a real back-label box via the existing `drawBackLabel` path (so the
   test exercises the same `safeFootprint` + text sizing the real labels use),
   with sample text, centered at the mirror (`x → W − x`) of the front target
   center. Add mirrored registration corners (reuse
   `drawBackRegistrationCorners`) and a one-line header explaining the
   hold-to-light check.

3. **Shared reference-target definition.** A single source of truth for the
   target sizes and their stacked centers, consumed by both the front (draws
   outlines) and the back (draws mirrored labels), so the two sides cannot drift
   out of sync. Centers are chosen so the column (10 + 25 + 50 mm tall plus
   gaps) fits beside the square within the page width and stays clear of the
   rulers and header.

### Coordinate contract

Front target center `(cx, cy)` ⇒ back label center `(W − cx, cy)`, where `W`
is the page width. This is the same reflection `drawBackPage` already uses, so
"hold to light and flip about the long edge" lands the back box on the front
target.

## Error handling

No new user input. The reference geometry is internal and fixed; the only
constraint (largest target fits inside the 100 mm square, clear of rulers) is a
compile-time property of the chosen constants, asserted by a unit test rather
than checked at runtime.

## Testing

- **Containment:** for each reference size and both cut shapes, the back-label
  box (and every text line) fits inside the corresponding front target outline.
- **Mirror symmetry:** each back label center equals `W − cx` of its front
  target center; registration corners coincide front/back.
- **Front targets gated:** `drawCalibrationPage` draws the targets only in the
  double-sided case; the single-sided calibration page output is unchanged.
- **Page-count parity (`pdf.ts`):** with `printLabelsOnBack`, total page count
  is `2 + 2·pageCount` (even); the alignment page is present and absent without
  the flag.

## Out of scope

- Numeric auto-readout of the measured offset (the 1 mm grid suffices).
- Per-job tag-size targets (deliberately fixed; see rationale above).
- Short-edge duplex (the existing back layout already assumes long-edge).
</content>
</invoke>
