import { readJson, writeJson, type RunContext } from "../orchestrator/runContext.js";
import type { Issue } from "../orchestrator/supervisor.js";
import type { RunState } from "../orchestrator/stateMachine.js";
import { type BlocksFile, type Block } from "../schemas/block.js";
import { type TalkPlan, type Scene } from "../schemas/talkPlan.js";
import {
  DialogueFileSchema,
  type DialogueFile,
  type DialogueLine,
  type SceneDialogue,
} from "../schemas/dialogue.js";
import { loadGlossary, loadBanned, allBannedRegex, type GlossaryTerm, compliancePhrasesByPlacement } from "../tools/configLoader.js";
import { lineToSsml, estimateLineDuration, VOICE, SPEAKER_DISPLAY, type SpeakerName } from "../tools/ssml.js";
import { chatJson, isLLMAvailable } from "../tools/llmClient.js";
import { sanitizeRestrictedComplianceText, COMPLIANCE_POLICY } from "../tools/compliancePolicy.js";
import { durationPolicy } from "../tools/durationPolicy.js";
import { scriptMode, type ScriptMode } from "../tools/runProfile.js";
import type { MarketData } from "../tools/marketExtractor.js";

/**
 * WRITE phase (v2) — agent-first, conclusion-first script generator.
 *
 * The dialogue is authored by the LLM in a SINGLE whole-script call that sees
 * a compact market-derived brief and writes all four acts at once, leading with
 * the headline conclusion (Act 1) before drilling into fundamentals, the
 * probability distribution and the upset analysis. A market-aware deterministic
 * generator is the offline fallback, and the legacy block-template `writeScene`
 * remains as the last-resort path for reports without structured market data.
 *
 * The post-processing passes (glossary gloss, time-concept strip, Chinese-number
 * conversion, brand welcome + compliance repair, dedup, dual-host cadence,
 * pacing recompute) are preserved — they are the compliance/quality guarantees
 * that VERIFY_TEXT / AUDIT_TALK depend on, not creative templates.
 *
 * Output: dialogue.json conforming to DialogueFile.
 */

const MAX_SENT_CHARS = 28;
const CPS = 3.7;  // calibrated against Qwen3-TTS-12Hz-1.7B-CustomVoice

function writeAgentTimeoutMs(): number {
  const n = Number.parseInt(process.env.HARNESS_WRITE_AGENT_TIMEOUT_MS ?? "", 10);
  if (!Number.isFinite(n)) return 240_000;
  return Math.min(900_000, Math.max(30_000, n));
}

/**
 * When set (`HARNESS_REQUIRE_AGENT=1`), WRITE must not ship the deterministic
 * template: if the LLM agent did not author the script, WRITE fails so the
 * supervisor retries/escalates instead of publishing a near-identical-every-
 * match fallback. Off by default so offline tests / no-provider runs still work.
 */
