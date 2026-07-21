import { test } from "node:test";
import { strict as assert } from "node:assert";
import { applyRunProfile, applyVoiceOverrides, applyCloneRefOverrides, renderFps, shouldUseVisualAuditLLM, ttsParallel, writeParallel } from "../../src/tools/runProfile.js";
import { voicesForProvider } from "../../src/tools/azureSpeech.js";

test("fast profile skips render and disables visual LLM by default", () => {
  const prev = snapshotEnv();
  try {
    clearProfileEnv();
    const profile = applyRunProfile("fast");
    assert.equal(profile, "fast");
    assert.equal(process.env.HARNESS_SKIP_RENDER, "1");
    assert.equal(shouldUseVisualAuditLLM(), false);
    assert.equal(renderFps(), 24);
  } finally {
    restoreEnv(prev);
  }
});

test("explicit env overrides profile defaults", () => {
  const prev = snapshotEnv();
  try {
    clearProfileEnv();
    process.env.HARNESS_VISUAL_AUDIT_LLM = "1";
    process.env.HARNESS_RENDER_FPS = "30";
    applyRunProfile("draft");
    assert.equal(shouldUseVisualAuditLLM(), true);
    assert.equal(renderFps(), 30);
  } finally {
    restoreEnv(prev);
  }
});

test("parallel knobs are clamped", () => {
  const prev = snapshotEnv();
  try {
    clearProfileEnv();
    process.env.HARNESS_TTS_PARALLEL = "99";
    process.env.HARNESS_WRITE_PARALLEL = "0";
    assert.equal(ttsParallel(), 8);
    assert.equal(writeParallel(), 1);
  } finally {
    restoreEnv(prev);
  }
});

test("applyVoiceOverrides: per-role flags set Qwen env vars", () => {
  const prev = snapshotEnv();
  try {
    clearVoiceEnv();
    applyVoiceOverrides({ voiceMale: "Dylan", voiceFemale: "Vivian", voiceNarrator: "Uncle_Fu" });
    assert.equal(process.env.QWEN_TTS_VOICE_MALE, "Dylan");
    assert.equal(process.env.QWEN_TTS_VOICE_FEMALE, "Vivian");
    assert.equal(process.env.QWEN_TTS_VOICE_NARRATOR, "Uncle_Fu");
    // End-to-end: resolver reflects the overrides for the qwen backend.
    const v = voicesForProvider("qwen");
    assert.equal(v.Analyst, "Dylan");
    assert.equal(v.Anchor, "Vivian");
    assert.equal(v.Narrator, "Uncle_Fu");
  } finally {
    restoreEnv(prev);
  }
});

test("applyVoiceOverrides: generic --voice routes by mode (podcast→both hosts)", () => {
  const prev = snapshotEnv();
  try {
    clearVoiceEnv();
    delete process.env.HARNESS_SCRIPT_MODE; // default podcast
    applyVoiceOverrides({ voice: "Aiden" });
    assert.equal(process.env.QWEN_TTS_VOICE_MALE, "Aiden");
    assert.equal(process.env.QWEN_TTS_VOICE_FEMALE, "Aiden");
    assert.equal(process.env.QWEN_TTS_VOICE_NARRATOR, undefined);
  } finally {
    restoreEnv(prev);
  }
});

test("applyVoiceOverrides: generic --voice routes by mode (monologue→Narrator)", () => {
  const prev = snapshotEnv();
  try {
    clearVoiceEnv();
    process.env.HARNESS_SCRIPT_MODE = "monologue";
    applyVoiceOverrides({ voice: "Uncle_Fu" });
    assert.equal(process.env.QWEN_TTS_VOICE_NARRATOR, "Uncle_Fu");
    assert.equal(process.env.QWEN_TTS_VOICE_MALE, undefined);
    assert.equal(process.env.QWEN_TTS_VOICE_FEMALE, undefined);
  } finally {
    restoreEnv(prev);
  }
});

