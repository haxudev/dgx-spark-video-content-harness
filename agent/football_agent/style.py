"""Deterministic mapping from upstream `style`/`options` to harness CLI flags.

The 35B orchestration model only supplies a few flat, enum-constrained scalars;
this module validates them and turns them into concrete harness `run` arguments
and environment overrides. The LLM never invents harness flags.
"""

from __future__ import annotations

from dataclasses import dataclass, field

ALLOWED_MODES = ("podcast", "monologue")
ALLOWED_PROFILES = ("fast", "draft", "final")
ALLOWED_COVER = ("ai", "none")
ALLOWED_AVATAR = ("on", "off")


@dataclass
class RunOptions:
    report_url: str
    mode: str = "podcast"
    profile: str = "final"
    cover: str = "ai"
    avatar: str = "on"
    skip_render: bool = False
    voice: str | None = None
    voice_male: str | None = None
    voice_female: str | None = None
    voice_narrator: str | None = None
    clone_ref: str | None = None
    clone_ref_male: str | None = None
    clone_ref_female: str | None = None
    clone_ref_narrator: str | None = None
    clone_ref_text: str | None = None
    narrative: str | None = None

    cli_args: list[str] = field(default_factory=list)
    env_overrides: dict[str, str] = field(default_factory=dict)


def _norm(value: str | None, default: str) -> str:
    return (value or default).strip().lower()


# Qwen3-TTS voice names are an open-ended set, so we soft-validate
# (trim + length/charset sanity) rather than enforce an allowlist.
_MAX_VOICE_LEN = 64


def _clean_voice(value: str | None, label: str) -> str | None:
    """Soft-validate a custom voice name: trim, reject empty/over-long/control
    characters. Returns None when unset so the harness keeps its env default."""
    if value is None:
        return None
    v = value.strip()
    if not v:
        return None
    if len(v) > _MAX_VOICE_LEN:
        raise ValueError(f"{label} too long (max {_MAX_VOICE_LEN} chars): {v!r}")
    if any(ord(ch) < 0x20 for ch in v):
        raise ValueError(f"{label} contains control characters: {v!r}")
    return v


# Clone-reference values are filesystem paths (or http(s)/data URIs) so they are
# longer and use a wider charset than a voice name; still reject control chars.
_MAX_PATH_LEN = 1024
_MAX_NOTE_LEN = 600


def _clean_path(value: str | None, label: str) -> str | None:
    """Soft-validate a clone-reference path/URI: trim, reject empty/over-long/
    control characters. Returns None when unset."""
    if value is None:
        return None
    v = value.strip()
    if not v:
        return None
    if len(v) > _MAX_PATH_LEN:
        raise ValueError(f"{label} too long (max {_MAX_PATH_LEN} chars)")
    if any(ord(ch) < 0x20 for ch in v):
        raise ValueError(f"{label} contains control characters")
    return v


def _clean_note(value: str | None, label: str) -> str | None:
    """Soft-validate the free-text editorial narrative note: trim, drop control
    chars (except keep newlines/tabs as spaces), cap length. Returns None when
    unset so WRITE behaviour is unchanged."""
    if value is None:
        return None
    # Collapse control characters (incl. newlines) to spaces so it stays a clean
    # single env value; the harness injects it into the WRITE prompt as-is.
    cleaned = "".join(" " if ord(ch) < 0x20 else ch for ch in value).strip()
    if not cleaned:
        return None
    return cleaned[:_MAX_NOTE_LEN]