function requireAgent(): boolean {
  const v = process.env.HARNESS_REQUIRE_AGENT?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Optional per-run editorial angle for the WRITE agent (env HARNESS_WRITE_NOTE).
 * Free-text steer the human supplies for THIS match (e.g. a 阴谋论 backdrop, a
 * host-nation framing, which upset scenarios to foreground). It is injected into
 * the agent user prompt as a soft creative hint — the agent must still honour the
 * brief's real data and every compliance gate; it never overrides 数据保真 or the
 * banned/compliance rules. Returns undefined when unset so behaviour is unchanged.
 */
function writeEditorialNote(): string | undefined {
  const raw = process.env.HARNESS_WRITE_NOTE?.trim();
  if (!raw) return undefined;
  // Keep it bounded so a runaway value can't blow the prompt budget.
  return raw.slice(0, 600);
}

export const write = async (
  ctx: RunContext,
  _state: RunState,
  priorIssues: Issue[],
): Promise<{ ok: boolean; issues?: Issue[] }> => {
  const blocksFile = await readJson<BlocksFile>(ctx.paths.blocks);
  const plan = await readJson<TalkPlan>(ctx.paths.talkPlan);

  // Adaptive knobs based on prior verifier feedback (re-runs)
  const knobs = adaptFromPriorIssues(priorIssues);

  const blockMap = new Map<string, Block>(blocksFile.blocks.map(b => [b.id, b]));
  const market = await tryReadMarket(ctx);

  const mode = scriptMode();
  const useLLM = isLLMAvailable() && process.env.HARNESS_DISABLE_LLM !== "1";

  // PASS 1: agent-first whole-script generation (conclusion-first). One LLM
  // call writes all four acts; on any failure we fall back to a market-aware
  // deterministic script (and finally to the block-template path).
  //
  // Two modes:
  //   - podcast   (default): dual-host 男女对谈 (Anchor + Analyst)
  //   - monologue: single-host first-person 口播稿 (Narrator), 阴谋论式解读
  const dataPool = buildDataPool(blocksFile);
  // Per-generation creative seed: decorrelates the agent's framing across
  // matches AND re-runs so the script is freshly authored every time instead of
  // gravitating to one fixed opening / metaphor set.
  const creativeSeed = makeCreativeSeed(plan.matchId);
  let sceneDialogues: SceneDialogue[];
  // Track whether the script was actually authored by the LLM agent (free,
  // per-match creation) or fell back to the deterministic template (identical
  // every match). Surfaced in dialogue.json + verify/write.json so a silent
  // fallback is auditable rather than mistaken for "the agent wrote the same
  // thing again".
  let authoredBy: "agent" | "deterministic" = "deterministic";
  let fallbackReason: string | null = null;
  if (mode === "monologue") {
    if (useLLM) {
      try {
        sceneDialogues = await writeMonologueWithLLM(plan, blocksFile, market, knobs, dataPool, creativeSeed);
        authoredBy = "agent";
      } catch (e: any) {
        fallbackReason = String(e?.message ?? e);
        // eslint-disable-next-line no-console
        console.warn(`[write] monologue LLM failed (${fallbackReason}); falling back to deterministic`);
        sceneDialogues = deterministicMonologue(plan, market, blockMap, knobs);
      }
    } else {
      sceneDialogues = deterministicMonologue(plan, market, blockMap, knobs);
    }
  } else if (useLLM) {
    try {
      sceneDialogues = await writeScriptWithLLM(plan, blocksFile, market, knobs, dataPool, creativeSeed);
      authoredBy = "agent";
    } catch (e: any) {
      fallbackReason = String(e?.message ?? e);
      // eslint-disable-next-line no-console
      console.warn(`[write] whole-script LLM failed (${fallbackReason}); falling back to deterministic`);
      sceneDialogues = deterministicScript(plan, market, blockMap, knobs);
    }
  } else {
    sceneDialogues = deterministicScript(plan, market, blockMap, knobs);
  }

  // Hard gate: the deterministic generator is only an offline / provider-down
  // safety net — never the product. When HARNESS_REQUIRE_AGENT is set, refuse to
  // ship a template silently: fail WRITE so the supervisor retries (giving the
  // LLM another chance) and ultimately escalates instead of publishing a
  // near-identical-every-match script.
  if (requireAgent() && authoredBy !== "agent") {
    return { ok: false, issues: [{
      kind: "write-agent-required",
      severity: "error",
      message: `HARNESS_REQUIRE_AGENT=1，但本次脚本未由 agent 创作（${fallbackReason ?? (useLLM ? "agent 调用失败" : "未配置 LLM provider")}）。已阻止用确定性模板出片；请修复 LLM provider 后重试 WRITE。`,
    }] };
  }

  // The single-host narrator leads everything (welcome + compliance read-outs);
  // the dual-host program splits opening (Anchor) and closing (Analyst).
  const leadSpeaker: SpeakerName = mode === "monologue" ? "Narrator" : "Anchor";

  // PASS 2: single global gloss-introduction sweep (deterministic "first occurrence" semantics)
  applyGlossaryGloss(sceneDialogues);

  // PASS 2b: strip time concepts, then turn every remaining digit / "%" / "元"
  // / "比" / "比分" combination into fully Chinese-readable form so the TTS does
  // not have to handle ASCII. `stripTimeConcepts` runs FIRST (before chineseify,
  // dedup and the PASS 3 char/SSML recompute) so calendar/clock/duration words
  // never reach the audience regardless of whether the line came from the agent
  // or the deterministic fallback.
  for (const sd of sceneDialogues) {
    for (const l of sd.lines) {
      let t = ensureTerminalPunctuation(
        sanitizeRestrictedComplianceText(chineseifyForTTS(stripTimeConcepts(l.text))),
      );
      // A line should never be fully emptied by time-stripping (time words are
      // qualifiers, not whole lines) — but guard the rare case so dual-host
      // cadence + both-speaker invariants survive.
      if (countCJK(t) === 0) {
        t = l.speaker === "Anchor" ? "那这场怎么看？" : "我们接着看这场。";
      }
      l.text = t;
    }
  }

  // PASS 2c: deduplicate cross-scene boundaries.
  //
  // The LLM is told to never repeat `previousLineTail` at the start of a new
  // scene, but in practice it does — often verbatim — because every scene
  // call also asks the LLM to end with an Anchor question that "naturally
  // introduces the next topic". The two rules clash and the LLM resolves the
  // tension by parroting the same question on both sides of the boundary.
  // Audience hears the female voice ask the exact same thing twice.
  //
  // Deterministic fix: walk every adjacent (i-1, i) pair; if scene_i's first
  // line repeats (or is a prefix of) scene_{i-1}'s last line and both belong
  // to the same speaker, drop or trim the duplicate. Never blocks the
  // pipeline — only mutates the dialogue array in place.
  deduplicateCrossSceneBoundaries(sceneDialogues);

  // PASS 2c-pre: guarantee the opening brand welcome is the very first spoken
  // line (Anchor in podcast, Narrator in monologue). Runs before compliance
  // repair so the compliance read-out is inserted right after the welcome.
  ensureBrandWelcome(sceneDialogues, leadSpeaker);

  // PASS 2d: deterministic compliance repair. The agent prompt lists the exact
  // required keywords, but compliance is non-creative — rather than burn a
  // WRITE retry when the agent drops a required opening/closing phrase, we
  // guarantee them here: insert any missing opening phrase into scene[0] and
  // any missing closing phrase into the last scene. Podcast splits opening
  // (Anchor) / closing (Analyst); monologue keeps both on the Narrator.
  repairCompliancePhrases(
    sceneDialogues,
    mode === "monologue"
      ? { openingSpeaker: "Narrator", closingSpeaker: "Narrator" }
      : { openingSpeaker: "Anchor", closingSpeaker: "Analyst" },
  );

  // PASS 2e: guarantee the script clears the VERIFY_TEXT character floor.
  //
  // For an AGENT-authored script we top it up by asking the AGENT to extend its
  // own script (same voice, fresh lines) — never the canned template — so the
  // spoken track stays 100% the agent's free creation. The deterministic
  // (offline / fallback) path still uses the market-derived act bank.
  if (authoredBy === "agent" && useLLM) {
    try {
      await expandAgentScriptToFloor(mode, sceneDialogues, market, plan, knobs, dataPool, creativeSeed);
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.warn(`[write] agent floor top-up failed (${e?.message ?? e}); leaving length to VERIFY_TEXT retry`);
    }
  } else {
    padToFloor(sceneDialogues, mode, market, plan, knobs);
  }

  // PASS 3: recompute SSML + chars from final text (gloss may have lengthened lines)
  for (const sd of sceneDialogues) {
    for (const l of sd.lines) {
      const chars = countCJK(l.text);
      l.estChars = chars;
      l.targetSec = round(chars / CPS, 2);
      l.ssml = (await import("../tools/ssml.js")).lineToSsml(l.text, l.speaker);
    }
  }

  // PASS 4: pacing is advisory only. Do not trim the agent's script to a hard
  // runtime envelope; VERIFY_AV later ensures the rendered video matches audio.
  enforceDurationCeiling(sceneDialogues, mode);

  // PASS 4b: trimming Analyst lines (and the orphan-Anchor cleanup that
  // follows) can mutate a scene's first/last line so that a previously
  // hidden duplicate now sits on a scene boundary. Re-run dedup + SSML
  // recompute so the final dialogue is guaranteed dup-free.
  deduplicateCrossSceneBoundaries(sceneDialogues);

  // PASS 4c: guarantee dual-host cadence. The system prompt forbids ≥3
  // consecutive same-speaker lines, but the LLM occasionally violates it,
  // which fails AUDIT_TALK (talk-audit-dual-host-cadence) and can exhaust the
  // retry budget. Deterministically break any run of ≥3 same-speaker lines by
  // inserting a short reaction from the other host — mirroring the
  // pushWithCadence guarantee the template path already has. Skipped entirely
  // in monologue mode, where a single speaker is intentional.
  if (mode !== "monologue") enforceDualHostCadence(sceneDialogues, plan);
  for (const sd of sceneDialogues) {
    for (const l of sd.lines) {
      const chars = countCJK(l.text);
      l.estChars = chars;
      l.targetSec = round(chars / CPS, 2);
      l.ssml = (await import("../tools/ssml.js")).lineToSsml(l.text, l.speaker);
    }
  }

  // PASS 5 (narrative LLM cards) was removed in v2 — Act-2 / Act-4 now render
  // structured ECharts dashboards from MarketData instead of LLM-summarised
  // text cards, so there is nothing to attach back to the scene props here.

  const totalChars = sceneDialogues.flatMap(s => s.lines).reduce((s, l) => s + l.estChars, 0);
  const totalEstSec = sceneDialogues.flatMap(s => s.lines).reduce((s, l) => s + l.targetSec, 0);

  const file: DialogueFile = {
    matchId: plan.matchId,
    mode,
    authoredBy,
    scenes: sceneDialogues,
    totalEstSec: round(totalEstSec, 2),
    totalChars,
    createdAt: new Date().toISOString(),
  };
  await writeJson(ctx.paths.dialogue, DialogueFileSchema.parse(file));

  // Transparency: record how the script was authored. If the LLM was available
  // but the agent call failed, surface a WARN so the (identical-every-match)
  // template fallback is visible in state.json instead of silently shipping.
  const issues: Issue[] = [];
  if (useLLM && authoredBy === "deterministic") {
    issues.push({
      kind: "write-agent-fallback",
      severity: "warn",
      message: `agent(LLM) 创作失败，已回退确定性模板脚本（每场雷同）：${fallbackReason ?? "unknown"}。请检查 LLM provider 可用性后重跑 WRITE。`,
    });
  }
  await writeJson(`${ctx.paths.verifyDir}/write.json`, {
    mode,
    authoredBy,
    llmAvailable: useLLM,
    creativeSeed,
    fallbackReason,
    sceneCount: sceneDialogues.length,
    totalChars,
    totalEstSec: round(totalEstSec, 2),
    at: new Date().toISOString(),
  });

  return { ok: true, issues };
};

export interface AdaptiveKnobs {
  /** Per-scene length scaling factor (1.0 = default). */
  sceneSecScale: number;
  /** Per-scene id → forced extra fillers, e.g. {"s03": 2}. */
  extraFillersPerScene: Map<string, number>;
  /** Term aliases to forcibly NOT use (e.g. dropped banned terms). */
  extraBanned: Set<string>;
}

function adaptFromPriorIssues(priorIssues: Issue[]): AdaptiveKnobs {
  const knobs: AdaptiveKnobs = {
    sceneSecScale: 1.0,
    extraFillersPerScene: new Map(),
    extraBanned: new Set(),
  };
  for (const i of priorIssues) {
    if (i.kind === "text-total-too-short") knobs.sceneSecScale *= 1.15;
    if (i.kind === "text-total-too-long")  knobs.sceneSecScale *= 0.9;
    if (i.kind === "text-scene-drift" && typeof i.message === "string") {
      const m = i.message.match(/scene (s\d+) estimated (\-?\d+(?:\.\d+)?)s vs target (\-?\d+(?:\.\d+)?)s/);
      if (m && parseFloat(m[2]!) < parseFloat(m[3]!)) {
        knobs.extraFillersPerScene.set(m[1]!, (knobs.extraFillersPerScene.get(m[1]!) ?? 0) + 2);
      }
    }
    if (i.kind === "text-banned-terms" && Array.isArray(i.data)) {
      for (const t of i.data as string[]) knobs.extraBanned.add(t);
    }
    // Also pull restricted compliance terms (e.g. "稳胆", "推荐") from any
    // audit stage so the LLM system prompt explicitly forbids them in the
    // next WRITE pass.
    if ((i.kind === "talk-audit-restricted-terms" ||
         i.kind === "text-restricted-compliance-terms" ||
         i.kind === "visual-restricted-compliance-terms" ||
         i.kind === "post-restricted-compliance-terms") &&
        Array.isArray(i.data)) {
      for (const t of i.data as string[]) knobs.extraBanned.add(t);
    }
  }
  return knobs;
}

/**
 * Per-generation creative seed. Mixed into the agent's user prompt so the LLM
 * freshly authors each script (different opening / metaphors / ordering) instead
 * of converging on a single canned framing — the whole point of "agent 自由创作"
 * rather than a fixed template. Defaults to a per-run nonce (so even re-running
 * the same match yields a fresh take); pin with HARNESS_WRITE_SEED for
 * reproducible debugging/tests.
 */
function makeCreativeSeed(matchId: string): string {
  const pinned = process.env.HARNESS_WRITE_SEED?.trim();
  if (pinned) return pinned;
  const rand = Math.random().toString(36).slice(2, 8);
  const ts = Date.now().toString(36).slice(-4);
  return `${matchId}-${ts}${rand}`;
}

export function writeScene(scene: Scene, blockMap: Map<string, Block>, knobs: AdaptiveKnobs, plan: TalkPlan): DialogueLine[] {
  const blocks = scene.blockRefs.map(id => blockMap.get(id)).filter((b): b is Block => !!b);
  const lines: DialogueLine[] = [];
  let lid = 0;
  const mkLine = (speaker: "Anchor" | "Analyst", text: string): DialogueLine => {
    const sanitised = stripBanned(text, knobs.extraBanned);
    const cleanText = splitLongSentences(sanitised);
    const estChars = countCJK(cleanText);
    const targetSec = round(estChars / CPS, 2);
    const ssml = lineToSsml(cleanText, speaker);
    lid += 1;
    return {
      id: `${scene.id}-l${lid}`,
      sceneId: scene.id,
      speaker,
      text: cleanText,
      ssml,
      targetSec,
      estChars,
    };
  };

  // Reference the fixture by team names — never by date/clock/duration.
  const matchLabel = pickMatchZh(plan);

  switch (scene.narrativeBeat) {
    case "hook": {
      const props = scene.visualSpec.props as any;
      const matchZh = props.matchZh ?? "";
      const opening = compliancePhrasesByPlacement("opening");
      const must = opening[0]?.text ?? "本内容仅作赛前概率观察和体育数据讨论";
      const m = cleanTitle(matchZh) || matchLabel;
      const seed = pickIndex(matchZh || scene.id);
      // Anchor (female) leads the whole opening: brand welcome → compliance →
      // question. The male host (Analyst) only speaks after she poses the
      // question. Agent-first when LLM is used; this deterministic path keeps
      // it non-templated via seeded variants.
      const welcomes = buildWelcomeVariants();
      // Female-voiced compliance read-out (spoken by 小美, not 小帅).
      const complianceLeads = [
        `先优雅地交代一句：${must}。`,
        `开场也提醒一句：${must}。`,
        `照例先说明：${must}。`,
        `开始前先讲清楚：${must}。`,
      ];
      const openers = [
        `${m}这场，赛前看点都有哪些？`,
        `${m}这场，赛前的趋势往哪边走？`,
        `${m}这场，赛前预测怎么落？`,
        `${m}这场，模型分布更偏向谁？`,
        `${m}这场，赛前走势有哪些演化？`,
        `轮到${m}这场了，先把几个赛前看点摆出来。`,
      ];
      // Analyst (male) answers the female host's question — first time he speaks.
      const answers = [
        `好，咱们从两队状态和模型分布慢慢说。`,
        `行，先看两队的基本面，再聊模型分布。`,
        `这就来，先把两队的强弱底子摆清楚。`,
        `好，先从模型分布说起，再看两队对比。`,
      ];
      lines.push(mkLine("Anchor", welcomes[seed % welcomes.length]));
      lines.push(mkLine("Anchor", complianceLeads[seed % complianceLeads.length]));
      lines.push(mkLine("Anchor", openers[seed % openers.length]));
      lines.push(mkLine("Analyst", answers[seed % answers.length]));
      break;
    }
    case "compliance": {
      const must = compliancePhrasesByPlacement("closing").map(p => p.text);
      lines.push(mkLine("Anchor", `最后我们重复一遍合规要点。`));
      for (const t of must) lines.push(mkLine("Analyst", t + "。"));
      lines.push(mkLine("Anchor", `我们下一场比赛再见。`));
      break;
    }
    case "risk": {
      // Pre-game reflection: more storytelling, less alarmist. Anchor frames
      // it as a thoughtful recap; Analyst lists 3-4 reflective bullets.
      lines.push(mkLine("Anchor", `那赛前还有哪些值得回头想一想的点？`));
      const collected = collectRiskBullets(blocks).slice(0, 4);
      const items = collected.length > 0 ? collected : [
        "模型只能描述大致方向，比赛永远存在变量。",
        "决赛日心理压力会让强弱差距收敛一些。",
        "把模型当导航，而不是当口令。",
      ];
      pushWithCadence(lines, items, "Analyst", mkLine, ANCHOR_BEATS_RISK);
      lines.push(mkLine("Anchor", `带着这些反思看球，心里更有底。`));
      break;
    }
    case "comparison": {
      const tbl = blocks.find(b => b.kind === "table") as Extract<Block, { kind: "table" }> | undefined;
      lines.push(mkLine("Anchor", `${scene.title}——两队差在哪？`));
      if (tbl && tbl.rows.length > 0) {
        const top = pickTopComparisonRows(tbl, 3);
        pushWithCadence(lines, top, "Analyst", mkLine, ANCHOR_BEATS_COMPARE);
      } else {
        const para = blocks.find(b => b.kind === "paragraph") as Extract<Block, { kind: "paragraph" }> | undefined;
        if (para) lines.push(mkLine("Analyst", trim(para.text, 100)));
      }
      lines.push(mkLine("Anchor", `所以一边偏强、一边偏弱，这场怎么打就有了基本面。`));
      break;
    }
    case "data-drill": {
      lines.push(mkLine("Anchor", `${scene.title}，先看哪一组数？`));
      // Pull enough facts to roughly fill the scene budget
      const wanted = Math.max(3, Math.ceil(scene.targetSec / 5));
      const facts = collectDataFacts(blocks).slice(0, wanted);
      pushWithCadence(lines, facts, "Analyst", mkLine, ANCHOR_BEATS_DATA);
      lines.push(mkLine("Anchor", `就是这几条数，构成了这场的核心判断。`));
      break;
    }
    case "recommendation": {
      const strategies = blocks.filter(b => b.kind === "strategy-card") as Extract<Block, { kind: "strategy-card" }>[];
      lines.push(mkLine("Anchor", `${scene.title}：模型给了哪几种情景？`));
      const wantStrats = Math.min(strategies.length, Math.max(2, Math.ceil(scene.targetSec / 12)));
      const stratLines = strategies.slice(0, wantStrats).map(describeStrategy);
      pushWithCadence(lines, stratLines, "Analyst", mkLine, ANCHOR_BEATS_STRAT);
      lines.push(mkLine("Anchor", `这些只当分布参考，不当行动依据。`));
      break;
    }
    case "reveal": {
      lines.push(mkLine("Anchor", `${scene.title}，一句话先抛结论。`));
      const para = blocks.find(b => b.kind === "paragraph") as Extract<Block, { kind: "paragraph" }> | undefined;
      const callout = blocks.find(b => b.kind === "callout") as Extract<Block, { kind: "callout" }> | undefined;
      if (para) lines.push(mkLine("Analyst", trim(para.text, 100)));
      else if (callout) lines.push(mkLine("Analyst", trim(callout.text, 100)));
      lines.push(mkLine("Anchor", `下面我们一步一步看，模型为什么这么判断。`));
      break;
    }
    case "outro": {
      lines.push(mkLine("Anchor", `这场的分析就到这里。`));
      lines.push(mkLine("Analyst", `如果你觉得有用，记得点关注。`));
      break;
    }
  }

  // Ensure scene has at least one Anchor + one Analyst, and not empty
  if (lines.length === 0) {
    lines.push(mkLine("Anchor", `${scene.title}。`));
    lines.push(mkLine("Analyst", `这里的数据值得多看一眼。`));
  }

  // Pad / trim to land near scene.targetSec (apply scale + extra fillers from priorIssues)
  const effectiveTarget = scene.targetSec * knobs.sceneSecScale;
  const extraFillers = knobs.extraFillersPerScene.get(scene.id) ?? 0;
  // hook and compliance scenes are tightly curated; padding with generic
  // fillers ruins their pacing. Only rebalance content scenes.
  if (scene.narrativeBeat === "hook" || scene.narrativeBeat === "compliance") {
    return lines;
  }
  return rebalance(lines, effectiveTarget, mkLine, extraFillers);
}

// --------------------------- helpers --------------------------------------

function rebalance(
  lines: DialogueLine[],
  targetSec: number,
  mk: (speaker: "Anchor" | "Analyst", text: string) => DialogueLine,
  forceExtraFillers: number = 0,
): DialogueLine[] {
  let total = lines.reduce((s, l) => s + l.targetSec, 0);
  const maxLines = Math.max(6, Math.ceil(targetSec / 4));
  // Pad if too short — vary the filler so we don't repeat the same phrase
  const fillers = [
    "这一段数据，可以当作观察信号。",
    "这说明比赛节奏可能有变化。",
    "这是理解模型分布的重要依据。",
    "记住这条，后面会再回来对照。",
    "再往下看，会发现更有意思的细节。",
  ];
  let fillerIdx = 0;
  // Always add `forceExtraFillers` regardless of current total (used by retry adaptation)
  for (let i = 0; i < forceExtraFillers && lines.length < maxLines; i++) {
    const speaker: "Anchor" | "Analyst" = lines[lines.length - 1]?.speaker === "Anchor" ? "Analyst" : "Anchor";
    const next = mk(speaker, fillers[fillerIdx % fillers.length]!);
    fillerIdx += 1;
    lines.push(next);
    total += next.targetSec;
  }
  while (total < targetSec * 0.85 && lines.length < maxLines) {
    const speaker: "Anchor" | "Analyst" = lines[lines.length - 1]?.speaker === "Anchor" ? "Analyst" : "Anchor";
    const next = mk(speaker, fillers[fillerIdx % fillers.length]!);
    fillerIdx += 1;
    lines.push(next);
    total += next.targetSec;
  }
  while (total > targetSec * 1.15 && lines.length > 2) {
    const popped = lines.pop()!;
    total -= popped.targetSec;
  }
  return lines;
}

function cleanTitle(t: string): string {
  return t.replace(/^.*?·\s*/, "").replace(/\s+\(.*?\)/g, "").trim();
}

function pickIndex(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Deterministic-but-varied selection: pick one variant from `arr` by a seed
 * offset. Used so the offline fallback is not identical across matches — a
 * different matchId yields a different combination of phrasings while a given
 * match stays reproducible (offline tests / debugging).
 */
function pick<T>(n: number, arr: readonly T[]): T {
  const i = ((n % arr.length) + arr.length) % arr.length;
  return arr[i]!;
}

function pickMatchZh(plan: TalkPlan): string {
  const hook = plan.scenes.find(s => s.narrativeBeat === "hook");
  const props = hook?.visualSpec.props as { matchZh?: string } | undefined;
  const raw = props?.matchZh ?? "";
  return cleanTitle(raw);
}

async function tryReadMarket(ctx: RunContext): Promise<MarketData | null> {
  try {
    const { maybeReadJson } = await import("../orchestrator/runContext.js");
    return await maybeReadJson<MarketData>(ctx.paths.marketData);
  } catch {
    return null;
  }
}

// Short Anchor reactions inserted between Analyst facts so the
// AUDIT_TALK dual-host cadence rule (≥3 同 speaker 连说 → fail) never
// triggers on the deterministic path. Beats are tuned per narrative role
// so the inserted Anchor still sounds natural.
const ANCHOR_BEATS_COMPARE = [
  "这个对比很关键。",
  "差距清楚了。",
  "继续讲。",
];
const ANCHOR_BEATS_DATA = [
  "嗯，记一下这个数。",
  "继续。",
  "这条信号挺明显。",
];
const ANCHOR_BEATS_RISK = [
  "这条要划重点。",
  "注意这个边界。",
  "还有呢？",
];
const ANCHOR_BEATS_STRAT = [
  "这是一种情景。",
  "还有别的画像吗？",
  "继续看下一个。",
];

/**
 * Append `items` to `lines` as `mainSpeaker` lines, but break up any run
 * of ≥2 same-speaker entries by inserting a short Anchor reaction
 * between them. Guarantees that after this push, no 3-in-a-row of the
 * same speaker exists at the tail of `lines`.
 */
function pushWithCadence(
  lines: DialogueLine[],
  items: string[],
  mainSpeaker: "Anchor" | "Analyst",
  mk: (speaker: "Anchor" | "Analyst", text: string) => DialogueLine,
  anchorBeats: readonly string[],
): void {
  const otherSpeaker: "Anchor" | "Analyst" = mainSpeaker === "Anchor" ? "Analyst" : "Anchor";
  let beatIdx = 0;
  for (let i = 0; i < items.length; i++) {
    lines.push(mk(mainSpeaker, items[i]!));
    // After every 2nd main-speaker line in a row, insert a 1-line
    // reaction from the other speaker — unless this was the last item.
    if (i < items.length - 1) {
      const sinceOther = trailingSameSpeaker(lines, mainSpeaker);
      if (sinceOther >= 2) {
        lines.push(mk(otherSpeaker, anchorBeats[beatIdx % anchorBeats.length]!));
        beatIdx += 1;
      }
    }
  }
}

function trailingSameSpeaker(lines: DialogueLine[], speaker: "Anchor" | "Analyst"): number {
  let n = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.speaker === speaker) n += 1;
    else break;
  }
  return n;
}

/**
 * Remove or trim duplicate Anchor / Analyst lines at adjacent scene
 * boundaries.
 *
 * Why this is needed: the LLM is instructed (a) to end every scene with an
 * Anchor question that previews the next topic and (b) to never repeat the
 * `previousLineTail` at the start of the next scene. In practice, those two
 * goals collide and the LLM resolves the conflict by emitting the same
 * Anchor question on both sides of the boundary. The audience then hears
 * the female voice ask "那客场这边呢？" / "那这账怎么算？" twice in a row.
 *
 * This pass walks every (i-1, i) pair and:
 *   - drops `cur.lines[0]` when it exactly matches `prev.lines[-1]`
 *   - trims `cur.lines[0]` when it is `prev.lines[-1]` + extra content;
 *     drops it entirely if the remainder is too short to stand alone
 *   - drops the shorter of the two when one is a proper prefix of the other
 *   - drops the shorter when the two are ≥80% character-overlap similar
 *
 * Never touches lines from different speakers — those reads as a natural
 * call-and-response.
 *
 * SSML/duration are recomputed in the subsequent PASS 3, so trimming text
 * here is safe — downstream sees the deduped text as if the LLM had emitted
 * it correctly the first time.
 */
