import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  }
}
