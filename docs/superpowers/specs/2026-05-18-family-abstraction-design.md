# Family Abstraction Refactor — Design Spec

**Date:** 2026-05-18
**Status:** Draft, awaiting review
**Branch:** `architecture-refactor-specs` (spec only); implementation branch TBD

## Context

The current family layer (`src/families/`) assumes every family is backed by
a PNG mosaic served from `public/resources/`. Adding ArUco support breaks
that assumption — ArUco dictionaries are large (up to 1000 markers), are
defined by a fixed bit table rather than an image, and several ArUco
dictionaries (`DICT_APRILTAG_*`) are aliases for AprilTag families OpenCV
already ships. Forcing all of these into the mosaic format is wasteful
(megabyte-scale PNG assets for things that fit in a few KB of code) and
dishonest (the asset is generated, not authored).

The existing layout, render, and preview code receives bit grids through
two slightly-different interfaces:

- `BitsProvider` (`src/families/index.ts:28`): `bits(family: string, id: number) → boolean[][] | null`. Caller passes family name and id; result is a bit grid or `null`.
- `FamilyBitmaps` (`src/families/load.ts:11`): `bits(id: number) → boolean[][] | null` plus `family`, `edge`, `totalTiles`. Per-family, returned from `loadFamily(name)`.

The two coexist because rendering wants a registry-style lookup (one provider
for all families) while loading is per-family. Both leak mosaic semantics: the
soft `null` return ("mosaic still loading, unknown family, id out of range")
makes sense for an async PNG fetch but is the wrong shape for a procedural
family where ids are either valid or invalid with no in-between state.

This spec describes the refactor that lets ArUco and any future
non-mosaic family slot in without special-casing — and incidentally cleans
up the current dual interface.

## Goals

1. A single `Family` interface that hides whether a family is mosaic-backed,
   procedurally generated, or proxied to another family.
2. Explicit, synchronous bit-grid access after an explicit async `load()`
   step. No more nullable "not ready yet" returns from the hot path.
3. Family registry remains a flat string-keyed lookup, unchanged from the
   UI's perspective. Adding ArUco adds rows to the registry; existing
   family names continue to work.
4. Renderer / layout / preview code no longer takes a `(familyName, id)`
   pair plus a separate provider — it takes a `Marker` (or a `Family` to
   pull markers from).
5. Per-tag and per-family caching consolidated behind the interface so
   call sites don't need to know which lookups are expensive.

## Non-goals

- ArUco implementation itself. This spec defines the seam; populating it
  with ArUco dictionaries is a follow-up branch that depends on this
  landing first.
- New families (RuneTag, CCTag, DL-based markers). Not on the roadmap;
  not designed against here. The interface is shaped so that adding them
  later would require widening `Marker` to a union, not redesigning the
  registry or lifecycle.
- Canvas / rendering refactor. That is a separate spec
  ([2026-05-18-canvas-and-exports-design.md](./2026-05-18-canvas-and-exports-design.md))
  and ships on its own schedule. The two refactors touch disjoint files
  apart from one shared concept (a `Marker` is what each family returns
  and what the canvas-lowering step consumes).
- UI changes. The family-picker dropdown and recursive-tag UI stay
  exactly as they are.

## Design

### Interfaces