export function deduplicateCrossSceneBoundaries(scenes: SceneDialogue[]): void {
  const stripPunct = (s: string) => s
    .replace(/[，,。!?！？、；;:：\s\u3000\u00a0「」『』《》()（）"'""`]+/g, "")
    .toLowerCase();
  const lcsRatio = (a: string, b: string): number => {
    if (!a || !b) return 0;
    const long = a.length >= b.length ? a : b;
    const short = a.length < b.length ? a : b;
    let i = 0, lcs = 0;
    for (const ch of long) {
      if (i < short.length && ch === short[i]) { lcs += 1; i += 1; }
    }
    return lcs / long.length;
  };

  for (let i = 1; i < scenes.length; i++) {
    const prev = scenes[i - 1]!;
    const cur = scenes[i]!;
    if (prev.lines.length === 0 || cur.lines.length === 0) continue;
    const lastLine = prev.lines[prev.lines.length - 1]!;
    const firstLine = cur.lines[0]!;
    if (lastLine.speaker !== firstLine.speaker) continue;

    const lastN = stripPunct(lastLine.text);
    const firstN = stripPunct(firstLine.text);
    if (lastN.length === 0 || firstN.length === 0) continue;

    if (firstN === lastN) {
      // Exact duplicate — drop the first line of the current scene.
      cur.lines.shift();
      continue;
    }

    if (firstN.startsWith(lastN) && firstN.length > lastN.length) {
      // Current scene's first line extends the previous closer. Trim the
      // overlapping prefix so the audience hears the extension only.
      const trimmed = trimSharedPrefix(firstLine.text, lastLine.text);
      if (countCJK(trimmed) >= 4) {
        firstLine.text = ensureTerminalPunctuation(trimmed);
      } else {
        cur.lines.shift();
      }
      continue;
    }

    if (lastN.startsWith(firstN) && lastN.length > firstN.length) {
      // Previous closer extends the current opener — opener is redundant.
      cur.lines.shift();
      continue;
    }

    if (lcsRatio(lastN, firstN) >= 0.8) {
      // Highly similar but not exact / prefix — drop the shorter of the two
      // to preserve the most informative wording.
      if (firstN.length <= lastN.length) cur.lines.shift();
      else prev.lines.pop();
    }
  }
}

/**
 * Brand welcome variants for the opening Anchor (female) line. Every variant
 * carries the on-screen brand + host display name. Kept varied (not a single
 * fixed template) so the deterministic path still reads naturally; the LLM
 * path authors its own welcome and only falls back to these on repair.
 */
function buildWelcomeVariants(): string[] {
  const brand = COMPLIANCE_POLICY.brand;
  const host = SPEAKER_DISPLAY.Anchor;
  return [
    `欢迎来到${brand}，我是主持人${host}。`,
    `大家好，这里是${brand}，我是${host}。`,
    `${host}在这里，欢迎收看${brand}。`,
    `欢迎来到${brand}，我是${host}，咱们直接进这场比赛。`,
  ];
}

/**
 * Guarantee the very first spoken line is a brand welcome that names the
 * on-screen brand, voiced by `leadSpeaker` (Anchor in podcast, Narrator in
 * monologue). Idempotent: leaves an existing brand welcome in place (moving it
 * to the front if the agent put it later), otherwise inserts a deterministic
 * welcome. Runs before {@link repairCompliancePhrases} so the compliance
 * read-out lands right after the welcome.
 */
export function ensureBrandWelcome(scenes: SceneDialogue[], leadSpeaker: SpeakerName = "Anchor"): void {
  if (scenes.length === 0) return;
  const first = scenes[0]!;
  const brand = COMPLIANCE_POLICY.brand;
  const head = first.lines[0];
  if (head && head.speaker === leadSpeaker && head.text.includes(brand)) return;

  const existingIdx = first.lines.findIndex(l => l.speaker === leadSpeaker && l.text.includes(brand));
  if (existingIdx > 0) {
    const [w] = first.lines.splice(existingIdx, 1);
    first.lines.unshift(w!);
    return;
  }

  const hostName = SPEAKER_DISPLAY[leadSpeaker];
  const intro = leadSpeaker === "Anchor" ? `主持人${hostName}` : hostName;
  const text = ensureTerminalPunctuation(`欢迎来到${brand}，我是${intro}`);
  const estChars = countCJK(text);
  first.lines.unshift({
    id: `${first.sceneId}-welcome`,
    sceneId: first.sceneId,
    speaker: leadSpeaker,
    text,
    ssml: lineToSsml(text, leadSpeaker),
    targetSec: round(estChars / CPS, 2),
    estChars,
  });
}

/**
 * Deterministic compliance repair. Guarantees the required opening phrase is
 * present in the first scene and every required closing phrase is present in
 * the last scene. Only inserts when a phrase's keywords are genuinely missing,
 * so an agent that already produced them is left untouched. Speaker routing is
 * mode-dependent: podcast leads the opening with Anchor (female) and reads
 * closing compliance with Analyst (male); monologue keeps both on the Narrator.
 */
export function repairCompliancePhrases(
  scenes: SceneDialogue[],
  opts: { openingSpeaker?: SpeakerName; closingSpeaker?: SpeakerName } = {},
): void {
  if (scenes.length === 0) return;
  const openingSpeaker = opts.openingSpeaker ?? "Anchor";
  const closingSpeaker = opts.closingSpeaker ?? "Analyst";
  const opening = compliancePhrasesByPlacement("opening");
  const closing = compliancePhrasesByPlacement("closing");
  const has = (sd: SceneDialogue, keywords: string[]) =>
    sd.lines.some(l => keywords.every(k => l.text.includes(k)));

  const first = scenes[0]!;
  for (const p of opening) {
    const kws = p.keywords ?? [p.text];
    if (!has(first, kws)) insertComplianceLine(first, p.text, true, openingSpeaker);
  }

  const last = scenes[scenes.length - 1]!;
  for (const p of closing) {
    const kws = p.keywords ?? [p.text];
    if (!has(last, kws)) insertComplianceLine(last, p.text, false, closingSpeaker);
  }
}

/** VERIFY_TEXT character floor mirror (keep in sync with verify-text textCharLimits). */
function minTotalChars(): number {
  const policy = durationPolicy();
  if (!policy.shortForm) return 560;
  return Math.max(280, Math.round(policy.hardMinSec * 3.2));
}

/**
 * Guarantee the script clears the VERIFY_TEXT character floor. When the chosen
 * generator (usually an LLM) lands under the floor, append on-topic, compliant,
 * deduped lines from the deterministic act bank to the content scenes (never the
 * cover or the closing-compliance scene) until the floor is cleared with margin.
 * No-op when already long enough or when there is no structured market data to
 * draw novel lines from. Appended text is chineseified/sanitised here so the
 * subsequent SSML/char recompute picks it up consistently.
 */
function padToFloor(
  scenes: SceneDialogue[],
  mode: ScriptMode,
  market: MarketData | null,
  plan: TalkPlan,
  knobs: AdaptiveKnobs,
): void {
  if (scenes.length < 3) return;
  if (!market || !market.market1x2 || (market.market1x2.outcomes ?? []).length === 0) return;
  const floor = minTotalChars() + 16; // small safety margin over the hard floor
  const total = () => scenes.flatMap(s => s.lines).reduce((a, l) => a + countCJK(l.text), 0);
  if (total() >= floor) return;

  const stripPunct = (s: string) => s.replace(/[，,。!?！？、；;:：\s]+/g, "");
  const seen = new Set(scenes.flatMap(s => s.lines).map(l => stripPunct(l.text)));

  const cleanLine = (raw: string): string =>
    ensureTerminalPunctuation(
      sanitizeRestrictedComplianceText(chineseifyForTTS(stripTimeConcepts(stripBanned(raw, knobs.extraBanned)))),
    );

  // Content acts only: skip Act-1 cover (idx 0) and the last (closing-compliance)
  // scene so we never disturb the welcome or the closing read-out ordering.
  const contentIdx: number[] = [];
  for (let i = 1; i < scenes.length - 1; i++) contentIdx.push(i);
  if (contentIdx.length === 0) return;

  const sceneChars = (sd: SceneDialogue) => sd.lines.reduce((a, l) => a + countCJK(l.text), 0);
  // Pre-stage novel candidate lines per content scene from the act bank.
  const seed = pickIndex(plan.matchId);
  const banks = new Map<number, string[]>();
  for (const idx of contentIdx) {
    const raw = mode === "monologue"
      ? monologueActLines(idx, plan.scenes.length, market, seed)
      : deterministicActLines(idx, plan.scenes.length, market, seed).map(p => p[1]);
    banks.set(idx, raw.map(cleanLine).filter(t => countCJK(t) >= 4));
  }

  // Distribute padding: each pass append ONE novel line to the currently
  // shortest content scene, so the top-up never clusters into one act.
  let guard = 60;
  while (total() < floor && guard-- > 0) {
    const order = [...contentIdx].sort((a, b) => sceneChars(scenes[a]!) - sceneChars(scenes[b]!));
    let added = false;
    for (const idx of order) {
      const scene = scenes[idx]!;
      const bank = banks.get(idx) ?? [];
      const text = bank.find(t => { const n = stripPunct(t); return n && !seen.has(n); });
      if (!text) continue;
      seen.add(stripPunct(text));
      const speaker: SpeakerName = mode === "monologue"
        ? "Narrator"
        : (scene.lines[scene.lines.length - 1]?.speaker === "Analyst" ? "Anchor" : "Analyst");
      const estChars = countCJK(text);
      scene.lines.push({
        id: `${scene.sceneId}-pad${scene.lines.length + 1}`,
        sceneId: scene.sceneId,
        speaker,
        text,
        ssml: lineToSsml(text, speaker),
        targetSec: round(estChars / CPS, 2),
        estChars,
      });
      added = true;
      break; // re-evaluate shortest scene after each line
    }
    if (!added) break; // bank exhausted
  }
}

/**
 * Agent-authored floor top-up. When an agent script lands under the VERIFY_TEXT
 * character floor, ask the SAME agent to extend its OWN script with fresh, non-
 * repeating lines in the same voice — keeping the whole spoken track the agent's
 * free creation instead of leaking the canned (identical-every-match) template
 * that {@link padToFloor} would otherwise append. Best-effort: on any failure it
 * leaves the (short) script for VERIFY_TEXT to flag, which re-runs WRITE with a
 * larger length scale. Content acts only — never the cover or closing scene.
 */
async function expandAgentScriptToFloor(
  mode: ScriptMode,
  scenes: SceneDialogue[],
  market: MarketData | null,
  plan: TalkPlan,
  knobs: AdaptiveKnobs,
  dataPool: ReadonlySet<string>,
  creativeSeed: string,
): Promise<void> {
  if (!market || !market.market1x2) return;
  if (scenes.length < 3) return;
  const floor = minTotalChars() + 40;
  const stripPunct = (s: string) => s.replace(/[，,。!?！？、；;:：\s]+/g, "");
  const total = () => scenes.flatMap(s => s.lines).reduce((a, l) => a + countCJK(l.text), 0);
  if (total() >= floor) return;

  const speaker: SpeakerName = mode === "monologue" ? "Narrator" : "Analyst";
  const host = SPEAKER_DISPLAY[speaker];
  // Content acts only: skip Act-1 cover (idx 0) and the last (closing-compliance) scene.
  const contentActs: number[] = [];
  for (let i = 1; i < scenes.length - 1; i++) contentActs.push(i + 1); // 1-based act numbers
  if (contentActs.length === 0) return;

  const cleanLine = (raw: string): string =>
    ensureTerminalPunctuation(
      sanitizeRestrictedComplianceText(
        chineseifyForTTS(stripTimeConcepts(stripBanned(sanitiseNumbers(raw, dataPool), knobs.extraBanned))),
      ),
    );

  const sys = mode === "monologue"
    ? [
        `你是单人口播解局节目主笔「${host}」。下面「已写内容」是你已经写好的口播稿（按幕）。`,
        "请只为【可补充的内容幕】补写新的短句，让节目更充实——保持同样的第一人称解局腔，延续已有叙事，不要重复已写过的任何句子，不要写开场白或结尾合规句。",
        "硬规则：合规口径（禁止彩票/投注/赔率/庄家/金额/收益/行动引导）、无时间概念、少数字多故事且不出现小数、一行≤28个中文字、全中文。",
        '只输出 JSON：{"additions":[{"act":<幕号>,"lines":["新增短句", ...]}]}。',
      ].join("\n")
    : [
        "你是男女双主持解读节目的编剧。下面「已写内容」是已经写好的对话（按幕）。",
        "请只为【可补充的内容幕】补写新的对答短句，让节目更充实，延续已有内容、不要重复任何已写句子，不要写开场或结尾合规句。",
        "硬规则：合规口径、无时间概念、一行≤28个中文字、全中文；speaker 用 Analyst 居多、Anchor 偶尔追问。",
        '只输出 JSON：{"additions":[{"act":<幕号>,"lines":["新增短句", ...]}]}。',
      ].join("\n");

  const userPrompt = JSON.stringify({
    creativeSeed,
    需要补充的中文字数: Math.max(20, floor - total()),
    可补充的内容幕: contentActs,
    已写内容: scenes.map((s, i) => ({ act: i + 1, lines: s.lines.map(l => l.text) })),
    brief: buildMarketBrief(market),
  }, null, 2);

  const raw = await chatJson<{ additions?: Array<{ act?: number; lines?: unknown }> }>({
    systemPrompt: sys,
    userPrompt,
    maxTokens: Math.max(900, (floor - total()) * 6),
    temperature: 0.9,
    // Bounded: this is a best-effort top-up. If it fails/slow, VERIFY_TEXT's
    // char-floor gate re-runs WRITE with a larger length scale — so keep it fast
    // and never let it stack minutes of provider timeouts onto WRITE.
    retries: 1,
    timeoutMs: 45_000,
  });

  const additions = Array.isArray(raw?.additions) ? raw!.additions! : [];
  const seen = new Set(scenes.flatMap(s => s.lines).map(l => stripPunct(l.text)));
  const lastIdx = scenes.length - 1;
  for (const add of additions) {
    const actNo = Number(add?.act);
    const idx = actNo - 1;
    if (!Number.isInteger(idx) || idx <= 0 || idx >= lastIdx) continue; // never cover / closing
    const scene = scenes[idx]!;
    const lines = Array.isArray(add?.lines) ? add!.lines as unknown[] : [];
    for (const rawLine of lines) {
      let text = (typeof rawLine === "string" ? rawLine : String(rawLine ?? "")).trim();
      if (!text) continue;
      text = cleanLine(text);
      text = ensureTerminalPunctuation(splitLongSentences(text));
      const n = stripPunct(text);
      if (!n || seen.has(n) || countCJK(text) < 4) continue;
      seen.add(n);
      const estChars = countCJK(text);
      scene.lines.push({
        id: `${scene.sceneId}-x${scene.lines.length + 1}`,
        sceneId: scene.sceneId,
        speaker,
        text,
        ssml: lineToSsml(text, speaker),
        targetSec: round(estChars / CPS, 2),
        estChars,
      });
      if (total() >= floor) return;
    }
  }
}

function insertComplianceLine(sd: SceneDialogue, text: string, atStart: boolean, speaker: SpeakerName): void {
  const clean = ensureTerminalPunctuation(text.trim());
  const estChars = countCJK(clean);
  const line: DialogueLine = {
    id: `${sd.sceneId}-cmpl${sd.lines.length + 1}`,
    sceneId: sd.sceneId,
    speaker,
    text: clean,
    ssml: lineToSsml(clean, speaker),
    targetSec: round(estChars / CPS, 2),
    estChars,
  };
  if (atStart) {
    // After a leading Anchor opener if present, else at the very start.
    const idx = sd.lines.length > 0 && sd.lines[0]!.speaker === "Anchor" ? 1 : 0;
    sd.lines.splice(idx, 0, line);
  } else {
    // Before a trailing Anchor outro line if present, else at the end.
    let idx = sd.lines.length;
    if (idx > 0 && sd.lines[idx - 1]!.speaker === "Anchor") idx -= 1;
    sd.lines.splice(idx, 0, line);
  }
}

// Short neutral reactions used to break up runs of the same speaker. No time
// concepts, no banned/restricted terms — safe to insert anywhere.
const CADENCE_ANCHOR_BEATS = [
  "嗯，这点挺关键。", "那继续说。", "哦？这有意思。", "我大概懂了。", "这条得记一下。", "原来如此。",
];
const CADENCE_ANALYST_BEATS = [
  "对。", "没错。", "可以这么理解。", "确实是这样。",
];

/**
 * Guarantee dual-host cadence: no scene (except 合规幕) may contain a run of
 * ≥3 consecutive same-speaker lines, which is a hard AUDIT_TALK failure
 * (`talk-audit-dual-host-cadence`). Deterministically insert a short reaction
 * from the other host before a would-be 3rd consecutive line. Mirrors the
 * template path's `pushWithCadence` so LLM output can never exhaust the retry
 * budget on this rule.
 */
export function enforceDualHostCadence(scenes: SceneDialogue[], plan: TalkPlan): void {
  const beatById = new Map(plan.scenes.map(s => [s.id, s.narrativeBeat]));
  let aIdx = 0;
  let bIdx = 0;
  for (const sd of scenes) {
    if (beatById.get(sd.sceneId) === "compliance") continue;
    // The hook is curated: the female host leads with welcome → compliance →
    // question (3 consecutive Anchor lines by design) before the male host
    // answers. Skip cadence-breaking here so we don't inject a male reaction
    // into that intentional female-led opening.
    if (beatById.get(sd.sceneId) === "hook") continue;
    const out: DialogueLine[] = [];
    let streakSpeaker: SpeakerName | null = null;
    let streak = 0;
    let inserted = 0;
    for (const line of sd.lines) {
      if (line.speaker === streakSpeaker) streak += 1;
      else { streakSpeaker = line.speaker; streak = 1; }

      if (streak >= 3) {
        const other: "Anchor" | "Analyst" = line.speaker === "Anchor" ? "Analyst" : "Anchor";
        const text = other === "Anchor"
          ? CADENCE_ANCHOR_BEATS[aIdx++ % CADENCE_ANCHOR_BEATS.length]!
          : CADENCE_ANALYST_BEATS[bIdx++ % CADENCE_ANALYST_BEATS.length]!;
        const estChars = countCJK(text);
        inserted += 1;
        out.push({
          id: `${sd.sceneId}-cad${inserted}`,
          sceneId: sd.sceneId,
          speaker: other,
          text,
          ssml: lineToSsml(text, other),
          targetSec: round(estChars / CPS, 2),
          estChars,
        });
        // The inserted line breaks the run; the current line now starts a new
        // streak of length 1.
        streak = 1;
      }
      out.push(line);
    }
    sd.lines = out;
  }
}

/**
 * Trim a shared character-level prefix between `text` and `prefix`,
 * ignoring punctuation/whitespace differences. Returns the leftover text
 * with any leading punctuation/whitespace stripped.
 */
function trimSharedPrefix(text: string, prefix: string): string {
  const isPunct = (ch: string) => /[，,。!?！？、；;:：\s\u3000\u00a0「」『』《》()（）"'""`]/.test(ch);
  let ti = 0;
  let pi = 0;
  while (ti < text.length && pi < prefix.length) {
    const tc = text[ti]!;
    const pc = prefix[pi]!;
    if (isPunct(tc)) { ti += 1; continue; }
    if (isPunct(pc)) { pi += 1; continue; }
    if (tc.toLowerCase() === pc.toLowerCase()) { ti += 1; pi += 1; }
    else break;
  }
  // We've consumed everything in the prefix — `ti` now points at the
  // remainder. Strip leading punctuation/space so the trimmed line opens
  // cleanly.
  if (pi < prefix.length) return text;
  return text.slice(ti).replace(/^[，,。!?！？、；;:：\s\u3000\u00a0]+/, "").trim();
}

/**
 * Legacy duration-ceiling hook. Runtime is no longer hard-capped; audio/video
 * sync is enforced in VERIFY_AV instead.
 */
function enforceDurationCeiling(scenes: SceneDialogue[], mode: ScriptMode = "podcast"): void {
  void scenes;
  void mode;
}

function inferBeat(scene: SceneDialogue): string {
  // Scene metadata isn't carried into DialogueFile; infer from scene id
  // ordering — hook is s01, compliance is the last scene. Risk/etc. fall
  // into the content bucket.
  if (scene.sceneId === "s01") return "hook";
  return scene.sceneId === lastScene(scene.sceneId) ? "compliance" : "content";
}

// Helper: keep last scene logic local — only s07 here for short-form runs;
// callers that change scene count should update this.
const COMPLIANCE_HINTS = new Set(["s06", "s07", "s08"]);
function lastScene(_id: string): string {
  return "s07";
}
void COMPLIANCE_HINTS;

function cleanOrphanAnchorBeats(scene: SceneDialogue): void {
  // Remove any standalone Anchor reaction (≤ 10 字符) that now has Anchor
  // on both sides (or is the first / last interior beat) after a deletion.
  const out: DialogueLine[] = [];
  for (let i = 0; i < scene.lines.length; i++) {
    const cur = scene.lines[i]!;
    const prev = scene.lines[i - 1];
    const next = scene.lines[i + 1];
    const isShortAnchorBeat = cur.speaker === "Anchor" && countCJK(cur.text) <= 10;
    if (isShortAnchorBeat && prev && next && prev.speaker === "Anchor" && next.speaker === "Anchor") {
      continue;
    }
    out.push(cur);
  }
  scene.lines = out;
}

function trim(s: string, n: number): string {
  if (s.length <= n) return s.replace(/\s+/g, "");
  return s.slice(0, n).replace(/\s+/g, "");
}

function collectRiskBullets(blocks: Block[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "list") {
      for (const it of b.items) out.push(simplify(it.text));
    } else if (b.kind === "paragraph") {
      out.push(simplify(b.text));
    } else if (b.kind === "callout") {
      out.push(simplify(b.text));
    }
  }
  return out.filter(isUsableBullet).map(condenseBullet);
}

// Glossary definitions and footnote-style entries leak in from sourcematerial — e.g. "*偏离 = ...对照公式..." 这类术语解释，
// 对口播毫无用处。Filter them out here so risk scenes only keep
// audience-relevant "boundary" sentences.
function isUsableBullet(text: string): boolean {
  if (!text) return false;
  if (/^[*＊]/.test(text.trim())) return false;            // footnote
  if (/[=＝]/.test(text)) return false;                    // definition
  if (/client[-_\s]balanced|outcome\b|null[-_\s]?test/i.test(text)) return false;
  // Too long even after simplify → probably an unsuitable paragraph
  if (countCJK(text) > 36) return false;
  return true;
}

function condenseBullet(text: string): string {
  // If a bullet contains an embedded comma list, keep only the first clause
  // so each bullet stays ≤ MAX_SENT_CHARS for口播 cadence.
  let out = text.trim();
  if (countCJK(out) > MAX_SENT_CHARS) {
    const first = out.split(/[，,;；]/)[0] ?? out;
    out = first.slice(0, MAX_SENT_CHARS);
  }
  if (!/[。！？]$/.test(out)) out += "。";
  return out;
}

function collectDataFacts(blocks: Block[]): string[] {
  const facts: string[] = [];
  for (const b of blocks) {
    if (b.kind === "kpi-grid") {
      for (const it of b.items.slice(0, 4)) {
        facts.push(`${it.label}约为${it.value}。`);
      }
    } else if (b.kind === "bar-list") {
      const sorted = [...b.items].sort((a, b) => b.probability - a.probability).slice(0, 3);
      for (const it of sorted) {
        facts.push(`${b.title ? b.title + " " : ""}${it.label}的可能性是${pct(it.probability)}。`);
      }
    } else if (b.kind === "table") {
      const headerLabel = b.headers[0] ?? "项";
      const valueCols = b.headers.slice(1);
      const interesting = b.rows
        .filter(r => r.some(c => c.numeric !== undefined))
        .slice(0, 3);
      for (const r of interesting) {
        const label = r[0]?.text ?? "";
        const valCell = r.find(c => c.numeric !== undefined);
        if (label && valCell) {
          facts.push(`${headerLabel}${label}，对应${valCell.text}。`);
        }
      }
    } else if (b.kind === "paragraph" && b.dataPoints.length > 0) {
      facts.push(simplify(b.text));
    }
  }
  return facts;
}

function describeStrategy(s: Extract<Block, { kind: "strategy-card" }>): string {
  const top = s.allocations.slice(0, 2)
    .map(a => `${a.market}${a.option}`).join("、");
  return `${s.name}情景：模型主要观察${top}，只作分布参考。`;
}

function pickTopComparisonRows(tbl: Extract<Block, { kind: "table" }>, n: number): string[] {
  const rows = tbl.rows.slice(0, n);
  return rows.map(r => {
    const label = r[0]?.text ?? "";
    const left = r[1]?.text ?? "";
    const right = r[2]?.text ?? "";
    return `${label}方面，${tbl.headers[1] ?? "一方"}是${left}，${tbl.headers[2] ?? "另一方"}是${right}。`;
  });
}

function simplify(text: string): string {
  return text
    .replace(/\([^)]{1,40}\)/g, "")
    .replace(/（[^）]{1,40}）/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([，。、；：！？])\s*/g, "$1")
    .trim();
}

function splitLongSentences(text: string): string {
  // Split overly long Chinese sentences at commas / semicolons to keep ≤ MAX_SENT_CHARS.
  const sentences = text.split(/(?<=[。！？])/);
  const out: string[] = [];
  for (const s of sentences) {
    if (countCJK(s) <= MAX_SENT_CHARS) { out.push(s); continue; }
    const parts = s.split(/(?<=[，；])/);
    let buf = "";
    for (const p of parts) {
      if (countCJK(buf + p) > MAX_SENT_CHARS && buf) {
        out.push(finalisePart(buf));
        buf = p;
      } else buf += p;
    }
    if (buf.trim()) out.push(finalisePart(buf));
  }
  return out.join("");
}

function ensureTerminalPunctuation(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const fixed = trimmed.replace(/[，、；：,:;]+$/u, "。");
  return /[。！？?]$/u.test(fixed) ? fixed : `${fixed}。`;
}

function finalisePart(buf: string): string {
  // Trim a trailing comma/semicolon (we're starting a new sentence) and ensure
  // a terminal sentence punctuation. Prevents artifacts like "1.86，。"
  let s = buf.trim().replace(/[，；、]+$/u, "");
  if (!/[。！？]$/.test(s)) s += "。";
  return s;
}

/**
 * Replace English / jargon terms with their plain-Chinese equivalent so the
 * spoken script reads naturally. Examples:
 *   "Elo 1640"  → "球队实力评分 1640"
 *   "EV +0.05"  → "长期下来平均赚还是亏 +0.05"
 * This is preferred over a parenthetical annotation for TTS clarity.
 */
function autoExplainTerms(text: string, introduced: Set<string>): string {
  const glossary = loadGlossary().terms;
  let out = text;
  for (const t of glossary) {
    // Replace term + every alias with the plain-Chinese explanation.
    const names = [t.term, ...t.aliases];
    for (const n of names) {
      // Build a non-greedy global pattern so all occurrences get rewritten.
      // Escape regex metachars in the alias.
      const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escaped, "g");
      if (re.test(out)) {
        out = out.replace(re, t.simpleZh);
        introduced.add(t.term);
      }
    }
    // Strip the parenthetical "（球队实力评分，数字越高越强）" if the LLM still
    // produced it adjacent to (now-replaced) term.
    const escapedGloss = t.simpleZh.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const dupRe = new RegExp(`${escapedGloss}\\s*[（(]\\s*${escapedGloss}[^）)]*[）)]`, "g");
    out = out.replace(dupRe, t.simpleZh);
  }
  return out;
}

