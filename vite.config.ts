/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import type { PluginOption } from "vite";
import { basePath, repoUrl, siteUrl } from "./site.config";

// Project page on GitHub Pages: served from /<repo-name>/.
// Override at build time with VITE_BASE if the repo is served from root.
const base = process.env.VITE_BASE ?? basePath;

/** Today's date as YYYY-MM-DD, for the sitemap's <lastmod>. */
function today_iso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Substitute `{{SITE_URL}}` / `{{REPO_URL}}` in `index.html` (dev + build)
 *  and emit a fresh `sitemap.xml` into `dist/` at build time. Both pull
 *  their values from `site.config.ts` — renaming the repo is a one-field
 *  edit there. */
function siteIdentityPlugin(): PluginOption {
  return {
    name: "site-identity",
    transformIndexHtml(html: string) {
      return html
        .replace(/\{\{SITE_URL\}\}/g, siteUrl)
        .replace(/\{\{REPO_URL\}\}/g, repoUrl);
    },
    generateBundle() {
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        `  <url>\n` +
        `    <loc>${siteUrl}</loc>\n` +
        `    <lastmod>${today_iso()}</lastmod>\n` +
        `    <changefreq>monthly</changefreq>\n` +
        `    <priority>1.0</priority>\n` +
        `  </url>\n` +
        `</urlset>\n`;
      this.emitFile({ type: "asset", fileName: "sitemap.xml", source: xml });
    },
  };
}

export default defineConfig({
  base,
  plugins: [siteIdentityPlugin()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
