#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import pLimit from "p-limit";
import { buildRunContext, loadOrInitState, readJson } from "./orchestrator/runContext.js";
import { createRunState, type Phase, type RunState } from "./orchestrator/stateMachine.js";
import { runPhase, runRange, type PhaseHandlers } from "./orchestrator/supervisor.js";
import { ingest } from "./phases/01-ingest.js";
import { plan } from "./phases/02-plan.js";
import { write } from "./phases/03-write.js";
import { verifyText } from "./phases/04-verify-text.js";
import { auditTalkTrack } from "./phases/04b-audit-talk.js";
import { tts } from "./phases/05-tts.js";
import { verifyAudio } from "./phases/06-verify-audio.js";
import { avatar } from "./phases/06b-avatar.js";
import { compose } from "./phases/07-compose.js";
import { verifyVisual } from "./phases/08-verify-visual.js";
import { render } from "./phases/09-render.js";
import { verifyAv } from "./phases/10-verify-av.js";
import { auditVisualFrames } from "./phases/10b-audit-visual.js";
import { post } from "./phases/11-post.js";
import { applyRunProfile, activeHarnessProfile, parseScriptMode, scriptMode, applyVoiceOverrides, applyCloneRefOverrides, avatarImagePath, avatarResolution, avatarSegments, type ScriptMode } from "./tools/runProfile.js";
import { fetchReport, deriveReportPath } from "./tools/reportFetch.js";
import { discoverMatches } from "./tools/matchDiscovery.js";
import { isAvatarEnabled, avatarBaseUrl } from "./tools/avatarClient.js";
import { prewarmAvatarClip } from "./tools/avatarGenerate.js";
import { avatarLibraryDir, libraryClipName, activeAvatarPrompt, readIndex, fileSha256 } from "./tools/avatarLibrary.js";

const HANDLERS: PhaseHandlers = {
  INGEST:        ingest,
  PLAN:          plan,
  WRITE:         write,
  VERIFY_TEXT:   verifyText,
  AUDIT_TALK:    auditTalkTrack,
  TTS:           tts,
  VERIFY_AUDIO:  verifyAudio,
  AVATAR:        avatar,
  COMPOSE:       compose,
  VERIFY_VISUAL: verifyVisual,
  RENDER:        render,
  VERIFY_AV:     verifyAv,
  AUDIT_VISUAL:  auditVisualFrames,
  POST:          post,
};

const ROOT = process.env.HARNESS_WORK_DIR ?? "out";
const BATCH_PARALLEL = parseInt(process.env.HARNESS_BATCH_PARALLEL ?? "2", 10);

const program = new Command();
program
  .name("harness")
  .description("Agent-first football data observation video harness")
  .version("0.1.0");

interface BatchRow {
  matchId: string;
  status: "ok" | "fail";
  workDir?: string;
  finalMp4?: string;
  totalSec?: number;
  sceneCount?: number;
  cacheHits?: number;
  cacheMisses?: number;
  attempts?: number;
  phaseDurationsSec?: Record<string, number>;
  renderRuns?: number;
  compliancePolicy?: string;
  restrictedTerms?: string[];
  escalated?: boolean;
  err?: string;
}

