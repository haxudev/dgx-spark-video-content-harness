import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import { parseHtmlToBlocks } from "../../src/tools/blockParser.js";

const BOURNEMOUTH = "/home/haxu/swa_html/reports/20260519/bournemouth-vs-man-city.html";
const CHELSEA = "/home/haxu/swa_html/reports/20260519/chelsea-vs-tottenham.html";
const HAS_BOURNEMOUTH = fs.existsSync(BOURNEMOUTH);
const HAS_CHELSEA = fs.existsSync(CHELSEA);

test("bournemouth report yields rich Block[] with all 4 strategies + KPIs + bar-lists", {
  skip: HAS_BOURNEMOUTH ? false : `missing external fixture ${BOURNEMOUTH}`,
}, () => {
  const html = fs.readFileSync(BOURNEMOUTH, "utf8");
  const file = parseHtmlToBlocks(html, BOURNEMOUTH);
  assert.ok(file.blocks.length >= 50, `expected ≥50 blocks, got ${file.blocks.length}`);
  assert.equal(file.stats.byKind["strategy-card"], 4, "must extract all 4 strategy cards (A/B/C/D)");
  assert.ok((file.stats.byKind["kpi-grid"] ?? 0) >= 3, "must extract ≥3 kpi-grids");
  assert.ok((file.stats.byKind["bar-list"] ?? 0) >= 2, "must extract ≥2 bar-lists");
  assert.ok(file.stats.unknownPct < 0.1, `unknown ratio ${file.stats.unknownPct} too high`);
  assert.ok(file.stats.highImportanceCount >= 10, `expected ≥10 hi-imp, got ${file.stats.highImportanceCount}`);

  const meta = file.blocks.find(b => b.kind === "meta");
  assert.ok(meta && meta.kind === "meta", "must have meta block");
  if (meta && meta.kind === "meta") {
    assert.match(meta.matchZh ?? meta.match, /伯恩茅斯|曼城|Bournemouth|Man City/);
  }
});

test("chelsea report (different structure: mostly tables) parses without crash", {
  skip: HAS_CHELSEA ? false : `missing external fixture ${CHELSEA}`,
}, () => {
  const html = fs.readFileSync(CHELSEA, "utf8");
  const file = parseHtmlToBlocks(html, CHELSEA);
  assert.ok(file.blocks.length >= 20, `expected ≥20 blocks, got ${file.blocks.length}`);
  assert.ok((file.stats.byKind["table"] ?? 0) >= 10, "must extract ≥10 tables");
  assert.ok(file.blocks.find(b => b.kind === "meta"), "must have meta block");
});

test("every Block has stable id, headingPath, dataPoints array", {
  skip: HAS_BOURNEMOUTH ? false : `missing external fixture ${BOURNEMOUTH}`,
}, () => {
  const html = fs.readFileSync(BOURNEMOUTH, "utf8");
  const file = parseHtmlToBlocks(html, BOURNEMOUTH);
  const ids = new Set<string>();
  for (const b of file.blocks) {
    assert.ok(b.id, "block must have id");
    assert.ok(!ids.has(b.id), `duplicate id ${b.id}`);
    ids.add(b.id);
    assert.ok(Array.isArray(b.headingPath));
    assert.ok(Array.isArray(b.dataPoints));
  }
});
