import { readJson, writeJson, type RunContext } from "../orchestrator/runContext.js";
import type { Issue } from "../orchestrator/supervisor.js";
import type { RunState } from "../orchestrator/stateMachine.js";
import type { BlocksFile, Block, DataPoint } from "../schemas/block.js";
import type { DialogueFile, DialogueLine } from "../schemas/dialogue.js";
import type { TalkPlan } from "../schemas/talkPlan.js";
import {
  allBannedRegex,
  loadGlossary,
  compliancePhrasesByPlacement,
} from "../tools/configLoader.js";
import { COMPLIANCE_POLICY, uniqueRestrictedTerms } from "../tools/compliancePolicy.js";

const SCENE_TOL = 0.35;   // ±35% of scene targetSec
const MAX_LINE_CHARS = 30;

export const verifyText = async (
  ctx: RunContext,
  _state: RunState,
  _priorIssues: Issue[],
): Promise<{ ok: boolean; issues?: Issue[] }> => {
  const blocksFile = await readJson<BlocksFile>(ctx.paths.blocks);
  const plan = await readJson<TalkPlan>(ctx.paths.talkPlan);
  const dlg = await readJson<DialogueFile>(ctx.paths.dialogue);
  const limits = textCharLimits();
  const mode = dlg.mode ?? "podcast";
  // The host that leads the opening welcome + compliance read-outs.
  const leadSpeaker = mode === "monologue" ? "Narrator" : "Anchor";

  const issues: Issue[] = [];
  const banned = allBannedRegex();

  // 1. Total chars sanity
  if (dlg.totalChars < limits.min) issues.push({
    kind: "text-total-too-short",
    severity: "error",
    message: `total chars ${dlg.totalChars} < ${limits.min}`,
  });
  if (dlg.totalChars > limits.max) issues.push({
    kind: "text-total-too-long",
    severity: "warn",
    message: `total chars ${dlg.totalChars} > ${limits.max}`,
  });

  // 2. Per-scene budget
  for (const sc of plan.scenes) {
    const sd = dlg.scenes.find(s => s.sceneId === sc.id);
    if (!sd) {
      issues.push({ kind: "text-scene-missing", severity: "error", message: `scene ${sc.id} has no dialogue` });
      continue;
    }
    const sceneSec = sd.lines.reduce((s, l) => s + l.targetSec, 0);
    const drift = (sceneSec - sc.targetSec) / sc.targetSec;
    if (Math.abs(drift) > SCENE_TOL) {
      issues.push({
        kind: "text-scene-drift",
        severity: "warn",
        message: `scene ${sc.id} estimated ${sceneSec.toFixed(1)}s vs target ${sc.targetSec}s (drift ${(drift * 100).toFixed(1)}%)`,
      });
    }
    if (sd.lines.length < 2) issues.push({
      kind: "text-scene-dialogue-thin",
      severity: "warn",
      message: mode === "monologue"
        ? `scene ${sc.id} has only ${sd.lines.length} line(s)`
        : `scene ${sc.id} has only ${sd.lines.length} line(s); dual-host cadence broken`,
    });
    // Dual-host only: each scene should carry both voices. Monologue is a
    // single Narrator by design, so this check does not apply.
    if (mode !== "monologue" &&
        (!sd.lines.find(l => l.speaker === "Anchor") || !sd.lines.find(l => l.speaker === "Analyst"))) {
      issues.push({
        kind: "text-scene-single-speaker",
        severity: "warn",
        message: `scene ${sc.id} missing one speaker`,
      });
    }
  }

  // 3. Banned terms
  const allText = dlg.scenes.flatMap(s => s.lines).map(l => l.text).join(" ");
  const bannedHits = allText.match(banned);
  if (bannedHits && bannedHits.length > 0) {
    const unique = [...new Set(bannedHits)];
    issues.push({
      kind: "text-banned-terms",
      severity: "error",
      message: `banned terms found: ${unique.join(", ")}`,
      data: unique,
    });
  }

  const restrictedHits = uniqueRestrictedTerms(allText);
  if (restrictedHits.length > 0) {
    issues.push({
      kind: "text-restricted-compliance-terms",
      severity: "error",
      message: `restricted ${COMPLIANCE_POLICY.version} terms found: ${restrictedHits.join(", ")}`,
      data: restrictedHits,
    });
  }

  // 4. Sentence length
  for (const sd of dlg.scenes) {
    for (const l of sd.lines) {
      const sents = l.text.split(/(?<=[。！？])/).filter(s => s.trim().length > 0);
      for (const s of sents) {
        if (countCJK(s) > MAX_LINE_CHARS) {
          issues.push({
            kind: "text-sentence-too-long",
            severity: "warn",
            message: `${l.id} sentence ${countCJK(s)} chars > ${MAX_LINE_CHARS}: ${trim(s, 36)}`,
          });
        }
      }
    }
  }

  // 5. Compliance phrases
  const opening = compliancePhrasesByPlacement("opening");
  const closing = compliancePhrasesByPlacement("closing");
  const openingScene = dlg.scenes[0];
  const closingScene = dlg.scenes[dlg.scenes.length - 1];

  // 5a. Brand welcome: the very first spoken line must be a lead-host welcome
  // that names the on-screen brand (Anchor in podcast, Narrator in monologue).
  const firstLine = openingScene?.lines[0];
  const hasBrandWelcome = firstLine?.speaker === leadSpeaker
    && firstLine.text.includes(COMPLIANCE_POLICY.brand);
  if (!hasBrandWelcome) issues.push({
    kind: "text-brand-welcome-missing",
    severity: "error",
    message: `opening scene first line must be a ${leadSpeaker} brand welcome naming "${COMPLIANCE_POLICY.brand}"`,
  });

  for (const p of opening) {
    const matches = openingScene?.lines.filter(l => phraseMatches(l.text, p.keywords ?? [p.text])) ?? [];
    if (matches.length === 0) issues.push({
      kind: "text-compliance-opening-missing",
      severity: "error",
      message: `opening scene missing compliance phrase: ${p.text}`,
    });
    else if (!matches.some(l => l.speaker === leadSpeaker)) issues.push({
      // The lead host must voice the opening compliance line.
      kind: "text-compliance-opening-not-anchor",
      severity: "error",
      message: `opening compliance phrase must be spoken by ${leadSpeaker}: ${p.text}`,
    });
  }
  for (const p of closing) {
    const found = closingScene?.lines.some(l => phraseMatches(l.text, p.keywords ?? [p.text]));
    if (!found) issues.push({
      kind: "text-compliance-closing-missing",
      severity: "error",
      message: `closing scene missing compliance phrase: ${p.text}`,
    });
  }

  // 6. Glossary policy: jargon terms (Elo / EV / Kelly / …) should be REPLACED
  //    with their plain-Chinese equivalent by the chineseifyForTTS post-pass.
  //    Any residual occurrence here means the post-pass missed it — surface
  //    as a warning so the script can be tightened.
  const glossary = loadGlossary().terms;
  const introduced = new Map<string, number>();
  dlg.scenes.forEach((sd, idx) => {
    for (const l of sd.lines) {
      for (const t of glossary) {
        const names = [t.term, ...t.aliases];
        for (const n of names) {
          if (!l.text.includes(n)) continue;
          if (!introduced.has(t.term)) introduced.set(t.term, idx + 1);
          issues.push({
            kind: "text-glossary-jargon-not-replaced",
            severity: "warn",
            message: `term "${n}" should have been rewritten to "${t.simpleZh}" in ${l.id}`,
          });
          break;
        }
      }
    }
  });

  // 7. Data fidelity: numbers in dialogue must trace to Block.dataPoints values
  const allDPs: DataPoint[] = blocksFile.blocks.flatMap(b => b.dataPoints);
  const dpSet = new Set<string>();
  for (const dp of allDPs) {
    if (typeof dp.value === "number") {
      dpSet.add(normalizeNum(dp.value));
    } else if (typeof dp.value === "string") {
      dpSet.add(dp.value.trim());
    }
  }
  // Allow any number that appears in a block.dataPoints OR in raw sourceText / text
  const rawBlockText = blocksFile.blocks.flatMap(b => {
    if (b.kind === "paragraph") return [b.text];
    if (b.kind === "callout") return [b.text];
    if (b.kind === "list") return b.items.map(i => i.text);
    if (b.kind === "table") return b.rows.flatMap(r => r.map(c => c.text));
    if (b.kind === "kpi-grid") return b.items.map(i => `${i.label} ${i.value}`);
    if (b.kind === "bar-list") return b.items.map(i => `${i.label} ${(i.probability * 100).toFixed(1)}%`);
    if (b.kind === "strategy-card") return [b.name, ...b.summary, ...b.allocations.map(a => `${a.market} ${a.option} ${a.amount}`)];
    if (b.kind === "meta") return [b.matchZh ?? b.match];
    return [];
  }).join(" ");

  // 7. Data fidelity: numbers in dialogue must trace to Block.dataPoints values.
  //    Since the dialogue is now Chinese-spoken (e.g. "百分之五十七点一" instead
  //    of "57.1%"), we check on stray ASCII digits only. The chineseifyForTTS
  //    pass already converts allowed numbers into Chinese; remaining ASCII
  //    numerics are likely tokens (codes / years) that should match a block.
  for (const sd of dlg.scenes) {
    for (const l of sd.lines) {
      const nums = l.text.match(/[+\-−]?\d+(?:\.\d+)?/g) ?? [];
      for (const n of nums) {
        const norm = normalizeNum(parseFloat(n.replace("−", "-")));
        if (dpSet.has(norm)) continue;
        if (rawBlockText.includes(n)) continue;
        const v = parseFloat(n);
        if (!Number.isFinite(v)) continue;
        if (Math.abs(v) < 10 && Number.isInteger(v)) continue;
        if ([100, 50, 30, 20, 10, 5].includes(v)) continue;
        issues.push({
          kind: "text-data-fidelity",
          severity: "warn",
          message: `${l.id}: stray ASCII number ${n} not found in any block`,
        });
      }
    }
  }

  // 7b. TTS-friendliness: warn on residual % / ¥ / hyphen-between-digits / "比"
  //     constructs that should already have been chineseified.
  const ttsHostileGlobal = /(\d+\s*%)|(¥\s*\d)|(\d\s*[-]\s*\d)/g;
  for (const sd of dlg.scenes) {
    for (const l of sd.lines) {
      const hits = l.text.match(ttsHostileGlobal);
      if (hits && hits.length > 0) {
        issues.push({
          kind: "text-tts-not-chineseified",
          severity: "warn",
          message: `${l.id}: TTS-hostile tokens ${[...new Set(hits)].join(", ")} should be Chinese-spoken`,
        });
      }
    }
  }

  // 8. medium compliance policy presence
  if (!/赛前概率观察|体育数据讨论/.test(allText)) {
    issues.push({
      kind: "text-no-compliance-policy-mention",
      severity: "error",
      message: `"赛前概率观察" / "体育数据讨论" never mentioned in any line`,
    });
  }

  const hardErr = issues.some(i => i.severity === "error");
  // Persist a verifier report for the audit trail
  await writeJson(`${ctx.paths.verifyDir}/verify-text.json`, {
    ok: !hardErr, totalChars: dlg.totalChars, sceneCount: dlg.scenes.length, issues,
    introducedTerms: Array.from(introduced.entries()),
    at: new Date().toISOString(),
  });
  return { ok: !hardErr, issues };
};

function phraseMatches(text: string, keywords: string[]): boolean {
  return keywords.every(k => text.includes(k));
}

function countCJK(s: string): number {
  let n = 0;
  for (const ch of s) {
    if (/[\u4e00-\u9fff]/.test(ch)) n += 1;
    else if (/[A-Za-z0-9]/.test(ch)) n += 0.5;
  }
  return Math.round(n);
}

function textCharLimits(): { min: number; max: number } {
  return { min: 520, max: Number.MAX_SAFE_INTEGER };
}

function trim(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function normalizeNum(x: number): string {
  if (Math.abs(x) >= 1) return x.toString();
  return x.toFixed(3);
}
