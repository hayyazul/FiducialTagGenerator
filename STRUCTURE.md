# STRUCTURE.md

## Architecture

A static, client-side TypeScript web app (Vite + pdf-lib) that generates
printable PDFs of AprilTags. Four layers, each with a single responsibility:

1. **Families** (`src/families/`) — Polymorphic marker catalogue. A `Family`
   exposes markers indexed by integer id; each `Marker` knows how to draw
   itself onto a `Canvas` via `draw(canvas, frame)`. New marker shapes
   (bit-grid, vector circles, raster PNG, dot-pattern) add a class — the
   compose/export layer never inspects internals. Today every shipped family
   is backed by a PNG mosaic (`MosaicFamily`), but procedural / raster /
   alias families drop in behind the same interface.
2. **Layout** (`src/layout/`) — Geometry engine that packs tags onto pages.
   Pure math, no DOM, no rendering. Produces a `LayoutPlan`.
3. **Rendering** — Two parallel consumers of `LayoutPlan`:
   - **Preview** (`src/preview/`) — SVG string builder for live in-browser preview.
   - **PDF** (`src/render/`) — pdf-lib vector renderer for the downloadable file.
4. **UI** (`src/main.ts`) — Orchestrator that wires the form, families, layout
   engine, and renderers together.

Shared utility: `src/tag-caption.ts` produces the human-readable tag label
used by both renderers.

Build: Vite 5 · TypeScript 5 (strict) · Vitest 2 · ESLint 9 · Node 20.

## File Map

### Source (`src/`)