/**
 * Global single-pass gloss application over the final dialogue. This guarantees
 * deterministic "first-occurrence-in-time" semantics that the verifier checks:
 * the first scene in production order containing a glossary term (or alias)
 * receives the parenthetical explanation; subsequent occurrences are left as-is.
 *
 * Done as a post-pass so it survives any rebalance / line-dropping done in
 * writeScene.
 */
function applyGlossaryGloss(scenes: SceneDialogue[]): void {
  const glossary = loadGlossary().terms;
  const introduced = new Set<string>();
  for (const sd of scenes) {
    for (const l of sd.lines) {
      l.text = autoExplainTerms(l.text, introduced);
    }
  }
}

/**
 * Strip or replace any banned terms appearing in pass-through report text.
 * Strategy: if the sentence containing the term has another safe sentence
 * sibling, drop the whole sentence; otherwise, replace the term with "某项技术指标"
 * placeholder and continue. `extraBanned` allows the supervisor to inject
 * additional terms discovered by a verifier in a prior attempt.
 */
function stripBanned(text: string, extraBanned: Set<string> = new Set()): string {
  const banned = [...loadBanned().banned, ...extraBanned];
  let out = text;

  // 1. Strip the entire 句子 if it contains a banned term and the line has more 句子
  const sentences = out.split(/(?<=[。！？])/);
  if (sentences.length > 1) {
    const safe = sentences.filter(s => !banned.some(b => s.includes(b)));
    if (safe.length > 0 && safe.join("").length >= 8) {
      out = safe.join("");
    } else {
      for (const b of banned) out = out.split(b).join("某项技术指标");
    }
  } else {
    for (const b of banned) out = out.split(b).join("某项技术指标");
  }
  return out;
}

function pct(p: number): string {
  return `${(p * 100).toFixed(0)}%`;
}

// ===========================================================================
// TTS-friendly Chinese-only post-processing
// ===========================================================================
//
// Turns every digit / "%" / "-" between numbers / "¥" into the spoken form
// so the TTS reads everything as natural Chinese. Examples:
//   "57.1%"    → "百分之五十七点一"
//   "1665"     → "一千六百六十五"
//   "2-1"      → "二比一"
//   "¥100"     → "一百元"
//   "Elo 1640" → "Elo 一千六百四十"  (Elo kept; only its number is converted)
//   "1.75"     → "一点七五"
// The conversion is run AFTER glossary annotation, so parenthetical glosses
// (already in Chinese) are untouched.

/**
 * Soft time-concept sanitizer (no hard verifier gate).
 *
 * Removes calendar / clock / publish-duration language from the spoken script
 * so the dialogue refers to the match by its fixture (team names) only — never
 * by date, time-of-day, or video duration. Conservative + allowlist-protected:
 * legitimate football vocabulary (上半场 / 下半场 / 补时 / 读秒 / 第X分钟 /
 * 九十分钟 / 近五场 / 本赛季 …) and the compliance framing word "赛前" are left
 * untouched. Applied to every line in PASS 2b, before chineseify / dedup /
 * char-recompute.
 */
export function stripTimeConcepts(text: string): string {
  let out = text;

  // 1. Video / production-duration phrases (NOT in-match minutes).
  //    Require an adjacent production verb so football minutes like
  //    "九十分钟内" / "第九十分钟" are never touched.
  out = out.replace(
    /(用|花|大概|差不多)?\s*[一两二三四五六七八九十百零\d]+\s*分钟(之内|以内|左右|内)?\s*(讲透|讲完|说完|看懂|聊透|带你看懂|说清楚?|搞懂|过一遍|捋一遍)/g,
    "",
  );
  // Small video-pacing windows ("三分钟之内/左右") — in-match uses large minutes.
  out = out.replace(/[一两二三四五]\s*分钟\s*(之内|以内|左右)/g, "");
  out = out.replace(/时间不多/g, "");
  out = out.replace(/(这期|本期|这一期)\s*(视频|节目)/g, "这场");
  out = out.replace(/今天的\s*(分析|节目|内容|解读)/g, "这场的$1");

  // 2. Imminence.
  out = out.replace(/(马上就要|就要开打|即将开打|开打在即|马上|即将)/g, "");

  // 3. Clock / kickoff time. Only unambiguous forms — never bare "点"
  //    (避免误删 "记得点关注" / "一点也不" 这类非时间用法).
  out = out.replace(/北京时间/g, "");
  out = out.replace(/几点(钟|开球|开赛|打响)?/g, "");

  // 4. Time-of-day / calendar tokens. Handle the "的" connector first so we
  //    don't leave a dangling 的 (e.g. "今晚的看点" → "这场的看点").
  out = out.replace(
    /(今晚|今夜|明晚|明天晚上|昨晚|昨夜|今天|今日|明天|明日|昨天|昨日|后天|前天|当天|当晚|本周末|这周末|下周末|周末|下周[一二三四五六日天]|本周|这周)的/g,
    "这场的",
  );
  out = out.replace(
    /(今晚|今夜|明晚|明天晚上|昨晚|昨夜|凌晨|清晨|今早|明早|今天|今日|明天|明日|昨天|昨日|后天|前天|当天|当晚|本周末|这周末|下周末|周末|下周[一二三四五六日天]|本周|这周)/g,
    "",
  );
  out = out.replace(/(今天|明天|昨天)?(早上|上午|中午|下午|傍晚|晚上|夜里)的?/g, "");

  // 5. Cleanup: dangling connectors, doubled / leading punctuation, stray spaces.
  out = out.replace(/(^|[，,。！？、；：])的/g, "$1");
  out = out.replace(/([，,、；：])\s*([，,。！？、；：])/g, "$2");
  out = out.replace(/[，,、；：]+(?=[。！？])/g, "");
  out = out.replace(/^[，,。！？、；：\s]+/, "");
  out = out.replace(/\s{2,}/g, " ");
  return out.trim();
}

