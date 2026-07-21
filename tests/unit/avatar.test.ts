import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  STAGE_W, STAGE_H, RIBBON_H, BAND_X, BAND_Y, BAND_W, BAND_H, SCENE_BOTTOM,
  avatarBandRect, avatarOverlayRect, avatarLayoutCss,
} from "../../src/tools/avatarLayout.js";
import { avatarBaseUrl, isAvatarEnabled } from "../../src/tools/avatarClient.js";
import { buildBoomerangArgs, buildOverlayArgs } from "../../src/phases/09-render.js";
import { PHASE_ORDER } from "../../src/orchestrator/stateMachine.js";

// ── Layout geometry ──────────────────────────────────────────────────────
test("avatar band sits within the stage and above the compliance ribbon", () => {
  const band = avatarBandRect();
  assert.ok(band.x >= 0 && band.x + band.w <= STAGE_W, "band must fit horizontally");
  assert.ok(band.y > 0, "band must have positive top");
  assert.ok(band.y + band.h <= STAGE_H - RIBBON_H, "band must clear the bottom ribbon");
  assert.equal(band.w, BAND_W);
  assert.equal(band.h, BAND_H);
  assert.equal(band.x, BAND_X);
  assert.equal(band.y, BAND_Y);
});

test("overlay rect is inset inside the band with even dimensions (yuv420-safe)", () => {
  const band = avatarBandRect();
  const o = avatarOverlayRect();
  assert.ok(o.x >= band.x && o.y >= band.y, "overlay top-left inside band");
  assert.ok(o.x + o.w <= band.x + band.w, "overlay fits band width");
  assert.ok(o.y + o.h <= band.y + band.h, "overlay fits band height");
  for (const v of [o.x, o.y, o.w, o.h]) assert.equal(v % 2, 0, "overlay dims must be even");
});

test("scene bottom clears the band top", () => {
  // SCENE_BOTTOM is measured from the stage bottom; the band top is at
  // STAGE_H - SCENE_BOTTOM + gap, so the scene area must end above the band.
  assert.ok(STAGE_H - SCENE_BOTTOM <= BAND_Y, "scene bottom edge must be above band top");
  assert.ok(SCENE_BOTTOM > RIBBON_H, "scene must clear at least the ribbon");
});