test("applyVoiceOverrides: per-role overrides win over the generic base", () => {
  const prev = snapshotEnv();
  try {
    clearVoiceEnv();
    delete process.env.HARNESS_SCRIPT_MODE; // podcast
    applyVoiceOverrides({ voice: "Aiden", voiceMale: "Dylan" });
    assert.equal(process.env.QWEN_TTS_VOICE_MALE, "Dylan"); // per-role wins
    assert.equal(process.env.QWEN_TTS_VOICE_FEMALE, "Aiden"); // generic base kept
  } finally {
    restoreEnv(prev);
  }
});

test("applyVoiceOverrides: unsupported voice throws (named roster only)", () => {
  const prev = snapshotEnv();
  try {
    clearVoiceEnv();
    assert.throws(() => applyVoiceOverrides({ voiceMale: "definitely-not-a-speaker" }), /Unsupported Qwen3-TTS voice/);
  } finally {
    restoreEnv(prev);
  }
});

test("applyVoiceOverrides: blank/whitespace values are ignored (keep defaults)", () => {
  const prev = snapshotEnv();
  try {
    clearVoiceEnv();
    process.env.QWEN_TTS_VOICE_MALE = "Preexisting";
    applyVoiceOverrides({ voice: "   ", voiceMale: "", voiceFemale: undefined });
    assert.equal(process.env.QWEN_TTS_VOICE_MALE, "Preexisting");
    assert.equal(process.env.QWEN_TTS_VOICE_FEMALE, undefined);
  } finally {
    restoreEnv(prev);
  }
});

test("applyCloneRefOverrides: generic --clone-ref routes by mode and is not roster-validated", () => {
  const prev = snapshotEnv();
  try {
    clearVoiceEnv();
    process.env.HARNESS_SCRIPT_MODE = "monologue";
    applyCloneRefOverrides({ cloneRef: "/home/nuc/openclaw-artifacts/custom_voice/merged.wav" });
    assert.equal(process.env.QWEN_TTS_CLONE_REF_NARRATOR, "/home/nuc/openclaw-artifacts/custom_voice/merged.wav");
    assert.equal(process.env.QWEN_TTS_CLONE_REF_MALE, undefined);

    clearVoiceEnv();
    delete process.env.HARNESS_SCRIPT_MODE; // podcast → both hosts
    applyCloneRefOverrides({ cloneRef: "/ref.wav", cloneRefFemale: "/she.wav" });
    assert.equal(process.env.QWEN_TTS_CLONE_REF_MALE, "/ref.wav");
    assert.equal(process.env.QWEN_TTS_CLONE_REF_FEMALE, "/she.wav"); // per-role wins
  } finally {
    restoreEnv(prev);
  }
});

function snapshotEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

function restoreEnv(prev: NodeJS.ProcessEnv): void {
  process.env = { ...prev };
}

function clearProfileEnv(): void {
  for (const key of [
    "HARNESS_PROFILE",
    "HARNESS_SKIP_RENDER",
    "HARNESS_VISUAL_AUDIT_LLM",
    "HARNESS_RENDER_FPS",
    "HARNESS_RENDER_QUALITY",
    "HARNESS_LLM_PROVIDER",
    "HARNESS_TTS_PARALLEL",
    "HARNESS_WRITE_PARALLEL",
    "HARNESS_CARD_PARALLEL",
  ]) delete process.env[key];
}

function clearVoiceEnv(): void {
  for (const key of [
    "QWEN_TTS_VOICE_MALE",
    "QWEN_TTS_VOICE_FEMALE",
    "QWEN_TTS_VOICE_NARRATOR",
    "QWEN_TTS_CLONE_REF",
    "QWEN_TTS_CLONE_REF_MALE",
    "QWEN_TTS_CLONE_REF_FEMALE",
    "QWEN_TTS_CLONE_REF_NARRATOR",
    "QWEN_TTS_CLONE_REF_TEXT",
  ]) delete process.env[key];
}