program
  .command("run")
  .argument("[input]", "HTML report file OR directory of reports (omit when using --url)")
  .option("--url <url>", "Fetch an HTML report from a URL (SPA-rendered) before running")
  .option("--phase <name>", "Run a single phase (INGEST, PLAN, …)")
  .option("--from <name>", "Start from this phase (default INGEST)")
  .option("--to <name>", "Stop after this phase (default POST)")
  .option("--parallel <n>", "Number of reports processed in parallel", String(BATCH_PARALLEL))
  .option("--profile <name>", "Run profile: fast, draft, or final (default final)")
  .option("--mode <name>", "Script mode: podcast (dual-host) or monologue (single-host)")
  .option("--voice <name>", "Qwen3-TTS named voice override (mode-aware: monologue→Narrator, podcast→both hosts)")
  .option("--voice-male <name>", "Qwen3-TTS voice for Analyst 小帅 (QWEN_TTS_VOICE_MALE)")
  .option("--voice-female <name>", "Qwen3-TTS voice for Anchor 小美 (QWEN_TTS_VOICE_FEMALE)")
  .option("--voice-narrator <name>", "Qwen3-TTS voice for Narrator 解局人 (QWEN_TTS_VOICE_NARRATOR)")
  .option("--clone-ref <wav>", "Clone a custom voice from a reference wav (mode-aware: monologue→Narrator, podcast→both hosts)")
  .option("--clone-ref-male <wav>", "Reference wav to clone for Analyst 小帅 (QWEN_TTS_CLONE_REF_MALE)")
  .option("--clone-ref-female <wav>", "Reference wav to clone for Anchor 小美 (QWEN_TTS_CLONE_REF_FEMALE)")
  .option("--clone-ref-narrator <wav>", "Reference wav to clone for Narrator 解局人 (QWEN_TTS_CLONE_REF_NARRATOR)")
  .option("--clone-ref-text <text>", "Transcript of --clone-ref (enables higher-fidelity ICL cloning)")
  .option("--skip-avatar", "Skip the bottom digital-human presenter clip (deck ships with a framed placeholder)")
  .option("--avatar-image <png>", "Override the avatar source image (default: mode-aware two-people/single-people.png)")
  .option("--avatar-resolution <res>", "Avatar render resolution: 480p (default) or 720p")
  .option("--avatar-segments <n>", "Avatar continuation segments (each ~3.7s/~10min; default 1)")
  .option("--summary <file>", "Write batch summary JSON to file (default stdout)")
  .option("--result-json <file>", "Write a machine-readable per-report result manifest (mp4 path, duration, compliance)")
  .action(async (input: string | undefined, opts: { url?: string; phase?: string; from?: string; to?: string; parallel?: string; profile?: string; mode?: string; voice?: string; voiceMale?: string; voiceFemale?: string; voiceNarrator?: string; cloneRef?: string; cloneRefMale?: string; cloneRefFemale?: string; cloneRefNarrator?: string; cloneRefText?: string; skipAvatar?: boolean; avatarImage?: string; avatarResolution?: string; avatarSegments?: string; summary?: string; resultJson?: string }) => {
    if (opts.mode) process.env.HARNESS_SCRIPT_MODE = parseScriptMode(opts.mode);
    // Avatar (digital-human presenter) overrides → env consumed by the AVATAR phase.
    if (opts.skipAvatar) process.env.HARNESS_SKIP_AVATAR = "1";
    if (opts.avatarImage) process.env.HARNESS_AVATAR_IMAGE = opts.avatarImage;
    if (opts.avatarResolution) process.env.HARNESS_AVATAR_RESOLUTION = opts.avatarResolution;
    if (opts.avatarSegments) process.env.HARNESS_AVATAR_SEGMENTS = opts.avatarSegments;
    // Qwen3-TTS voice overrides — applied AFTER mode resolution so the generic
    // --voice routes to the correct host(s). qwen backend only; Azure unchanged.
    applyVoiceOverrides({
      voice: opts.voice,
      voiceMale: opts.voiceMale,
      voiceFemale: opts.voiceFemale,
      voiceNarrator: opts.voiceNarrator,
    });
    // Voice-clone references (Qwen3-TTS Base model). Also mode-aware.
    applyCloneRefOverrides({
      cloneRef: opts.cloneRef,
      cloneRefMale: opts.cloneRefMale,
      cloneRefFemale: opts.cloneRefFemale,
      cloneRefNarrator: opts.cloneRefNarrator,
      cloneRefText: opts.cloneRefText,
    });
    const profile = applyRunProfile(opts.profile);
    if (opts.url) {
      const out = deriveReportPath(opts.url, "inputs");
      console.log(`⇣ fetching ${opts.url}`);
      const r = await fetchReport(opts.url, out);
      console.log(`  saved ${(r.bytes / 1024).toFixed(1)}KB via ${r.via} → ${r.outPath}`);
      input = r.outPath;
    }
    if (!input) {
      console.error("Provide an <input> file/dir or --url <url>");
      process.exit(1);
    }
    const files = await collectInputFiles(input);
    if (files.length === 0) {
      console.error(`No .html files found for input ${input}`);
      process.exit(1);
    }
    const limit = pLimit(Math.max(1, parseInt(opts.parallel ?? String(BATCH_PARALLEL), 10)));
    const rows: BatchRow[] = await Promise.all(files.map((f) => limit(async () => {
      const ctx = await buildRunContext(f, ROOT);
      const state = await loadOrInitState(ctx, () => createRunState(ctx.matchId, ctx.reportPath));
      const row: BatchRow = { matchId: ctx.matchId, status: "ok", workDir: path.resolve(ctx.workDir) };
      console.log(`▶ ${ctx.matchId}`);
      try {
        if (opts.phase) {
          await runPhase(ctx, state, opts.phase as Phase, HANDLERS);
        } else {
          const from = (opts.from ?? "INGEST") as Phase;
          const to = (opts.to ?? "POST") as Phase;
          await runRange(ctx, state, from, to, HANDLERS);
        }
        try {
          const mani = await readJson<{ totalSec: number; scenes: any[] }>(ctx.paths.audioManifest);
          row.totalSec = mani.totalSec;
          row.sceneCount = mani.scenes.length;
        } catch {}
        row.finalMp4 = await existingAbs(ctx.paths.finalMp4);
        try {
          const audit = await readJson<{ compliancePolicy?: string; restrictedTerms?: string[] }>(ctx.paths.complianceAudit);
          row.compliancePolicy = audit.compliancePolicy;
          row.restrictedTerms = audit.restrictedTerms ?? [];
        } catch {}
        row.cacheHits = state.ttsCacheHits ?? 0;
        row.cacheMisses = state.ttsCacheMisses ?? 0;
        row.attempts = state.phases.reduce((s, p) => s + (p.attempts ?? 0), 0);
        row.phaseDurationsSec = phaseDurations(state);
        row.renderRuns = state.phases.filter(p => p.phase === "RENDER").length;
        console.log(`✔ ${ctx.matchId} ${row.totalSec?.toFixed(1) ?? "?"}s / ${row.sceneCount ?? "?"} scenes / cache ${row.cacheHits}/${(row.cacheHits ?? 0)+(row.cacheMisses ?? 0)}`);
        if ((row.renderRuns ?? 0) > 1) console.warn(`WARN ${ctx.matchId}: RENDER ran ${row.renderRuns} times; inspect routed issues in state.json`);
      } catch (e: any) {
        row.status = "fail";
        row.err = String(e?.message ?? e);
        row.escalated = await fileExists(ctx.paths.escalation);
        row.finalMp4 = await existingAbs(ctx.paths.finalMp4);
        console.error(`✖ ${ctx.matchId}: ${row.err}`);
      }
      return row;
    })));

    const okCount = rows.filter(r => r.status === "ok").length;
    const failCount = rows.length - okCount;
    const totalHits = rows.reduce((s, r) => s + (r.cacheHits ?? 0), 0);
    const totalMisses = rows.reduce((s, r) => s + (r.cacheMisses ?? 0), 0);
    const cacheHitRate = (totalHits + totalMisses) === 0 ? 0 : totalHits / (totalHits + totalMisses);

    const summary = {
      total: rows.length,
      ok: okCount,
      fail: failCount,
      profile,
      ttsCacheHits: totalHits,
      ttsCacheMisses: totalMisses,
      ttsCacheHitRate: round(cacheHitRate, 3),
      avgTotalSec: avg(rows.map(r => r.totalSec).filter((x): x is number => typeof x === "number")),
      avgScenes: avg(rows.map(r => r.sceneCount).filter((x): x is number => typeof x === "number")),
      rows,
      generatedAt: new Date().toISOString(),
    };
    if (opts.summary) {
      await fs.writeFile(opts.summary, JSON.stringify(summary, null, 2), "utf8");
      console.log(`\nSummary written to ${opts.summary}`);
    } else {
      console.log(`\n── Batch summary ──`);
      console.log(`Reports:   ${rows.length} total · ${okCount} ok · ${failCount} fail`);
      console.log(`Profile:   ${activeHarnessProfile()}`);
      console.log(`TTS cache: ${totalHits}/${totalHits+totalMisses} (${(cacheHitRate*100).toFixed(1)}%)`);
      if (typeof summary.avgTotalSec === "number") console.log(`Avg dur:   ${summary.avgTotalSec.toFixed(1)}s  Avg scenes: ${summary.avgScenes?.toFixed(1)}`);
      const repeatedRender = rows.filter(r => (r.renderRuns ?? 0) > 1);
      if (repeatedRender.length > 0) console.warn(`Repeated render: ${repeatedRender.map(r => `${r.matchId}×${r.renderRuns}`).join(", ")}`);
    }

    if (opts.resultJson) {
      const result = {
        ok: failCount === 0,
        profile,
        mode: scriptMode(),
        reports: rows.map(r => ({
          matchId: r.matchId,
          status: r.status,
          ok: r.status === "ok",
          workDir: r.workDir,
          finalMp4: r.finalMp4 ?? null,
          durationSec: r.totalSec ?? null,
          sceneCount: r.sceneCount ?? null,
          compliancePolicy: r.compliancePolicy ?? null,
          restrictedTerms: r.restrictedTerms ?? [],
          escalated: r.escalated ?? false,
          error: r.err ?? null,
        })),
        generatedAt: new Date().toISOString(),
      };
      await fs.writeFile(opts.resultJson, JSON.stringify(result, null, 2), "utf8");
      console.log(`Result manifest written to ${opts.resultJson}`);
    }

    if (failCount > 0) process.exit(2);
  });

