"""Serve the harness agent over the Foundry RESPONSES protocol on :8088.

Runnable locally (docker-compose / `python -m football_agent.server`) and
deployable unchanged to Azure Foundry as a hosted agent.
"""

from __future__ import annotations

import logging

from agent_framework_foundry_hosting import ResponsesHostServer

from .agent import build_agent, enable_inrun_history_reload
from .config import AgentConfig, load_config


def serve(cfg: AgentConfig | None = None) -> None:
    cfg = cfg or load_config()
    agent = build_agent(cfg)
    # Build the server first (its startup guard rejects load_messages=True), then
    # enable in-run history reload so the tool-calling loop keeps the user query
    # for the post-tool summary turn (GX10 rejects tool-only message lists).
    server = ResponsesHostServer(agent)
    flipped = enable_inrun_history_reload(agent)
    logger = logging.getLogger("football_agent.server")
    logger.info(
        "serving RESPONSES protocol on %s:%s (agent=%s, in-run-history-providers=%d)",
        cfg.host, cfg.port, cfg.agent_name, flipped,
    )
    server.run(host=cfg.host, port=cfg.port)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    try:
        from dotenv import load_dotenv

        load_dotenv()
    except ImportError:  # dotenv optional in container (env injected directly)
        pass
    serve()


if __name__ == "__main__":
    main()
