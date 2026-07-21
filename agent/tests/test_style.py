"""Unit tests for the deterministic style/voice → harness-flag mapping.

`football_agent/style.py` is pure stdlib (dataclasses), but importing it via the
package would pull in `football_agent/__init__.py → agent.py → agent_framework`,
a heavy optional dep. So we load the module file directly to keep the test
runnable without the MAF runtime installed.

Run: `python -m unittest agent/tests/test_style.py` (from the repo root) or
`python -m unittest tests.test_style` from inside `agent/`.
"""

from __future__ import annotations

import importlib.util
import pathlib
import sys
import unittest

_STYLE_PATH = pathlib.Path(__file__).resolve().parent.parent / "football_agent" / "style.py"
_spec = importlib.util.spec_from_file_location("style_under_test", _STYLE_PATH)
assert _spec and _spec.loader
style = importlib.util.module_from_spec(_spec)
sys.modules["style_under_test"] = style  # required for dataclass introspection
_spec.loader.exec_module(style)

resolve_run_options = style.resolve_run_options

URL = "https://football.test/match/1/"


class ResolveRunOptionsVoiceTest(unittest.TestCase):
    def test_no_voice_no_flags(self):
        o = resolve_run_options(URL)
        self.assertNotIn("--voice", o.cli_args)
        self.assertIsNone(o.voice)
        self.assertEqual(o.cli_args[:2], ["--url", URL])

    def test_generic_voice_flag(self):
        o = resolve_run_options(URL, mode="monologue", voice="Uncle_Fu")
        self.assertIn("--voice", o.cli_args)
        i = o.cli_args.index("--voice")
        self.assertEqual(o.cli_args[i + 1], "Uncle_Fu")
        self.assertEqual(o.voice, "Uncle_Fu")

    def test_per_role_flags(self):
        o = resolve_run_options(
            URL, voice_male="Dylan", voice_female="Vivian", voice_narrator="Uncle_Fu"
        )
        self.assertIn("--voice-male", o.cli_args)
        self.assertIn("--voice-female", o.cli_args)
        self.assertIn("--voice-narrator", o.cli_args)
        self.assertEqual(o.cli_args[o.cli_args.index("--voice-male") + 1], "Dylan")
        self.assertEqual(o.cli_args[o.cli_args.index("--voice-female") + 1], "Vivian")
        self.assertEqual(o.cli_args[o.cli_args.index("--voice-narrator") + 1], "Uncle_Fu")

    def test_generic_plus_per_role_both_present(self):
        # Both are forwarded; the harness CLI resolves precedence (per-role wins).
        o = resolve_run_options(URL, voice="Aria", voice_male="Dylan")
        self.assertIn("--voice", o.cli_args)
        self.assertIn("--voice-male", o.cli_args)

    def test_blank_and_whitespace_ignored(self):
        o = resolve_run_options(URL, voice="   ", voice_male="", voice_female=None)
        self.assertNotIn("--voice", o.cli_args)
        self.assertNotIn("--voice-male", o.cli_args)
        self.assertNotIn("--voice-female", o.cli_args)
        self.assertIsNone(o.voice)

    def test_trims_value(self):
        o = resolve_run_options(URL, voice_male="  Dylan  ")
        self.assertEqual(o.cli_args[o.cli_args.index("--voice-male") + 1], "Dylan")

    def test_over_long_voice_rejected(self):
        with self.assertRaises(ValueError):
            resolve_run_options(URL, voice="x" * 100)

    def test_control_chars_rejected(self):
        with self.assertRaises(ValueError):
            resolve_run_options(URL, voice_male="bad\nname")

    def test_unknown_mode_still_raises(self):
        with self.assertRaises(ValueError):
            resolve_run_options(URL, mode="bogus", voice="Aria")


