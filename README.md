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

The website is built with React, TypeScript, vinext, React Three Fiber and Three.js. Hosting metadata lives in `.openai/hosting.json`.

## Regression fixtures

User-supplied floorplans that are approved for internal product testing live in `tests/fixtures/floorplans`. The manifest records the expected number and arrangement of plan regions, integrity hashes, and known parsing challenges. These files are not production assets, are excluded from the deployed website bundle, and are not approved for model training or public redistribution.
