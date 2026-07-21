import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { buildRunContext, readJson, writeJson } from "../../src/orchestrator/runContext.js";
import { createRunState } from "../../src/orchestrator/stateMachine.js";
import { auditTalkTrack } from "../../src/phases/04b-audit-talk.js";
import { auditVisualFrames } from "../../src/phases/10b-audit-visual.js";
import type { DialogueFile } from "../../src/schemas/dialogue.js";
import type { TalkPlan } from "../../src/schemas/talkPlan.js";
import type { AudioManifest } from "../../src/schemas/audioManifest.js";

test("talk-track audit writes scores and improvement suggestions", async () => {
  const root = await fs.mkdtemp(path.join("/tmp", "podcast-talk-audit-"));
  const ctx = await buildRunContext("/tmp/fixtures/match.html", root);
  const state = createRunState(ctx.matchId, ctx.reportPath);

  await writeJson(ctx.paths.talkPlan, plan(ctx.matchId));
  await writeJson(ctx.paths.dialogue, dialogue(ctx.matchId));

  const result = await auditTalkTrack(ctx, state, []);
  assert.equal(result.ok, true);

  const audit = await readJson<any>(path.join(ctx.paths.verifyDir, "talk-track-audit.json"));
  assert.equal(audit.gate, "talk-track");
  assert.ok(audit.overallScore >= 80);
  assert.ok(audit.summary.length > 0);
  assert.ok(Array.isArray(audit.improvementSuggestions));
  assert.ok(audit.sceneReviews.length >= 3);

  await fs.rm(root, { recursive: true, force: true });
});

test("talk-track audit fails on broken dual-host cadence", async () => {
  const root = await fs.mkdtemp(path.join("/tmp", "podcast-talk-audit-fail-"));
  const ctx = await buildRunContext("/tmp/fixtures/match.html", root);
  const state = createRunState(ctx.matchId, ctx.reportPath);

  await writeJson(ctx.paths.talkPlan, plan(ctx.matchId));
  const broken = dialogue(ctx.matchId);
  broken.scenes[1]!.lines = [
    line("s02-l1", "s02", "Analyst", "第一句连续分析。"),
    line("s02-l2", "s02", "Analyst", "第二句连续分析。"),
    line("s02-l3", "s02", "Analyst", "第三句连续分析。"),
  ];
  await writeJson(ctx.paths.dialogue, broken);

  const result = await auditTalkTrack(ctx, state, []);
  assert.equal(result.ok, false);
  assert.ok(result.issues?.some(i => i.kind === "talk-audit-dual-host-cadence"));

  await fs.rm(root, { recursive: true, force: true });
});

test("visual frame audit skips gracefully when final mp4 is unavailable", async () => {
  const root = await fs.mkdtemp(path.join("/tmp", "podcast-visual-audit-"));
  const ctx = await buildRunContext("/tmp/fixtures/match.html", root);
  const state = createRunState(ctx.matchId, ctx.reportPath);

  await writeJson(ctx.paths.talkPlan, plan(ctx.matchId));
  await writeJson(ctx.paths.audioManifest, audioManifest(ctx.matchId));
  await fs.writeFile(ctx.paths.compositionHtml, "<html><body>赛前概率观察</body></html>", "utf8");

  const result = await auditVisualFrames(ctx, state, []);
  assert.equal(result.ok, true);
  assert.ok(result.issues?.some(i => i.kind === "visual-audit-skipped-no-mp4"));

  const audit = await readJson<any>(path.join(ctx.paths.verifyDir, "visual-frame-audit.json"));
  assert.equal(audit.gate, "visual-frame");
  assert.equal(audit.skipped, true);
  assert.ok(Array.isArray(audit.improvementSuggestions));

  await fs.rm(root, { recursive: true, force: true });
});