```ts
/**
 * A marker family — AprilTag, ArUco dictionary, or anything else that
 * exposes a fixed-size catalog of markers indexed by integer id.
 *
 * Lifecycle: callers must `await family.load()` once before calling
 * `getMarker`. `load()` is idempotent and may be called concurrently;
 * the second call resolves to the same value as the first. After
 * `load()` resolves, `getMarker(id)` is synchronous and throws on
 * invalid input rather than returning null.
 */
interface Family {
  /** Stable identifier, matches the family-picker option value. */
  readonly name: string;

  /** UI grouping label (existing concept). */
  readonly group?: string;

  /** Number of valid marker ids in this family. Ids are 0..count-1. */
  readonly count: number;

  /**
   * Static metadata describing every marker in this family. All markers
   * in a family share these properties — bit-grid edge length, outer
   * shape (square / circle), and the recursive-tag center-block region
   * when applicable.
   */
  readonly geometry: FamilyGeometry;

  /** Idempotent. Resolves once the family is ready for synchronous use. */
  load(): Promise<void>;

  /**
   * Marker bits for `id`. Throws `RangeError` if `id < 0 || id >= count`.
   * Throws `Error` if called before `load()` resolves.
   */
  getMarker(id: number): Marker;
}

interface FamilyGeometry {
  /** Edge length of the bit grid in cells (the "tile size" today). */
  readonly edge: number;

  /**
   * Reference length on which the user-visible "Tag size" input is
   * applied. Distance between detection corners, in cells. Matches
   * today's widthAtBorder_modules.
   */
  readonly widthAtBorder: number;

  /** Cut shape around each marker. */
  readonly outerShape: "square" | "circle";

  /**
   * Required when `outerShape === "circle"`. Radius in cells of the
   * smallest circle centered on the tile that encloses every printed
   * black pixel across any valid marker in the family.
   */
  readonly outerRadiusCells?: number;

  /**
   * Present iff this family supports embedded sub-markers. Identifies
   * the always-black center block where a sub-tag can be placed.
   */
  readonly centerBlock?: { row: number; col: number; size: number };
}

/**
 * A single marker. Today this is always a bit grid because every
 * supported and planned family (AprilTag, ArUco) is a bit-grid family.
 * If a non-bit-grid family (dot-pattern, freeform vector) is ever
 * added, this becomes a discriminated union with `kind: "bit-grid"`
 * vs `kind: "vector"` etc. — at that point every callsite that
 * inspects bits gets a compile error and must handle the new variant.
 *
 * For now: type alias with no discriminator. No abstraction tax.
 */
type Marker = BitGrid;

interface BitGrid {
  /** True = printed (black) cell, false = white. Row 0 is the top row. */
  readonly bits: readonly (readonly boolean[])[];
  /** Convenience: `bits.length`. Always equals the family's `geometry.edge`. */
  readonly edge: number;
}
```

### Registry

A single module-level registry, replacing the current `FAMILIES` record
in `src/families/index.ts`:

```ts
// src/families/registry.ts
export function getFamily(name: string): Family | undefined;
export function listFamilies(): Family[]; // iteration order = display order
export function listFamilyNames(): string[];
export function listFamiliesByGroup(): Map<string, Family[]>;
```

