# STRUCTURE.md

## Architecture

A static, client-side TypeScript web app (Vite + pdf-lib) that generates
printable PDFs of AprilTags. Four layers, each with a single responsibility:

1. **Families** (`src/families/`) — Tag family registry and mosaic bitmap
   loading. Pure data definitions plus a browser-side PNG decoder.
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
| `src/families/index.ts` | Tag family registry defining all supported families with their mosaic paths and geometry, plus pure functions for mosaic grid calculation, bit extraction, and circle masks. |
| `src/families/load.ts` | Browser-side mosaic loader: fetches a family's PNG, decodes it via canvas into grayscale pixels, and returns a `FamilyBitmaps` object with per-tag-id bit-grid lookup. |
| `src/families/index.test.ts` | Unit tests for family registry functions: mosaic grid math, bit extraction, circle masks, occupied-mask application, and outer-radius measurement. |
| `src/ids.ts` | Pure parser for tag-ID range specifications (e.g. "0-9, 12, 15-20"), producing an ordered array of integer IDs with validation. |
| `src/ids.test.ts` | Unit tests for `parseTagIdSpec`: single IDs, ranges, mixed input, whitespace, backwards ranges, duplicates, malformed tokens, and oversized ranges. |
| `src/layout/types.ts` | Domain types for the layout engine: `TagSpec`, `Paper`, `LayoutOptions` (including the `packingStrategy` choice), `Placement`, `CutSegment`, `CutCircle`, and `LayoutPlan` — all in millimetres with bottom-left origin. |
| `src/layout/plan.ts` | Layout planner: packs tags onto pages under the selected strategy (`grid` for squares, hexagonal close-packing for circles by default); computes placements, cut geometry, and page count. |
| `src/layout/plan.test.ts` | Unit tests for the layout planner: grid and hex capacity, cut-segment generation, circle-plan geometry, hex-lattice invariants, and `maxTagSizeForCount` bounds under each strategy. |
| `src/preview/svg.ts` | SVG preview renderer: converts one page of a `LayoutPlan` to an SVG string with tag images, cut lines/circles, registration marks, curved or linear captions, and sub-tag overlays. |
| `src/preview/svg.test.ts` | Unit tests for SVG rendering: placeholder fallback, image rendering, XML escaping, colour/style invariants, registration marks, circle output, sub-tag overlays, and curved quiet-zone text. |
| `src/preview/tag-images.ts` | Tag bitmap rasteriser: converts bit grids into 1-pixel-per-bit PNG data URIs via an offscreen canvas, caching results for the preview. |
| `src/preview/tag-images.test.ts` | Unit tests for `bitsToRgba`: black/white RGBA mapping and correct row ordering. |
| `src/render/pdf.ts` | PDF renderer: converts a `LayoutPlan` into a multi-page PDF with calibration sheet, vector-drawn tags, cut lines/circles, registration marks, curved or linear captions, back labels, and page footers. |
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
| `docs/code-smells.md` | Living list of code smells noticed during development with locations and rationale. |
| `docs/superpowers/specs/2026-05-17-circular-tags-design.md` | Architectural design spec for circular AprilTag family support. |

### CI/CD

| File | Role |
|------|------|
| `.github/workflows/deploy.yml` | GitHub Actions pipeline: lint, test, build, deploy to GitHub Pages. |
