import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { detectPlanRegions } from "../app/plan-regions.ts";
import { alignAdjacentStairStructures, detectFloorStructures } from "../app/structure-detector.ts";
import { suggestBuildingOrder } from "../app/floorplan-document.ts";

const fixtureDirectory = new URL("./fixtures/floorplans/", import.meta.url);
const manifestUrl = new URL("manifest.json", fixtureDirectory);
const manifest = await readFile(manifestUrl, "utf8")
  .then((contents) => JSON.parse(contents))
  .catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });

function readPngDimensions(buffer) {
  const signature = buffer.subarray(0, 8).toString("hex");
  assert.equal(signature, "89504e470d0a1a0a");
  assert.equal(buffer.subarray(12, 16).toString("ascii"), "IHDR");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

if (!manifest) {
  test("private floorplan corpus is optional in repository checkouts", { skip: "local-only fixtures are absent" }, () => {});
} else {
  const { default: sharp } = await import("sharp");

  test("floorplan regression manifest has the agreed level labels", () => {
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.trainingUseApproved, false);
    assert.equal(manifest.publicRedistributionApproved, false);
    assert.equal(manifest.fixtures.length, 7);
    assert.deepEqual(
      manifest.fixtures.map(({ expectedLevelCount }) => expectedLevelCount),
      [2, 2, 1, 1, 1, 1, 1],
    );
    assert.deepEqual(
      manifest.fixtures.slice(0, 2).map(({ arrangement }) => arrangement),
      ["vertical", "horizontal"],
    );
  });

  for (const fixture of manifest.fixtures) {
    test(`${fixture.id} preserves its original pixels and dimensions`, async () => {
      const buffer = await readFile(new URL(fixture.file, fixtureDirectory));
      const hash = createHash("sha256").update(buffer).digest("hex");
      const dimensions = readPngDimensions(buffer);

      assert.equal(hash, fixture.sha256);
      assert.deepEqual(dimensions, {
        width: fixture.width,
        height: fixture.height,
      });
    });

    test(`${fixture.id} proposes the expected number of floor regions`, async () => {
      const buffer = await readFile(new URL(fixture.file, fixtureDirectory));
      const maxSide = 720;
      const scale = Math.min(1, maxSide / Math.max(fixture.width, fixture.height));
      const width = Math.max(1, Math.round(fixture.width * scale));
      const height = Math.max(1, Math.round(fixture.height * scale));
      const { data, info } = await sharp(buffer)
        .resize(width, height, { fit: "fill" })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const regions = detectPlanRegions(data, info.width, info.height);

      assert.equal(regions.length, fixture.expectedLevelCount);

      const structures = detectFloorStructures(data, info.width, info.height, regions);
      regions.forEach((region) => {
        const structure = structures[region.id];
        assert.ok(structure.walls.length >= 3, `${fixture.id}/${region.id} should contain a usable wall network`);
        assert.ok(structure.walls.every((wall) => wall.start.every(Number.isFinite) && wall.end.every(Number.isFinite)));
      });

      if (fixture.id === "fp-001") {
        const topPlan = structures[regions[0].id];
        const bottomPlan = structures[regions[1].id];
        assert.equal(topPlan.outdoorAreas.length, 1, "first-floor balcony should be retained");
        assert.equal(topPlan.stairs.length, 1, "first-floor stair symbol should be retained");
        assert.equal(bottomPlan.stairs.length, 1, "ground-floor stair symbol should be retained");
        assert.ok(topPlan.walls.flatMap((wall) => wall.openings).some((opening) => opening.kind === "door"));
        assert.ok(bottomPlan.walls.flatMap((wall) => wall.openings).filter((opening) => opening.kind === "door").length >= 2);
        const balconyWall = topPlan.walls.find((wall) => (
          wall.axis === "horizontal"
          && Math.abs(wall.start[1] - (topPlan.footprint.y + topPlan.footprint.height)) <= topPlan.diagnostics.wallThickness * 2
        ));
        assert.ok(balconyWall, "the first-floor balcony edge should be part of the wall network");
        const balconyAccess = [...balconyWall.openings].sort((a, b) => {
          const wallCenter = Math.hypot(balconyWall.end[0] - balconyWall.start[0], balconyWall.end[1] - balconyWall.start[1]) / 2;
          return Math.abs(a.offset + a.width / 2 - wallCenter) - Math.abs(b.offset + b.width / 2 - wallCenter);
        })[0];
        assert.equal(balconyAccess?.kind, "door", "the central balcony access symbol should become a door, not a window");
        assert.equal(balconyAccess?.evidence, "symbol", "the balcony door must be supported by its leaf and swing arc, not its position");
        const bedroomDoorWall = topPlan.walls.find((wall) => {
          const normalizedX = (wall.start[0] - topPlan.footprint.x) / topPlan.footprint.width;
          return wall.axis === "vertical"
            && normalizedX > 0.25
            && normalizedX < 0.5
            && wall.openings.some((opening) => opening.kind === "door");
        });
        assert.ok(bedroomDoorWall, "the short wall fragment beside the first-floor bedroom door should survive topology filtering");
        const entranceBedroomWall = bottomPlan.walls.find((wall) => {
          const normalizedX = (wall.start[0] - bottomPlan.footprint.x) / bottomPlan.footprint.width;
          const normalizedStartY = (Math.min(wall.start[1], wall.end[1]) - bottomPlan.footprint.y) / bottomPlan.footprint.height;
          const normalizedEndY = (Math.max(wall.start[1], wall.end[1]) - bottomPlan.footprint.y) / bottomPlan.footprint.height;
          return wall.axis === "vertical"
            && normalizedX > 0.55
            && normalizedX < 0.7
            && normalizedStartY < 0.45
            && normalizedEndY > 0.68
            && wall.openings.some((opening) => opening.kind === "door");
        });
        assert.ok(entranceBedroomWall, "the wall between the entrance hallway and bedroom should survive across its doorway gap");
        const fakeOpenSpaceDivider = topPlan.walls.find((wall) => (
          wall.axis === "horizontal"
          && wall.start[1] > topPlan.footprint.y + topPlan.footprint.height * 0.35
          && wall.start[1] < topPlan.footprint.y + topPlan.footprint.height * 0.75
          && wall.start[0] < topPlan.footprint.x + topPlan.footprint.width * 0.45
          && wall.end[0] > topPlan.footprint.x + topPlan.footprint.width * 0.82
        ));
        assert.equal(fakeOpenSpaceDivider, undefined, "the Stue/Køkken open space must not receive a virtual wall");
        const suggested = suggestBuildingOrder(regions, structures);
        assert.equal(suggested[0].id, regions[1].id, "the enclosed lower plan should be proposed as ground floor");
        assert.equal(suggested[1].id, regions[0].id, "the balcony plan should be proposed as first floor");
        const aligned = alignAdjacentStairStructures([regions[1], regions[0]], structures);
        const alignedBottom = aligned[regions[1].id].stairs[0];
        const topStair = topPlan.stairs[0];
        const bottomCenter = (alignedBottom.x + alignedBottom.width / 2 - bottomPlan.footprint.x) / bottomPlan.footprint.width;
        const topCenter = (topStair.x + topStair.width / 2 - topPlan.footprint.x) / topPlan.footprint.width;
        assert.ok(Math.abs(bottomCenter - topCenter) < 0.0001, "both analyser stair boxes should share one shaft center");
      }
    });
  }

  test("the validation residence remains structural when the sheet is rotated", async () => {
    const fixture = manifest.fixtures.find(({ id }) => id === "fp-001");
    assert.ok(fixture);
    const buffer = await readFile(new URL(fixture.file, fixtureDirectory));
    const { data, info } = await sharp(buffer)
      .rotate(9, { background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const regions = detectPlanRegions(data, info.width, info.height);
    assert.equal(regions.length, 2, "rotation must not merge the two floor regions");
    const structures = detectFloorStructures(data, info.width, info.height, regions);
    const values = Object.values(structures);
    assert.ok(values.every((structure) => Math.abs(Math.abs(structure.sourceRotationDegrees ?? 0) - 9) <= 2), `expected about 9° correction, received ${values.map((structure) => structure.sourceRotationDegrees).join(", ")}`);
    assert.ok(values.every((structure) => structure.walls.length >= 5), "both rotated floors should retain usable wall networks");
    assert.ok(values.flatMap((structure) => structure.walls).flatMap((wall) => wall.openings)
      .some((opening) => opening.kind === "door" && opening.evidence === "symbol"), "the rotated residence should retain a symbol-supported swing door");
  });
}