class ResolveRunOptionsCloneTest(unittest.TestCase):
    def test_no_clone_no_flags(self):
        o = resolve_run_options(URL)
        self.assertNotIn("--clone-ref", o.cli_args)
        self.assertIsNone(o.clone_ref)

    def test_generic_clone_ref_flag(self):
        o = resolve_run_options(
            URL, mode="monologue", clone_ref="/app/custom_voice/merged.wav"
        )
        i = o.cli_args.index("--clone-ref")
        self.assertEqual(o.cli_args[i + 1], "/app/custom_voice/merged.wav")
        self.assertEqual(o.clone_ref, "/app/custom_voice/merged.wav")

    def test_per_role_clone_refs(self):
        o = resolve_run_options(
            URL,
            clone_ref_male="/a/m.wav",
            clone_ref_female="/a/f.wav",
            clone_ref_narrator="/a/n.wav",
            clone_ref_text="参考文字稿",
        )
        self.assertEqual(o.cli_args[o.cli_args.index("--clone-ref-male") + 1], "/a/m.wav")
        self.assertEqual(o.cli_args[o.cli_args.index("--clone-ref-female") + 1], "/a/f.wav")
        self.assertEqual(o.cli_args[o.cli_args.index("--clone-ref-narrator") + 1], "/a/n.wav")
        self.assertEqual(o.cli_args[o.cli_args.index("--clone-ref-text") + 1], "参考文字稿")

    def test_clone_ref_url_passthrough(self):
        o = resolve_run_options(URL, clone_ref="https://host/ref.wav")
        self.assertEqual(o.cli_args[o.cli_args.index("--clone-ref") + 1], "https://host/ref.wav")

    def test_blank_clone_ref_ignored(self):
        o = resolve_run_options(URL, clone_ref="   ", clone_ref_male="")
        self.assertNotIn("--clone-ref", o.cli_args)
        self.assertNotIn("--clone-ref-male", o.cli_args)

    def test_clone_ref_control_chars_rejected(self):
        with self.assertRaises(ValueError):
            resolve_run_options(URL, clone_ref="/a/bad\nname.wav")


class ResolveRunOptionsNarrativeTest(unittest.TestCase):
    def test_no_narrative_no_env(self):
        o = resolve_run_options(URL)
        self.assertNotIn("HARNESS_WRITE_NOTE", o.env_overrides)
        self.assertIsNone(o.narrative)

    def test_narrative_sets_env(self):
        o = resolve_run_options(URL, mode="monologue", narrative="阴谋论背景：美国是东道主")
        self.assertEqual(o.env_overrides["HARNESS_WRITE_NOTE"], "阴谋论背景：美国是东道主")
        self.assertEqual(o.narrative, "阴谋论背景：美国是东道主")

    def test_narrative_newlines_collapsed(self):
        o = resolve_run_options(URL, narrative="第一行\n第二行")
        self.assertEqual(o.env_overrides["HARNESS_WRITE_NOTE"], "第一行 第二行")

    def test_blank_narrative_ignored(self):
        o = resolve_run_options(URL, narrative="   ")
        self.assertNotIn("HARNESS_WRITE_NOTE", o.env_overrides)
        self.assertIsNone(o.narrative)


class ResolveRunOptionsAvatarTest(unittest.TestCase):
    def test_avatar_on_default_no_flag(self):
        o = resolve_run_options(URL)
        self.assertEqual(o.avatar, "on")
        self.assertNotIn("--skip-avatar", o.cli_args)

    def test_avatar_off_adds_skip_flag(self):
        o = resolve_run_options(URL, avatar="off")
        self.assertEqual(o.avatar, "off")
        self.assertIn("--skip-avatar", o.cli_args)

    def test_avatar_case_insensitive(self):
        o = resolve_run_options(URL, avatar="OFF")
        self.assertIn("--skip-avatar", o.cli_args)

    def test_unknown_avatar_raises(self):
        with self.assertRaises(ValueError):
            resolve_run_options(URL, avatar="maybe")


if __name__ == "__main__":
    unittest.main()