| File | Role |
|------|------|
| `src/main.ts` | Application entry point and UI orchestrator: builds the HTML form with recursive sub-tag UI, reads form state, validates inputs, lazy-loads family mosaics, computes the layout plan, renders SVG previews, and triggers PDF download. |
| `src/families/family.ts` | Core abstractions: `Marker` (polymorphic draw), `BitGridMarker` (bit-grid impl), `MarkerProvider` (renderer seam), `Family` (catalogue + lifecycle), `FamilyGeometry` (static per-family shape). |
| `src/families/index.ts` | Module-level registry: instantiates one `MosaicFamily` per shipped family, exposes `getFamily` / `listFamilies` / `listFamilyNames` / `listFamiliesByGroup` / `isRecursiveFamily`. |
| `src/families/mosaic-bits.ts` | Pure helpers for the AprilTag mosaic format: `mosaicGrid`, `extractTagBits`, `circleOccupiedMask`, `applyCircleMask`, `outerRadiusModulesFor`. Decoupled from the family object model. |
| `src/families/mosaic-bits.test.ts` | Unit tests for mosaic-bits pure helpers: grid math, bit extraction from synthetic pixel buffers, circle masks, outer-radius measurement. |
| `src/families/mosaic-family.ts` | `MosaicFamily` (`Family` impl): fetches a PNG mosaic, decodes via 2D canvas, extracts + caches `BitGridMarker`s on demand. Replaces the old `load.ts`. |
| `src/families/mosaic-family.test.ts` | Unit tests for `MosaicFamily`: lifecycle (load idempotency, getMarker-before-load error), getMarker caching, RangeError on out-of-range id, circle-mask application. |
| `src/ids.ts` | Pure parser for tag-ID range specifications (e.g. "0-9, 12, 15-20"), producing an ordered array of integer IDs with validation. |
| `src/ids.test.ts` | Unit tests for `parseTagIdSpec`: single IDs, ranges, mixed input, whitespace, backwards ranges, duplicates, malformed tokens, and oversized ranges. |
| `src/layout/types.ts` | Domain types for the layout engine: `TagSpec`, `Paper`, `LayoutOptions` (including the `packingStrategy` choice), `Placement`, `CutSegment`, `CutCircle`, and `LayoutPlan` — all in millimetres with bottom-left origin. |
| `src/layout/plan.ts` | Layout planner: packs tags onto pages under the selected strategy (`grid` for squares, hexagonal close-packing for circles by default); computes placements, cut geometry, and page count. |
| `src/layout/plan.test.ts` | Unit tests for the layout planner: grid and hex capacity, cut-segment generation, circle-plan geometry, hex-lattice invariants, and `maxTagSizeForCount` bounds under each strategy. |
| `src/preview/svg.ts` | Thin wrapper around `compose.composePage` + `SvgCanvas` for the live preview: constructs an `SvgCanvas`, dispatches to `composePage` with a `MarkerProvider`, adds preview-only root `<svg>` chrome. |
| `src/preview/svg.test.ts` | Unit tests for SVG rendering: placeholder fallback, image rendering, XML escaping, colour/style invariants, registration marks, circle output, sub-tag overlays, and curved quiet-zone text. |
| `src/render/canvas.ts` | The `Canvas` interface used by `compose.composePage` and implemented by `SvgCanvas` and `PdfCanvas` (and, eventually, `PngCanvas`). Coordinate convention: millimetres, bottom-left origin. Stateless calls; style is per-call. |
| `src/render/svg-canvas.ts` | `SvgCanvas` backend (SVG-string builder) and `createDomRasterizer` (DOM-backed bit-grid → PNG data URI helper used by the live preview). |
| `src/render/pdf-canvas.ts` | `PdfCanvas` backend (pdf-lib-backed) and `embedPdfFonts` (pre-embeds the six StandardFonts so `drawText` can stay synchronous). |
| `src/render/pdf-pages.ts` | PDF-only page generators that don't go through `composePage`: calibration sheet, mirrored back-label sheet, and the small per-page footer. All emit through the shared `Canvas` interface. |
| `src/render/compose.ts` | Backend-agnostic renderer: walks one page of a `LayoutPlan` and calls `marker.draw(canvas, frame)` via `MarkerProvider`. Handles registration marks, recursive sub-tags (centre-block masking), quiet-zone captions, and cut lines/circles. |
| `src/render/bits-to-rgba.ts` | Pure helper: marker bit grid → RGBA pixel buffer (opaque black/white). Shared by `SvgCanvas`'s DOM rasteriser and, eventually, the PNG export backend. |
| `src/render/bits-to-rgba.test.ts` | Unit tests for `bitsToRgba`: black/white RGBA mapping, row ordering, buffer size. |
| `src/render/pdf.ts` | PDF orchestrator: embeds fonts, builds calibration sheet, then for every layout page constructs a `PdfCanvas` and dispatches to `composePage` with a `MarkerProvider` + footer/back-page. |
| `src/render/png-canvas.ts` | `PngCanvas` backend (HTMLCanvasElement 2D at configurable DPI); raster `drawBitGrid` via nearest-neighbour upscale of a 1-px-per-bit scratch canvas. Browser-only. |
| `src/render/compose-per-tag.ts` | Bare-marker renderer for per-tag SVG/PNG exports — draws a single marker via `marker.draw()` centred with optional quiet zone and caption. Shares the same `MarkerProvider` seam as `composePage`. |
| `src/export.ts` | Public download API: format × mode dispatch (pdf/svg/png × packed/per-tag), zip bundling via fflate. Takes a `MarkerProvider` and forwards it to composePage/composePerTag. |
| `src/export.test.ts` | Unit tests for `perTagFilenames` dedup and `runExport` with PDF packed / back-page / rejection of unsupported combinations. |
| `src/render/pdf.test.ts` | Unit tests for PDF rendering: round-trip parse validation, page sizing, placeholder rendering, back-page generation, circular quiet-zone labels, and subtag support. |
| `src/tag-caption.ts` | Shared utility producing the one-line tag identification string (e.g. "tag36h11 #5 · 40 mm") and a size formatter, consumed by both renderers. |
| `src/tag-caption.test.ts` | Unit tests for `formatTagSize` (decimal rounding) and `tagCaptionLine` (combined label output). |

### Root Configuration

