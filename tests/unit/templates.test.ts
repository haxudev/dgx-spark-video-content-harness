import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { VisualKindSchema } from "../../src/schemas/talkPlan.js";

test("every visualSpec.kind in the whitelist has a partial in templates/scenes/", async () => {
  const tplDir = path.resolve("templates/scenes");
  const files = await fs.readdir(tplDir);
  const names = new Set(files.filter(f => f.endsWith(".hbs")).map(f => f.replace(/\.hbs$/, "")));

  const kinds = VisualKindSchema.options;
  for (const k of kinds) {
    assert.ok(names.has(k), `missing partial templates/scenes/${k}.hbs (registered visualSpec.kind without template)`);
  }
});

test("M5 templates (timeline / side-by-side-cards / probability-map / kelly-bar) all exist", async () => {
  const must = ["timeline", "side-by-side-cards", "probability-map", "kelly-bar"];
  for (const n of must) {
    const p = path.resolve("templates/scenes", `${n}.hbs`);
    const stat = await fs.stat(p);
    assert.ok(stat.size > 200, `${n}.hbs should be non-trivial`);
    const html = await fs.readFile(p, "utf8");
    assert.match(html, /scene-title/, `${n}.hbs should render a scene title`);
  }
});

test("VisualKind schema exposes 24 kinds (13 base + 4 M5 + 5 M6 + 2 v2)", () => {
  assert.equal(VisualKindSchema.options.length, 24);
  assert.ok(VisualKindSchema.options.includes("watch-boundary"));
  assert.ok(VisualKindSchema.options.includes("cover-anime"));
  assert.ok(VisualKindSchema.options.includes("fundamentals-signal"));
});
