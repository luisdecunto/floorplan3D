# Floorplan regression fixtures

This directory contains representative floorplans supplied for internal Planform testing. `manifest.json` is the source of truth for expected floor counts and known visual challenges.

Important handling rules:

- use the images only for development and regression testing;
- do not use them for model training;
- do not redistribute them publicly without confirming their provenance and rights;
- do not copy them into `public/` or the deployed bundle;
- preserve the original pixels so the SHA-256 checks remain useful.

The first fixture contains two vertically stacked floors. The second contains two side-by-side floors. The other five contain one floor each and cover clutter, furniture, low plan-to-canvas ratios, outside annotations, and brochure layouts.
