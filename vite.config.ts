/// <reference types="vitest" />
import { defineConfig } from "vitest/config";

// Project page on GitHub Pages: served from /<repo-name>/.
// Override at build time with VITE_BASE if the repo is renamed or served from root.
const base = process.env.VITE_BASE ?? "/AprilTagPDFGenerator/";

export default defineConfig({
  base,
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
