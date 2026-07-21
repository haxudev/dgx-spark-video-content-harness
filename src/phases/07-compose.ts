import * as fs from "node:fs/promises";
import * as path from "node:path";
import Handlebars from "handlebars";
import { writeJson, type RunContext } from "../orchestrator/runContext.js";
import type { Issue } from "../orchestrator/supervisor.js";
import type { RunState } from "../orchestrator/stateMachine.js";
import { readJson, maybeReadJson } from "../orchestrator/runContext.js";
import type { BlocksFile, Block } from "../schemas/block.js";
import type { TalkPlan, VisualKind } from "../schemas/talkPlan.js";
import type { AudioManifest, AudioLine } from "../schemas/audioManifest.js";
import type { MarketData } from "../tools/marketExtractor.js";
import { buildComposition } from "../tools/hfmlBuilder.js";
import { buildSubtitles } from "../tools/subtitles.js";
import { loadBanned, allBannedRegex } from "../tools/configLoader.js";
import { isImageGenAvailable, buildBackgroundPromptCandidates, generateImageWithFallback } from "../tools/backgroundImage.js";
import { isCoverGenAvailable, buildCoverPromptCandidates, coverDurationSec } from "../tools/coverImage.js";

/** Strip banned terms from HTML body content, preserving tags. */
function stripBannedFromHtml(html: string): string {
  const bannedRegex = allBannedRegex();
  return html.replace(/>([^<]*)</g, (_, content) => {
    return ">" + content.replace(bannedRegex, "某项数据") + "<";
  });
}

