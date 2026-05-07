# AprilTag PDF Generator

Static, client-side web app that generates printable PDFs of AprilTags. No
backend; everything runs in the browser. Deployed to GitHub Pages from the
`main` branch via GitHub Actions.

See `CLAUDE.md` for the detailed design and the three-part build plan.

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

    http://localhost:5173/AprilTagPDFGenerator/

The trailing `/AprilTagPDFGenerator/` matters: it matches the GitHub
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
repository settings with the source set to "GitHub Actions".

The Vite `base` defaults to `/AprilTagPDFGenerator/` (matches the repo
name). Override with the `VITE_BASE` env var if the repo is renamed or
served from a custom domain root.
