"""Invoke the existing Node harness pipeline as a subprocess and parse its
machine-readable result manifest.

This is the single point where the Python agent "drives" the unchanged
TypeScript pipeline: it shells out to `harness run --url ... --result-json`,
streams progress to stdout (keeps the connection warm during long renders), and
returns a compact structured result for the agent to relay upstream.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
from typing import Any

from .config import AgentConfig
from .style import resolve_run_options

log = logging.getLogger("football_agent.harness")

# Seconds to wait before re-launching a pipeline that was killed by a signal
# (transient OOM), giving the host a moment to relieve memory pressure.
_SIGNAL_RETRY_BACKOFF_SEC = 5


async def run_harness_pipeline(
    cfg: AgentConfig,
    report_url: str,
    *,
    mode: str = "podcast",
    profile: str = "final",
    cover: str = "ai",
    avatar: str = "on",
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
) -> dict[str, Any]:
    """Fetch the report, run the full pipeline, and return a result dict.

    Returns a JSON-serializable dict:
        {ok, matchId, mp4Path, durationSec, sceneCount, compliancePolicy,
         restrictedTerms, escalated, mode, profile, error, exitCode}
    """
    opts = resolve_run_options(
        report_url,
        mode=mode,
        profile=profile,
        cover=cover,
        avatar=avatar,
        skip_render=skip_render,
        voice=voice,
        voice_male=voice_male,
        voice_female=voice_female,
        voice_narrator=voice_narrator,
        clone_ref=clone_ref,
        clone_ref_male=clone_ref_male,
        clone_ref_female=clone_ref_female,
        clone_ref_narrator=clone_ref_narrator,
        clone_ref_text=clone_ref_text,
        narrative=narrative,
    )

    fd, result_path = tempfile.mkstemp(prefix="harness-result-", suffix=".json")
    os.close(fd)

    cmd = [*cfg.harness_bin, "run", *opts.cli_args, "--result-json", result_path]
    env = {**os.environ, **opts.env_overrides}

    # A transient host OOM can deliver SIGKILL (-9) to the Node pipeline mid-run
    # (observed during the long WRITE/RENDER phases), which leaves no result
    # manifest. That kill is environmental, not a deterministic pipeline error,
    # so retry a *signal-terminated* run a bounded number of times. A normal
    # non-zero exit (a real pipeline failure) is NOT retried — it would just fail
    # again and burn another full ~15 min run.
    attempts = max(1, cfg.job_signal_retries + 1)
    exit_code = -1
    report: dict[str, Any] | None = None
    for attempt in range(1, attempts + 1):
        # Fresh manifest target per attempt (the previous run may have unlinked it).
        if not os.path.exists(result_path):
            fd, result_path = tempfile.mkstemp(prefix="harness-result-", suffix=".json")
            os.close(fd)
            cmd = [*cfg.harness_bin, "run", *opts.cli_args, "--result-json", result_path]

        log.info("harness exec (attempt %d/%d): %s (cwd=%s)", attempt, attempts, " ".join(cmd), cfg.harness_dir)
        try:
            exit_code = await _stream_subprocess(cmd, cwd=cfg.harness_dir, env=env, timeout=cfg.job_timeout_sec)
        except asyncio.TimeoutError:
            return _err(opts, f"pipeline timed out after {cfg.job_timeout_sec}s", exit_code=-2, result_path=result_path)

        report = _read_result(result_path)
        _safe_unlink(result_path)
        if report is not None:
            break

        # No manifest. Only a signal-kill (negative exit code, e.g. -9 SIGKILL
        # from the OOM killer) is treated as transient and worth retrying.
        if exit_code < 0 and attempt < attempts:
            log.warning(
                "harness killed by signal %d with no result manifest (attempt %d/%d) — retrying after backoff",
                exit_code, attempt, attempts,
            )
            await asyncio.sleep(_SIGNAL_RETRY_BACKOFF_SEC)
            continue
        break

    if report is None:
        return _err(
            opts,
            f"pipeline exited {exit_code} but wrote no result manifest",
            exit_code=exit_code,
            result_path=None,
        )

    return {
        "ok": bool(report.get("ok")) and exit_code == 0,
        "matchId": report.get("matchId"),
        "mp4Path": report.get("finalMp4"),
        "durationSec": report.get("durationSec"),
        "sceneCount": report.get("sceneCount"),
        "compliancePolicy": report.get("compliancePolicy"),
        "restrictedTerms": report.get("restrictedTerms") or [],
        "escalated": bool(report.get("escalated")),
        "mode": opts.mode,
        "profile": opts.profile,
        "error": report.get("error"),
        "exitCode": exit_code,
    }


async def discover_matches(cfg: AgentConfig, date: str | None = None) -> dict[str, Any]:
    """Self-discover the day's matches by shelling `harness discover ... --json`.

    Returns {ok, date, count, matches:[{matchId, url}], error}. The harness owns
    the Supabase query (single source of truth); the agent only relays the list
    so the brain can decide which fixtures to render.
    """
    cmd = [*cfg.harness_bin, "discover"]
    if date and date.strip():
        cmd.append(date.strip())
    cmd.append("--json")
    env = {**os.environ}
    log.info("harness discover: %s", " ".join(cmd))
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=cfg.harness_dir,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, err = await asyncio.wait_for(proc.communicate(), timeout=60)
    except asyncio.TimeoutError:
        return {"ok": False, "date": date, "count": 0, "matches": [], "error": "discover timed out"}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "date": date, "count": 0, "matches": [], "error": str(exc)}
    if proc.returncode != 0:
        msg = (err or b"").decode("utf-8", "replace").strip() or f"exit {proc.returncode}"
        return {"ok": False, "date": date, "count": 0, "matches": [], "error": msg}
    try:
        data = json.loads((out or b"").decode("utf-8", "replace"))
    except json.JSONDecodeError as exc:
        return {"ok": False, "date": date, "count": 0, "matches": [], "error": f"bad JSON: {exc}"}
    return {
        "ok": True,
        "date": data.get("date"),
        "count": data.get("count", 0),
        "matches": data.get("matches", []),
        "error": None,
    }


async def run_day_batch(
    cfg: AgentConfig,
    *,
    date: str | None = None,
    mode: str = "podcast",
    profile: str = "final",
    cover: str = "ai",
    avatar: str = "on",
    skip_render: bool = False,
    voice: str | None = None,
    voice_male: str | None = None,
    voice_female: str | None = None,
    voice_narrator: str | None = None,
    narrative: str | None = None,
) -> dict[str, Any]:
    """Self-discover the day's matches then render each one end-to-end.

    One reliable tool call for the 35B brain: it discovers the real report URLs
    (no fabricated/placeholder input) and drives the unchanged single-run path
    per match, so every video is authored from its own real report data.
    """
    disc = await discover_matches(cfg, date)
    if not disc["ok"]:
        return {"ok": False, "date": disc.get("date"), "total": 0, "okCount": 0,
                "failCount": 0, "results": [], "error": f"discovery failed: {disc['error']}"}
    matches = disc["matches"] or []
    if not matches:
        return {"ok": False, "date": disc.get("date"), "total": 0, "okCount": 0,
                "failCount": 0, "results": [], "error": f"no matches found for {disc.get('date')}"}

    results: list[dict[str, Any]] = []
    ok_count = 0
    for m in matches:
        url = m.get("url")
        log.info("day-batch: rendering %s (%s)", m.get("matchId"), url)
        res = await run_harness_pipeline(
            cfg, url, mode=mode, profile=profile, cover=cover, avatar=avatar,
            skip_render=skip_render, voice=voice, voice_male=voice_male,
            voice_female=voice_female, voice_narrator=voice_narrator, narrative=narrative,
        )
        res["requestedMatchId"] = m.get("matchId")
        results.append(res)
        if res.get("ok"):
            ok_count += 1

    return {
        "ok": ok_count == len(matches),
        "date": disc.get("date"),
        "total": len(matches),
        "okCount": ok_count,
        "failCount": len(matches) - ok_count,
        "results": results,
        "error": None,
    }


async def _stream_subprocess(cmd: list[str], *, cwd: str, env: dict, timeout: int) -> int:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=cwd,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )

    async def _pump() -> None:
        assert proc.stdout is not None
        async for raw in proc.stdout:
            line = raw.decode("utf-8", "replace").rstrip()
            if line:
                log.info("[harness] %s", line)

    try:
        await asyncio.wait_for(asyncio.gather(_pump(), proc.wait()), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise
    return proc.returncode if proc.returncode is not None else -1


def _read_result(path: str) -> dict[str, Any] | None:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None
    reports = data.get("reports") or []
    if not reports:
        return None
    first = dict(reports[0])
    # Surface the top-level ok if the per-report ok is absent.
    first.setdefault("ok", data.get("ok"))
    return first


def _err(opts, message: str, *, exit_code: int, result_path: str | None) -> dict[str, Any]:
    if result_path:
        _safe_unlink(result_path)
    log.error("harness pipeline error: %s", message)
    return {
        "ok": False,
        "matchId": None,
        "mp4Path": None,
        "durationSec": None,
        "sceneCount": None,
        "compliancePolicy": None,
        "restrictedTerms": [],
        "escalated": False,
        "mode": opts.mode,
        "profile": opts.profile,
        "error": message,
        "exitCode": exit_code,
    }


def _safe_unlink(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass
