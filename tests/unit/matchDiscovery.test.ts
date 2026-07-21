import { test } from "node:test";
import { strict as assert } from "node:assert";
import { normalizeDate, beijingDate } from "../../src/tools/matchDiscovery.js";

test("normalizeDate accepts YYYY-MM-DD and YYYYMMDD", () => {
  assert.equal(normalizeDate("2026-07-02"), "20260702");
  assert.equal(normalizeDate("20260702"), "20260702");
  assert.equal(normalizeDate("  2026-07-02 "), "20260702");
});

test("normalizeDate keywords resolve relative to Beijing today", () => {
  assert.equal(normalizeDate("today"), beijingDate(0));
  assert.equal(normalizeDate("tomorrow"), beijingDate(1));
  assert.equal(normalizeDate("yesterday"), beijingDate(-1));
  // empty/undefined defaults to T+1 (the daily-publish convention)
  assert.equal(normalizeDate(), beijingDate(1));
  assert.equal(normalizeDate(""), beijingDate(1));
});

test("normalizeDate rejects garbage", () => {
  assert.throws(() => normalizeDate("not-a-date"));
  assert.throws(() => normalizeDate("2026/13"));
});

test("beijingDate returns 8-digit YYYYMMDD", () => {
  assert.match(beijingDate(0), /^\d{8}$/);
  assert.match(beijingDate(1), /^\d{8}$/);
});
