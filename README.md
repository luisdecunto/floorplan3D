# Planform

Planform turns ordinary floorplan files into a structured, multi-level 3D digital twin that can be reviewed and explored from desktop or mobile.

This repository currently contains the first product vertical slice:

- image and document intake;
- lightweight floor-region proposals for separated plans;
- a responsive multi-level review workspace;
- metric scene entities for levels, walls and openings;
- a touch-enabled Three.js viewer with true door and window gaps;
- a private, mobile-accessible Sites deployment configuration.

The production CV pipeline, geometric correction editor, scale calibration service and persistent project storage are the next milestones. The interface identifies sample geometry honestly until that backend is connected.

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

The browser owns responsive review and derived 3D rendering. The canonical model stores metric building structure, not meshes. Later, uploaded source documents will be processed by a separate Python/GPU service and returned as editable level, wall, opening and room proposals.

The website is built with React, TypeScript, React Three Fiber and Three.js. The same client application has two build targets while the hosting migration is in progress: vinext for the existing Sites deployment and a static Vite bundle for GitHub Pages.

## GitHub Pages

Build the static site locally with:

```bash
npm run validate:pages
```

The generated site lives in `pages-dist/`. GitHub Actions validates and deploys that directory on every push to `main`. The default project path is `/floorplan3D/`; set `PAGES_BASE_PATH=/` when moving to a custom domain.

## Regression fixtures

When present in a local checkout, user-supplied floorplans approved for internal product testing live in the Git-ignored `tests/fixtures/floorplans` directory. The local manifest records expected floor counts, arrangements, integrity hashes, and parsing challenges. These files are not repository or production assets, are excluded from deployment, and are not approved for model training or public redistribution.