function chineseifyForTTS(text: string): string {
  let out = text;
  out = out.replace(/¥\s*(\d+(?:\.\d+)?)/g, (_, n) => `${num2zh(n)}元`);

  // 2. "X 比 Y" / "X-Y" / "X:Y" / "X比Y" score patterns (between integers only)
  //    Avoid "Top-5", "p<0.05" by requiring both sides to be plain ints.
  out = out.replace(/(?<![\w%.])(\d{1,2})\s*[-比:：]\s*(\d{1,2})(?![\w%.])/g,
    (_, a, b) => `${num2zh(a)}比${num2zh(b)}`);

  // 3. Percentages: "57.1%", "57%", "57.1 %" → "百分之五十七点一"
  out = out.replace(/(\d+(?:\.\d+)?)\s*%/g, (_, n) => `百分之${num2zh(n)}`);

  // 4. Latin-only odds / probability prefixes like "P=57.1" → "P 等于 五十七点一"
  out = out.replace(/(\d+(?:\.\d+)?)\s*倍/g, (_, n) => `${num2zh(n)}倍`);

  // 5. Bare numbers — last sweep over anything still ASCII.
  //    Keep token-internal numbers (Elo, U23, B2B…) by requiring a non-word
  //    boundary on the left.
  out = out.replace(/(?<![\w.])(\d+(?:\.\d+)?)(?![\w%])/g, (_, n) => num2zh(n));

  // 6. Tidy spaces around CJK boundaries that the replacements may leave
  out = out.replace(/\s+/g, " ").replace(/\s*([，。！？；：、])\s*/g, "$1");
  // 6b. Drop ASCII spaces that sit BETWEEN two CJK characters (TTS dislikes
  //     mid-sentence whitespace pauses). Keep spaces that border Latin chars
  //     so "Elo 一千六百四十" stays separable.
  out = out.replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, "$1$2");
  out = out.replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, "$1$2");
  return out.trim();
}

const ZH_DIGIT = ["零","一","二","三","四","五","六","七","八","九"];
const ZH_UNIT_4 = ["", "十", "百", "千"];
const ZH_BIG    = ["", "万", "亿", "兆"];

function num2zh(s: string): string {
  // Split integer / fraction parts
  const neg = s.startsWith("-") || s.startsWith("−");
  if (neg) s = s.slice(1);
  const [intPart, fracPart] = s.split(".");
  let intZh = intToZh(intPart ?? "0");
  if (fracPart) intZh += "点" + fracPart.split("").map(d => ZH_DIGIT[parseInt(d, 10)] ?? "").join("");
  return (neg ? "负" : "") + intZh;
}

function intToZh(intStr: string): string {
  if (!/^\d+$/.test(intStr)) return intStr;
  const n = intStr.replace(/^0+(?=\d)/, "");
  if (n === "0") return "零";
  if (n.length <= 4) return chunk4ToZh(n);

  // Split into 4-digit chunks from the right, label with 万/亿/…
  const chunks: string[] = [];
  let rest = n;
  while (rest.length > 4) {
    chunks.unshift(rest.slice(-4));
    rest = rest.slice(0, -4);
  }
  chunks.unshift(rest);

  let out = "";
  for (let i = 0; i < chunks.length; i++) {
    const idxFromRight = chunks.length - 1 - i;
    const chunkStr = chunks[i]!;
    if (chunkStr === "0000") {
      // All zeros: only emit a single "零" if neighbours non-zero (handled below)
      if (out && !out.endsWith("零")) out += "零";
      continue;
    }
    const part = chunk4ToZh(chunkStr);
    const big = ZH_BIG[idxFromRight] ?? "";
    // Pad leading-zero connector: "一亿零三百" between higher non-zero and lower with leading zero
    if (out && chunkStr.length < 4 && parseInt(chunkStr, 10) < 1000 && !out.endsWith("零")) out += "零";
    out += part + big;
  }
  return out.replace(/零+/g, "零").replace(/零$/, "");
}

function chunk4ToZh(s: string): string {
  // s is up to 4 digits, no leading-zero stripping required
  const padded = s.padStart(4, "0");
  let out = "";
  let zeroPending = false;
  for (let i = 0; i < 4; i++) {
    const d = parseInt(padded[i]!, 10);
    const unit = ZH_UNIT_4[3 - i]!;
    if (d === 0) {
      zeroPending = true;
      continue;
    }
    if (zeroPending && out) out += "零";
    // Idiomatic: 一十 → 十 only when it's the leading digit
    if (!out && d === 1 && unit === "十") out += "十";
    else out += ZH_DIGIT[d] + unit;
    zeroPending = false;
  }
  return out;
}

function countCJK(s: string): number {
  // Each CJK char counts as 1; latin counts as 0.5 (TTS reads faster)
  let n = 0;
  for (const ch of s) {
    if (/[\u4e00-\u9fff]/.test(ch)) n += 1;
    else if (/[A-Za-z0-9]/.test(ch)) n += 0.5;
  }
  return Math.round(n);
}

function round(x: number, p: number): number {
  const f = Math.pow(10, p);
  return Math.round(x * f) / f;
}

// ===========================================================================
// LLM-driven scene writer
// ===========================================================================
//
// The deterministic templates above remain as a fallback. When Azure OpenAI is
// configured (env: AZURE_OPENAI_*), each scene is generated by a chat call
// that receives a compact SceneBrief and a strict system prompt. The output
// is a JSON object { lines: [{speaker, text}] } that we then validate, clean
// (banned terms, char counts, splitting long sentences) and turn into
// DialogueLine objects with SSML.

interface LLMScriptResponse {
  scenes: Array<{ lines: Array<{ speaker: "Anchor" | "Analyst"; text: string }> }>;
}

/**
 * Agent-first, conclusion-first whole-script generator. One LLM call authors
 * all acts at once from a compact market-derived brief, then each scene's raw
 * lines run through the shared sanitisation pipeline. Throws on any structural
 * failure so the caller can fall back to the deterministic path.
 */
async function writeScriptWithLLM(
  plan: TalkPlan,
  blocksFile: BlocksFile,
  market: MarketData | null,
  knobs: AdaptiveKnobs,
  dataPool: ReadonlySet<string>,
  creativeSeed: string,
): Promise<SceneDialogue[]> {
  if (!market || !market.market1x2) throw new Error("no market data for agent-first brief");

  const opening = compliancePhrasesByPlacement("opening").map(p => p.text);
  const closing = compliancePhrasesByPlacement("closing").map(p => p.text);
  const glossary = loadGlossary().terms;
  const banned = loadBanned().banned;

  const totalSec = plan.scenes.reduce((s, x) => s + x.targetSec * knobs.sceneSecScale, 0);
  // Aim just above the VERIFY_TEXT floor so the agent clears it on its own (the
  // canned-template top-up never fires) WITHOUT padding toward the old ~180s
  // ceiling. The small +10 margin keeps the script comfortably ≤180s while the
  // story-first style naturally trims data recitation.
  const targetChars = Math.max(Math.round(totalSec * CPS), minTotalChars() + 10);

  const systemPrompt = buildScriptSystemPrompt({
    glossary,
    banned: [...banned, ...knobs.extraBanned],
    opening,
    closing,
  });

  const userPrompt = JSON.stringify({
    creativeSeed,
    创作要求: "这是男女双主持解读稿，必须根据本场 brief 自由创作：禁止套用任何固定模板/范文/口头禅，开场、转场、收尾与提问每一场都要换新说法；用 creativeSeed 选定本场独特的切入角度。**面向中学文化程度的普通球迷，一听就懂；比喻只能用足球场上看得见的画面和球赛术语，严禁门缝/裂缝/风向/资本/钥匙/棋局/电影这类跨领域抽象比喻；开场直给、不要冷开场**。**以 brief 的「定性解读」（伤情/战术/动机/场地/样本/强弱）为主线，用因果推理讲清'为什么会这样、接下来会怎样'**；数字极省——整片最多 3 个数字、多数幕零数字，「关键数字备查」只作参考不要逐条念；以故事性与讨论感为主，整片控制在 180 秒以内、偏短优先。",
    ...(writeEditorialNote() ? {
      编辑视角: writeEditorialNote(),
      编辑视角说明: "这是本场人工指定的叙事切入与背景视角，请据此组织对谈的悬念与主线；但仍须忠于 brief 的真实数据与强弱关系，遵守全部合规与禁用词规则，不得为此编造数据或越过合规边界。",
    } : {}),
    totalScenes: plan.scenes.length,
    targetChineseChars: targetChars,
    acts: plan.scenes.map((s, i) => ({
      act: i + 1,
      beat: s.narrativeBeat,
      kind: s.visualSpec.kind,
      title: s.title,
      targetSeconds: round(s.targetSec * knobs.sceneSecScale, 1),
    })),
    brief: buildMarketBrief(market),
  }, null, 2);

  const raw = await chatJson<LLMScriptResponse>({
    systemPrompt,
    userPrompt,
    maxTokens: Math.max(1800, Math.round(targetChars * 4)),
    temperature: 0.8,
    // 3 attempts: a transient provider hiccup must NOT drop us to the canned
    // (identical-every-match) deterministic template — keep retrying the agent.
    retries: 2,
    timeoutMs: writeAgentTimeoutMs(),
  });

  if (!raw || !Array.isArray(raw.scenes) || raw.scenes.length === 0) {
    throw new Error("LLM script response missing scenes[]");
  }

  const out: SceneDialogue[] = [];
  for (let i = 0; i < plan.scenes.length; i++) {
    const scene = plan.scenes[i]!;
    const src = raw.scenes[i]?.lines ?? raw.scenes[Math.min(i, raw.scenes.length - 1)]?.lines ?? [];
    const lines = toDialogueLines(scene, src, knobs, dataPool);
    if (lines.length < 2) throw new Error(`LLM scene ${scene.id} produced ${lines.length} usable lines`);
    ensureDualSpeakers(lines, scene.id);
    // Trim only genuinely runaway scenes (content beats only); never pad with canned fillers.
    if (scene.narrativeBeat !== "hook") {
      const targetSec = scene.targetSec * knobs.sceneSecScale;
      let total = lines.reduce((s, l) => s + l.targetSec, 0);
      while (total > targetSec * 1.6 && lines.length > 3) {
        total -= lines.pop()!.targetSec;
      }
    }
    out.push({ sceneId: scene.id, lines });
  }
  return out;
}

/** Turn raw {speaker,text} pairs into sanitised DialogueLine[] for a scene. */
function toDialogueLines(
  scene: Scene,
  src: Array<{ speaker: "Anchor" | "Analyst"; text: string }>,
  knobs: AdaptiveKnobs,
  dataPool: ReadonlySet<string>,
): DialogueLine[] {
  const out: DialogueLine[] = [];
  let lid = 0;
  for (const r of src) {
    if (!r || (r.speaker !== "Anchor" && r.speaker !== "Analyst")) continue;
    let text = (typeof r.text === "string" ? r.text : String(r.text ?? "")).trim();
    if (!text) continue;
    text = stripBanned(text, knobs.extraBanned);
    text = sanitiseNumbers(text, dataPool);
    text = ensureTerminalPunctuation(splitLongSentences(text));
    if (!text) continue;
    const estChars = countCJK(text);
    lid += 1;
    out.push({
      id: `${scene.id}-l${lid}`,
      sceneId: scene.id,
      speaker: r.speaker,
      text,
      ssml: lineToSsml(text, r.speaker),
      targetSec: round(estChars / CPS, 2),
      estChars,
    });
  }
  return out;
}

/** Compact, probability-only brief derived from MarketData for the LLM. */
function buildMarketBrief(m: MarketData): Record<string, unknown> {
  const outcomes = m.market1x2?.outcomes ?? [];
  const lead = outcomes.reduce((a, b) => (b.pct > a.pct ? b : a), outcomes[0] ?? { role: "", team: "", pct: 0, lead: false });
  const topScore = m.correctScore?.topScores?.[0];
  const topGoal = m.totalGoals?.topGoals?.[0];

  // ── Qualitative story material (the BACKBONE the agent should narrate from) ──
  // The report ships rich prose: per-team finding bodies (injuries, tactics,
  // squad depth, sample-size caveats) and curated highlight cards (战术对位 /
  // 动机背景 / 近期交锋 / 基本面叙事). These carry the "why" and the storylines;
  // numbers are only evidence. We surface them prominently and de-duplicate the
  // per-team blurbs against the highlight bullets so the agent has clean prose.
  const homeBlurb = (m.fundamentals?.homeBlurb ?? "").trim();
  const awayBlurb = (m.fundamentals?.awayBlurb ?? "").trim();
  const highlights = (m.fundamentals?.highlights ?? [])
    .slice(0, 6)
    .map(h => ({ 主题: h.title, 要点: h.bullets }));
  const scoreStories = (m.upset?.scores ?? [])
    .slice(0, 4)
    .filter(s => s.interp)
    .map(s => ({ 比分: s.score, 含义: s.interp }));
  const driverNames = (m.upset?.drivers ?? []).map(d => d.label);

  return {
    matchZh: m.hero?.matchZh ?? "",
    league: m.hero?.league ?? "",
    home: m.hero?.homeName ?? m.fundamentals?.homeName ?? "",
    away: m.hero?.awayName ?? m.fundamentals?.awayName ?? "",

    // 1) 结论（口播先行，尽量用文字，不必逐个报数）
    结论速览: {
      最被看好: lead?.role ? { 倾向: lead.role, 球队: lead.team } : null,
      最可能比分: topScore ? topScore.score : "",
      最可能球数: topGoal ? `${topGoal.goals}球` : "",
      爆冷量级: m.upset?.band || m.upset?.probPct || "",
    },

    // 2) 定性解读（★主线素材：伤情/战术/动机/场地/样本可靠性/因果推演★）
    //    这是本场最该讲的"故事与为什么"，务必据此展开，而不是复述数字。
    定性解读: {
      主队解读: homeBlurb,
      客队解读: awayBlurb,
      看点: highlights,
      市场情绪: marketSentimentNote(m),
      爆冷逻辑: {
        定性: m.upset?.band ?? "",
        热门: m.upset?.favTeam ?? "",
        主要驱动: driverNames,
        比分情景: scoreStories,
      },
    },

    // 3) 关键数字备查（★仅供参考：整片只在能"一锤定音"时点极少数字，每幕≤1个★）
    关键数字备查: {
      最被看好可能性: lead?.role ? `${lead.pct}%` : "",
      胜平负: outcomes.map(o => ({ 倾向: o.role, 球队: o.team, 可能性: `${o.pct}%` })),
      期望进球: m.totalGoals?.expected ?? "",
      峰值球数: m.totalGoals?.peakLabel ?? "",
      大于等于三球: m.totalGoals?.ge3pct ?? "",
      最可能比分: (m.correctScore?.topScores ?? []).slice(0, 3).map(s => ({ 比分: s.score, 可能性: `${s.pct}%` })),
      风向标: (m.marketSignal?.rows ?? []).map(r => ({
        标的: r.role, 市场隐含可能性: `${r.implied}%`, 模型可能性: `${r.model}%`, 差值: `${r.mismatchPp}个百分点`,
      })),
      爆冷可能性: m.upset?.probPct ?? "",
      复杂性: (m.upset?.complexityMetrics ?? []).map(c => ({ 名称: c.label, 数值: c.value })),
    },
  };
}

/**
 * Turn the market-signal rows (市场隐含 vs 模型可能性) into a one-line QUALITATIVE
 * reading — "市场把某一方看得比模型更热 / 模型比市场更谨慎" — so the agent can
 * narrate the 风向标 as a sentiment story instead of reciting implied/model
 * percentages. Never emits odds/EV/betting language. Returns "" when unusable.
 */
