"""Container-based Microsoft Agent Framework hosted agent that drives the
podcast-football harness pipeline (HTML report URL -> narrated 9:16 MP4)."""

from .config import AgentConfig, load_config
from .agent import build_agent
from .style import RunOptions, resolve_run_options

__all__ = [
    "AgentConfig",
    "load_config",
    "build_agent",
    "RunOptions",
    "resolve_run_options",
]
