# Fiducial Tag Generator

Free, open, browser-based generator for fiducial markers. Pick a
family, choose a tag ID range and a physical size, and the tool packs as
many tags as fit per page — quiet zones, cut margins, and printable
boundaries computed correctly. Print-ready PDFs, PNGs, and SVGs are produced in the
browser; nothing is uploaded. Currently, AprilTags, ArUco, and CCTags are supported.

**Live site:** https://hayyazul.github.io/ArUcoCCTagAprilTagGenerator/

## Features

- Multiple families across various markers.
- **Recursive / nested tags** — embed a smaller tag inside another tag&rsquo;s
  center region for multi-scale detection.
- Hexagonal close-packing for circle families (~15% more tags per page
  than a square grid).
- Per-tag captions, optional back-side labels, optional in-quiet-zone
  labels, and a calibration sheet.

## Develop

Requires Node 20 (an `.nvmrc` is provided; if you use `nvm`, run
`nvm use` from the project root).

```sh
npm install      # one-time, after a fresh clone
npm test         # run unit tests once
npm run lint     # eslint
npm run build    # type-check + production build into dist/
```

### Run the app locally

```sh
npm run dev
```

This starts a development server with hot reload. Open the URL it prints
in your browser — by default that is:

    http://localhost:5173/ArUcoCCTagAprilTagGenerator/

The trailing `/ArUcoCCTagAprilTagGenerator/` matters: it matches the GitHub
Pages `base` path so local URLs behave the same as the deployed site.
Press `Ctrl+C` in the terminal to stop the server. Edit any source file
and the page will refresh automatically.

To preview the production build (the exact files GitHub Pages will
serve):

```sh
npm run build
npm run preview
```

## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`, which lints,
tests, builds, and publishes `dist/` to GitHub Pages. Enable Pages in the
repository settings with the source set to &ldquo;GitHub Actions&rdquo;.

The Vite `base` defaults to `/ArUcoCCTagAprilTagGenerator/` (matches the repo
name). Override with the `VITE_BASE` env var if the repo is renamed or
served from a custom domain root.

## Author

Built by Ayyaz Hassan, CS at UIUC and member of SIGRobotics@UIUC.
GitHub: [github.com/hayyazul](https://github.com/hayyazul).
