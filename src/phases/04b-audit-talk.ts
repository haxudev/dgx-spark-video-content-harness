import { readJson, writeJson, type RunContext } from "../orchestrator/runContext.js";
import type { Issue } from "../orchestrator/supervisor.js";
import type { RunState } from "../orchestrator/stateMachine.js";
import type { DialogueFile, DialogueLine } from "../schemas/dialogue.js";
import type { TalkPlan } from "../schemas/talkPlan.js";
import { COMPLIANCE_POLICY, uniqueRestrictedTerms } from "../tools/compliancePolicy.js";
import { chatJson, isLLMAvailable } from "../tools/llmClient.js";

interface SceneTalkReview {
  sceneId: string;
  title: string;
  score: number;
  strengths: string[];
  issues: string[];
  improvementSuggestions: string[];
}

interface TalkTrackAudit {
  gate: "talk-track";
  ok: boolean;
  overallScore: number;
  summary: string;
  policyVersion: string;
  deterministicChecks: Record<string, number | string>;
  sceneReviews: SceneTalkReview[];
  improvementSuggestions: string[];
  llm?: {
    enabled: boolean;
    summary?: string;
    improvementSuggestions?: string[];
  };
  issues: Issue[];
  at: string;
}

export const auditTalkTrack = async (
  ctx: RunContext,
  _state: RunState,
  _priorIssues: Issue[],
): Promise<{ ok: boolean; issues?: Issue[] }> => {
  const plan = await readJson<TalkPlan>(ctx.paths.talkPlan);
  const dlg = await readJson<DialogueFile>(ctx.paths.dialogue);
  const mode = dlg.mode ?? "podcast";
  const issues: Issue[] = [];
  const allLines = dlg.scenes.flatMap(s => s.lines);
  const allText = allLines.map(l => l.text).join(" ");

  const restrictedTerms = uniqueRestrictedTerms(allText);
  if (restrictedTerms.length > 0) issues.push({
    kind: "talk-audit-restricted-terms",
    severity: "error",
    message: `restricted terms found in talk track: ${restrictedTerms.join(", ")}`,
    data: restrictedTerms,
  });

  const sceneReviews: SceneTalkReview[] = [];
  for (const scene of plan.scenes) {
    const sd = dlg.scenes.find(s => s.sceneId === scene.id);
    const lines = sd?.lines ?? [];
    const review = reviewScene(scene.id, scene.title, scene.narrativeBeat, lines, mode);
    sceneReviews.push(review);
    // Dual-host cadence only applies to the podcast mode; a single Narrator is
    // intentional in monologue mode.
    if (mode !== "monologue" && review.issues.some(i => /连续三行|缺少Anchor|缺少Analyst/.test(i))) {
      issues.push({
        kind: "talk-audit-dual-host-cadence",
        severity: "error",
        message: `${scene.id}: ${review.issues.join("; ")}`,
      });
    }
  }

  const anchorCount = allLines.filter(l => l.speaker === "Anchor").length;
  const analystCount = allLines.filter(l => l.speaker === "Analyst").length;
  const anchorRatio = allLines.length === 0 ? 0 : anchorCount / allLines.length;
  // Speaker-balance is a dual-host metric; skip it for single-host monologue.
  if (mode !== "monologue" && (anchorRatio < 0.28 || anchorRatio > 0.55)) {
    issues.push({
      kind: "talk-audit-speaker-balance",
      severity: "warn",
      message: `Anchor ratio ${(anchorRatio * 100).toFixed(1)}% outside preferred 28%-55%`,
    });
  }

  const avgSceneScore = sceneReviews.reduce((s, r) => s + r.score, 0) / Math.max(1, sceneReviews.length);
  const scorePenalty = issues.filter(i => i.severity === "error").length * 25 + issues.filter(i => i.severity === "warn").length * 5;
  const overallScore = clamp(Math.round(avgSceneScore - scorePenalty), 0, 100);
  if (overallScore < 75) issues.push({
    kind: "talk-audit-low-score",
    severity: "error",
    message: `talk-track audit score ${overallScore} < 75`,
  });

  const deterministicSuggestions = buildTalkSuggestions(sceneReviews, anchorRatio);
  const llm = await maybeLlmTalkAudit(plan, dlg);
  const audit: TalkTrackAudit = {
    gate: "talk-track",
    ok: !issues.some(i => i.severity === "error"),
    overallScore,
    summary: summarizeTalk(overallScore, issues),
    policyVersion: COMPLIANCE_POLICY.version,
    deterministicChecks: {
      lineCount: allLines.length,
      sceneCount: plan.scenes.length,
      anchorRatio: Number(anchorRatio.toFixed(3)),
      restrictedTermCount: restrictedTerms.length,
    },
    sceneReviews,
    improvementSuggestions: [...deterministicSuggestions, ...(llm?.improvementSuggestions ?? [])].slice(0, 10),
    llm,
    issues,
    at: new Date().toISOString(),
  };

  await writeJson(`${ctx.paths.verifyDir}/talk-track-audit.json`, audit);
  return { ok: audit.ok, issues };
};