test("image JSON client sends Qwen-compatible image_url payloads", async () => {
  const root = await fs.mkdtemp(path.join("/tmp", "podcast-image-llm-"));
  const imagePath = path.join(root, "scene.jpg");
  await fs.writeFile(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  let requestBody: any = null;
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      requestBody = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify({
              score: 91,
              strengths: ["画面层级清楚"],
              issues: [],
              improvementSuggestions: ["保持标题与字幕间距"],
            }),
          },
          finish_reason: "stop",
        }],
      }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  const prev = {
    gxBase: process.env.GX10_OPENAI_BASE_URL,
    gxKey: process.env.GX10_OPENAI_API_KEY,
    gxModel: process.env.GX10_MODEL_NAME,
    azureEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
    azureKey: process.env.AZURE_OPENAI_API_KEY,
    azureDeployment: process.env.AZURE_OPENAI_DEPLOYMENT,
  };

  process.env.GX10_OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.GX10_OPENAI_API_KEY = "test-key";
  process.env.GX10_MODEL_NAME = "qwen-vision-test";
  delete process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_API_KEY;
  delete process.env.AZURE_OPENAI_DEPLOYMENT;

  try {
    const { chatJsonWithImages } = await import(`../../src/tools/llmClient.js?image-test-${Date.now()}`);
    const result = await chatJsonWithImages<{ score: number }>({
      systemPrompt: "Only JSON",
      userPrompt: "Review this scene.",
      images: [{ path: imagePath, mimeType: "image/jpeg" }],
      maxTokens: 200,
      temperature: 0.2,
      retries: 0,
    });

    assert.equal(result.score, 91);
    assert.equal(requestBody.model, "qwen-vision-test");
    assert.equal(requestBody.response_format.type, "json_object");
    const content = requestBody.messages[1].content;
    assert.equal(content[0].type, "text");
    assert.equal(content[1].type, "image_url");
    assert.match(content[1].image_url.url, /^data:image\/jpeg;base64,/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
    restoreEnv("GX10_OPENAI_BASE_URL", prev.gxBase);
    restoreEnv("GX10_OPENAI_API_KEY", prev.gxKey);
    restoreEnv("GX10_MODEL_NAME", prev.gxModel);
    restoreEnv("AZURE_OPENAI_ENDPOINT", prev.azureEndpoint);
    restoreEnv("AZURE_OPENAI_API_KEY", prev.azureKey);
    restoreEnv("AZURE_OPENAI_DEPLOYMENT", prev.azureDeployment);
  }
});

function plan(matchId: string): TalkPlan {
  const baseScene = (id: string, title: string, kind: any, narrativeBeat: any) => ({
    id,
    title,
    narrativeBeat,
    blockRefs: [],
    dataPointRefs: [],
    targetSec: 40,
    transitionIn: "none" as const,
    visualSpec: { kind, props: {} },
  });
  return {
    matchId,
    totalTargetSec: 140,
    scenes: [
      baseScene("s01", "赛前变量", "hook", "hook"),
      baseScene("s02", "模型概率分布", "market-grid", "data-drill"),
      baseScene("s03", "内容边界", "compliance", "compliance"),
    ],
    dropped: [],
    createdAt: new Date().toISOString(),
  };
}

function dialogue(matchId: string): DialogueFile {
  const scenes = [
    { sceneId: "s01", lines: [
      line("s01-l1", "s01", "Anchor", "今晚这场比赛，赛前有哪些变量？"),
      line("s01-l2", "s01", "Analyst", "本内容仅作赛前概率观察和体育数据讨论。"),
      line("s01-l3", "s01", "Anchor", "那先看核心分布。"),
    ] },
    { sceneId: "s02", lines: [
      line("s02-l1", "s02", "Anchor", "模型概率分布怎么理解？"),
      line("s02-l2", "s02", "Analyst", "主队一侧略高，但只是情景分布。"),
      line("s02-l3", "s02", "Anchor", "也就是别放大单一结论。"),
    ] },
    { sceneId: "s03", lines: [
      line("s03-l1", "s03", "Anchor", "最后说明内容边界。"),
      line("s03-l2", "s03", "Analyst", "以上内容仅供体育数据讨论。"),
      line("s03-l3", "s03", "Analyst", "模型概率不代表比赛结果承诺。"),
      line("s03-l4", "s03", "Analyst", "请理性看球，不作为任何参与决策依据。"),
    ] },
  ];
  return {
    matchId,
    scenes,
    totalEstSec: 120,
    totalChars: scenes.flatMap(s => s.lines).reduce((n, l) => n + l.estChars, 0),
    createdAt: new Date().toISOString(),
  };
}

function audioManifest(matchId: string): AudioManifest {
  return {
    matchId,
    totalSec: 120,
    sampleRate: 24000,
    channels: 1,
    lines: [],
    scenes: [
      { sceneId: "s01", startSec: 0, endSec: 40, durSec: 40, lineIds: [] },
      { sceneId: "s02", startSec: 40, endSec: 80, durSec: 40, lineIds: [] },
      { sceneId: "s03", startSec: 80, endSec: 120, durSec: 40, lineIds: [] },
    ],
    interLineGapMs: 150,
    interSpeakerGapMs: 250,
    createdAt: new Date().toISOString(),
  };
}

function line(id: string, sceneId: string, speaker: "Anchor" | "Analyst", text: string) {
  return {
    id,
    sceneId,
    speaker,
    text,
    ssml: `<speak>${text}</speak>`,
    targetSec: 4,
    estChars: text.length,
  };
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
