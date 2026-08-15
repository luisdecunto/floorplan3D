import assert from "node:assert/strict";
import test from "node:test";
import { buildStairConnections, sceneFootprint, slabPieces, slabPieceTextureUv, stairwellOpening } from "../app/scene-geometry.ts";
import { alignAdjacentStairStructures, detectFloorStructure, expandDetectedStairReturn, structureToLevel } from "../app/structure-detector.ts";

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

function rotatePlan({ pixels, width, height }, degrees) {
  const rotated = new Uint8ClampedArray(width * height * 4).fill(255);
  const radians = degrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - centerX;
      const dy = y - centerY;
      const sourceX = Math.round(centerX + dx * cosine + dy * sine);
      const sourceY = Math.round(centerY - dx * sine + dy * cosine);
      if (sourceX < 0 || sourceX >= width || sourceY < 0 || sourceY >= height) continue;
      const sourceIndex = (sourceY * width + sourceX) * 4;
      const destinationIndex = (y * width + x) * 4;
      rotated[destinationIndex] = pixels[sourceIndex];
      rotated[destinationIndex + 1] = pixels[sourceIndex + 1];
      rotated[destinationIndex + 2] = pixels[sourceIndex + 2];
      rotated[destinationIndex + 3] = pixels[sourceIndex + 3];
    }
  }
  return { pixels: rotated, width, height };
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

test("walls and swing-door symbols survive a rotated source plan", () => {
  const { pixels, width, height } = rotatePlan(syntheticPlan(), 11);
  const region = { id: "level-rotated", name: "Rotated plan", x: 0, y: 0, width: 1, height: 1, confidence: 0.9, hasOutdoorArea: true };
  const structure = detectFloorStructure(pixels, width, height, region);
  const symbolDoors = structure.walls
    .flatMap((wall) => wall.openings)
    .filter((opening) => opening.kind === "door" && opening.evidence === "symbol");

  assert.ok(Math.abs(Math.abs(structure.sourceRotationDegrees ?? 0) - 11) <= 2, `expected about 11° correction, received ${structure.sourceRotationDegrees}`);
  assert.ok(structure.walls.length >= 6, `rotated plan should retain its wall network; received ${structure.walls.length}`);
  assert.ok(symbolDoors.length >= 1, "a rotated swing glyph should still be recognized as a symbol-supported door");
});

test("a thin dimension line cannot extend a real partition across an open room", () => {
  const width = 240;
  const height = 190;
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  const rectangle = (x1, y1, x2, y2, value = 0) => {
    for (let y = y1; y <= y2; y += 1) {
      for (let x = x1; x <= x2; x += 1) {
        const index = (y * width + x) * 4;
        pixels[index] = value;
        pixels[index + 1] = value;
        pixels[index + 2] = value;
        pixels[index + 3] = 255;
      }
    }
  };

  rectangle(25, 20, 215, 26);
  rectangle(25, 20, 31, 168);
  rectangle(209, 20, 215, 168);
  rectangle(25, 162, 215, 168);
  rectangle(28, 77, 95, 83);
  rectangle(96, 80, 210, 80); // collinear measurement line, not structure

  const region = { id: "level-a", name: "First floor", x: 0, y: 0, width: 1, height: 1, confidence: 0.9 };
  const structure = detectFloorStructure(pixels, width, height, region);
  const partition = structure.walls.find((wall) => (
    wall.axis === "horizontal"
    && Math.abs(wall.start[1] - 80) <= 4
    && wall.start[0] <= 35
  ));

  assert.ok(partition, "the genuine thick partition should remain detected");
  assert.ok(partition.end[0] <= 100, `dimension line must be trimmed; received end x=${partition.end[0]}`);
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
  assert.ok(Math.abs(
    level.outdoorAreas[0].z - level.outdoorAreas[0].depth / 2 - level.slab.depth / 2,
  ) < 0.0001, "balcony should be attached to the outside slab edge");
  assert.equal(level.stairs?.length, structure.stairs.length);
  assert.equal(level.elevation, 3.05);
  assert.ok(level.walls.every((wall) => wall.thickness && wall.thickness >= 0.1));
  const footprint = sceneFootprint([level]);
  assert.equal(footprint.maxZ, level.outdoorAreas[0].z + level.outdoorAreas[0].depth / 2);
  assert.ok(footprint.centerZ > level.slab.z, "viewer framing should include the exterior platform");
});