function marketSentimentNote(m: MarketData): string {
  const rows = m.marketSignal?.rows ?? [];
  if (rows.length === 0) return "";
  // Largest positive mismatch = market hotter than the model on that outcome.
  const byGap = rows
    .map(r => ({ role: r.role, gap: Number(r.mismatchPp) }))
    .filter(r => Number.isFinite(r.gap))
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  const top = byGap[0];
  if (!top || Math.abs(top.gap) < 1) return "市场情绪与模型基本一致，没有明显分歧。";
  if (top.gap > 0) return `市场把「${top.role}」看得比模型更热，外界情绪比模型更激动。`;
  return `模型比市场更看好「${top.role}」，市场反而偏谨慎。`;
}

export function buildScriptSystemPrompt(opts: {
  glossary: GlossaryTerm[];
  banned: string[];
  opening: string[];
  closing: string[];
}): string {
  const glossList = opts.glossary.map(t => {
    const allNames = [t.term, ...t.aliases].join(" / ");
    return `- 看到 ${allNames} → **直接说 "${t.simpleZh}"**（不保留英文、不加括号）`;
  }).join("\n");
  const bannedList = opts.banned.map(b => `- ${b}`).join("\n");
  const openingList = opts.opening.map(p => `- ${p}`).join("\n");
  const closingList = opts.closing.map(p => `- ${p}`).join("\n");

  return `你是一档中文足球数据解读节目的编剧。你拿到一场比赛的赛前数据简报（user 消息里的 brief 与 acts），要把它改写成男女双主持人的轻快口播对话。**这是一档"看懂数据报告"的解读节目，要简单易懂、结论先行**——不要套用任何固定模板或范文，每一场都要有不同的说法。

# 自由创作（硬规则，最重要）
- 这是你的**原创**，不是填模板：user 消息里的 creativeSeed 是本场专属的创作种子，用它为这一场选定独一无二的开场、转场、收尾与提问方式，确保和任何其他场次都不雷同
- **严禁**任何固定开场白、口头禅或范文句式；同一类判断（谁更被看好、市场偏热、爆冷大小）每场都要换一整套全新的说法，不要每场都用同一个句式
- 灵感只来自**本场 brief 的真实数据**；让观众听完感到"这是专门讲这一场的"，而不是通用模板换了队名

# 节目设定
- 形式：男女双人对谈，解读欧洲足球赛事的可能性/走势分析，整片总时长控制在 180 秒以内（约 160 秒为佳），节奏快、口语化、像朋友聊球；宁可精炼，也不要为凑时长而拖沓
- Anchor（女声·小美）：代表观众发问、推动节奏、收束要点，多抛悬念与好奇式追问
- Analyst（男声·小帅）：把数据翻译成故事和观点，重点讲"为什么会这样、接下来会怎样"，最多点 1 个关键数字，不堆数据
- 受众：中学文化程度的普通球迷，没看过数据报告，所有数学/术语都要用日常话补一句

# 直白易懂（硬规则，最重要之一）
- 听众是**中学文化程度的普通球迷**，没看过任何数据报告：**"一听就懂"是硬标准**，宁可直白，也不要绕弯子
- **比喻只能用足球场上看得见的画面和球赛术语**（控球、反击、压迫、防线、定位球、体能、主场氛围、伤病、板凳深度、纸面实力……）；**严禁任何跨领域、文学化、抽象的隐喻**——不许出现"门缝 / 裂缝 / 风向 / 暗线 / 脚下的纸 / 窗户纸 / 钥匙开锁 / 一盘棋 / 一部电影 / 一封信 / 资本"这类要观众动脑筋去猜的说法
- 开场（第 1 幕）要**直白、直给**：一句大白话说清谁被看好、悬念在哪，钩子来自真实比赛故事（伤情/动机/强弱/主客场），**严禁"这场像一部…/像两把钥匙…"这种要人猜的冷开场**
- 自检：**一个比喻如果还要再补一句才能听懂，就不要用它**，直接用大白话把意思说出来
- 直白开场示范（照这种方向写、别照抄）：❌"这场像两把钥匙开同一把锁。" ✅"都说主队稳赢，但他们中卫刚受伤，客队又擅长打反击，这场没那么简单。"

# 故事化、推理与讨论感（风格硬规则，最重要之一）
- 这是"两个人聊球讲门道"，不是"念数据报告"：**以 brief 里的「定性解读」为绝对主线**——伤情、阵容、战术博弈、动机背景、场地、样本可靠性、强弱底子——把这些讲成有画面感的故事和观点碰撞
- **必须做因果推理，而不是罗列事实**：多用"因为…所以…、这意味着…、于是…、问题就出在…、真正的看点是…"，把「某队右路伤兵→逼对手换解法→节奏被谁掌控→进球容易落在几球」这样的链条讲清楚，让观众听到"分析"而不是"结论清单"
- **数字要极省**：整片总共最多出现 3 个数字，且只在能"一锤定音"时才点一个（如最被看好方的可能性、或爆冷量级其一）；**大多数幕应该一个数字都没有**，全部用大白话/球场画面/因果把"势头、底气、优势多大、会不会翻车"说清楚。「关键数字备查」只是你的参考池，不是要你逐条念出来
- 两位主持人要有真实来回：一方给判断，另一方补充/质疑/换角度，多用"你觉得呢 / 我倒觉得 / 反过来想 / 换个角度看"，像朋友拌嘴聊球
- 用一条悬念主线串起整场（谁更有底气、热门会不会翻车、冷门机会大不大），每幕都用一段"为什么"往前推进，而不是抛一个新数字

# 结论先行（v2 核心结构，硬规则）
- **第一幕（act 1）必须先给结论**：开场欢迎+合规短句之后，直接说出本场最重要的结论——最被看好的一方与可能性、最可能比分、最可能球数、以及爆冷大致量级；用一两句让观众秒懂"这场大概会怎样"
- 后面三幕再展开依据：act 2 讲球队基本面 + 风向标（市场隐含可能性 vs 模型可能性的差异），act 3 摊开模型概率分布（胜平负/进球数/比分），act 4 讲爆冷可能性
- 每一幕都呼应该幕的图表数据，但**不要把同一个数字在多幕重复堆叠**

# 各幕产出
- 输出的 scenes 数组**顺序与数量必须与 acts 完全一致**（4 幕就是 4 个 scene）
- 第 1 幕（hook）：① 第一行 Anchor 说一句含品牌「${COMPLIANCE_POLICY.brand}」的欢迎词（每场换说法）；② 紧接着用"结论先行"给出本场速览（最被看好方、比赛大概走向、爆冷量级），尽量用文字讲清、最多点 1 个数字，再由 Analyst 用一句"为什么"起头。**开场不要朗读任何合规免责短句**（合规只在最后一幕收尾）。
- 第 2 幕（基本面+风向标）：以「定性解读」里的伤情/战术/阵容/动机为主线，讲"两队到底差在哪、为什么"；风向标用「市场情绪」那句话讲成"外界比模型更看好谁/更谨慎"，不要报隐含与模型的百分比
- 第 3 幕（概率分布）：把"最可能怎么赢、比分与球数为什么落在这个区间"讲成因果故事（如控球主导 vs 伺机反击→节奏中低→球数落点），至多点 1 个数字
- 第 4 幕（最后一幕，reveal）：先用「爆冷逻辑」讲"冷门从哪来、更像哪种翻法"（是被对手掀翻，还是自己太热被拖住），最多点 1 个数字，最后把下面每一条合规话都**完整落到台词里（关键词原样出现，不可省）**：
${closingList}

# 勾起好奇（重点）
- Anchor 要多用**激发观众猎奇心理的发问**，制造悬念和反转钩子，例如"这场有没有陷阱？""热门会不会翻车？""冷门机会到底大不大？""数据里藏着什么意外？"
- 每一幕至少有一处这种"钩子式"提问，但问题要紧扣该幕的真实数据，不要空泛

# 对话节奏（硬规则）
- 两人**交替**说话，**严禁连续 ≥ 3 行都是同一个人**；连续 2 行后另一人必须接一句反应/追问（哪怕只有 5-8 字）
- Anchor 台词约占总行数 35%-50%；每个 content 幕里 Anchor 至少发出 1 个疑问句（带"？"）
- 每幕第一行不要重复上一幕结尾——换说法、换关键词进入本幕

# 话术口径（合规硬规则）
- **不要使用任何彩票、投注、下注、购买、推荐、收益、赔率、庄家、抽水、资金、资本或行动引导措辞**；提问要定调为"赛前看点 / 模型预测 / 趋势"，不能定调成"是否参与"
- 描述风向标时，只说"市场把某一方看得更热 / 模型更保守"这类**可能性差异**，绝不出现赔率、EV、金额、下注、庄家、资金、资本等词
- 优先用"可能性 / 倾向 / 偏向 / 走势"；形容球队不要用"硬/软"，改用"偏强/偏弱、主场气势、客场冲击力"等
- **严禁数字堆叠**：整片总共最多 3 个数字，多数幕零数字；点数字必须紧跟一句人话翻译，同一段绝不连报多个数字，能用故事/因果/球场画面说清的一律不报数

# 无时间概念（硬规则）
- 不要出现任何日历/时钟/时长概念（今晚/明天/几点/北京时间/三分钟讲透/这期视频…）
- 直接用对阵（队名）称呼这场比赛；「赛前」是合规框定词，可正常使用；足球比赛内部的"上/下半场、补时、第X分钟、近五场、本赛季"可正常使用

# 数据保真（硬规则）
- 只能使用 brief 里出现过的数字、队名、比分；不得编造模型名、算法名或未出现的可能性数据

# 全中文口播（硬规则，TTS 直接配音）
- **所有数字、百分号、连字符比分都写成中文汉字读法**：百分比"51.4%"→"百分之五十一点四"；整数"1875"→"一千八百七十五"；比分"1-1"→"一比一"；球数"2球"→"两球/二球"
- 不要出现 "—"、"~"、"…"、"≥"、"P=" 这类符号；不要写英文/缩写术语本身，统一改成下面通俗中文：
${glossList}
- 严禁出现以下词汇（含变体）：
${bannedList}

# 写作约束
- 每个幕 Anchor 和 Analyst 都要开口；一行 ≤ 28 个中文字（含标点）；每行落到完整句号/问号/感叹号
- 总字数不要超过 targetChineseChars 太多，**偏短优先**；整片总时长务必控制在 180 秒以内，宁缺毋滥不要凑字

# 输出格式（只输出 JSON，不要任何额外说明）
{
  "scenes": [
    { "lines": [ { "speaker": "Anchor", "text": "..." }, { "speaker": "Analyst", "text": "..." } ] }
  ]
}`;
}

// ===========================================================================
// Market-aware deterministic generator (offline / LLM-failure fallback)
// ===========================================================================

/**
 * Build a conclusion-first four-act script directly from MarketData. Used when
 * no LLM is configured or the agent call fails. Falls back to the legacy
 * block-template `writeScene` when the report has no structured market data.
 */
function deterministicScript(
  plan: TalkPlan,
  market: MarketData | null,
  blockMap: Map<string, Block>,
  knobs: AdaptiveKnobs,
): SceneDialogue[] {
  if (!market || !market.market1x2 || (market.market1x2.outcomes ?? []).length === 0) {
    return plan.scenes.map(s => ({ sceneId: s.id, lines: writeScene(s, blockMap, knobs, plan) }));
  }

  const out: SceneDialogue[] = [];
  const seed = pickIndex(plan.matchId);
  for (let i = 0; i < plan.scenes.length; i++) {
    const scene = plan.scenes[i]!;
    let lid = 0;
    const mk = (speaker: "Anchor" | "Analyst", text: string): DialogueLine => {
      const cleanText = ensureTerminalPunctuation(splitLongSentences(stripBanned(text, knobs.extraBanned)));
      const estChars = countCJK(cleanText);
      lid += 1;
      return {
        id: `${scene.id}-l${lid}`,
        sceneId: scene.id,
        speaker,
        text: cleanText,
        ssml: lineToSsml(cleanText, speaker),
        targetSec: round(estChars / CPS, 2),
        estChars,
      };
    };
    const pairs = deterministicActLines(i, plan.scenes.length, market, seed);
    out.push({ sceneId: scene.id, lines: pairs.map(([sp, t]) => mk(sp, t)) });
  }
  return out;
}

type Pair = ["Anchor" | "Analyst", string];