test("avatarLayoutCss draws the band, placeholder and ribbon", () => {
  const css = avatarLayoutCss();
  assert.match(css, /\.avatar-band\{/);
  assert.match(css, /\.avatar-fallback/);
  assert.match(css, new RegExp(`bottom:${SCENE_BOTTOM}px`));
  assert.match(css, new RegExp(`height:${RIBBON_H}px`));
});

// ── Template: subtitles gone, avatar band present ────────────────────────
test("composition template drops the subtitle lower-third and adds the avatar band", async () => {
  const tpl = await fs.readFile(path.resolve("templates/composition.html.hbs"), "utf8");
  assert.match(tpl, /data-avatar-band/, "must declare the avatar band");
  assert.match(tpl, /\{\{\{avatarLayoutCss\}\}\}/, "must inject the avatar-layout css");
  assert.doesNotMatch(tpl, /class="lower-third/, "no lower-third caption strip");
  assert.doesNotMatch(tpl, /id="caption-text"/, "no caption sync target");
  assert.doesNotMatch(tpl, /captionsJson/, "no caption data wiring");
});

test("composition template has exactly one </style> (no stray closer in comments breaks the deck)", async () => {
  const tpl = await fs.readFile(path.resolve("templates/composition.html.hbs"), "utf8");
  // A literal </style> anywhere else (even inside a CSS comment) terminates the
  // stylesheet for the HTML parser and dumps the rest of the CSS as on-screen
  // text. Guard the count so that regression can't recur silently.
  assert.equal((tpl.match(/<\/style>/g) ?? []).length, 1, "exactly one </style>");
  assert.equal((tpl.match(/<style\b/g) ?? []).length, 1, "exactly one <style>");
});

// ── Client gating (no network) ───────────────────────────────────────────
test("avatar is disabled when LONGCAT_AVATAR_BASE_URL is unset", () => {
  const prev = process.env.LONGCAT_AVATAR_BASE_URL;
  const prevSkip = process.env.HARNESS_SKIP_AVATAR;
  try {
    delete process.env.LONGCAT_AVATAR_BASE_URL;
    delete process.env.HARNESS_SKIP_AVATAR;
    assert.equal(avatarBaseUrl(), null);
    assert.equal(isAvatarEnabled(), false);
  } finally {
    restore("LONGCAT_AVATAR_BASE_URL", prev);
    restore("HARNESS_SKIP_AVATAR", prevSkip);
  }
});

test("avatar base url trims trailing slashes; skip flag disables even when configured", () => {
  const prev = process.env.LONGCAT_AVATAR_BASE_URL;
  const prevSkip = process.env.HARNESS_SKIP_AVATAR;
  try {
    process.env.LONGCAT_AVATAR_BASE_URL = "http://host:8800/";
    delete process.env.HARNESS_SKIP_AVATAR;
    assert.equal(avatarBaseUrl(), "http://host:8800");
    assert.equal(isAvatarEnabled(), true);
    process.env.HARNESS_SKIP_AVATAR = "1";
    assert.equal(isAvatarEnabled(), false);
  } finally {
    restore("LONGCAT_AVATAR_BASE_URL", prev);
    restore("HARNESS_SKIP_AVATAR", prevSkip);
  }
});

// ── ffmpeg arg builders ──────────────────────────────────────────────────
test("buildBoomerangArgs scales+crops to the band and ping-pongs (reverse+concat)", () => {
  const rect = avatarOverlayRect();
  const args = buildBoomerangArgs("/in/avatar.mp4", rect, 0.12, "/out/loop.mp4");
  const fc = args[args.indexOf("-filter_complex") + 1]!;
  assert.match(fc, new RegExp(`scale=${rect.w}:${rect.h}:force_original_aspect_ratio=increase`));
  assert.match(fc, /reverse/);
  assert.match(fc, /concat=n=2:v=1:a=0/);
  assert.ok(args.includes("-an"), "boomerang drops avatar audio");
  assert.equal(args[args.length - 1], "/out/loop.mp4");
});

test("buildOverlayArgs loops the clip under the deck, keeps deck audio, bounds duration", () => {
  const rect = avatarOverlayRect();
  const args = buildOverlayArgs("/deck.mp4", "/loop.mp4", rect, 123.456, "/final.mp4");
  assert.ok(args.includes("-stream_loop") && args[args.indexOf("-stream_loop") + 1] === "-1");
  const fc = args[args.indexOf("-filter_complex") + 1]!;
  assert.match(fc, new RegExp(`overlay=${rect.x}:${rect.y}:shortest=1`));
  assert.equal(args[args.indexOf("-t") + 1], "123.456");
  assert.equal(args[args.indexOf("-map") + 1], "[v]");
  assert.ok(args.join(" ").includes("0:a?"), "keeps deck audio (optional)");
  assert.equal(args[args.length - 1], "/final.mp4");
});

// ── Phase ordering ───────────────────────────────────────────────────────
test("AVATAR runs after VERIFY_AUDIO and before COMPOSE (no LLM during the GPU window)", () => {
  const i = (p: string) => PHASE_ORDER.indexOf(p as any);
  assert.ok(i("AVATAR") > i("VERIFY_AUDIO"), "avatar after audio is ready");
  assert.ok(i("AVATAR") < i("COMPOSE"), "avatar before compose/render");
  // Every LLM-capable phase (WRITE + audits) precedes the avatar GPU window.
  assert.ok(i("WRITE") < i("AVATAR"));
  assert.ok(i("AUDIT_TALK") < i("AVATAR"));
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
