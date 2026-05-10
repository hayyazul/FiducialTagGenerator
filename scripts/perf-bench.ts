/**
 * Performance benchmarks for the AprilTag PDF generator.
 *
 * Measures layout planning, SVG preview rendering, and PDF rendering at
 * representative sizes (small page, full A4 fill, full tag36h11 family).
 *
 * Run with:   npx vite-node scripts/perf-bench.ts
 *
 * The SVG/PDF benches use a *synthetic* BitsProvider (a checkerboard) so the
 * numbers reflect rendering cost only, independent of mosaic decode time.
 * Decode time is measured separately by counting the bits in a fixed-size
 * synthetic mosaic.
 */
import { performance } from "node:perf_hooks";
import { planSmallTagLayout } from "../src/layout/plan";
import type { LayoutOptions, Paper, TagSpec } from "../src/layout/types";
import { renderPlanToSvg } from "../src/preview/svg";
import { renderPlan } from "../src/render/pdf";
import type { BitsProvider } from "../src/families";

const A4: Paper = { width_mm: 210, height_mm: 297 };
const OPTS: LayoutOptions = {
  pageMargin_mm: 10,
  quietZone_mm: 5,
  cutMargin_mm: 0.5,
};

// 8x8 bit grid for tag36h11 (6x6 data + 1-module border). Black/white
// checkerboard fills the same number of rectangles a real tag would draw.
const EDGE = 8;
const FAKE_BITS: boolean[][] = Array.from({ length: EDGE }, (_, r) =>
  Array.from({ length: EDGE }, (_, c) => ((r + c) & 1) === 0),
);

const BITS: BitsProvider = {
  bits(_family: string, _id: number) {
    return FAKE_BITS;
  },
};

function makeTags(n: number): TagSpec[] {
  return Array.from({ length: n }, (_, i) => ({ family: "tag36h11", id: i }));
}

interface Sample {
  mean: number;
  median: number;
  min: number;
  max: number;
}

async function bench(
  label: string,
  fn: () => unknown | Promise<unknown>,
  iterations = 10,
): Promise<Sample> {
  // warm up (one iter, discarded)
  await fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const median = samples[Math.floor(samples.length / 2)]!;
  const min = samples[0]!;
  const max = samples[samples.length - 1]!;
  console.log(
    `  ${label.padEnd(48)} median=${median.toFixed(2).padStart(7)}ms  ` +
      `mean=${mean.toFixed(2).padStart(7)}ms  ` +
      `min=${min.toFixed(2).padStart(7)}ms  max=${max.toFixed(2).padStart(7)}ms`,
  );
  return { mean, median, min, max };
}

async function run(): Promise<void> {
  console.log("\n=== layout planning ===");
  for (const n of [20, 200, 587]) {
    const tags = makeTags(n);
    const tagSize_mm = 40;
    await bench(`plan ${n} tags @ 40mm`, () => {
      planSmallTagLayout(tags, tagSize_mm, A4, OPTS);
    });
  }

  console.log("\n=== SVG preview render (per page) ===");
  for (const [n, label] of [
    [20, "20 tags (1 page)"],
    [200, "200 tags (~5 pages, render page 0)"],
    [587, "587 tags (~14 pages, render page 0)"],
  ] as Array<[number, string]>) {
    const tags = makeTags(n);
    const plan = planSmallTagLayout(tags, 40, A4, OPTS);
    await bench(`svg ${label}`, () => {
      renderPlanToSvg(plan, 0, BITS);
    });
  }

  console.log("\n=== SVG preview render (ALL pages, what UI does) ===");
  for (const n of [20, 200, 587]) {
    const tags = makeTags(n);
    const plan = planSmallTagLayout(tags, 40, A4, OPTS);
    await bench(`svg ALL pages, ${n} tags`, () => {
      let s = "";
      for (let p = 0; p < plan.pageCount; p++) s += renderPlanToSvg(plan, p, BITS);
      return s;
    });
  }

  // Worst case: lots of tiny tags packed onto ONE page. The black-bit count
  // (≈ rects emitted) is ~half of EDGE² per tag regardless of physical size,
  // so this is where the SVG string and the DOM subtree get huge.
  console.log("\n=== SVG preview render (MANY tags, ONE page) ===");
  const dense: LayoutOptions = { pageMargin_mm: 5, quietZone_mm: 0, cutMargin_mm: 0 };
  for (const [n, tagSize] of [
    [200, 8],
    [576, 4.5],
    [1000, 3],
    [2000, 2],
  ] as Array<[number, number]>) {
    const tags = makeTags(n);
    let plan;
    try {
      plan = planSmallTagLayout(tags, tagSize, A4, dense);
    } catch (e) {
      console.log(`  (skipped ${n} @ ${tagSize}mm: ${(e as Error).message})`);
      continue;
    }
    if (plan.pageCount !== 1) {
      console.log(`  (skipped ${n} @ ${tagSize}mm: needs ${plan.pageCount} pages, not 1)`);
      continue;
    }
    let svgLen = 0;
    const sample = await bench(`svg ${n} tags on 1 page (${tagSize}mm)`, () => {
      const s = renderPlanToSvg(plan, 0, BITS);
      svgLen = s.length;
      return s;
    });
    void sample;
    const rects = n * FAKE_BITS.flat().filter(Boolean).length;
    console.log(
      `    └─ ~${rects.toLocaleString()} <rect> elements, SVG string ${(svgLen / 1024).toFixed(0)} KB`,
    );
  }

  console.log("\n=== PDF render (front only) ===");
  for (const n of [20, 200, 587]) {
    const tags = makeTags(n);
    const plan = planSmallTagLayout(tags, 40, A4, OPTS);
    await bench(
      `pdf ${n} tags`,
      async () => {
        const bytes = await renderPlan(plan, BITS);
        return bytes.length;
      },
      5,
    );
  }

  console.log("\n=== PDF render (front + backside labels) ===");
  for (const n of [20, 200, 587]) {
    const tags = makeTags(n);
    const plan = planSmallTagLayout(tags, 40, A4, OPTS);
    await bench(
      `pdf+back ${n} tags`,
      async () => {
        const bytes = await renderPlan(plan, BITS, { printLabelsOnBack: true });
        return bytes.length;
      },
      5,
    );
  }

  console.log("\n=== PDF output sizes ===");
  for (const n of [20, 200, 587]) {
    const tags = makeTags(n);
    const plan = planSmallTagLayout(tags, 40, A4, OPTS);
    const front = await renderPlan(plan, BITS);
    const both = await renderPlan(plan, BITS, { printLabelsOnBack: true });
    console.log(
      `  ${n} tags`.padEnd(50) +
        `front=${(front.length / 1024).toFixed(1)}KB  ` +
        `front+back=${(both.length / 1024).toFixed(1)}KB`,
    );
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