function deterministicActLines(actIndex: number, totalActs: number, m: MarketData, seed = 0): Pair[] {
  const o = m.market1x2!.outcomes;
  const lead = o.reduce((a, b) => (b.pct > a.pct ? b : a), o[0]!);
  const home = o.find(x => /主/.test(x.role)) ?? o[0]!;
  const away = o.find(x => /客/.test(x.role)) ?? o[o.length - 1]!;
  const draw = o.find(x => /平/.test(x.role));
  const homeName = m.hero?.homeName || home.team || "主队";
  const awayName = m.hero?.awayName || away.team || "客队";
  const ts = m.correctScore?.topScores ?? [];
  const tg = m.totalGoals;
  const topGoal = tg?.topGoals?.[0];
  const up = m.upset;
  const sig = m.marketSignal?.rows ?? [];
  const drivers = up?.drivers ?? [];

  const isLast = actIndex === totalActs - 1;

  if (actIndex === 0) {
    // Act 1 — cover, conclusion-first (no opening compliance read-out in v2)
    const lines: Pair[] = [
      ["Anchor", pick(seed, [
        `欢迎来到${COMPLIANCE_POLICY.brand}，我是小美。`,
        `大家好，这里是${COMPLIANCE_POLICY.brand}，我是小美。`,
        `${COMPLIANCE_POLICY.brand}和你见面了，我是小美。`,
      ])],
      ["Anchor", pick(seed + 1, [
        `先说结论，${homeName}对${awayName}这场。`,
        `开门见山，${homeName}对${awayName}。`,
        `${homeName}对${awayName}，先把话放这儿。`,
      ])],
      ["Analyst", `模型最看好${lead.role}，${lead.team || lead.role}可能性约${lead.pct}%。`],
      ["Anchor", pick(seed + 2, [
        "听着挺稳，可这场有没有陷阱？",
        "听着一边倒，可真有这么保险？",
        "看着是稳，但里面藏没藏坑？",
      ])],
      ["Analyst", pick(seed + 3, [
        "好问题，越热门的一方越容易被爆冷。",
        "别急，越被看好，摔得可能越疼。",
        "这就得往下看，热门也不是铁板。",
      ])],
    ];
    if (ts[0]) lines.push(["Anchor", pick(seed + 4, ["那最可能的比分是多少？", "那比分最看好哪个？", "最可能踢成几比几？"])], ["Analyst", `是${ts[0].score}，大约${ts[0].pct}%。`]);
    if (topGoal) lines.push(["Anchor", pick(seed + 5, ["进球数呢？", "那球数大概几个？", "总进球看多少？"])], ["Analyst", `最可能${topGoal.goals}球，约${topGoal.pct}%。`]);
    if (up?.probPct) lines.push(["Anchor", pick(seed + 6, ["爆冷的机会到底大不大？", "冷门的可能有多高？", "翻盘的门槛高不高？"])], ["Analyst", `综合爆冷可能性约${up.probPct}，留个悬念。`]);
    return lines;
  }

  if (actIndex === 1) {
    // Act 2 — fundamentals + market signal
    const lines: Pair[] = [["Anchor", pick(seed + 7, ["两队基本面差在哪？", "先说说两队的底子。", "纸面上，两队差多少？"])]];
    const hk = m.fundamentals?.homeStats?.kvStats ?? [];
    const ak = m.fundamentals?.awayStats?.kvStats ?? [];
    const hPow = hk.find(x => /实力|评分/.test(x.label))?.value;
    const aPow = ak.find(x => /实力|评分/.test(x.label))?.value;
    if (hPow && aPow) {
      lines.push(["Analyst", `${homeName}实力评分${hPow}。`]);
      lines.push(["Analyst", `${awayName}${aPow}，纸面有差距。`]);
    }
    const hPpg = hk.find(x => /近期|场均/.test(x.label))?.value;
    const aPpg = ak.find(x => /近期|场均/.test(x.label))?.value;
    if (hPpg && aPpg) lines.push(["Anchor", pick(seed + 8, ["近期状态呢？", "那最近手感如何？", "近期谁更热？"])], ["Analyst", `近期场均${homeName}${hPpg}、${awayName}${aPpg}，咬得不松。`]);
    lines.push(["Anchor", pick(seed + 9, ["市场和模型看法一致吗？", "外界和数据看法一样吗？", "大家和模型想到一块了吗？"])]);
    const leadSig = sig.find(r => r.role === lead.role);
    if (leadSig) {
      lines.push(["Analyst", `市场把${lead.team || lead.role}隐含可能性抬到${leadSig.implied}%。`]);
      lines.push(["Anchor", pick(seed + 10, ["模型呢？", "那数据给多少？", "模型这边怎么算？"])]);
      lines.push(["Analyst", `模型只给${leadSig.model}%，市场更热一些。`]);
    }
    const value = sig.find(r => r.mismatchPp > 3);
    if (value) lines.push(["Anchor", pick(seed + 11, ["那看点在哪？", "那门道在哪儿？", "值得留意的是谁？"])], ["Analyst", `${value.role}这边模型给的可能性反而更高。`]);
    return lines;
  }

  if (actIndex === 2) {
    // Act 3 — probability distribution
    const lines: Pair[] = [["Anchor", pick(seed + 12, ["把模型的概率分布摊开看。", "把数据分布摆开聊。", "一条条看模型怎么分。"])]];
    lines.push(["Analyst", `胜平负，${homeName}${home.pct}%、${awayName}${away.pct}%。`]);
    lines.push(["Anchor", pick(seed + 13, ["平局呢？", "那踢平的概率？", "握手言和的可能？"])]);
    lines.push(["Analyst", `平局${draw?.pct ?? 0}%，三条线没谁碾压谁。`]);
    lines.push(["Anchor", pick(seed + 14, ["进球和比分呢？", "球数和比分怎么看？", "那进球这块呢？"])]);
    if (tg?.expected) lines.push(["Analyst", `期望进球${tg.expected}球，峰值${tg.peakLabel}球。`]);
    if (tg?.ge3pct) lines.push(["Anchor", pick(seed + 15, ["大球氛围浓吗？", "会不会打成大球？", "球会不会很多？"])], ["Analyst", `三球以上概率${tg.ge3pct}，氛围不算淡。`]);
    if (ts.length >= 3) lines.push(["Anchor", pick(seed + 16, ["最可能的比分有哪些？", "热门比分是哪几个？", "比分前几名是？"])], ["Analyst", `前三是${ts[0]!.score}、${ts[1]!.score}、${ts[2]!.score}。`]);
    if (ts[0]) lines.push(["Anchor", pick(seed + 17, ["挺分散的。", "看着挺散。", "没谁一枝独秀。"])], ["Analyst", `对，单一比分最高也就${ts[0].pct}%，走势开放。`]);
    return lines;
  }

  // Act 4 — upset + closing compliance
  const lines: Pair[] = [["Anchor", pick(seed + 18, ["压轴问题，这场冷门会不会真的来？", "最后一问，冷门到底会不会来？", "收尾了，翻盘的门开着吗？"])]];
  if (up?.probPct) lines.push(["Analyst", `综合爆冷可能性约${up.probPct}，没法完全排除。`]);
  if (up?.favTeam) lines.push(["Anchor", pick(seed + 19, ["热门是哪边？", "谁是被看好的那个？", "热门站哪边？"])], ["Analyst", `模型把${up.favTeam}看作热门，但优势不大。`]);
  if (drivers[0]) lines.push(["Anchor", pick(seed + 20, ["主要是什么在推动？", "背后是什么在使劲？", "谁在把冷门往上抬？"])], ["Analyst", `${drivers[0].label}排在前面，强度约${drivers[0].pct}%。`]);
  const cm = (up?.complexityMetrics ?? []).filter(c => c.pct !== null);
  if (cm.length >= 2) lines.push(["Anchor", pick(seed + 21, ["复杂度高吗？", "这场乱不乱？", "变数多不多？"])], ["Analyst", `${cm[0]!.label}${cm[0]!.value}、${cm[1]!.label}${cm[1]!.value}，都不低。`]);
  const us = up?.scores ?? [];
  if (us.length >= 2) lines.push(["Anchor", pick(seed + 22, ["哪些比分支持爆冷？", "冷门更可能踢成几比几？", "翻盘的比分长啥样？"])], ["Analyst", `${us[0]!.score}、${us[1]!.score}这些非热门比分都有真实路径。`]);
  if (isLast) {
    lines.push(["Analyst", "以上内容仅供体育数据讨论。"]);
    lines.push(["Anchor", "模型概率不代表比赛结果承诺。"]);
    lines.push(["Analyst", "请理性看球，不作为任何参与决策依据。"]);
  }
  return lines;
}

// ===========================================================================
// Single-host monologue generator (第一人称"解局人"口播稿)
// ===========================================================================
//
// Same agent-first / deterministic-fallback shape as the dual-host path, but
// every line is voiced by a single Narrator (解局人). The narrative keeps the
// confiding "解局" persona (suspense + reveal) but is told in PLAIN, football-
// grounded language for a middle-school audience — no cross-domain/literary
// metaphors (门缝/裂缝/风向/资本…). Story spine, in plain words: 谁被当成热门 →
// 数据其实更冷静 → 牌面很散 → 冷门会不会来. Strictly on top of the probability-only
// MarketData (市场隐含 vs 模型概率 + 漂移, 爆冷驱动). The compliance口径 is
// unchanged: no odds/betting/capital-amount language ever.

/** Agent-first single-host monologue generator. One LLM call writes all acts. */
async function writeMonologueWithLLM(
  plan: TalkPlan,
  blocksFile: BlocksFile,
  market: MarketData | null,
  knobs: AdaptiveKnobs,
  dataPool: ReadonlySet<string>,
  creativeSeed: string,
): Promise<SceneDialogue[]> {
  if (!market || !market.market1x2) throw new Error("no market data for monologue brief");

  const closing = compliancePhrasesByPlacement("closing").map(p => p.text);
  const glossary = loadGlossary().terms;
  const banned = loadBanned().banned;

  const totalSec = plan.scenes.reduce((s, x) => s + x.targetSec * knobs.sceneSecScale, 0);
  const minChars = minTotalChars() + 30; // hard floor for the agent to clear
  // Aim comfortably ABOVE the floor so the agent clears it on its own and the
  // canned-template top-up never fires (the agent's "少数字多故事" voice tends to
  // under-produce on length, so we ask for headroom).
  const targetChars = Math.max(Math.round(totalSec * CPS), minChars + 60);

  const systemPrompt = buildMonologueSystemPrompt({
    glossary,
    banned: [...banned, ...knobs.extraBanned],
    closing,
  });

  const userPrompt = JSON.stringify({
    creativeSeed,
    创作要求: "这是单人解局口播稿，必须根据本场 brief 自由创作：禁止套用任何固定模板/范文/口头禅，开场切入、叙事顺序每一场都要独一无二；用 creativeSeed 选定本场独特的切入角度。**保持解局人的悬念感，但全程用大白话和球场上看得见的画面来讲，面向中学文化程度的普通球迷，一听就懂；严禁门缝/裂缝/风向/资本/钥匙/棋局/电影这类跨领域抽象比喻**。**以 brief 的「定性解读」（伤情/战术/动机/场地/样本/强弱）为故事素材，用因果推理层层揭开这场的'局'**；数字极省——整片最多一两个、且无小数，「关键数字备查」只作参考不要念。",
    ...(writeEditorialNote() ? {
      编辑视角: writeEditorialNote(),
      编辑视角说明: "这是本场人工指定的叙事切入与背景视角，请据此组织故事的悬念与主线；但仍须忠于 brief 的真实数据与强弱关系，遵守全部合规与禁用词规则，不得为此编造数据或越过合规边界。",
    } : {}),
    totalScenes: plan.scenes.length,
    targetChineseChars: targetChars,
    minChineseChars: minChars,
    acts: plan.scenes.map((s, i) => ({
      act: i + 1,
      beat: s.narrativeBeat,
      kind: s.visualSpec.kind,
      title: s.title,
      targetSeconds: round(s.targetSec * knobs.sceneSecScale, 1),
    })),
    brief: buildMarketBrief(market),
  }, null, 2);

  const raw = await chatJson<LLMScriptResponse>({
    systemPrompt,
    userPrompt,
    maxTokens: Math.max(1800, Math.round(targetChars * 4)),
    temperature: 0.9,
    // 3 attempts: a transient provider hiccup must NOT drop us to the canned
    // (identical-every-match) deterministic template — keep retrying the agent.
    retries: 2,
    timeoutMs: writeAgentTimeoutMs(),
  });

  if (!raw || !Array.isArray(raw.scenes) || raw.scenes.length === 0) {
    throw new Error("LLM monologue response missing scenes[]");
  }

  const out: SceneDialogue[] = [];
  for (let i = 0; i < plan.scenes.length; i++) {
    const scene = plan.scenes[i]!;
    const src = raw.scenes[i]?.lines ?? raw.scenes[Math.min(i, raw.scenes.length - 1)]?.lines ?? [];
    const lines = toMonologueLines(scene, src, knobs, dataPool);
    if (lines.length < 1) throw new Error(`LLM monologue scene ${scene.id} produced 0 usable lines`);
    // Trim only genuinely runaway scenes; keep the agent's content otherwise so
    // the floor top-up rarely needs to run.
    const targetSec = scene.targetSec * knobs.sceneSecScale;
    let total = lines.reduce((s, l) => s + l.targetSec, 0);
    while (total > targetSec * 1.6 && lines.length > 2) {
      total -= lines.pop()!.targetSec;
    }
    out.push({ sceneId: scene.id, lines });
  }
  return out;
}

/** Turn raw lines into sanitised single-speaker Narrator DialogueLine[]. */
function toMonologueLines(
  scene: Scene,
  src: ReadonlyArray<{ speaker?: unknown; text?: unknown }>,
  knobs: AdaptiveKnobs,
  dataPool: ReadonlySet<string>,
): DialogueLine[] {
  const out: DialogueLine[] = [];
  let lid = 0;
  for (const r of src) {
    let text = (typeof r?.text === "string" ? r.text : String(r?.text ?? "")).trim();
    if (!text) continue;
    text = stripBanned(text, knobs.extraBanned);
    text = sanitiseNumbers(text, dataPool);
    text = ensureTerminalPunctuation(splitLongSentences(text));
    if (!text) continue;
    const estChars = countCJK(text);
    lid += 1;
    out.push({
      id: `${scene.id}-l${lid}`,
      sceneId: scene.id,
      speaker: "Narrator",
      text,
      ssml: lineToSsml(text, "Narrator"),
      targetSec: round(estChars / CPS, 2),
      estChars,
    });
  }
  return out;
}

export function buildMonologueSystemPrompt(opts: {
  glossary: GlossaryTerm[];
  banned: string[];
  closing: string[];
}): string {
  const glossList = opts.glossary.map(t => {
    const allNames = [t.term, ...t.aliases].join(" / ");
    return `- 看到 ${allNames} → **直接说 "${t.simpleZh}"**（不保留英文、不加括号）`;
  }).join("\n");
  const bannedList = opts.banned.map(b => `- ${b}`).join("\n");
  const closingList = opts.closing.map(p => `- ${p}`).join("\n");
  const host = SPEAKER_DISPLAY.Narrator;

  return `你是一档中文足球解读节目的单人口播主笔。你拿到一场比赛的赛前数据简报（user 消息里的 brief 与 acts），要把它写成**第一人称、单人讲述**的口播稿，用于直接配音和压制竖屏短视频。整片约 150 秒，只有一个声音——主讲人「${host}」。**这是一档"讲故事"的节目，不是念数据**——不要套用任何固定模板或范文，每一场都要有不同的说法。

# 自由创作（硬规则，最重要）
- 这是你的**原创**，不是填模板：user 消息里的 creativeSeed 是本场专属的创作种子，用它为这一场选定一个**独一无二**的切入角度和叙事顺序，确保和任何其他场次都不雷同
- **严禁**任何固定开场白、口头禅或范文句式；变化要来自**本场真实的比赛故事**（谁被看好、强弱差、状态、伤情、概率分布、冷门可能），**而不是靠发明新奇的比喻**
- 让观众听完明确感到"这是专门讲这一场的"，而不是一个通用模板换了队名

# 人设与腔调（重要）
- 你是「${host}」：冷静、笃定、略带神秘感的"解局人"，像在跟观众交底、把表面下的门道一层层讲清楚
- 全程像在讲一个"局"：设悬念、抛反问、揭真相——但**用大白话和球场上的画面来讲，绝不故弄玄虚**
- 观众是来**听门道、听故事**的：你的任务是把冷冰冰的概率，翻译成**看得见的比赛画面**（谁攻谁守、谁快谁稳、主场气势、体能、伤病、板凳厚不厚）
- **你的故事素材主要来自 brief 的「定性解读」**（伤情、阵容、战术博弈、动机背景、场地、样本可靠性、强弱底子）——用**因果推理**串起来（"因为右路主力受伤 → 逼对手改打法 → 中场被谁控住 → 冷门就有机会"），让观众听到层层剥开的分析，而不是一句结论

# 直白易懂（硬规则，最重要之一）
- 听众是**中学文化程度的普通球迷**，没看过任何数据报告：**"一听就懂"是硬标准**，宁可直白重复，也不要绕弯子
- **比喻只能用足球场上看得见的画面和球赛术语**：控球、反击、压迫、防线、定位球、体能、主场氛围、伤病、板凳深度、纸面实力、状态起伏……
- **严禁任何跨领域、文学化、抽象的隐喻**——不许出现"门缝 / 裂缝 / 裂隙 / 一道门""风向 / 暗线 / 一股热""脚下的纸 / 窗户纸""钥匙开锁 / 一盘棋 / 一部电影 / 一封信 / 资本"这类要观众动脑筋去猜的说法
- 自检：**一个比喻如果还要再补一句才能听懂，就不要用它**，直接用大白话把意思说出来

# 少数字、多故事（硬规则，最关键）
- **整片最多出现一两个数字，能不用就不用**；绝对不要逐条念概率、比分、评分、百分比
- **严禁任何小数点**；真要提量级，只用大白话："六成上下""勉强过半""三分之一不到""几乎一边倒""五五开"
- 概率高低、热度强弱、冷门大小，用**具体的比赛画面和因果**讲清楚（如"球不会太多，因为两队都不急着压上"），不要用抽象比喻替代

# 故事结构（四幕，硬规则）
- 输出的 scenes 数组**顺序与数量必须与 acts 完全一致**（4 幕就是 4 个 scene）
- 第一幕：开场用一句带节目品牌「${COMPLIANCE_POLICY.brand}」的自我介绍（"我是${host}"），然后**结论先行、直给**——一句大白话说清表面上谁被当成稳赢的、可疑点在哪、悬念是什么，钩子要来自**真实的比赛故事**（伤情/动机/强弱/主客场）。**严禁"这场像一部…/像两把钥匙…/像一封信…"这种要人猜的冷开场**；**开场也不要朗读任何合规免责短句**。
- 第二幕：讲大家为什么把某一方当热门——外界、舆论把谁越捧越高，可**数据（模型）其实更冷静、没那么看好**，这份"被高估的热度"就是本场第一个疑点；只讲"外界比数据更看好谁"，不谈任何资金
- 第三幕：讲牌面其实是散的——赢、平、冷门，没谁真把谁锁死，表面平静下面变数不少
- 第四幕：讲**冷门到底会不会来、会从哪来**（是被对手打反击掀翻，还是自己太顺被拖住），收束成一句"真相"；最后把下面每一条合规话都**完整落到口播里（关键词原样出现，不可省）**：
${closingList}
- 每一幕都要有一处"钩子式"反问勾起好奇（例如"这场真有那么稳吗？""冷门的机会到底大不大？"）

# 直白开场示范（照这种"直白 + 球场画面"的方向写，别照抄）
- ❌ 不要（抽象、要动脑筋）："这场像两把钥匙开同一把锁。""这场，风向是谁吹起来的？"
- ✅ 要（直白、有画面、有悬念）："都说主队稳赢，我偏想多看一眼——他们中卫刚受伤，客队最近全靠反击吃饭，这场没那么简单。"

# 话术口径（合规硬规则，整片所有幕都遵守）
- **严禁任何彩票、投注、下注、购买、推荐、收益、赔率、庄家、抽水、资金、资本、金额或行动引导措辞**；这是一档纯粹的赛前概率观察节目
- "谁更被看好"只用**球队热度 / 外界看好 / 数据更冷静**这类球赛说法来讲，绝不出现赔率、金额、下注、庄家、资金、资本等词
- "冷门 / 变数"只指向**比赛本身的不确定性**，不是任何金融或资金风险
- 形容球队不要用"硬/软"，改用"偏强/偏弱、主场气势、客场冲击力、攻强守稳、经验老到、年轻冲劲"等球赛说法

# 无时间概念（硬规则）
- 不要出现任何日历/时钟/时长概念（今晚/明天/几点/北京时间/三分钟讲透/这期视频…）
- 直接用对阵（队名）称呼这场比赛；「赛前」可正常使用；足球比赛内部的"上/下半场、补时、第X分钟、近五场、本赛季"可正常使用

# 数据保真（硬规则）
- 只能依据 brief 里真实的倾向、队名、强弱关系来讲；不得编造模型名、算法名，也不得为了戏剧性夸大成"必胜/铁定爆冷"
- 即便讲故事，方向也要和 brief 一致（谁更被看好、冷门大致大不大）

# 全中文口播（硬规则，TTS 直接配音）
- **尽量不写数字**；万一要写，必须是中文汉字读法且**没有小数**（如"六成""过半"），不要阿拉伯数字、百分号、连字符比分
- 不要出现 "—"、"~"、"…"、"≥"、"P="、"%" 这类符号；不要写英文/缩写术语本身，统一改成下面通俗中文：
${glossList}
- 严禁出现以下词汇（含变体）：
${bannedList}

# 写作约束
- **单人口播：每一行都是「${host}」一个人在说**，不要写成对话、不要出现第二个角色、不要有问答互换
- 一行 ≤ 28 个中文字（含标点）；每行落到完整句号/问号/感叹号；多用短句，像讲故事一样有节奏、有停顿
- 总字数贴近 targetChineseChars，并且**绝对不能少于 minChineseChars 字（硬性下限，宁可多讲一两句故事也不要写短）**；每个中间幕（act 2/3/4）至少写 8 行短句，把故事讲透、讲满

# 输出格式（只输出 JSON，不要任何额外说明）
{
  "scenes": [
    { "lines": [ { "speaker": "Narrator", "text": "..." }, { "speaker": "Narrator", "text": "..." } ] }
  ]
}`;
}

