import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readJson, writeJson, type RunContext } from "../orchestrator/runContext.js";
import type { Issue } from "../orchestrator/supervisor.js";
import type { RunState } from "../orchestrator/stateMachine.js";
import type { AudioManifest } from "../schemas/audioManifest.js";
import type { TalkPlan } from "../schemas/talkPlan.js";
import { chatJsonWithImages, isLLMAvailable } from "../tools/llmClient.js";
import { cardParallel, shouldUseVisualAuditLLM } from "../tools/runProfile.js";
import pLimit from "p-limit";

interface VisualSceneReview {
  sceneId: string;
  title: string;
  kind: string;
  framePath: string | null;
  reviewMode: "deterministic" | "qwen-vision" | "skipped";
  score: number | null;
  strengths: string[];
  issues: string[];
  improvementSuggestions: string[];
}

interface VisualFrameAudit {
  gate: "visual-frame";
  ok: boolean;
  skipped: boolean;
  reviewMode: "deterministic" | "qwen-vision" | "skipped";
  framesDir: string;
  sceneReviews: VisualSceneReview[];
  improvementSuggestions: string[];
  issues: Issue[];
  at: string;
}

export const auditVisualFrames = async (
  ctx: RunContext,
  _state: RunState,
  _priorIssues: Issue[],
): Promise<{ ok: boolean; issues?: Issue[] }> => {
  const issues: Issue[] = [];
  const plan = await readJson<TalkPlan>(ctx.paths.talkPlan);
  const mani = await readJson<AudioManifest>(ctx.paths.audioManifest);
  const framesDir = path.join(ctx.paths.verifyDir, "visual-frames");
  await fs.mkdir(framesDir, { recursive: true });

  const requireFrames = process.env.HARNESS_REQUIRE_VISUAL_AUDIT === "1";
  const requireQwen = process.env.HARNESS_REQUIRE_QWEN_VISION === "1";
  const mp4Exists = await exists(ctx.paths.finalMp4);

  if (!mp4Exists) {
    issues.push({
      kind: "visual-audit-skipped-no-mp4",
      severity: requireFrames ? "error" : "warn",
      message: "final.mp4 not present; final-frame image audit skipped",
    });
    const audit: VisualFrameAudit = {
      gate: "visual-frame",
      ok: !issues.some(i => i.severity === "error"),
      skipped: true,
      reviewMode: "skipped",
      framesDir,
      sceneReviews: plan.scenes.map(sc => ({
        sceneId: sc.id,
        title: sc.title,
        kind: sc.visualSpec.kind,
        framePath: null,
        reviewMode: "skipped",
        score: null,
        strengths: [],
        issues: ["缺少 final.mp4，无法抽取每幕终稿图片。"],
        improvementSuggestions: ["运行完整 RENDER 阶段后重跑 AUDIT_VISUAL；如在快速迭代中，可接受该 warn。"],
      })),
      improvementSuggestions: ["运行完整 RENDER 阶段生成 MP4 后，可进行每个板块终稿图片审查。"],
      issues,
      at: new Date().toISOString(),
    };
    await writeJson(`${ctx.paths.verifyDir}/visual-frame-audit.json`, audit);
    return { ok: audit.ok, issues };
  }

  const html = await fs.readFile(ctx.paths.compositionHtml, "utf8");
  const sceneReviews: VisualSceneReview[] = [];
  for (const sc of plan.scenes) {
    const audioScene = mani.scenes.find(s => s.sceneId === sc.id);
    const framePath = path.join(framesDir, `${sc.id}.jpg`);
    if (audioScene) {
      const t = frameTime(audioScene.startSec, audioScene.durSec);
      const extracted = await extractFrame(ctx.paths.finalMp4, t, framePath);
      if (!extracted.ok) {
        issues.push({
          kind: "visual-audit-frame-extract-failed",
          severity: requireFrames ? "error" : "warn",
          message: `${sc.id}: ${extracted.message}`,
        });
      }
    }

    const frameExists = await exists(framePath);
    const deterministic = deterministicReview(sc.id, sc.title, sc.visualSpec.kind, frameExists ? framePath : null, html);
    sceneReviews.push(deterministic);
  }

  const qwenRequested = shouldUseVisualAuditLLM() || requireQwen;
  const qwenEnabled = process.env.HARNESS_DISABLE_LLM !== "1"
    && qwenRequested
    && isLLMAvailable();
  let reviewMode: VisualFrameAudit["reviewMode"] = "deterministic";

  if (qwenEnabled) {
    reviewMode = "qwen-vision";
    const limit = pLimit(cardParallel());
    const reviewed = await Promise.all(sceneReviews.map((current) => limit(async () => {
      if (!current.framePath) return current;
      const qwenReview = await maybeQwenReview(current);
      if (!qwenReview && requireQwen) {
        issues.push({
          kind: "visual-audit-qwen-review-failed",
          severity: "error",
          message: `${current.sceneId}: Qwen vision review failed`,
        });
      }
      return qwenReview ?? current;
    })));
    sceneReviews.splice(0, sceneReviews.length, ...reviewed.filter((r): r is VisualSceneReview => !!r));
  } else if (requireQwen) {
    issues.push({
      kind: "visual-audit-qwen-unavailable",
      severity: "error",
      message: "HARNESS_REQUIRE_QWEN_VISION=1 but no LLM provider is available",
    });
  }

  for (const r of sceneReviews) {
    if (typeof r.score === "number" && r.score < 70) {
      issues.push({
        kind: "visual-audit-low-score",
        severity: "error",
        message: `${r.sceneId}: visual audit score ${r.score} < 70`,
      });
    }
  }

  const suggestions = [...new Set(sceneReviews.flatMap(r => r.improvementSuggestions))].slice(0, 12);
  const audit: VisualFrameAudit = {
    gate: "visual-frame",
    ok: !issues.some(i => i.severity === "error"),
    skipped: false,
    reviewMode,
    framesDir,
    sceneReviews,
    improvementSuggestions: suggestions.length > 0 ? suggestions : ["整体视觉结构可用；下一轮可重点检查字幕遮挡和板块标题层级。"],
    issues,
    at: new Date().toISOString(),
  };

  await writeJson(`${ctx.paths.verifyDir}/visual-frame-audit.json`, audit);
  return { ok: audit.ok, issues };
};