def resolve_run_options(
    report_url: str,
    *,
    mode: str | None = "podcast",
    profile: str | None = "final",
    cover: str | None = "ai",
    avatar: str | None = "on",
    skip_render: bool = False,
    voice: str | None = None,
    voice_male: str | None = None,
    voice_female: str | None = None,
    voice_narrator: str | None = None,
    clone_ref: str | None = None,
    clone_ref_male: str | None = None,
    clone_ref_female: str | None = None,
    clone_ref_narrator: str | None = None,
    clone_ref_text: str | None = None,
    narrative: str | None = None,
) -> RunOptions:
    """Validate inputs and produce harness `run` args + env overrides.

    Raises ValueError on any unknown enum value so a malformed tool call fails
    loudly instead of silently shipping the wrong style.
    """
    if not report_url or not report_url.strip():
        raise ValueError("report_url is required")
    url = report_url.strip()
    if not (url.startswith("http://") or url.startswith("https://")):
        raise ValueError(f"report_url must be an http(s) URL, got: {url!r}")

    m = _norm(mode, "podcast")
    p = _norm(profile, "final")
    c = _norm(cover, "ai")
    a = _norm(avatar, "on")
    if m not in ALLOWED_MODES:
        raise ValueError(f"mode must be one of {ALLOWED_MODES}, got {m!r}")
    if p not in ALLOWED_PROFILES:
        raise ValueError(f"profile must be one of {ALLOWED_PROFILES}, got {p!r}")
    if c not in ALLOWED_COVER:
        raise ValueError(f"cover must be one of {ALLOWED_COVER}, got {c!r}")
    if a not in ALLOWED_AVATAR:
        raise ValueError(f"avatar must be one of {ALLOWED_AVATAR}, got {a!r}")

    # Qwen3-TTS-only custom voices (Azure voices are unaffected). Soft-validated
    # and appended as harness `run` flags; the harness routes the generic --voice
    # by script mode and these invalidate the Qwen3-TTS cache automatically.
    v = _clean_voice(voice, "voice")
    v_male = _clean_voice(voice_male, "voice_male")
    v_female = _clean_voice(voice_female, "voice_female")
    v_narrator = _clean_voice(voice_narrator, "voice_narrator")

    # Qwen3-TTS voice-clone references (Base model). A reference wav path/URI to
    # clone an arbitrary voice. Mode-aware like --voice: the generic --clone-ref
    # seeds the Narrator (monologue) or both hosts (podcast); per-role flags win.
    cr = _clean_path(clone_ref, "clone_ref")
    cr_male = _clean_path(clone_ref_male, "clone_ref_male")
    cr_female = _clean_path(clone_ref_female, "clone_ref_female")
    cr_narrator = _clean_path(clone_ref_narrator, "clone_ref_narrator")
    cr_text = _clean_note(clone_ref_text, "clone_ref_text")

    note = _clean_note(narrative, "narrative")

    cli_args = ["--url", url, "--mode", m, "--profile", p]
    if v:
        cli_args += ["--voice", v]
    if v_male:
        cli_args += ["--voice-male", v_male]
    if v_female:
        cli_args += ["--voice-female", v_female]
    if v_narrator:
        cli_args += ["--voice-narrator", v_narrator]
    if cr:
        cli_args += ["--clone-ref", cr]
    if cr_male:
        cli_args += ["--clone-ref-male", cr_male]
    if cr_female:
        cli_args += ["--clone-ref-female", cr_female]
    if cr_narrator:
        cli_args += ["--clone-ref-narrator", cr_narrator]
    if cr_text:
        cli_args += ["--clone-ref-text", cr_text]
    if a == "off":
        # Ship without the bottom digital-human presenter (framed placeholder band).
        cli_args += ["--skip-avatar"]
    env_overrides: dict[str, str] = {}

    # Per-run editorial angle for the WRITE agent (soft creative steer; the
    # harness still enforces data fidelity + every compliance gate).
    if note:
        env_overrides["HARNESS_WRITE_NOTE"] = note

    if c == "none":
        # Ship without the gpt-image-2 AI cover/background (gradient/data-card).
        env_overrides["HARNESS_SKIP_COVER"] = "1"
        env_overrides["HARNESS_SKIP_BGIMAGE"] = "1"

    if skip_render:
        env_overrides["HARNESS_SKIP_RENDER"] = "1"

    return RunOptions(
        report_url=url,
        mode=m,
        profile=p,
        cover=c,
        avatar=a,
        skip_render=bool(skip_render),
        voice=v,
        voice_male=v_male,
        voice_female=v_female,
        voice_narrator=v_narrator,
        clone_ref=cr,
        clone_ref_male=cr_male,
        clone_ref_female=cr_female,
        clone_ref_narrator=cr_narrator,
        clone_ref_text=cr_text,
        narrative=note,
        cli_args=cli_args,
        env_overrides=env_overrides,
    )