test("adjacent floors share the upper-floor stair shaft in analyser coordinates", () => {
  const lower = {
    regionId: "lower",
    sourceWidth: 320,
    sourceHeight: 620,
    walls: [],
    outdoorAreas: [],
    stairs: [{ id: "lower-stair", runAxis: "vertical", x: 168, y: 348, width: 45, height: 83, stepCount: 16, confidence: 0.78 }],
    footprint: { x: 52, y: 356, width: 226, height: 184 },
    roomCount: 0,
    confidence: 0.8,
    diagnostics: { threshold: 0, wallThickness: 6, geometryVotes: 0, topologyVotes: 0, openingVotes: 0, stairVotes: 1 },
  };
  const upper = {
    ...lower,
    regionId: "upper",
    stairs: [{ id: "upper-stair", runAxis: "vertical", x: 139, y: 16, width: 53, height: 74, stepCount: 12, confidence: 0.82 }],
    footprint: { x: 52, y: 23, width: 226, height: 186 },
  };
  const regions = [
    { id: "lower", name: "Ground floor", x: 0, y: 0.5, width: 1, height: 0.5, confidence: 0.8 },
    { id: "upper", name: "First floor", x: 0, y: 0, width: 1, height: 0.5, confidence: 0.8 },
  ];
  const aligned = alignAdjacentStairStructures(regions, { lower, upper });
  const lowerBox = aligned.lower.stairs[0];
  const upperBox = aligned.upper.stairs[0];
  const lowerCenter = (lowerBox.x + lowerBox.width / 2 - lower.footprint.x) / lower.footprint.width;
  const upperCenter = (upperBox.x + upperBox.width / 2 - upper.footprint.x) / upper.footprint.width;
  assert.ok(Math.abs(lowerCenter - upperCenter) < 0.0001);
  assert.ok(Math.abs(lowerBox.width / lower.footprint.width - upperBox.width / upper.footprint.width) < 0.0001);
});

test("a right-hand flight expands left across connected return-flight evidence", () => {
  const width = 240;
  const height = 190;
  const mask = new Uint8Array(width * height);
  const point = (x, y) => { mask[y * width + x] = 1; };
  // Two short curved/winder traces continue from the detected flight toward
  // the building centre without forming a solid wall column.
  for (let x = 104; x <= 130; x += 1) {
    const progress = (130 - x) / 26;
    point(x, Math.round(63 + progress * 14));
    point(x, Math.round(83 - progress * 10));
  }
  const stair = { id: "right-flight", runAxis: "vertical", x: 131, y: 48, width: 31, height: 74, stepCount: 10, confidence: 0.78 };
  const expanded = expandDetectedStairReturn(stair, mask, width, height, { x: 20, y: 18, width: 200, height: 154 }, 5);
  assert.ok(expanded.x <= 106, "the shaft should include the left-hand return flight");
  assert.ok(expanded.width >= 56, "the shaft should cover both halves rather than shifting one flight");
});

