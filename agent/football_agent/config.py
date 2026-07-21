"""Runtime configuration for the hosted agent.

Everything is environment-driven so the same image runs locally (WSL Docker)
and on Azure Foundry. The MAF *orchestration* model defaults to the GX10
`qwen3.6-35b` OpenAI-compatible endpoint (35B-friendly); the harness pipeline's
own WRITE provider chain (GX10 -> Azure fallback) is configured separately via
the harness's existing env vars and is untouched here.
"""

from __future__ import annotations

import os
import shlex
from dataclasses import dataclass, field


def _env(*names: str, default: str | None = None) -> str | None:
    for n in names:
        v = os.environ.get(n)
        if v is not None and v.strip() != "":
            return v
    return default


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    try:
        return int(raw) if raw not in (None, "") else default
    except ValueError:
        return default


@dataclass
class AgentConfig:
    # --- MAF orchestration model (GX10 qwen3.6-35b, OpenAI-compatible) ---
    model: str
    api_key: str
    base_url: str
    # create_harness_agent requires explicit token budgets.
    max_context_window_tokens: int = 32000
    max_output_tokens: int = 2048
    # Heavy harness-agent features off by default for a lean, 35B-friendly,
    # single-tool orchestrator. Flip via env if you want plan/todo/memory.
    enable_todo: bool = False
    enable_mode: bool = False
    enable_memory: bool = False
    enable_web_search: bool = False

    # --- Harness CLI (the existing Node pipeline) ---
    harness_bin: list[str] = field(default_factory=lambda: ["node", "/app/dist/cli.js"])
    harness_dir: str = "/app"
    job_timeout_sec: int = 60 * 60  # hard cap on a single pipeline run
    # A transient host OOM can SIGKILL (-9) the Node pipeline mid-run, leaving no
    # result manifest. Retry a *signal-killed* run this many times before giving
    # up (a real non-zero pipeline error is never retried). 0 disables retries.
    job_signal_retries: int = 1

    # --- Server ---
    host: str = "0.0.0.0"
    port: int = 8088

    @property
    def agent_name(self) -> str:
        return os.environ.get("AGENT_NAME", "football-video-agent")


def load_config() -> AgentConfig:
    """Build AgentConfig from the environment.

    The orchestration model reuses the harness's GX10 credentials by default so
    a single `.env` configures both layers, but can be overridden independently
    with AGENT_MODEL_* vars (e.g. to point the brain at a different endpoint).
    """
    base_url = _env("AGENT_MODEL_BASE_URL", "GX10_OPENAI_BASE_URL")
    api_key = _env("AGENT_MODEL_API_KEY", "GX10_OPENAI_API_KEY")
    model = _env("AGENT_MODEL_NAME", "GX10_MODEL_NAME")

    missing = [
        n
        for n, v in (
            ("AGENT_MODEL_BASE_URL/GX10_OPENAI_BASE_URL", base_url),
            ("AGENT_MODEL_API_KEY/GX10_OPENAI_API_KEY", api_key),
            ("AGENT_MODEL_NAME/GX10_MODEL_NAME", model),
        )
        if not v
    ]
    if missing:
        raise RuntimeError(
            "Missing required orchestration-model env vars: " + ", ".join(missing)
        )

    harness_bin_raw = os.environ.get("HARNESS_BIN")
    harness_bin = (
        shlex.split(harness_bin_raw) if harness_bin_raw else ["node", "/app/dist/cli.js"]
    )

    return AgentConfig(
        model=model,  # type: ignore[arg-type]
        api_key=api_key,  # type: ignore[arg-type]
        base_url=base_url,  # type: ignore[arg-type]
        max_context_window_tokens=_int_env("AGENT_MAX_CONTEXT_TOKENS", 32000),
        max_output_tokens=_int_env("AGENT_MAX_OUTPUT_TOKENS", 2048),
        enable_todo=os.environ.get("AGENT_ENABLE_TODO") == "1",
        enable_mode=os.environ.get("AGENT_ENABLE_MODE") == "1",
        enable_memory=os.environ.get("AGENT_ENABLE_MEMORY") == "1",
        enable_web_search=os.environ.get("AGENT_ENABLE_WEB_SEARCH") == "1",
        harness_bin=harness_bin,
        harness_dir=os.environ.get("HARNESS_DIR", "/app"),
        job_timeout_sec=_int_env("HARNESS_AGENT_JOB_TIMEOUT", 60 * 60),
        job_signal_retries=_int_env("HARNESS_AGENT_SIGNAL_RETRIES", 1),
        host=os.environ.get("AGENT_HOST", "0.0.0.0"),
        port=_int_env("AGENT_PORT", _int_env("PORT", 8088)),
    )
