import { test } from "node:test";
import { strict as assert } from "node:assert";
import { allBannedRegex, loadGlossary, compliancePhrasesByPlacement, clearConfigCache } from "../../src/tools/configLoader.js";

test("glossary loads expected core terms", () => {
  clearConfigCache();
  const g = loadGlossary();
  const ids = g.terms.map(t => t.term);
  for (const must of ["Elo", "EV", "Kelly", "upset", "SP", "vig"]) {
    assert.ok(ids.includes(must), `missing core term ${must}`);
  }
  for (const t of g.terms) {
    assert.ok(t.simpleZh.length > 0, `${t.term} missing simpleZh`);
  }
});

test("banned terms regex matches forbidden words", () => {
  // allBannedRegex returns a /g regex with stateful lastIndex — build a per-call
  // copy so assert.match doesn't interact with prior matches.
  const fresh = () => new RegExp(allBannedRegex().source);
  assert.match("含有 Hurst 指数", fresh());
  assert.match("PR-AUC 校验", fresh());
  assert.doesNotMatch("普通文本不含违禁词", fresh());
});

test("compliance has no opening read-out (v2) but keeps closing + always-on phrases", () => {
  const o = compliancePhrasesByPlacement("opening");
  const c = compliancePhrasesByPlacement("closing");
  const a = compliancePhrasesByPlacement("always-on");
  assert.equal(o.length, 0, "v2: opening compliance read-out removed");
  assert.ok(c.length >= 3);
  assert.ok(a.length >= 1);
});
