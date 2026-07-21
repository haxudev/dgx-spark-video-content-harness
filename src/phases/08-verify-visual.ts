import * as fs from "node:fs/promises";
import type { RunContext } from "../orchestrator/runContext.js";
import { writeJson } from "../orchestrator/runContext.js";
import type { Issue } from "../orchestrator/supervisor.js";
import type { RunState } from "../orchestrator/stateMachine.js";
import { COMPLIANCE_POLICY, uniqueRestrictedTerms } from "../tools/compliancePolicy.js";
import { renderFps } from "../tools/runProfile.js";

export const verifyVisual = async (
  ctx: RunContext,
  _state: RunState,
  _priorIssues: Issue[],
): Promise<{ ok: boolean; issues?: Issue[] }> => {
  // M1 minimal: structural check on composition.html (no hyperframes lint binary
  // dependency yet). Future: spawn `npx hyperframes lint` + screenshot 3 frames.
  const html = await fs.readFile(ctx.paths.compositionHtml, "utf8");
  const issues: Issue[] = [];

  const must = [
    "data-composition-id",
    "data-width=\"1080\"",
    "data-height=\"1920\"",
    `data-fps=\"${renderFps()}\"`,
    // Subtitles are gone; the bottom presenter band is now the required cue.
    "data-avatar-band",
    COMPLIANCE_POLICY.brand,
    COMPLIANCE_POLICY.headerLabel,
    COMPLIANCE_POLICY.footerText,
  ];
  for (const m of must) {
    if (!html.includes(m)) issues.push({
      kind: "visual-lint-missing",
      severity: "error",
      message: `composition.html missing required token: ${m}`,
    });
  }

  // Count <audio>, <section.scene>
  const audioCount = (html.match(/<audio\b/g) ?? []).length;
  const sceneCount = (html.match(/<section[^>]+data-scene-id=/g) ?? []).length;
  if (audioCount === 0) issues.push({ kind: "visual-no-audio", severity: "error", message: "0 <audio> tags" });
  if (sceneCount < 3)   issues.push({ kind: "visual-too-few-scenes", severity: "error", message: `${sceneCount} scenes (need ≥3)` });

  const restrictedHits = uniqueRestrictedTerms(html);
  if (restrictedHits.length > 0) {
    issues.push({
      kind: "visual-restricted-compliance-terms",
      severity: "error",
      message: `restricted ${COMPLIANCE_POLICY.version} terms found in composition.html: ${restrictedHits.join(", ")}`,
      data: restrictedHits,
    });
  }

  await writeJson(`${ctx.paths.verifyDir}/verify-visual.json`, {
    ok: !issues.some(i => i.severity === "error"),
    compliancePolicy: COMPLIANCE_POLICY.version,
    audioCount, sceneCount, issues, at: new Date().toISOString(),
  });
  return { ok: !issues.some(i => i.severity === "error"), issues };
};