The registry is constructed at module load by instantiating each `Family`
implementation. Instantiation is cheap — it does **not** trigger
`load()`. The UI calls `load()` on demand when a family is first
selected (matches today's behavior).

### Family implementations

Three implementations cover all planned families. Each is a class (or
factory returning a closure) that satisfies the `Family` interface.

#### 1. `MosaicFamily`

For AprilTag families and any ArUco dictionary that's easier to ship as a
mosaic than as a bit table. Wraps today's `loadFamily` flow:

- Constructor takes the static metadata (`name`, `count`, `geometry`,
  `mosaicPath`).
- `load()` fetches the PNG, decodes via 2D canvas to a grayscale
  `Uint8Array`, and caches it. Second `load()` returns the same resolved
  promise.
- `getMarker(id)` extracts the tag's cells from the cached pixel buffer
  using today's `extractTagBits` + `applyOccupiedMask` (unchanged), and
  caches the result.
- Throws `RangeError` on out-of-range id, `Error` if called before load.

Today's `tag36h11`, `tagStandard41h12`, `tagStandard52h13`,
`tagCustom48h12`, `tagCircle21h7`, `tagCircle49h12` are all
`MosaicFamily` instances after the refactor.

#### 2. `ProceduralFamily`

For ArUco dictionaries that are defined by fixed bit tables. The
"mosaic" in this case is a compile-time TypeScript constant array of
bit grids (or packed bits) baked into the bundle.

- Constructor takes `name`, `count`, `geometry`, and a synchronous
  `generate(id) → boolean[][]` function.
- `load()` resolves immediately with no work. (The bit table is already
  in the bundle.) The async signature is retained for interface
  uniformity.
- `getMarker(id)` calls `generate(id)`, caches the result, returns the
  bit grid. Throws as for `MosaicFamily`.

The bit table itself is generated **once, offline**, by a script in
`scripts/` that pulls from a known-correct source (OpenCV's predefined
dictionary tables) and emits a TypeScript module under
`src/families/aruco-data/`. The script lives in version control; its
output is checked in so the build doesn't depend on network access. See
"Open questions" for the data-source decision.

#### 3. `AliasFamily`

For ArUco dictionaries that are byte-for-byte equivalent to existing
AprilTag families (e.g. OpenCV's `DICT_APRILTAG_36h11` is `tag36h11`).
Wraps another `Family`:

- Constructor takes `name` (the alias's display name, e.g.
  `"DICT_APRILTAG_36h11"`) and a reference to the underlying family.
- `load()`, `getMarker`, `count`, `geometry` all delegate.

This avoids duplicating mosaic data or maintaining two copies of the
same bit table.

### Lifecycle in the UI

Today, `src/main.ts` calls `loadFamily(name)` lazily whenever a family
is selected. The refactor keeps that pattern:

```ts
const family = getFamily(selectedName);
if (!family) throw new Error(`unknown family: ${selectedName}`);
await family.load();
// from here, family.getMarker(id) is sync
```

The UI never holds a global "loaded families" map — each `Family`
instance owns its own readiness state. Multiple `load()` calls from
different code paths are safe (idempotent).

### Migration of existing consumers

The current `BitsProvider` interface (`bits(family, id) → boolean[][] | null`)
is consumed by `src/preview/tag-images.ts:42` and indirectly by the
preview SVG builder. After the refactor:

- The preview takes a `Family` (or a `Map<name, Family>` for recursive
  rendering, where a sub-tag may use a different family). It calls
  `family.getMarker(id).bits` instead of `provider.bits(name, id)`.
- The `null` return for "still loading" goes away — the UI gates rendering
  on `await family.load()` before kicking off the preview.
- The `null` return for "id out of range" becomes a `RangeError` thrown
  by `getMarker`. Callers either validate first (the UI's `parseTagIdSpec`
  already enforces ranges) or wrap in try/catch where soft failure is
  desired (placeholder rendering for an explicitly-bad id).

PDF and SVG renderers currently call into `BitsProvider` indirectly
through the preview's `TagImageProvider` (PNG data URIs) for the preview
path, and through pure `boolean[][]` arguments for the PDF path. After
the refactor:

- PDF renderer takes `Family` instances and calls `getMarker(id).bits`
  directly.
- Preview's `TagImageProvider` is rebuilt around `Family` rather than
  `BitsProvider`.

Both old interfaces (`BitsProvider`, `FamilyBitmaps`) are removed.

### Caching

Caching collapses to one layer **inside** each family implementation:

- `MosaicFamily` caches the decoded mosaic pixel buffer (one per family,
  unbounded — it's KB-scale) and the extracted bit grid per id (Map keyed
  by id, unbounded — each grid is < 1KB and the worst-case family,
  `tagCustom48h12`, is 42k tags × ~600 bytes = 25MB if fully populated,
  which never happens in practice because the user prints a handful at a
  time).
- `ProceduralFamily` caches generated bit grids per id (same shape).
- `AliasFamily` doesn't cache; it delegates.

No global cache in any consumer. The renderer asks for a marker each time
it draws; the family answers from its internal Map.

If the per-id cache memory ever becomes a concern (it won't at current
scale), an LRU cap can be added behind the interface without changing
the contract. Designed for that, not implemented now.

### Error handling

Per CLAUDE.md "Fail loudly on invalid input":

| Call | Bad input | Behavior |
|------|-----------|----------|
| `getFamily(name)` | unknown name | returns `undefined` (existing behavior — caller handles) |
| `family.load()` | network error (mosaic) | rejects the returned promise with the underlying error |
| `family.load()` | call concurrently | safe; both callers resolve to the same value |
| `family.getMarker(id)` | `id < 0` or `id >= count` | throws `RangeError` naming the family and the offending id |
| `family.getMarker(id)` | called before `load()` resolves | throws `Error` instructing the caller to await `load()` first |

No silent `null` returns, no silent clamping, no auto-load-on-getMarker
(would couple async into the hot rendering path).

## Files changed

| File | Change |
|------|--------|
| `src/families/index.ts` | Demoted to a re-export shim during transition; eventually deleted. Pure helpers (`mosaicGrid`, `extractTagBits`, `circleOccupiedMask`, `applyOccupiedMask`, `outerRadiusModulesFor`) move to `src/families/mosaic-bits.ts` so `MosaicFamily` can import them. |
| `src/families/registry.ts` | New. Module-level registry; instantiates each `Family` at import time. |
| `src/families/family.ts` | New. The `Family`, `Marker`, `BitGrid`, `FamilyGeometry` types. |
| `src/families/mosaic.ts` | New. `MosaicFamily` class — replaces today's `load.ts` decode flow. |
| `src/families/procedural.ts` | New. `ProceduralFamily` class — used by ArUco follow-up. Empty of data in this refactor's PR; ArUco bit tables land in the follow-up. |
| `src/families/alias.ts` | New. `AliasFamily` class — used by ArUco follow-up. |
| `src/families/load.ts` | Deleted. Its functionality moves to `mosaic.ts`. |
| `src/families/mosaic-bits.ts` | New. Pure bit-extraction helpers, currently sitting in `index.ts`. Unit tests follow (`mosaic-bits.test.ts` from today's `index.test.ts`). |
| `src/preview/tag-images.ts` | Rewritten to take `Family` instead of `BitsProvider`. Caching behavior unchanged. |
| `src/preview/svg.ts` | `TagImageProvider` consumer updates to match. |
| `src/render/pdf.ts` | Consumers of bit grids switch from `BitsProvider` calls to `family.getMarker(id).bits`. |
| `src/main.ts` | `loadFamily(name)` calls become `getFamily(name); await family.load()`. Sub-tag handling updated to pass `Family` instances down. |
| `src/families/index.test.ts` | Renames to `mosaic-bits.test.ts` for the pure helpers. New `mosaic.test.ts` covers `MosaicFamily` lifecycle (load, getMarker, error cases). |

### Files NOT changed by this refactor

- `src/layout/` (plan + types) — speaks in `Placement` and `TagSpec`,
  doesn't care about families directly.
- `src/ids.ts` — pure id-range parser.
- `src/tag-caption.ts` — pure formatter.
- All `public/resources/*.png` mosaics — still consumed by `MosaicFamily`,
  paths unchanged.

## Testing

| Layer | Test type | Notes |
|-------|-----------|-------|
| `mosaic-bits.ts` pure helpers | Existing unit tests, renamed file | No behavior change. |
| `MosaicFamily` | New unit tests | Loads a tiny synthesized mosaic via a stub `fetch`/canvas; verifies lifecycle, getMarker, error cases. |
| `ProceduralFamily` | New unit tests | Trivial — register a family with a known generator, assert getMarker returns the expected grid. |
| `AliasFamily` | New unit tests | Wrap a stub family; assert delegation. |
| Registry | New unit tests | listFamilies, getFamily, name uniqueness, group ordering. |
| Renderer round-trip | Existing PDF and SVG tests | Must continue to pass with no change in output. This is the regression net for the refactor. |

The renderer tests are the load-bearing regression check — if the bit
grids flowing through the new interface match what the old interface
produced (and they must, byte for byte, since the underlying mosaic
extraction is unchanged), every existing snapshot and round-trip test
continues to pass without modification. **Acceptance criterion: all 109
existing tests pass with zero changes to their expected outputs.**

## Verification before opening a PR

1. `npm test` — all existing tests pass; new tests pass.
2. `npm run lint` — clean.
3. `npm run build` — clean.
4. `npm run dev` — manually verify each existing family still renders
   correctly in the preview, including the recursive `tagCustom48h12`
   nested case.
5. Spot-check a PDF download for each family — visual diff against a
   pre-refactor build.

## Implementation order (within the family-abstraction PR)

This sub-sequence keeps the working tree green throughout:

1. Introduce `family.ts` (types only) and `mosaic-bits.ts` (extracted
   pure helpers). Existing code still works via the re-export shim in
   `index.ts`.
2. Implement `MosaicFamily` and `registry.ts`. Wire them up alongside
   the existing `loadFamily` / `FAMILIES` — both paths active.
3. Migrate `tag-images.ts`, `svg.ts`, `pdf.ts`, `main.ts` to the new
   interface one consumer at a time. After each migration, run tests.
4. Delete `load.ts`, `BitsProvider`, and the old `FAMILIES` object.
   Final test run.
5. Add `ProceduralFamily` and `AliasFamily` (empty of data — they exist
   to be filled in by the ArUco branch).

## Open questions

These need user input before implementation starts.

1. **ArUco bit table source.** Three options:
   - **Extract from OpenCV** (`cv2.aruco.getPredefinedDictionary` →
     `bytesList` → checked-in TS array). Faithful to the canonical
     source. Requires Python + opencv-contrib for the one-time generation
     script.
   - **Re-derive from polynomial / construction algorithm**. ArUco
     dictionaries are mathematically defined; we could regenerate them.
     Requires getting the construction code exactly right; risk of
     subtle ID-mapping divergence from OpenCV.
   - **Hybrid**: extract, but include a `scripts/verify-aruco.ts` that
     re-derives and asserts equality. Belt-and-braces.

   **Recommendation:** option 1 (extract from OpenCV) for the first ArUco
   PR; defer hybrid until / unless we see issues. This is an
   ArUco-branch decision, not strictly part of this spec — flagged here
   because it affects how `ProceduralFamily` is used.

2. **Family naming for ArUco aliases.** OpenCV calls them
   `DICT_APRILTAG_36h11`. We could:
   - Expose two registry entries (`tag36h11` and `DICT_APRILTAG_36h11`)
     pointing at the same underlying mosaic via `AliasFamily`.
   - Expose one entry and document the alias relationship in the UI.

   **Recommendation:** option 1 — separate entries — so users searching
   the family picker for `DICT_APRILTAG_*` find them. Costs nothing
   thanks to `AliasFamily`.

3. **`getMarker` return: shared reference vs copy.** The current code
   returns the cached bit grid by reference. The new contract should
   either (a) document that the returned grid is read-only and callers
   must not mutate it (`readonly` types enforce this at compile time), or
   (b) return a defensive copy. **Recommendation:** option (a) — readonly
   types — zero copies, no allocation churn.

4. **Test coverage for the renderer migration.** Beyond the existing 109
   tests, do we want a one-off "byte-for-byte equivalence" test that
   runs both the old and new path against the same family/id and
   asserts equal bit grids — kept around as a transition test and
   deleted once the old path is gone? **Recommendation:** yes, but only
   committed in step 3 of the implementation order and removed in step 4.
   Costs ~30 minutes to write, catches anything sneaky.

## Follow-ups (separate branches)

1. **ArUco implementation** — depends on this landing first. Populates
   `ProceduralFamily` with one entry per `DICT_NxN_K` dictionary,
   `AliasFamily` for each `DICT_APRILTAG_*` variant, updates the family
   picker. Updates the SEO copy in `index.html` to reflect what's
   actually shipped.

2. **Canvas + exports refactor** — independent of this; see
   [2026-05-18-canvas-and-exports-design.md](./2026-05-18-canvas-and-exports-design.md).
