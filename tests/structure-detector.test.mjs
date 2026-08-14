import assert from "node:assert/strict";
import test from "node:test";
import { detectFloorStructure, structureToLevel } from "../app/structure-detector.ts";

function syntheticPlan() {
  const width = 240;
  const height = 190;
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  const rectangle = (x1, y1, x2, y2, value = 0) => {
    for (let y = Math.max(0, y1); y <= Math.min(height - 1, y2); y += 1) {
      for (let x = Math.max(0, x1); x <= Math.min(width - 1, x2); x += 1) {
        const index = (y * width + x) * 4;
        pixels[index] = value;
        pixels[index + 1] = value;
        pixels[index + 2] = value;
        pixels[index + 3] = 255;
      }
    }
  };
  const point = (x, y, radius = 1) => rectangle(Math.round(x) - radius, Math.round(y) - radius, Math.round(x) + radius, Math.round(y) + radius);

  rectangle(27, 22, 213, 28);
  rectangle(27, 25, 33, 165);
  rectangle(207, 25, 213, 165);
  rectangle(30, 127, 91, 133);
  rectangle(116, 127, 210, 133);
  rectangle(30, 77, 96, 82, 18);
  rectangle(121, 77, 210, 82, 18);
  rectangle(118, 25, 123, 80, 18);

  // Door leaves and swing arcs provide evidence independent of wall gaps.
  rectangle(90, 105, 92, 130, 35);
  rectangle(96, 78, 96, 103, 35);
  for (let angle = 0; angle <= Math.PI / 2; angle += 0.04) {
    point(91 + Math.cos(angle) * 25, 130 - Math.sin(angle) * 25, 0);
    point(96 + Math.sin(angle) * 25, 79 + Math.cos(angle) * 25, 0);
  }

  // A thin, three-sided rail beyond the bottom façade is balcony evidence.
  rectangle(38, 164, 202, 165, 25);
  return { pixels, width, height };
}

test("thick strokes, door evidence and an exterior rail become structure", () => {
  const { pixels, width, height } = syntheticPlan();
  const region = { id: "level-a", name: "First floor", x: 0, y: 0, width: 1, height: 1, confidence: 0.9, hasOutdoorArea: true };
  const structure = detectFloorStructure(pixels, width, height, region);
  const openings = structure.walls.flatMap((wall) => wall.openings);

  assert.ok(structure.walls.length >= 6, `expected at least 6 walls, received ${structure.walls.length}`);
  assert.ok(openings.some((opening) => opening.kind === "door"), "expected a door opening");
  assert.equal(structure.outdoorAreas.length, 1);
  assert.equal(structure.outdoorAreas[0].side, "bottom");
  assert.ok(structure.confidence >= 0.65);
});

test("detected pixel geometry is converted into a non-sample 3D level", () => {
  const { pixels, width, height } = syntheticPlan();
  const region = { id: "level-a", name: "First floor", x: 0, y: 0, width: 1, height: 1, confidence: 0.9, hasOutdoorArea: true };
  const structure = detectFloorStructure(pixels, width, height, region);
  structure.stairs = [{ id: "stair-test", runAxis: "vertical", x: 145, y: 38, width: 32, height: 70, stepCount: 9, confidence: 0.84 }];
  const level = structureToLevel(structure, region, 1);

  assert.equal(level.source, "detected");
  assert.equal(level.walls.length, structure.walls.length);
  assert.equal(level.outdoorAreas?.length, 1);
  assert.equal(level.stairs?.length, structure.stairs.length);
  assert.equal(level.elevation, 3.05);
  assert.ok(level.walls.every((wall) => wall.thickness && wall.thickness >= 0.1));
});
