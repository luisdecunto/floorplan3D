# Planform

Planform turns ordinary floorplan files into a structured, multi-level 3D digital twin that can be reviewed and explored from desktop or mobile.

For a detailed description of the current image-analysis rules, confidence hierarchy, user corrections, and 3D generation mechanism, see [Planform V2: Rules and Processing Mechanism](docs/HOW_PLANFORM_WORKS.md).

This repository currently contains the first product vertical slice:

- image and document intake;
- lightweight floor-region proposals for separated plans;
- a responsive multi-level review workspace;
- metric scene entities for levels, walls and openings;
- a touch-enabled Three.js viewer with true door and window gaps;
- local project persistence and JSON backup;
- a mobile-accessible GitHub Pages deployment.

The trained semantic CV pipeline, arbitrary-geometry correction, scale calibration, and cross-device project sync are future milestones. The current project identifies its analyser as a browser-based geometry/topology fallback rather than presenting it as a trained model.

## Local development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Production checks:

```bash
npm run lint
npm run build
npm test
```

## Architecture

The browser currently owns image analysis, responsive review, local persistence, and derived 3D rendering. The canonical model stores editable building structure, not meshes. A future Python/GPU service can add semantic proposals without replacing the geometry/topology validator or the canonical document.

The website is built with React, TypeScript, React Three Fiber and Three.js. The same client application has two build targets while the hosting migration is in progress: vinext for the existing Sites deployment and a static Vite bundle for GitHub Pages.

## GitHub Pages

Build the static site locally with:

```bash
npm run validate:pages
```

The generated site lives in `pages-dist/`. GitHub Actions validates and deploys that directory on every push to `main`. The default project path is `/floorplan3D/`; set `PAGES_BASE_PATH=/` when moving to a custom domain.

## Regression fixtures

When present in a local checkout, user-supplied floorplans approved for internal product testing live in the Git-ignored `tests/fixtures/floorplans` directory. The local manifest records expected floor counts, arrangements, integrity hashes, and parsing challenges. These files are not repository or production assets, are excluded from deployment, and are not approved for model training or public redistribution.