function deterministicReview(
  sceneId: string,
  title: string,
  kind: string,
  framePath: string | null,
  html: string,
): VisualSceneReview {
  const issues: string[] = [];
  const suggestions: string[] = [];
  const strengths: string[] = [];
  let score = 86;

  if (!html.includes(`data-scene-id="${sceneId}"`)) {
    issues.push("HTML 中找不到该 scene 的渲染节点。");
    suggestions.push("检查 talk-plan scene id 和 composition 模板输出是否一致。");
    score -= 35;
  } else {
    strengths.push("HTML scene 节点存在。");
  }

  if (!framePath) {
    issues.push("未抽取到终稿图片。");
    suggestions.push("确认 RENDER 阶段生成 final.mp4，并检查 ffmpeg 是否可用。");
    score -= 25;
  } else {
    strengths.push("已生成终稿帧，可用于人工或视觉模型复核。");
  }

  if (kind === "market-grid") {
    suggestions.push("检查四宫格内数字是否被字幕条遮挡，比分热力图色阶是否足够清楚。");
  } else if (kind === "team-fundamentals") {
    suggestions.push("检查两队卡片的左右层级是否均衡，关键差异是否一眼可见。");
  } else if (kind === "upset-dashboard") {
    suggestions.push("检查仪表盘和因子卡是否抢视觉焦点，避免单一结论过强。");
  } else if (kind === "compliance") {
    suggestions.push("检查重要提示文字是否完整显示，避免被底部字幕遮挡。");
  } else {
    suggestions.push("检查标题、主体和字幕三层是否有足够间距。");
  }

  return {
    sceneId,
    title,
    kind,
    framePath,
    reviewMode: "deterministic",
    score: clamp(score, 0, 100),
    strengths,
    issues,
    improvementSuggestions: suggestions,
  };
}

async function maybeQwenReview(review: VisualSceneReview): Promise<VisualSceneReview | null> {
  if (!review.framePath) return null;
  const systemPrompt = "你是短视频竖屏 UI 视觉质量审查员。根据图片审查信息层级、可读性、字幕遮挡、移动端视觉密度、可信边界表达。只输出 JSON。";
  const userPrompt = JSON.stringify({
    sceneId: review.sceneId,
    title: review.title,
    visualKind: review.kind,
    rubric: [
      "标题和核心内容是否一眼可读",
      "字幕条是否遮挡关键图表或文字",
      "颜色对比是否足够",
      "是否有过强的结论诱导感",
      "给出具体可执行改进意见",
    ],
    outputSchema: {
      score: "number 0-100",
      strengths: ["string"],
      issues: ["string"],
      improvementSuggestions: ["string"],
    },
  }, null, 2);

  try {
    const res = await chatJsonWithImages<{
      score?: number;
      strengths?: string[];
      issues?: string[];
      improvementSuggestions?: string[];
    }>({
      systemPrompt,
      userPrompt,
      images: [{ path: review.framePath, mimeType: "image/jpeg" }],
      maxTokens: 1000,
      temperature: 0.2,
      retries: 1,
    });
    return {
      ...review,
      reviewMode: "qwen-vision",
      score: typeof res.score === "number" ? clamp(Math.round(res.score), 0, 100) : review.score,
      strengths: Array.isArray(res.strengths) ? res.strengths : review.strengths,
      issues: Array.isArray(res.issues) ? res.issues : review.issues,
      improvementSuggestions: Array.isArray(res.improvementSuggestions) ? res.improvementSuggestions : review.improvementSuggestions,
    };
  } catch {
    return null;
  }
}

function frameTime(startSec: number, durSec: number): number {
  if (durSec <= 1) return startSec + durSec / 2;
  return Math.max(startSec, startSec + durSec - 0.75);
}

async function extractFrame(mp4: string, timeSec: number, outPath: string): Promise<{ ok: boolean; message?: string }> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const args = ["-y", "-ss", timeSec.toFixed(3), "-i", mp4, "-frames:v", "1", "-q:v", "2", outPath];
  const res = await runSpawn("ffmpeg", args);
  if (res.code !== 0) return { ok: false, message: res.stderr.slice(-300) || `ffmpeg exit ${res.code}` };
  if (!await exists(outPath)) return { ok: false, message: "ffmpeg completed but frame file is missing" };
  return { ok: true };
}

async function exists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

interface SpawnResult { code: number; stdout: string; stderr: string; }
function runSpawn(cmd: string, args: string[]): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout?.on("data", d => stdout += d.toString());
    p.stderr?.on("data", d => stderr += d.toString());
    p.on("error", e => resolve({ code: -1, stdout, stderr: String(e?.message ?? e) }));
    p.on("exit", code => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