program
  .command("fetch")
  .argument("<url>", "HTML report URL (SPA-rendered via headless Chromium)")
  .argument("[out]", "Output .html path (default: inputs/<bucket>/<slug>.html)")
  .description("Fetch and SPA-render an HTML report from a URL into a local file")
  .action(async (url: string, out: string | undefined) => {
    const target = out ?? deriveReportPath(url, "inputs");
    const r = await fetchReport(url, target);
    console.log(`Saved ${(r.bytes / 1024).toFixed(1)}KB via ${r.via} → ${r.outPath}`);
  });

program
  .command("discover")
  .argument("[date]", "Target date: YYYY-MM-DD, YYYYMMDD, today, or tomorrow (default: tomorrow / T+1 Beijing)")
  .option("--json", "Emit machine-readable JSON { date, count, matches:[{matchId,url}] }")
  .description("Self-discover the day's match report URLs from the Supabase envelopes index")
  .action(async (date: string | undefined, opts: { json?: boolean }) => {
    const r = await discoverMatches({ date });
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    console.log(`\n── discovered ${r.count} match(es) for ${r.date} ──`);
    for (const m of r.matches) console.log(`  ${m.matchId}  ${m.url}`);
    if (r.count === 0) console.log("  (none — check the date or the Supabase index)");
  });