test("half-paced stairs use opposing flights, a half-height landing and an upper slab opening", () => {
  const base = {
    shortName: "GF",
    ceilingHeight: 2.7,
    area: 70,
    roomCount: 4,
    wallCount: 0,
    openingCount: 0,
    scaleStatus: "needed",
    slab: { width: 10, depth: 8, x: 0, z: 0 },
    walls: [],
  };
  const lower = {
    ...base,
    id: "lower",
    name: "Ground floor",
    elevation: 0,
    stairs: [{ id: "lower-stair", x: 1.15, z: -2.4, width: 1.9, depth: 3.4, runAxis: "vertical", stepCount: 14, confidence: 0.82 }],
  };
  const upper = {
    ...base,
    id: "upper",
    name: "First floor",
    elevation: 3.05,
    stairs: [{ id: "upper-stair", x: -0.1, z: -2.6, width: 2.1, depth: 3.2, runAxis: "vertical", stepCount: 12, confidence: 0.84 }],
  };
  const connections = buildStairConnections([lower, upper]);
  assert.equal(connections.length, 1);
  assert.equal(connections[0].lowerLevelId, "lower");
  assert.equal(connections[0].upperLevelId, "upper");
  assert.ok(connections[0].lowerFlight.start[0] > connections[0].upperFlight.end[0], "lower flight should start on the right and arrive on the left");
  const lowerVector = [
    connections[0].lowerFlight.end[0] - connections[0].lowerFlight.start[0],
    connections[0].lowerFlight.end[1] - connections[0].lowerFlight.start[1],
  ];
  const upperVector = [
    connections[0].upperFlight.end[0] - connections[0].upperFlight.start[0],
    connections[0].upperFlight.end[1] - connections[0].upperFlight.start[1],
  ];
  assert.ok(lowerVector[0] * upperVector[0] + lowerVector[1] * upperVector[1] < 0, "the two flights should run in opposite directions");
  assert.equal(connections[0].lowerFlight.toElevation, connections[0].landing.elevation);
  assert.equal(connections[0].upperFlight.fromElevation, connections[0].landing.elevation);
  assert.ok(connections[0].landing.elevation > 1.5 && connections[0].landing.elevation < 1.65);
  assert.ok(connections[0].upperFlight.toElevation > 3 && connections[0].upperFlight.toElevation < 3.1);

  const opening = connections[0].opening;
  assert.ok(opening);
  assert.equal(opening.x, stairwellOpening(upper).x, "the stairs should use the opening detected on the upper-floor plan");
  assert.ok(Math.abs((connections[0].lowerFlight.start[0] + connections[0].upperFlight.end[0]) / 2 - opening.x) < 0.0001, "the two flights should be centered in the plan opening");
  const openingLeft = opening.x - opening.width / 2;
  const openingRight = opening.x + opening.width / 2;
  const openingBack = opening.z - opening.depth / 2;
  const openingFront = opening.z + opening.depth / 2;
  assert.ok(Math.abs(connections[0].upperFlight.end[1] - openingFront) < 0.0001, "the top tread should meet the upper-floor slab");
  assert.ok(connections[0].landing.x - connections[0].landing.width / 2 >= openingLeft);
  assert.ok(connections[0].landing.x + connections[0].landing.width / 2 <= openingRight);
  assert.ok(connections[0].landing.z - connections[0].landing.depth / 2 >= openingBack, "the landing must not project through the rear wall");
  assert.ok(connections[0].landing.z + connections[0].landing.depth / 2 <= openingFront);
  for (const flight of [connections[0].lowerFlight, connections[0].upperFlight]) {
    for (const [x, z] of [flight.start, flight.end]) {
      assert.ok(x - connections[0].width / 2 >= openingLeft && x + connections[0].width / 2 <= openingRight);
      assert.ok(z >= openingBack && z <= openingFront);
    }
  }
  const pieces = slabPieces(upper, opening);
  assert.equal(pieces.length, 4);
  const remainingArea = pieces.reduce((sum, piece) => sum + piece.width * piece.depth, 0);
  assert.ok(Math.abs(remainingArea - (upper.slab.width * upper.slab.depth - opening.width * opening.depth)) < 0.0001);

  const slabLeft = upper.slab.x - upper.slab.width / 2;
  const slabBack = upper.slab.z - upper.slab.depth / 2;
  const openingLeftU = (opening.x - opening.width / 2 - slabLeft) / upper.slab.width;
  const openingRightU = (opening.x + opening.width / 2 - slabLeft) / upper.slab.width;
  const openingBackV = 1 - (opening.z - opening.depth / 2 - slabBack) / upper.slab.depth;
  const openingFrontV = 1 - (opening.z + opening.depth / 2 - slabBack) / upper.slab.depth;
  const leftUv = slabPieceTextureUv(upper, pieces.find((piece) => piece.id === "left"));
  const rightUv = slabPieceTextureUv(upper, pieces.find((piece) => piece.id === "right"));
  const backUv = slabPieceTextureUv(upper, pieces.find((piece) => piece.id === "back"));
  const frontUv = slabPieceTextureUv(upper, pieces.find((piece) => piece.id === "front"));
  assert.ok(Math.abs(leftUv[2] - openingLeftU) < 0.0001, "left plan fragment should end at the opening's exact image coordinate");
  assert.ok(Math.abs(rightUv[0] - openingRightU) < 0.0001, "right plan fragment should begin at the opening's exact image coordinate");
  assert.ok(Math.abs(backUv[5] - openingBackV) < 0.0001, "back plan fragment should end at the opening's exact image coordinate");
  assert.ok(Math.abs(frontUv[1] - openingFrontV) < 0.0001, "front plan fragment should begin at the opening's exact image coordinate");
});