export const compose = async (
  ctx: RunContext,
  _state: RunState,
  _priorIssues: Issue[],
): Promise<{ ok: boolean; issues?: Issue[] }> => {
  const blocks = await readJson<BlocksFile>(ctx.paths.blocks);
  const plan = await readJson<TalkPlan>(ctx.paths.talkPlan);
  const mani = await readJson<AudioManifest>(ctx.paths.audioManifest);
  const market = await maybeReadJson<MarketData>(ctx.paths.marketData);

  const dialogue = await readJson<import("../schemas/dialogue.js").DialogueFile>(ctx.paths.dialogue);

  // 0. Opening cover image AND persistent background image, both via Azure
  // gpt-image-2. When the image deployment is configured (and not explicitly
  // skipped) these are MANDATORY assets — the Act-1 cover must show the two
  // teams and bg.png is the persistent full-video backdrop, so a failure here
  // becomes a blocking COMPOSE issue (the supervisor retries COMPOSE; the
  // per-prompt fallback + per-call retries make transient image-API errors
  // recoverable). Only when the deployment is unconfigured / HARNESS_SKIP_* is
  // set does the composition fall back to its data card / gradient backdrop.
  // The two assets are authored + generated CONCURRENTLY to halve COMPOSE wall
  // time; each is individually bounded by HARNESS_BGIMAGE_TIMEOUT_MS.
  const coverPath = path.join(ctx.paths.compositionDir, "cover.png");
  const bgPath = path.join(ctx.paths.compositionDir, "bg.png");
  await fs.mkdir(ctx.paths.compositionDir, { recursive: true });

  const coverTask = (async (): Promise<{ coverImage?: string; coverSec: number }> => {
    if (process.env.HARNESS_SKIP_COVER !== "1" && await exists(coverPath)) {
      return { coverImage: "cover.png", coverSec: coverDurationSec() };
    }
    if (isCoverGenAvailable()) {
      try {
        const coverPrompts = await buildCoverPromptCandidates({
          matchZh: market?.hero?.matchZh ?? plan.matchId,
          league: market?.hero?.league,
          homeTeam: market?.hero?.homeName,
          awayTeam: market?.hero?.awayName,
          outcomes: market?.market1x2?.outcomes,
          topScores: market?.correctScore?.topScores,
          topGoals: market?.totalGoals?.topGoals,
        });
        const ok = await generateImageWithFallback(coverPrompts, coverPath);
        if (ok) return { coverImage: "cover.png", coverSec: coverDurationSec() };
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.warn(`[compose] cover image generation failed (${e?.message ?? e})`);
      }
    }
    return { coverSec: 0 };
  })();

  const bgTask = (async (): Promise<string | undefined> => {
    if (process.env.HARNESS_SKIP_BGIMAGE !== "1" && await exists(bgPath)) {
      return "bg.png";
    }
    if (isImageGenAvailable()) {
      try {
        const bgPrompts = await buildBackgroundPromptCandidates({
          matchZh: market?.hero?.matchZh ?? plan.matchId,
          league: market?.hero?.league,
          homeTeam: market?.hero?.homeName,
          awayTeam: market?.hero?.awayName,
        });
        const ok = await generateImageWithFallback(bgPrompts, bgPath);
        if (ok) return "bg.png";
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.warn(`[compose] background image generation failed (${e?.message ?? e})`);
      }
    }
    return undefined;
  })();

  const [coverRes, bgImage] = await Promise.all([coverTask, bgTask]);
  const coverImage = coverRes.coverImage;
  const coverSec = coverRes.coverSec;

  // 1. composition.html
  const html = await buildComposition({
    blocks: blocks.blocks,
    plan,
    manifest: mani,
    dialogue,
    market,
    bgImage,
    coverImage,
    coverSec,
    templatesDir: path.resolve(process.cwd(), "templates"),
  });
  // Sanitize source data that may have leaked banned/compliance terms into HTML text nodes
  const sanitizedHtml = stripBannedFromHtml(html);
  await fs.writeFile(ctx.paths.compositionHtml, sanitizedHtml, "utf8");

  // 1a. Copy vendor JS (gsap, echarts) into composition/vendor so the renderer
  // can load them with a relative path. Avoids depending on outbound CDN
  // access inside the headless Chrome that hyperframes spawns.
  const vendorDir = path.join(ctx.paths.compositionDir, "vendor");
  await fs.mkdir(vendorDir, { recursive: true });
  const vendorPairs: Array<[string, string]> = [
    [path.resolve(process.cwd(), "node_modules/gsap/dist/gsap.min.js"),       path.join(vendorDir, "gsap.min.js")],
    [path.resolve(process.cwd(), "node_modules/echarts/dist/echarts.min.js"), path.join(vendorDir, "echarts.min.js")],
  ];
  for (const [src, dst] of vendorPairs) {
    try { await fs.copyFile(src, dst); }
    catch (e: any) { /* non-fatal: missing dep will surface in verify-visual */ }
  }

  // 2. copy audio files into composition/ so relative paths resolve
  const compAudioDir = path.join(ctx.paths.compositionDir, "audio");
  await fs.mkdir(compAudioDir, { recursive: true });
  for (const line of mani.lines) {
    const src = path.resolve(ctx.paths.audioDir, path.basename(line.wavPath));
    const dst = path.join(compAudioDir, path.basename(line.wavPath));
    try { await fs.copyFile(src, dst); } catch {}
  }

  // 3. subtitles.vtt + word-level VTT
  const vtt = buildSubtitles(mani, dialogue, { wordLevel: true });
  await fs.writeFile(ctx.paths.subtitles, vtt, "utf8");
  await fs.writeFile(path.join(ctx.paths.compositionDir, "subtitles.vtt"), vtt, "utf8");

  // 4. quick lint
  const issues: Issue[] = [];
  if (!html.includes("data-composition-id")) issues.push({
    kind: "compose-no-stage-attr", severity: "error",
    message: `composition.html missing data-composition-id`,
  });
  if (!html.includes("<audio")) issues.push({
    kind: "compose-no-audio", severity: "error",
    message: `composition.html has no <audio> tags`,
  });
  // verify every scene rendered
  for (const sc of plan.scenes) {
    if (!html.includes(`data-scene-id="${sc.id}"`)) {
      issues.push({
        kind: "compose-scene-missing",
        severity: "error",
        message: `scene ${sc.id} not rendered in composition.html`,
      });
    }
  }

  // gpt-image-2 assets are固化 into the pipeline: when an image deployment is
  // configured (and not explicitly skipped), the Act-1 two-team cover and the
  // persistent full-video background are REQUIRED. A miss here is a blocking
  // error so the supervisor retries COMPOSE (cached successes are reused) rather
  // than silently shipping the gradient/data-card fallback.
  if (isCoverGenAvailable() && !coverImage) {
    issues.push({
      kind: "compose-cover-missing",
      severity: "error",
      message: "gpt-image-2 首幕封面图 cover.png 未生成（已配置图像部署但产出失败）",
    });
  }
  if (isImageGenAvailable() && !bgImage) {
    issues.push({
      kind: "compose-bg-missing",
      severity: "error",
      message: "gpt-image-2 视频背景底图 bg.png 未生成（已配置图像部署但产出失败）",
    });
  }

  await writeJson(`${ctx.paths.verifyDir}/compose.json`, {
    sceneCount: plan.scenes.length,
    audioLineCount: mani.lines.length,
    coverImage: coverImage ?? null,
    coverSec,
    bgImage: bgImage ?? null,
    imageGenConfigured: { cover: isCoverGenAvailable(), bg: isImageGenAvailable() },
    bytesHtml: Buffer.byteLength(html, "utf8"),
    bytesVtt: Buffer.byteLength(vtt, "utf8"),
    issues,
    at: new Date().toISOString(),
  });

  return { ok: !issues.some(i => i.severity === "error"), issues };
};

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
