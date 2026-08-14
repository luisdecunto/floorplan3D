import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

const outputDirectory = new URL("../pages-dist/", import.meta.url);

test("GitHub Pages build contains the Planform application shell", async () => {
  const html = await readFile(new URL("index.html", outputDirectory), "utf8");

  assert.match(html, /<title>Planform/);
  assert.match(html, /id="root"/);
  assert.match(html, /\/floorplan3D\/assets\//);
  assert.doesNotMatch(html, /_next|_vinext|chatgpt\.site/);
});

test("GitHub Pages artifact contains only deployable static assets", async () => {
  const entries = await readdir(outputDirectory);
  assert.ok(entries.includes("index.html"));
  assert.ok(entries.includes("assets"));
  assert.ok(entries.includes(".nojekyll"));
  assert.ok(!entries.includes("tests"));
  assert.ok(!entries.includes("fixtures"));
  await access(new URL("og.png", outputDirectory));
});

test("plan review visually separates detected walls from source annotations", async () => {
  const assetDirectory = new URL("assets/", outputDirectory);
  const stylesheet = (await readdir(assetDirectory)).find((entry) => entry.endsWith(".css"));
  assert.ok(stylesheet, "expected the production stylesheet");
  const css = await readFile(new URL(stylesheet, assetDirectory), "utf8");

  assert.match(css, /\.detected-wall-halo/);
  assert.match(css, /\.region-box\{[^}]*background:(?:transparent|0 0)/);
});