program
  .command("inspect")
  .argument("<input>", "HTML report file")
  .description("Run only INGEST and print Block[] summary (no LLM, no TTS, no render)")
  .action(async (input: string) => {
    const ctx = await buildRunContext(input, ROOT);
    const state = await loadOrInitState(ctx, () => createRunState(ctx.matchId, ctx.reportPath));
    await runPhase(ctx, state, "INGEST", HANDLERS);
    const blocks = JSON.parse(await fs.readFile(ctx.paths.blocks, "utf8"));
    const byKind = Object.entries(blocks.stats.byKind as Record<string, number>)
      .sort(([, a], [, b]) => b - a)
      .map(([k, v]) => `  ${k.padEnd(16)} ${v}`).join("\n");
    const top = blocks.blocks
      .slice()
      .sort((a: any, b: any) => b.importance - a.importance)
      .slice(0, 12)
      .map((b: any) => `  [${b.importance.toFixed(2)}] ${b.kind.padEnd(14)} ${b.id}  ${preview(b)}`)
      .join("\n");
    console.log(`\n── ${ctx.matchId} ──`);
    console.log(`Total blocks: ${blocks.stats.total}`);
    console.log(`Unknown%:     ${(blocks.stats.unknownPct * 100).toFixed(1)}%`);
    console.log(`High-importance (≥0.7): ${blocks.stats.highImportanceCount}`);
    console.log(`\nBy kind:\n${byKind}`);
    console.log(`\nTop 12 blocks by importance:\n${top}`);
    console.log(`\nWrote: ${ctx.paths.blocks}`);
  });

