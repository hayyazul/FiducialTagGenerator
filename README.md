# AprilTag PDF Generator

Static, client-side web app that generates printable PDFs of AprilTags. No
backend; everything runs in the browser. Deployed to GitHub Pages from the
`main` branch via GitHub Actions.

See `CLAUDE.md` for the detailed design and the three-part build plan.

## Develop

Requires Node 20 (an `.nvmrc` is provided).

```sh
npm install
npm run dev      # local dev server with HMR
npm test         # run unit tests once
npm run lint     # eslint
npm run build    # type-check + production build into dist/
```

## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`, which lints,
tests, builds, and publishes `dist/` to GitHub Pages. Enable Pages in the
repository settings with the source set to "GitHub Actions".

The Vite `base` defaults to `/AprilTagPDFGenerator/` (matches the repo
name). Override with the `VITE_BASE` env var if the repo is renamed or
served from a custom domain root.