| File | Role |
|------|------|
| `index.html` | Single-page HTML shell with full SEO meta (title, description, OG, Twitter, JSON-LD `SoftwareApplication`), favicon link, all CSS inlined, static `<header>` (h1 + tagline), `<main id="app">` mount point, and a static `<footer>` carrying explainer copy / supported-families list / author bio / related-links (all crawlable without JS). |
| `package.json` | NPM manifest: `pdf-lib` runtime dependency; Vite, Vitest, TypeScript, and ESLint as dev dependencies. Carries SEO/repo metadata (description, keywords, homepage, author, repository). |
| `README.md` | User-facing project description with features and USPs, plus developer Develop/Run/Deploy sections; also feeds GitHub-repo-page SEO. |
| `tsconfig.json` | TypeScript config: ES2022 target, strict mode, bundler module resolution, no emit. |
| `vite.config.ts` | Vite + Vitest config: GitHub Pages base path and Node test environment. |
| `eslint.config.js` | Flat ESLint config: recommended JS + typescript-eslint rules. |
| `.nvmrc` | Pins Node version to 20. |
| `.gitignore` | Ignores `node_modules/`, `dist/`, logs, `.vite/`, `coverage/`, `STYLES.md`, `.DS_Store`. |

### Scripts (`scripts/`)

| File | Role |
|------|------|
| `scripts/fetch-mosaics.ts` | One-shot Node script that downloads upstream `apriltag-imgs` mosaic PNGs into `public/resources/` and verifies geometry. |
| `scripts/perf-bench.ts` | Performance benchmark measuring layout planning, SVG rendering, and PDF rendering at various tag counts. |
| `scripts/dump-mosaic-region.py` | Python diagnostic: ASCII-dumps a pixel rectangle from a mosaic to inspect separator/tile structure. |
| `scripts/dump-mosaic-tile.py` | Python diagnostic: ASCII-dumps individual tiles from a mosaic to verify tile boundaries and content. |
| `scripts/measure-circle-geometry.py` | Python measurement: computes `outerRadius_modules` for circle families by scanning all valid tags in their mosaics. |

### Static Assets (`public/resources/`)

| File | Role |
|------|------|
| `public/resources/tag36h11_mosaic.png` | Mosaic PNG for tag36h11 (587 tags, 10×10 px tiles). |
| `public/resources/tagStandard41h12_mosaic.png` | Mosaic PNG for tagStandard41h12 (2115 tags, 9×9 px tiles). |
| `public/resources/tagStandard52h13_mosaic.png` | Mosaic PNG for tagStandard52h13 (48714 tags, 10×10 px tiles). |
| `public/resources/tagCustom48h12_mosaic.png` | Mosaic PNG for tagCustom48h12 (42211 tags, 10×10 px tiles). |
| `public/resources/tagCircle21h7_mosaic.png` | Mosaic PNG for tagCircle21h7 (38 tags, 9×9 px tiles). |
| `public/resources/tagCircle49h12_mosaic.png` | Mosaic PNG for tagCircle49h12 (65535 tags, 11×11 px tiles). |
| `public/robots.txt` | Allows all crawlers and points to the sitemap. |
| `public/sitemap.xml` | Single-URL sitemap for the site root; hand-maintained `lastmod`. |
| `public/favicon.svg` | Inline SVG mark suggesting an AprilTag bit-grid, used as the browser tab favicon. |
| `public/google60c6fb9354e060e4.html` | Google Search Console site-verification file. |

### Documentation (`docs/`)

| File | Role |
|------|------|
| `docs/superpowers/specs/2026-05-18-family-abstraction-design.md` | (Pre-Canvas-refactor) Architectural design spec for the family abstraction now implemented. The actual implementation diverged in Marker shape (polymorphic draw vs union) to accommodate non-bit-grid families. |
| `docs/superpowers/specs/2026-05-18-canvas-and-exports-design.md` | Architectural design spec: collapse the duplicated PDF and SVG drawing code behind a `Canvas` interface and add packed / per-tag SVG and PNG exports. |

### CI/CD

| File | Role |
|------|------|
| `.github/workflows/deploy.yml` | GitHub Actions pipeline: lint, test, build, deploy to GitHub Pages. |