function preview(b: any): string {
  const path = b.headingPath?.length ? `[${b.headingPath.join(" › ")}] ` : "";
  let detail = "";
  switch (b.kind) {
    case "meta":          detail = `${b.matchZh ?? b.match}`; break;
    case "heading":       detail = `H${b.level} "${b.text}"`; break;
    case "paragraph":     detail = trunc(b.text, 60); break;
    case "kpi-grid":      detail = `${b.items.length} KPIs: ${b.items.map((i: any) => i.label).join(", ")}`; break;
    case "table":         detail = `${b.headers?.join("|")} (${b.rows.length} rows)`; break;
    case "bar-list":      detail = `${b.items.length} bars (${b.title ?? ""})`; break;
    case "strategy-card": detail = `${b.name} · ${b.allocations.length} alloc`; break;
    case "callout":       detail = `[${b.tone}] ${trunc(b.text, 50)}`; break;
    case "list":          detail = `${b.items.length} items`; break;
    case "unknown":       detail = `UNK: ${trunc(b.text, 60)}`; break;
    default:              detail = "";
  }
  return path + detail;
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function avg(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function phaseDurations(state: RunState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of state.phases) {
    if (!p.startedAt || !p.endedAt) continue;
    const sec = (Date.parse(p.endedAt) - Date.parse(p.startedAt)) / 1000;
    if (!Number.isFinite(sec) || sec < 0) continue;
    out[p.phase] = round((out[p.phase] ?? 0) + sec, 3);
  }
  return out;
}

function round(x: number, p: number): number {
  const f = Math.pow(10, p);
  return Math.round(x * f) / f;
}

async function existingAbs(p: string): Promise<string | undefined> {
  const abs = path.resolve(p);
  try { await fs.stat(abs); return abs; } catch { return undefined; }
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function collectInputFiles(input: string): Promise<string[]> {
  const stat = await fs.stat(input);
  if (stat.isFile()) return [path.resolve(input)];
  const entries = await fs.readdir(input);
  return entries
    .filter(f => f.endsWith(".html"))
    .map(f => path.resolve(input, f))
    .sort();
}

program
  .command("avatar-prewarm")
  .description(
    "Pre-generate digital-human clips via longcat and persist them to the version-controlled library " +
      "(assets/avatar-clips/). WARNING: each clip PAUSES the co-located qwen brain ~10 min — run this " +
      "deliberately out of band; the normal pipeline never generates and only consumes these clips.",
  )
  .option("--mode <name>", "podcast, monologue, or both (default both)", "both")
  .option("--avatar-image <png>", "Override the source image (single --mode only; default: mode-aware two-people/single-people.png)")
  .option("--avatar-resolution <res>", "480p (default) or 720p")
  .option("--avatar-segments <n>", "Continuation segments (each ~3.7s/~10min; default 1)")
  .option("--drive-audio <wav>", "Pin the driving audio (else auto-discovered from prior runs' opening TTS)")
  .option("--prompt <text>", "Override the longcat prompt")
  .option("--out-dir <dir>", "Library dir override (default assets/avatar-clips or HARNESS_AVATAR_LIBRARY_DIR)")
  .option("--force", "Regenerate even when the library clip already exists")
  .action(async (opts: { mode: string; avatarImage?: string; avatarResolution?: string; avatarSegments?: string; driveAudio?: string; prompt?: string; outDir?: string; force?: boolean }) => {
    if (opts.outDir) process.env.HARNESS_AVATAR_LIBRARY_DIR = opts.outDir;
    if (!isAvatarEnabled()) {
      console.error("avatar-prewarm needs LONGCAT_AVATAR_BASE_URL set (and HARNESS_SKIP_AVATAR unset).");
      process.exit(1);
    }
    const modes: ScriptMode[] = opts.mode === "both" ? ["podcast", "monologue"] : [parseScriptMode(opts.mode)];
    if (opts.avatarImage && modes.length > 1) {
      console.error("--avatar-image cannot be combined with --mode both (one image can't serve both hosts). Run per mode.");
      process.exit(1);
    }
    const segments = opts.avatarSegments ? parseInt(opts.avatarSegments, 10) : undefined;
    console.log(`⇡ avatar-prewarm via ${avatarBaseUrl()} — this WILL pause the qwen brain (~10 min/clip)`);
    let failures = 0;
    for (const mode of modes) {
      try {
        const r = await prewarmAvatarClip({
          mode,
          imagePath: opts.avatarImage,
          resolution: opts.avatarResolution,
          segments,
          prompt: opts.prompt,
          driveAudio: opts.driveAudio,
          force: !!opts.force,
          onLog: (m) => console.log(m),
        });
        console.log(
          r.generated
            ? `✔ ${mode}: generated ${r.clipName}${r.jobId ? ` (job ${r.jobId.slice(0, 8)}, drive ${r.driveAudioSource})` : ""}`
            : `• ${mode}: ${r.clipName} already present (use --force to regenerate)`,
        );
      } catch (e: any) {
        failures++;
        console.error(`✖ ${mode}: ${e?.message ?? e}`);
      }
    }
    console.log(`\nLibrary: ${avatarLibraryDir()}`);
    if (failures > 0) process.exit(2);
  });

program
  .command("avatar-library")
  .description("List the pre-generated avatar clip library (assets/avatar-clips/) — read-only, no network, no generation.")
  .option("--out-dir <dir>", "Library dir override")
  .action(async (opts: { outDir?: string }) => {
    if (opts.outDir) process.env.HARNESS_AVATAR_LIBRARY_DIR = opts.outDir;
    const dir = avatarLibraryDir();
    const idx = await readIndex();
    const res = avatarResolution();
    const seg = avatarSegments();
    console.log(`\n── Avatar material library ──`);
    console.log(`Dir: ${dir}`);
    console.log(`Default-config combos (${res}/seg${seg}):`);
    for (const mode of ["podcast", "monologue"] as ScriptMode[]) {
      const name = libraryClipName(mode, res, seg, activeAvatarPrompt(mode));
      const present = await fileExists(path.join(dir, name));
      let note = present ? "" : `  → missing (run: harness avatar-prewarm --mode ${mode})`;
      if (present) {
        const entry = idx.entries.find((e) => e.clip === name);
        if (entry) {
          try {
            const curSha = await fileSha256(avatarImagePath(mode));
            if (curSha !== entry.imageSha256) note = "  → STALE: source image changed (harness avatar-prewarm --force)";
          } catch { /* source image absent — can't check staleness */ }
        }
      }
      console.log(`  ${present ? "✔" : "·"} ${name}${note}`);
    }
    if (idx.entries.length === 0) {
      console.log(`\n(index.json empty — no clips recorded yet)`);
    } else {
      console.log(`\nIndexed entries (${idx.entries.length}):`);
      for (const e of idx.entries) {
        console.log(`  ${e.clip.padEnd(30)} ${(e.bytes / 1024).toFixed(0)}KB  img=${e.image}  drive=${e.driveAudioSource ?? "?"}  ${e.createdAt}`);
      }
    }
  });

program.parseAsync(process.argv);