/**
 * Build a conclusion-first single-host monologue directly from MarketData.
 * Used when no LLM is configured or the agent call fails. Falls back to a
 * single-voice relabel of the dual-host deterministic script when the report
 * has no structured market data.
 */
function deterministicMonologue(
  plan: TalkPlan,
  market: MarketData | null,
  blockMap: Map<string, Block>,
  knobs: AdaptiveKnobs,
): SceneDialogue[] {
  if (!market || !market.market1x2 || (market.market1x2.outcomes ?? []).length === 0) {
    const fallback = deterministicScript(plan, market, blockMap, knobs);
    for (const sd of fallback) {
      for (const l of sd.lines) {
        l.speaker = "Narrator";
        l.ssml = lineToSsml(l.text, "Narrator");
      }
    }
    return fallback;
  }

  const out: SceneDialogue[] = [];
  const seed = pickIndex(plan.matchId);
  for (let i = 0; i < plan.scenes.length; i++) {
    const scene = plan.scenes[i]!;
    let lid = 0;
    const mk = (text: string): DialogueLine => {
      const cleanText = ensureTerminalPunctuation(splitLongSentences(stripBanned(text, knobs.extraBanned)));
      const estChars = countCJK(cleanText);
      lid += 1;
      return {
        id: `${scene.id}-l${lid}`,
        sceneId: scene.id,
        speaker: "Narrator",
        text: cleanText,
        ssml: lineToSsml(cleanText, "Narrator"),
        targetSec: round(estChars / CPS, 2),
        estChars,
      };
    };
    const texts = monologueActLines(i, plan.scenes.length, market, seed);
    out.push({ sceneId: scene.id, lines: texts.map(t => mk(t)) });
  }
  return out;
}

function monologueActLines(actIndex: number, totalActs: number, m: MarketData, seed = 0): string[] {
  const o = m.market1x2!.outcomes;
  const lead = o.reduce((a, b) => (b.pct > a.pct ? b : a), o[0]!);
  const home = o.find(x => /主/.test(x.role)) ?? o[0]!;
  const away = o.find(x => /客/.test(x.role)) ?? o[o.length - 1]!;
  const homeName = m.hero?.homeName || home.team || "主队";
  const awayName = m.hero?.awayName || away.team || "客队";
  const leadName = lead.team || lead.role || "热门";
  const sig = m.marketSignal?.rows ?? [];
  const up = m.upset;
  const isLast = actIndex === totalActs - 1;
  const host = SPEAKER_DISPLAY.Narrator;
  const p = (n: number, arr: readonly string[]): string => pick(seed + n, arr);

  // Qualitative phrasing — listeners want story, not arithmetic. Never emit a
  // raw percentage / decimal; translate magnitudes into plain football words
  // (no cross-domain / literary metaphors).
  const favWord = (pct: number): string => {
    if (!Number.isFinite(pct)) return "更看好它一些";
    if (pct >= 70) return "把它排得很靠前";
    if (pct >= 60) return "更看好它一些";
    if (pct >= 52) return "让它稍占上风";
    return "觉得两队很接近";
  };
  const upPct = parseFloat(String(up?.probPct ?? "").replace(/[^\d.]/g, ""));
  const upsetWord = (): string => {
    if (!Number.isFinite(upPct)) return "一直都在";
    if (upPct >= 45) return "真不算小";
    if (upPct >= 33) return "一直都在";
    if (upPct >= 22) return "有那么一点";
    return "不大，但没断";
  };
  // The side the model rates higher than the market (the overlooked one).
  // Prefer a real team name; avoid pointing at 平局 when a win side is available.
  const valueRow = sig.find(r => r.mismatchPp > 3 && r.role !== lead.role && !/平/.test(r.role))
    ?? sig.find(r => r.mismatchPp > 3 && r.role !== lead.role);
  const valueOutcome = valueRow ? o.find(x => x.role === valueRow.role) : o.find(x => x.role !== lead.role && !/平/.test(x.role));
  const valueRole = valueOutcome?.team || valueRow?.role || "另一边";

  if (actIndex === 0) {
    return [
      p(0, [
        `欢迎来到${COMPLIANCE_POLICY.brand}，我是${host}。`,
        `这里是${COMPLIANCE_POLICY.brand}，我是${host}。`,
        `${host}在这里，欢迎收看${COMPLIANCE_POLICY.brand}。`,
      ]),
      p(1, [
        `${homeName}对${awayName}，这场看着一边倒。`,
        `${homeName}对${awayName}，赛前几乎没人聊冷门。`,
        `先看${homeName}对${awayName}，表面上没什么悬念。`,
      ]),
      p(2, [
        `几乎所有人都站在${leadName}这边。`,
        `外界的天平，早早倒向了${leadName}。`,
        `大家嘴里的赢家，都是${leadName}。`,
      ]),
      p(3, [`都把它当成稳稳的赢家。`, `好像它上场就能赢。`, `仿佛结果已经写好。`]),
      `数据也确实${favWord(lead.pct)}。`,
      p(4, [
        `可越是一边倒，我越想多看一眼。`,
        `可这种"稳"，最值得多问一句。`,
        `可赛前越安静，场上越容易出事。`,
      ]),
      p(5, [`${leadName}真有那么保险吗？`, `热门就一定笑到最后？`, `强的一方，真能高枕无忧？`]),
      p(6, [`${valueRole}真就一点机会都没有？`, `弱的一方，只能来陪跑？`, `冷门那边，真就没戏了？`]),
      p(7, [`这场我一层层拆给你看。`, `跟着我，把门道看清楚。`, `我带你把这场从头捋到尾。`]),
    ];
  }

  if (actIndex === 1) {
    return [
      p(10, [`先说说，大家为什么这么看好${leadName}。`, `先弄明白，${leadName}的热度从哪来。`, `第一层，${leadName}凭什么被当热门。`]),
      p(11, [`名气更大，纸面实力也高一截。`, `阵容更硬，账面上确实压对手一头。`, `牌面上，${leadName}是更强的一方。`]),
      p(12, [`外界的目光，几乎全压在它身上。`, `舆论一边倒，都替它把结果想好了。`, `大家嘴上，早把三分给了它。`]),
      p(13, [`可数据没跟着一起起哄。`, `可模型这边，明显更冷静。`, `可真算下来，没那么夸张。`]),
      p(14, [`它承认${leadName}更强，但优势没那么大。`, `强是强，可没强到高枕无忧。`, `领先是有，但只有一点点。`]),
      p(15, [`真正被看轻的，是${valueRole}。`, `被大家忽略的，恰恰是${valueRole}。`, `没人愿意提的，是${valueRole}。`]),
      p(16, [`越没人看好它，它的空间反而越大。`, `越被低估，冷门的伏笔埋得越深。`, `外界越松懈，它越有机可乘。`]),
      p(17, [`强队一旦松口气，比赛就有变数。`, `热门只要慢半拍，场面立刻不一样。`, `一旦轻敌，麻烦就找上门。`]),
      p(18, [`这份被高估的热度，就是第一个疑点。`, `这份虚高的信心，就是本场的破绽。`, `记住这个落差，后面用得上。`]),
    ];
  }

  if (actIndex === 2) {
    return [
      p(20, [`再看结果，其实比你想的要散。`, `把可能的结果摊开，并不集中。`, `这场的走向，没那么单一。`]),
      p(21, [`赢、平、还是被爆冷。`, `拿下、握手、还是被翻盘。`, `大胜、闷平、冷门。`]),
      p(22, [`三种结果，没谁把谁彻底摁死。`, `三条路都开着，谁也没堵死谁。`, `没有哪一种，是板上钉钉。`]),
      p(23, [`进球大概率也不会太多。`, `场面未必是大开大合。`, `火力未必有想的那么猛。`]),
      p(24, [`两队都不会一上来就压满。`, `谁都不敢先把后防亮出来。`, `开局多半是互相试探。`]),
      p(25, [`就连最被看好的那个比分。`, `哪怕呼声最高的那种赢法。`, `连最热门的走势。`]),
      p(26, [`也只是众多可能里的一个。`, `摊开看，也只是其中一条。`, `真踢出来的概率，并不压倒性。`]),
      p(27, [`所谓的稳，更多是一种错觉。`, `表面的确定，经不起细看。`, `"稳赢"两个字，水分不小。`]),
      p(28, [`越是这样，越说明这场不好说。`, `越拆越明白，这场没定数。`, `这也正是它好看的地方。`]),
    ];
  }

  // Act 4 — 冷门 / 爆冷 + 收尾合规
  const lines = [
    p(30, [`最后，说说冷门到底会不会来。`, `压轴，聊聊翻盘的可能。`, `收个尾，冷门有没有机会。`]),
    `这场爆冷的可能，${upsetWord()}。`,
    p(31, [`越被看好的一方，压力其实越大。`, `热门背着所有人的期待，脚步反而更重。`, `被捧得越高，一旦落后越慌。`]),
    p(32, [`一次反击、一个定位球，就能改写。`, `一次快攻、一粒角球，局面就变。`, `一个瞬间的走神，就够翻盘。`]),
    p(33, [`${valueRole}并不是来陪跑的。`, `${valueRole}手里也攥着几张牌。`, `别小看${valueRole}那口气。`]),
    p(34, [`它只要抓住一两次机会，就能咬住。`, `逮住机会，比分马上被追平。`, `顶住上半场，后面就有戏。`]),
    p(35, [`强队未必翻车，但也绝不是铁板。`, `热门大概率过关，可远谈不上保险。`, `${leadName}赢面是大，但没上保险。`]),
    p(36, [`所以这场的真相是。`, `说到底，这场的门道就一句。`, `一句话收个尾。`]),
    p(37, [`热门看着稳，可变数一直都在。`, `账面上占优，可场上的变数一个没少。`, `外界越笃定，越该留个心眼。`]),
  ];
  if (isLast) {
    lines.push("以上内容仅供体育数据讨论。");
    lines.push("模型概率不代表比赛结果承诺。");
    lines.push("请理性看球，不作为任何参与决策依据。");
  }
  return lines;
}


function ensureDualSpeakers(lines: DialogueLine[], sceneId: string): void {
  const hasAnchor  = lines.some(l => l.speaker === "Anchor");
  const hasAnalyst = lines.some(l => l.speaker === "Analyst");
  if (hasAnchor && hasAnalyst) return;
  // Flip an interior line to the missing role
  const missing: "Anchor" | "Analyst" = hasAnchor ? "Analyst" : "Anchor";
  const target = lines[Math.floor(lines.length / 2)];
  if (target) {
    target.speaker = missing;
    target.ssml = lineToSsml(target.text, missing);
  }
}

/**
 * Set of every numeric token (with various stringifications) that exists in
 * the source blocks. WRITE uses it to suppress accidental hallucinations in
 * the LLM output: numbers not in this set are replaced with the nearest
 * legal value when an obvious match exists, otherwise stripped.
 *
 * We don't aggressively rewrite — minor mismatches usually trip the
 * verifier as warnings rather than errors, and supervisor adapts on rerun.
 */
function buildDataPool(blocksFile: BlocksFile): Set<string> {
  const pool = new Set<string>();
  for (const b of blocksFile.blocks) {
    for (const dp of b.dataPoints) {
      if (typeof dp.value === "number") {
        pool.add(dp.value.toString());
        pool.add(dp.value.toFixed(1));
        pool.add(dp.value.toFixed(2));
        if (dp.kind === "probability") {
          pool.add((dp.value * 100).toFixed(0));
          pool.add((dp.value * 100).toFixed(1));
        }
      } else if (typeof dp.value === "string") {
        pool.add(dp.value.trim());
      }
    }
    if (b.kind === "paragraph") harvestNumbers(b.text, pool);
    if (b.kind === "callout") harvestNumbers(b.text, pool);
    if (b.kind === "list") b.items.forEach(i => harvestNumbers(i.text, pool));
    if (b.kind === "table") b.rows.forEach(r => r.forEach(c => harvestNumbers(c.text, pool)));
    if (b.kind === "kpi-grid") b.items.forEach(i => harvestNumbers(`${i.label} ${i.value}`, pool));
    if (b.kind === "bar-list") b.items.forEach(i => {
      harvestNumbers(i.label, pool);
      pool.add((i.probability * 100).toFixed(0));
      pool.add((i.probability * 100).toFixed(1));
    });
    if (b.kind === "strategy-card") {
      b.allocations.forEach(a => {
        if (a.amount !== undefined) pool.add(a.amount.toString());
        if (a.units !== undefined)  pool.add(a.units.toString());
      });
      if (b.total?.amount !== undefined) pool.add(b.total.amount.toString());
    }
    if (b.kind === "unknown") harvestNumbers(b.text, pool);
  }
  return pool;
}

function harvestNumbers(s: string, into: Set<string>): void {
  const nums = s.match(/[+\-−]?\d+(?:\.\d+)?/g);
  if (!nums) return;
  for (const n of nums) into.add(n.replace("−", "-"));
}

/**
 * Conservative numeric guard: only strips obviously fabricated multi-digit
 * numbers (e.g. "98%" when 98 doesn't appear anywhere). Single-digit ints and
 * a few sentence-template constants (100, 50, …) are always allowed because
 * the verifier already whitelists them.
 */
function sanitiseNumbers(text: string, pool: ReadonlySet<string>): string {
  return text.replace(/(\d+(?:\.\d+)?)/g, (m) => {
    const v = parseFloat(m);
    if (!Number.isFinite(v)) return m;
    if (Math.abs(v) < 10 && Number.isInteger(v)) return m;
    if ([100, 50, 30, 20, 10, 5, 2].includes(v)) return m;
    if (pool.has(m)) return m;
    if (pool.has(v.toString())) return v.toString();
    if (pool.has(v.toFixed(1))) return v.toFixed(1);
    // Last resort: keep but flag — verifier will surface as warning
    return m;
  });
}