function reviewScene(sceneId: string, title: string, narrativeBeat: string, lines: DialogueLine[], mode: "podcast" | "monologue" = "podcast"): SceneTalkReview {
  const issues: string[] = [];
  const strengths: string[] = [];
  const improvementSuggestions: string[] = [];
  let score = 92;

  if (mode === "monologue") {
    // Single-host monologue: dual-host structure (both speakers / cadence) does
    // not apply. Score on口播 craft: sentence length and a curiosity hook.
    const hasNarrator = lines.some(l => l.speaker === "Narrator");
    if (!hasNarrator) {
      issues.push("缺少主讲人台词");
      score -= 30;
    } else {
      strengths.push("单人口播主讲清晰。");
    }
  } else {
    const hasAnchor = lines.some(l => l.speaker === "Anchor");
    const hasAnalyst = lines.some(l => l.speaker === "Analyst");
    if (!hasAnchor || !hasAnalyst) {
      issues.push(`缺少${hasAnchor ? "Analyst" : "Anchor"}声音`);
      improvementSuggestions.push("补一行对方角色的承接或追问，保持双主持节奏。");
      score -= 35;
    } else {
      strengths.push("双主持角色齐全。");
    }

    let streak = 1;
    // The hook (female-led opening) and the compliance read-out are both allowed
    // to run a few consecutive same-speaker lines by design, so they only get a
    // soft note instead of a hard cadence failure.
    const allowsConsecutive = narrativeBeat === "compliance" || narrativeBeat === "hook";
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]!.speaker === lines[i - 1]!.speaker) streak += 1;
      else streak = 1;
      if (streak >= 3 && !allowsConsecutive) {
        issues.push(`连续三行都是${lines[i]!.speaker}`);
        improvementSuggestions.push("连续两行同一角色后插入另一位主持人的短反应。");
        score -= 25;
        break;
      } else if (streak >= 3) {
        improvementSuggestions.push("开场/合规幕可以连续说明，但可用对方主持短句分隔以减轻听感压力。");
        score -= 4;
        break;
      }
    }
  }

  const longLines = lines.filter(l => countCJK(l.text) > 34);
  if (longLines.length > 0) {
    issues.push(`${longLines.length} 行偏长`);
    improvementSuggestions.push("把偏长句拆成两句，保留口播停顿。");
    score -= Math.min(15, longLines.length * 4);
  } else {
    strengths.push("句长适合口播。");
  }

  // A curiosity hook (问号) should appear in content scenes. Podcast expects it
  // from the Anchor; monologue accepts it from the single Narrator.
  const questions = mode === "monologue"
    ? lines.filter(l => /[？?]/.test(l.text)).length
    : lines.filter(l => l.speaker === "Anchor" && /[？?]/.test(l.text)).length;
  if (questions === 0 && !["compliance", "outro"].includes(narrativeBeat)) {
    issues.push(mode === "monologue" ? "缺少勾起好奇的反问" : "Anchor 缺少明确提问");
    improvementSuggestions.push(mode === "monologue"
      ? "给主讲人增加一个紧扣上一句数据的反问钩子。"
      : "给 Anchor 增加一个紧扣上一句数据的追问。");
    score -= 8;
  }

  if (improvementSuggestions.length === 0) {
    improvementSuggestions.push("可继续强化对数字的复述，让观众更快抓住结论边界。");
  }

  return {
    sceneId,
    title,
    score: clamp(score, 0, 100),
    strengths,
    issues,
    improvementSuggestions,
  };
}

async function maybeLlmTalkAudit(plan: TalkPlan, dlg: DialogueFile): Promise<TalkTrackAudit["llm"]> {
  if (process.env.HARNESS_DISABLE_LLM === "1") return { enabled: false };
  if (process.env.HARNESS_QUALITY_LLM !== "1") return { enabled: false };
  if (!isLLMAvailable()) return { enabled: false };

  const systemPrompt = "你是中文体育短视频口播质量审计员。只输出 JSON。重点审查双主持节奏、清晰度、合规边界、观众理解成本，并给可执行改进意见。";
  const userPrompt = JSON.stringify({
    policy: COMPLIANCE_POLICY.version,
    scenes: plan.scenes.map(sc => ({
      id: sc.id,
      title: sc.title,
      beat: sc.narrativeBeat,
      lines: dlg.scenes.find(s => s.sceneId === sc.id)?.lines.map(l => `${l.speaker}: ${l.text}`) ?? [],
    })),
    outputSchema: {
      summary: "string",
      improvementSuggestions: ["string"],
    },
  }, null, 2);

  try {
    const res = await chatJson<{ summary?: string; improvementSuggestions?: string[] }>({
      systemPrompt,
      userPrompt,
      maxTokens: 900,
      temperature: 0.2,
      retries: 1,
    });
    return {
      enabled: true,
      summary: typeof res.summary === "string" ? res.summary : undefined,
      improvementSuggestions: Array.isArray(res.improvementSuggestions) ? res.improvementSuggestions : [],
    };
  } catch (e: any) {
    return {
      enabled: true,
      summary: `LLM talk audit unavailable: ${String(e?.message ?? e)}`,
      improvementSuggestions: [],
    };
  }
}

function buildTalkSuggestions(sceneReviews: SceneTalkReview[], anchorRatio: number): string[] {
  const out = new Set<string>();
  if (anchorRatio < 0.32) out.add("提高 Anchor 占比：每个数据点后增加一句观众视角追问或复述。");
  if (anchorRatio > 0.5) out.add("减少 Anchor 连续铺垫，把关键数字交给 Analyst 解释。");
  for (const r of sceneReviews) {
    for (const s of r.improvementSuggestions) out.add(`${r.sceneId}：${s}`);
  }
  if (out.size === 0) out.add("整体口播结构可用；下一轮重点优化每幕最后一句的转场钩子。");
  return [...out];
}

function summarizeTalk(score: number, issues: Issue[]): string {
  if (issues.some(i => i.severity === "error")) return `口播审计未通过，得分 ${score}。`;
  if (issues.length > 0) return `口播审计通过但有优化项，得分 ${score}。`;
  return `口播审计通过，得分 ${score}。`;
}

function countCJK(s: string): number {
  let n = 0;
  for (const ch of s) {
    if (/[\u4e00-\u9fff]/.test(ch)) n += 1;
    else if (/[A-Za-z0-9]/.test(ch)) n += 0.5;
  }
  return Math.round(n);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
