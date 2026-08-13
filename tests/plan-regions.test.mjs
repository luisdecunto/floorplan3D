import assert from "node:assert/strict";
import test from "node:test";
import {
  moveRegion,
  resequenceRegions,
  resizeRegion,
  selectPlanBoxes,
} from "../app/plan-regions.ts";

test("a smaller nearby balcony is folded into its floorplan", () => {
  const floor = { minX: 8, minY: 9, maxX: 31, maxY: 34, cells: 310 };
  const balcony = { minX: 15, minY: 3, maxX: 25, maxY: 7, cells: 58 };
  const label = { minX: 18, minY: 1, maxX: 22, maxY: 2, cells: 9 };

  const result = selectPlanBoxes([floor, balcony, label]);

  assert.equal(result.length, 1);
  assert.deepEqual(
    { minX: result[0].minX, minY: result[0].minY, maxX: result[0].maxX, maxY: result[0].maxY },
    { minX: 8, minY: 1, maxX: 31, maxY: 34 },
  );
});

test("similarly-sized side-by-side plans remain separate floors", () => {
  const left = { minX: 1, minY: 4, maxX: 23, maxY: 30, cells: 280 };
  const right = { minX: 27, minY: 4, maxX: 54, maxY: 30, cells: 295 };

  const result = selectPlanBoxes([left, right]);

  assert.equal(result.length, 2);
  assert.equal(result[0].minX, 1);
  assert.equal(result[1].minX, 27);
});

test("brochure text and a corner render are excluded from a centered plan", () => {
  const title = { minX: 0, minY: 0, maxX: 13, maxY: 7, cells: 105 };
  const plan = { minX: 19, minY: 3, maxX: 31, maxY: 28, cells: 326 };
  const copy = { minX: 0, minY: 14, maxX: 13, maxY: 33, cells: 219 };
  const render = { minX: 33, minY: 24, maxX: 55, maxY: 33, cells: 175 };

  const result = selectPlanBoxes([title, plan, copy, render], 4, { cols: 56, rows: 34 });

  assert.deepEqual(result, [plan]);
});

test("visual floor order can be corrected without losing custom identities", () => {
  const regions = [
    { id: "a", name: "Ground floor", x: 0, y: 0, width: 0.4, height: 0.8, confidence: 0.9 },
    { id: "b", name: "First floor", x: 0.6, y: 0, width: 0.4, height: 0.8, confidence: 0.9 },
  ];

  assert.deepEqual(moveRegion(regions, "b", -1).map(({ id, name }) => ({ id, name })), [
    { id: "b", name: "Ground floor" },
    { id: "a", name: "First floor" },
  ]);

  const custom = resequenceRegions([{ ...regions[1], name: "Second floor", nameEdited: true }, regions[0]]);
  assert.equal(custom[0].name, "Second floor");
});

test("manual outline expansion stays inside the source image", () => {
  const region = { id: "a", name: "Ground floor", x: 0.02, y: 0.03, width: 0.92, height: 0.9, confidence: 0.9 };
  const expanded = resizeRegion(region, 0.06);

  assert.equal(expanded.x, 0);
  assert.equal(expanded.y, 0);
  assert.ok(expanded.x + expanded.width <= 1);
  assert.ok(expanded.y + expanded.height <= 1);
});
