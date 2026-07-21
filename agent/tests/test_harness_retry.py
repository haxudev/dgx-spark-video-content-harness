"""Unit tests for the transient signal-kill retry in `run_harness_pipeline`.

A host OOM can SIGKILL (-9) the Node pipeline mid-run, leaving no result
manifest. The runner must retry a *signal-killed* run (bounded) but must NOT
retry a real non-zero pipeline error.

`harness_runner.py` uses package-relative imports (`from .config import ...`),
so we register a lightweight throwaway package pointing at the real source dir
and load only `config` + `style` + `harness_runner` — never `agent.py`, which
would pull in the heavy `agent_framework` runtime.

Run: `python -m unittest agent/tests/test_harness_retry.py` (from repo root).
"""

from __future__ import annotations

import asyncio
import importlib.util
import pathlib
import sys
import types
import unittest

_PKG_DIR = pathlib.Path(__file__).resolve().parent.parent / "football_agent"
_PKG_NAME = "fa_retry_test"

_pkg = types.ModuleType(_PKG_NAME)
_pkg.__path__ = [str(_PKG_DIR)]  # type: ignore[attr-defined]
sys.modules[_PKG_NAME] = _pkg


def _load(name: str):
    spec = importlib.util.spec_from_file_location(f"{_PKG_NAME}.{name}", _PKG_DIR / f"{name}.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"{_PKG_NAME}.{name}"] = mod
    spec.loader.exec_module(mod)
    return mod


_load("config")
_load("style")
harness = _load("harness_runner")

AgentConfig = sys.modules[f"{_PKG_NAME}.config"].AgentConfig

URL = "https://football.test/match/1/"


def _cfg(signal_retries: int = 1) -> "AgentConfig":
    return AgentConfig(
        model="m",
        api_key="k",
        base_url="http://x",
        harness_bin=["node", "cli.js"],
        harness_dir="/tmp",
        job_signal_retries=signal_retries,
    )


class _Harness(unittest.TestCase):
    def setUp(self):
        # Neutralise the real backoff sleep so tests run instantly.
        self._orig_sleep = harness.asyncio.sleep

        async def _no_sleep(_secs):
            return None

        harness.asyncio.sleep = _no_sleep  # type: ignore[assignment]

        self.exit_codes: list[int] = []
        self.calls = 0

        async def _fake_stream(cmd, *, cwd, env, timeout):
            code = self.exit_codes[self.calls]
            self.calls += 1
            return code

        harness._stream_subprocess = _fake_stream  # type: ignore[assignment]

        # `_read_result` returns a manifest only when the matching attempt
        # "succeeded" (exit 0). We key off the just-consumed exit code.
        def _fake_read(_path):
            last = self.exit_codes[self.calls - 1]
            if last == 0:
                return {"ok": True, "matchId": "m", "finalMp4": "/out/final.mp4", "sceneCount": 4}
            return None

        harness._read_result = _fake_read  # type: ignore[assignment]
        harness._safe_unlink = lambda _p: None  # type: ignore[assignment]

    def tearDown(self):
        harness.asyncio.sleep = self._orig_sleep  # type: ignore[assignment]

    def _run(self, cfg):
        return asyncio.run(harness.run_harness_pipeline(cfg, URL, mode="monologue"))

    def test_signal_kill_then_success_is_retried(self):
        self.exit_codes = [-9, 0]  # OOM kill, then a clean run
        res = self._run(_cfg(signal_retries=1))
        self.assertEqual(self.calls, 2)
        self.assertTrue(res["ok"])
        self.assertEqual(res["exitCode"], 0)
        self.assertEqual(res["mp4Path"], "/out/final.mp4")

    def test_signal_kill_exhausts_retries(self):
        self.exit_codes = [-9, -9]  # killed on every attempt
        res = self._run(_cfg(signal_retries=1))
        self.assertEqual(self.calls, 2)  # 1 initial + 1 retry
        self.assertFalse(res["ok"])
        self.assertEqual(res["exitCode"], -9)
        self.assertIn("no result manifest", res["error"])

    def test_real_error_is_not_retried(self):
        self.exit_codes = [1, 0]  # deterministic failure — must not retry
        res = self._run(_cfg(signal_retries=1))
        self.assertEqual(self.calls, 1)
        self.assertFalse(res["ok"])
        self.assertEqual(res["exitCode"], 1)

    def test_retries_disabled(self):
        self.exit_codes = [-9, 0]
        res = self._run(_cfg(signal_retries=0))
        self.assertEqual(self.calls, 1)  # no retry when disabled
        self.assertFalse(res["ok"])
        self.assertEqual(res["exitCode"], -9)

    def test_first_attempt_success_no_retry(self):
        self.exit_codes = [0]
        res = self._run(_cfg(signal_retries=1))
        self.assertEqual(self.calls, 1)
        self.assertTrue(res["ok"])


if __name__ == "__main__":
    unittest.main()
