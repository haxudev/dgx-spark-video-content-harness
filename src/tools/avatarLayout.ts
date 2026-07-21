/**
 * Single source of truth for the bottom "presenter" avatar band geometry, in
 * the 1080×1920 composition space.
 *
 * Both the HTML deck (via `avatarLayoutCss()` injected into composition.html)
 * and the post-render ffmpeg overlay (via `avatarOverlayRect()` in RENDER) read
 * these numbers so the rounded card the deck draws and the talking-head video
 * we composite into it line up exactly. Subtitles are gone: this band is the
 * only "someone is narrating" cue, identical for podcast and monologue (only the
 * source image differs).
 */

export const STAGE_W = 1080;
export const STAGE_H = 1920;

/** Persistent top chrome (league/brand). Unchanged from the legacy deck. */
export const HEADER_H = 108;

/** Slim persistent compliance ribbon pinned to the very bottom. */
export const RIBBON_H = 40;

/** Side margin of the full-width avatar card. */
export const BAND_MARGIN_X = 24;
/** Gap between the avatar card and the compliance ribbon below it. */
export const BAND_GAP_BOTTOM = 8;
/** Gap between the deck scene area and the top of the avatar card. */
export const SCENE_GAP_TOP = 12;
/** Avatar card height — a compact full-width presenter band. Kept modest so an
 *  imperfect lip-sync is less distracting and the deck keeps more vertical room. */
export const BAND_H = 440;

/** Inset of the talking-head video rectangle inside the rounded card border. */
export const AVATAR_INSET = 8;

export const BAND_W = STAGE_W - 2 * BAND_MARGIN_X;          // 1032
export const BAND_X = BAND_MARGIN_X;                         // 24
export const BAND_Y = STAGE_H - RIBBON_H - BAND_GAP_BOTTOM - BAND_H; // 1252

/** `.scene` bottom offset (px from stage bottom) so deck content clears the band. */
export const SCENE_BOTTOM = STAGE_H - BAND_Y + SCENE_GAP_TOP; // 680

export interface Rect { x: number; y: number; w: number; h: number; }

/** The card rectangle (rounded frame the deck draws). */
export function avatarBandRect(): Rect {
  return { x: BAND_X, y: BAND_Y, w: BAND_W, h: BAND_H };
}

/**
 * The video rectangle the ffmpeg overlay targets — inset inside the card so the
 * card's rounded border frames the talking head (no per-frame alpha masking
 * needed). Even values keep ffmpeg's yuv420 scaler happy.
 */
export function avatarOverlayRect(): Rect {
  const x = even(BAND_X + AVATAR_INSET);
  const y = even(BAND_Y + AVATAR_INSET);
  const w = even(BAND_W - 2 * AVATAR_INSET);
  const h = even(BAND_H - 2 * AVATAR_INSET);
  return { x, y, w, h };
}

function even(n: number): number {
  const r = Math.round(n);
  return r % 2 === 0 ? r : r - 1;
}

/**
 * CSS rules injected into composition.html so the deck draws the presenter card
 * + slim compliance ribbon and clears vertical space for the band. Generated
 * from the constants above so the HTML and the ffmpeg overlay can never drift.
 */
export function avatarLayoutCss(): string {
  const band = avatarBandRect();
  return `
  /* ── Avatar presenter band (replaces the old subtitle lower-third) ──── */
  /* Deck scenes shrink upward to clear the bottom presenter card. */
  #stage .scene{bottom:${SCENE_BOTTOM}px;}
  #stage .scene:has(.cover-anime){bottom:${SCENE_BOTTOM - 16}px;}
  .avatar-band{position:absolute;left:${band.x}px;top:${band.y}px;
    width:${band.w}px;height:${band.h}px;z-index:30;overflow:hidden;
    border-radius:28px;border:1px solid rgba(126,148,178,0.28);
    background:linear-gradient(160deg,#10151f 0%,#0b0f17 100%);
    box-shadow:0 18px 52px rgba(0,0,0,0.62), inset 0 1px 0 rgba(255,255,255,0.05);}
  /* Placeholder shown only when no avatar.mp4 is composited (graceful degrade). */
  .avatar-band .avatar-fallback{position:absolute;inset:0;display:flex;
    flex-direction:column;align-items:center;justify-content:center;gap:16px;
    color:#7e94b2;text-align:center;}
  .avatar-band .avatar-fallback .ico{font-size:84px;opacity:0.5;}
  .avatar-band .avatar-fallback .lbl{font-size:30px;letter-spacing:2px;font-weight:600;}
  /* Soft inner top edge so the join with the deck reads as one cohesive frame. */
  .avatar-band::before{content:"";position:absolute;left:0;right:0;top:0;height:64px;
    z-index:2;pointer-events:none;
    background:linear-gradient(180deg,rgba(110,167,255,0.10) 0%,transparent 100%);}
  .footer{position:absolute;bottom:0;left:0;right:0;height:${RIBBON_H}px;
    display:flex;align-items:center;justify-content:center;
    padding:0 36px;text-align:center;color:var(--muted);font-size:21px;
    letter-spacing:1px;z-index:20;line-height:1;}
`;
}
