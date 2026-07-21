import { test } from "node:test";
import { strict as assert } from "node:assert";
import { ISSUE_ROUTING, routeIssue, PHASE_ORDER, type Phase } from "../../src/orchestrator/stateMachine.js";

test("ISSUE_ROUTING includes all critical text/audio/compose issue kinds", () => {
  const must = [
    "text-banned-terms", "text-compliance-opening-missing", "text-data-fidelity",
    "text-restricted-compliance-terms", "text-no-compliance-policy-mention",
    "talk-audit-dual-host-cadence", "talk-audit-low-score",
    "audio-scene-drift", "audio-overlap",
    "compose-no-stage-attr", "visual-lint-missing", "visual-restricted-compliance-terms", "verify-av-duration-drift",
    "visual-audit-frame-extract-failed",
    "plan-total-too-short",
  ];
  for (const k of must) {
    assert.ok(ISSUE_ROUTING[k], `routing table missing entry for ${k}`);
  }
});

test("visual low score does not route to expensive re-render", () => {
  assert.equal(ISSUE_ROUTING["visual-audit-low-score"], undefined);
  assert.equal(routeIssue("visual-audit-low-score", "AUDIT_VISUAL"), undefined);
});

test("routeIssue refuses forward-routes (no skipping work)", () => {
  // text-banned-terms maps to WRITE. From VERIFY_TEXT (later), should route to WRITE.
  // But from INGEST (earlier), would be forward → undefined.
  assert.equal(routeIssue("text-banned-terms", "VERIFY_TEXT"), "WRITE");
  assert.equal(routeIssue("text-banned-terms", "INGEST"), undefined);
});

test("routeIssue picks correct upstream phase for plan errors", () => {
  assert.equal(routeIssue("plan-total-too-short", "VERIFY_TEXT"), "PLAN");
  assert.equal(routeIssue("plan-missing-hook", "WRITE"), "PLAN");
});

test("PHASE_ORDER is monotonic and contains DONE", () => {
  assert.equal(PHASE_ORDER[PHASE_ORDER.length - 1], "DONE");
  assert.ok(PHASE_ORDER.indexOf("AUDIT_TALK") > PHASE_ORDER.indexOf("VERIFY_TEXT"));
  assert.ok(PHASE_ORDER.indexOf("AUDIT_VISUAL") > PHASE_ORDER.indexOf("VERIFY_AV"));
  for (let i = 1; i < PHASE_ORDER.length; i++) {
    assert.notEqual(PHASE_ORDER[i], PHASE_ORDER[i - 1]);
  }
});
