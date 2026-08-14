import assert from "node:assert/strict";
import test from "node:test";
import {
  addDocumentOpening,
  createFloorplanDocumentV2,
  documentRegions,
  removeDocumentWall,
  suggestBuildingOrder,
  undoLastDocumentEdit,
  validateFloorplanDocument,
} from "../app/floorplan-document.ts";
import { parseProject, serializeProject } from "../app/project-storage.ts";

function structure(regionId, { outdoor = false } = {}) {
  return {
    regionId,
    sourceWidth: 300,
    sourceHeight: 600,
    walls: [{
      id: `${regionId}-wall`,
      axis: "horizontal",
      start: [20, 20],
      end: [220, 20],
      thickness: 8,
      confidence: 0.91,
      openings: [],
    }],
    outdoorAreas: outdoor ? [{ id: "balcony", side: "bottom", x: 30, y: 180, width: 180, height: 40, confidence: 0.9 }] : [],
    stairs: [{ id: `${regionId}-stair`, runAxis: "vertical", x: 120, y: 45, width: 45, height: 80, stepCount: 12, confidence: 0.84 }],
    footprint: { x: 20, y: 20, width: 200, height: 160 },
    roomCount: 2,
    confidence: 0.88,
    diagnostics: { threshold: 140, wallThickness: 8, geometryVotes: 1, topologyVotes: 1, openingVotes: 0, stairVotes: 1 },
  };
}

test("balcony evidence suggests an upper level without trusting page position", () => {
  const pageTop = { id: "page-top", name: "Ground floor", x: 0, y: 0, width: 1, height: 0.45, confidence: 0.9 };
  const pageBottom = { id: "page-bottom", name: "First floor", x: 0, y: 0.55, width: 1, height: 0.45, confidence: 0.9 };
  const structures = { "page-top": structure("page-top", { outdoor: true }), "page-bottom": structure("page-bottom") };
  const ordered = suggestBuildingOrder([pageTop, pageBottom], structures);
  assert.equal(ordered[0].id, "page-bottom");
  assert.equal(ordered[0].name, "Ground floor");
  assert.equal(ordered[1].id, "page-top");
  assert.equal(ordered[1].name, "First floor");
});

test("V2 project JSON preserves structural corrections and supports undo", () => {
  const regions = [
    { id: "ground", name: "Ground floor", x: 0, y: 0.5, width: 1, height: 0.5, confidence: 0.9 },
    { id: "upper", name: "First floor", x: 0, y: 0, width: 1, height: 0.5, confidence: 0.9, hasOutdoorArea: true },
  ];
  const document = createFloorplanDocumentV2({
    name: "validation.jpg",
    mimeType: "image/jpeg",
    width: 300,
    height: 600,
    regions,
    structures: { ground: structure("ground"), upper: structure("upper", { outdoor: true }) },
  });
  assert.equal(document.schemaVersion, 2);
  assert.deepEqual(documentRegions(document).map(({ name }) => name), ["Ground floor", "First floor"]);

  const withDoor = addDocumentOpening(document, "upper", "upper-wall", "door");
  assert.equal(withDoor.levels.find(({ id }) => id === "upper").structure.walls[0].openings[0].kind, "door");
  assert.equal(undoLastDocumentEdit(withDoor).levels.find(({ id }) => id === "upper").structure.walls[0].openings.length, 0);

  const corrected = removeDocumentWall(document, "upper", "upper-wall");
  assert.equal(corrected.levels.find(({ id }) => id === "upper").structure.walls.length, 0);
  assert.equal(corrected.edits.at(-1).kind, "remove-wall");

  const roundTrip = parseProject(serializeProject(corrected));
  assert.equal(validateFloorplanDocument(roundTrip).levels.length, 2);
  const restored = undoLastDocumentEdit(roundTrip);
  assert.equal(restored.levels.find(({ id }) => id === "upper").structure.walls.length, 1);
  assert.equal(restored.edits.length, 0);
});
