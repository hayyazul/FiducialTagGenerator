import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { BitGridMarker, type MarkerProvider } from "./families";
import { perTagFilenames, runExport } from "./export";
import { planSmallTagLayout } from "./layout/plan";
import type { LayoutOptions, Paper, TagSpec } from "./layout/types";

const square100: Paper = { width_mm: 100, height_mm: 100 };
const minimalOpts: LayoutOptions = {
  pageMargin_mm: 5,
  quietZone_mm: 2,
  cutMargin_mm: 1,
};

const fakeMarker: MarkerProvider = {
  getMarker() {
    return new BitGridMarker(
      [
        [true, false, true, false],
        [false, true, false, true],
        [true, false, true, false],
        [false, true, false, true],
      ],
      "stub#0",
    );
  },
};

function makeTags(count: number): TagSpec[] {
  return Array.from({ length: count }, (_, i) => ({ family: "tag36h11", id: i }));
}

describe("perTagFilenames", () => {
  it("uses family-id as the basename for unique tags", () => {
    const plan = planSmallTagLayout(makeTags(3), 20, square100, minimalOpts);
    const names = perTagFilenames(plan).map((e) => e.name);
    expect(names).toEqual(["tag36h11-0", "tag36h11-1", "tag36h11-2"]);
  });

  it("appends a suffix to subsequent duplicates so zip entries don't collide", () => {
    const tags: TagSpec[] = [
      { family: "tag36h11", id: 0 },
      { family: "tag36h11", id: 0 },
      { family: "tag36h11", id: 1 },
      { family: "tag36h11", id: 0 },
    ];
    const plan = planSmallTagLayout(tags, 20, square100, minimalOpts);
    const names = perTagFilenames(plan).map((e) => e.name);
    expect(names).toEqual([
      "tag36h11-0",
      "tag36h11-0-2",
      "tag36h11-1",
      "tag36h11-0-3",
    ]);
  });
});

describe("runExport", () => {
  it("PDF packed mode produces a single .pdf blob that pdf-lib can parse", async () => {
    const plan = planSmallTagLayout(makeTags(4), 20, square100, minimalOpts);
    const result = await runExport({
      plan,
      markers: fakeMarker,
      format: "pdf",
      mode: "packed",
    });
    expect(result.filename).toBe("tags.pdf");
    expect(result.blob.type).toBe("application/pdf");
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBe(plan.pageCount + 1);
  });

  it("PDF packed mode passes printLabelsOnBack through to the renderer", async () => {
    const plan = planSmallTagLayout(makeTags(4), 20, square100, minimalOpts);
    const result = await runExport({
      plan,
      markers: fakeMarker,
      format: "pdf",
      mode: "packed",
      options: { printLabelsOnBack: true },
    });
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBe(1 + 2 * plan.pageCount);
  });

  it("rejects PDF + per-tag — that combination is intentionally unsupported", async () => {
    const plan = planSmallTagLayout(makeTags(2), 20, square100, minimalOpts);
    await expect(
      runExport({ plan, markers: fakeMarker, format: "pdf", mode: "per-tag" }),
    ).rejects.toThrow(/per-tag.*not supported.*PDF/i);
  });
});
