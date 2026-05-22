/**
 * Single source of truth for the published site's identity.
 *
 * Renaming the GitHub repo (which moves the GitHub Pages URL) should only
 * require editing `owner` / `repo` here. Vite's plugin (see
 * `vite.config.ts`) substitutes the derived URLs into `index.html` at
 * dev/build time and generates `dist/sitemap.xml` during `vite build`.
 *
 * Two files are not derived from this and must be edited by hand when the
 * repo is renamed: `package.json` (`homepage`, `repository.url`) and
 * `README.md`. They are read by npm and by GitHub respectively, not by
 * Vite, so a build-time placeholder doesn't help them.
 */
export const owner = "hayyazul";
export const repo = "apriltag-generator";

export const repoUrl = `https://github.com/${owner}/${repo}`;
export const siteUrl = `https://${owner}.github.io/${repo}/`;
export const basePath = `/${repo}/`;
