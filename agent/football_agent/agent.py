"""Build the Microsoft Agent Framework *harness agent* that orchestrates the
podcast-football pipeline.

The brain is GX10 `qwen3.6-35b` (OpenAI-compatible). The agent exposes a single
function tool, `generate_match_video`, so 35B function-calling stays reliable.
`create_harness_agent` wires the batteries-included harness runtime (automatic
tool-calling loop, history persistence, compaction); the heavyweight extras
(todo / plan-mode / memory / web-search) are disabled by default for a lean,
single-purpose orchestrator.
"""

from __future__ import annotations

import json
import logging
from typing import Annotated

from agent_framework import Agent, create_harness_agent, tool
from agent_framework._sessions import InMemoryHistoryProvider
from agent_framework.openai import OpenAIChatClient
from pydantic import Field

from .config import AgentConfig, load_config
from .harness_runner import discover_matches, run_day_batch, run_harness_pipeline

log = logging.getLogger("football_agent.agent")

HARNESS_INSTRUCTIONS = (
    "你是“足球数据观察”视频生成流水线的自主编排智能体（agent-first）。你能**自发现**当日/指定日的比赛、"
    "**自获取**真实报告、并**自调度**渲染，产出竖屏中文解说 mp4。所有解说文案都由流水线内的 WRITE 智能体"
    "**基于真实报告数据即时创作**（禁止模板化/雷同）。\n"
    "可用工具：\n"
    "- discover_matches(date)：从赛事索引发现某日全部比赛（返回 matchId + 真实报告 url）。date 可为空(默认明日T+1)、"
    "today、tomorrow 或 YYYY-MM-DD。\n"
    "- generate_day_videos(date, mode, ...)：**发现并逐场渲染某日全部比赛**（推荐用于“今日/当日/明日全部比赛”这类批量请求）。\n"
    "- generate_match_video(report_url, mode, ...)：渲染**单个**已知报告 URL。\n"
    "规则：\n"
    "1. 当用户说“今日/当日/明日的（全部）比赛”“把今天的比赛都做成视频”等**批量**意图时，直接调用一次 "
    "generate_day_videos（可先用 discover_matches 告知将处理哪几场）；不要编造 URL。\n"
    "2. 当用户给出**单个**报告 URL 时，调用一次 generate_match_video。\n"
    "3. 绝不编造/猜测比赛或 URL：报告必须来自 discover_matches 的真实发现结果或用户明确给出的 http(s) URL。\n"
    "4. 若用户要求“单人/解局人/口播”则 mode=monologue；“克隆音色”给出参考音频路径则填 clone_ref；"
    "“叙事背景/切入视角”填 narrative。\n"
    "5. 工具返回 JSON 后用简洁中文汇报：处理了哪几场、每场是否成功、最终 mp4 路径、时长、场景数、合规策略；"
    "若 ok=false，如实说明 error，不要谎称成功。\n"
    "6. 这是体育数据概率观察，禁止任何博彩/购彩/下注/资金建议类表述。\n"
    "7. avatar=on(默认) 会在视频底部生成数字人解说画面（命中素材库缓存则不暂停大脑）；工具调用是阻塞式的，"
    "等它返回即可；若用户要求“不要数字人/纯图表”则 avatar=off。"
)

AGENT_DESCRIPTION = (
    "Containerized orchestrator: turns a football probability-report URL into a "
    "Chinese dual-host (or monologue) 9:16 narrated MP4 via the harness pipeline."
)


def build_agent(cfg: AgentConfig | None = None) -> Agent:
    cfg = cfg or load_config()
    client = OpenAIChatClient(model=cfg.model, api_key=cfg.api_key, base_url=cfg.base_url)

    @tool(approval_mode="never_require")
    async def discover_today_matches(
        date: Annotated[str | None, Field(description="目标日期：留空=明日(T+1)、today、tomorrow 或 YYYY-MM-DD")] = None,
    ) -> str:
        """从赛事索引自发现某日的全部比赛，返回 { ok, date, count, matches:[{matchId,url}] } JSON。"""
        result = await discover_matches(cfg, date)
        return json.dumps(result, ensure_ascii=False)

    @tool(approval_mode="never_require")
    async def generate_day_videos(
        date: Annotated[str | None, Field(description="目标日期：留空=明日(T+1)、today、tomorrow 或 YYYY-MM-DD")] = None,
        mode: Annotated[str, Field(description="脚本风格：podcast(双人对谈) 或 monologue(单人口播)")] = "podcast",
        profile: Annotated[str, Field(description="质量档位：fast | draft | final")] = "final",
        cover: Annotated[str, Field(description="封面/背景：ai(gpt-image-2) 或 none")] = "ai",
        avatar: Annotated[str, Field(description="底部数字人解说：on(默认) 或 off")] = "on",
        skip_render: Annotated[bool, Field(description="为 true 时跳过最终渲染（快速校验）")] = False,
        voice: Annotated[str | None, Field(description="Qwen3-TTS 命名音色（按 mode 落位）")] = None,
        voice_male: Annotated[str | None, Field(description="Qwen3-TTS 男声（Analyst 小帅）")] = None,
        voice_female: Annotated[str | None, Field(description="Qwen3-TTS 女声（Anchor 小美）")] = None,
        voice_narrator: Annotated[str | None, Field(description="Qwen3-TTS 单人口播音色（Narrator）")] = None,
        narrative: Annotated[str | None, Field(description="本批叙事视角/背景（软引导，仍忠于报告数据与合规）")] = None,
    ) -> str:
        """自发现某日全部比赛并逐场渲染，返回批量结果 JSON（每场各自基于其真实报告数据创作）。"""
        result = await run_day_batch(
            cfg,
            date=date,
            mode=mode,
            profile=profile,
            cover=cover,
            avatar=avatar,
            skip_render=skip_render,
            voice=voice,
            voice_male=voice_male,
            voice_female=voice_female,
            voice_narrator=voice_narrator,
            narrative=narrative,
        )
        return json.dumps(result, ensure_ascii=False)

    @tool(approval_mode="never_require")
    async def generate_match_video(
        report_url: Annotated[str, Field(description="HTML 赛事报告的 http(s) URL")],
        mode: Annotated[str, Field(description="脚本风格：podcast(双人对谈) 或 monologue(单人口播)")] = "podcast",
        profile: Annotated[str, Field(description="质量档位：fast | draft | final")] = "final",
        cover: Annotated[str, Field(description="封面/背景：ai(gpt-image-2) 或 none")] = "ai",
        avatar: Annotated[str, Field(description="底部数字人解说：on(默认，生成数字人口播画面) 或 off(仅留边框占位)；on 时首个未缓存任务约 10 分钟且会临时暂停 qwen 大脑")] = "on",
        skip_render: Annotated[bool, Field(description="为 true 时跳过昂贵的最终渲染（用于快速校验）")] = False,
        voice: Annotated[str | None, Field(description="Qwen3-TTS 命名音色（按 mode 落位：monologue→解说人，podcast→双主持）；留空用默认 Vivian/Dylan")] = None,
        voice_male: Annotated[str | None, Field(description="Qwen3-TTS 男声音色（Analyst 小帅）")] = None,
        voice_female: Annotated[str | None, Field(description="Qwen3-TTS 女声音色（Anchor 小美）")] = None,
        voice_narrator: Annotated[str | None, Field(description="Qwen3-TTS 单人口播音色（Narrator 解局人）")] = None,
        clone_ref: Annotated[str | None, Field(description="克隆音色的参考音频路径(容器内路径，如 /app/custom_voice/merged.wav)或 http(s)/data URI；按 mode 落位：monologue→解说人，podcast→双主持")] = None,
        clone_ref_male: Annotated[str | None, Field(description="克隆给 Analyst 小帅 的参考音频路径/URI")] = None,
        clone_ref_female: Annotated[str | None, Field(description="克隆给 Anchor 小美 的参考音频路径/URI")] = None,
        clone_ref_narrator: Annotated[str | None, Field(description="克隆给 Narrator 解局人 的参考音频路径/URI")] = None,
        clone_ref_text: Annotated[str | None, Field(description="参考音频的文字稿（提供后启用更高保真的 ICL 克隆）")] = None,
        narrative: Annotated[str | None, Field(description="本场叙事视角/背景（人工编辑切入，如阴谋论背景、东道主设定、强调哪种爆冷）；仅作创作软引导，仍须忠于报告数据与合规")] = None,
    ) -> str:
        """抓取报告 URL 并运行完整流水线，产出竖屏解说 mp4；返回结构化 JSON 结果。"""
        result = await run_harness_pipeline(
            cfg,
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
        return json.dumps(result, ensure_ascii=False)

    agent = create_harness_agent(
        client,
        name=cfg.agent_name,
        description=AGENT_DESCRIPTION,
        harness_instructions=HARNESS_INSTRUCTIONS,
        tools=[discover_today_matches, generate_day_videos, generate_match_video],
        max_context_window_tokens=cfg.max_context_window_tokens,
        max_output_tokens=cfg.max_output_tokens,
        disable_todo=not cfg.enable_todo,
        disable_mode=not cfg.enable_mode,
        # agent-framework renamed the memory flag to `disable_file_memory` and
        # split off a separate file-access tool group. Keep the lean, 35B-friendly
        # single-purpose orchestrator: no file memory, no file read/write tools.
        disable_file_memory=not cfg.enable_memory,
        disable_file_access=True,
        disable_web_search=not cfg.enable_web_search,
        # Single-tool orchestrator: nothing to compact, and compaction could only
        # risk summarising away the lone user turn. Keep the short history intact.
        disable_compaction=True,
        # The Foundry RESPONSES host runs the agent without an AgentSession; the
        # default ToolApprovalMiddleware requires one and would crash every request
        # ("ToolApprovalMiddleware requires an AgentSession."). Our single tool is
        # approval_mode="never_require", so disable the approval middleware entirely.
        disable_tool_auto_approval=True,
        # load_messages=False here only to satisfy ResponsesHostServer's startup
        # guard (it refuses a history provider that loads on its own). server.py
        # flips it to True AFTER the server is built so the in-run tool loop reloads
        # the [user, tool_call, tool_result] history between brain calls — otherwise
        # the post-tool summary call gets ONLY the tool message and GX10 rejects it
        # ("No user query found in messages"). Per-request session ids keep this
        # ephemeral, so no cross-request bleed. See enable_inrun_history_reload().
        history_provider=InMemoryHistoryProvider(load_messages=False),
        # GX10 is plain chat-completions; store=True would chase a previous_response_id
        # the server never persisted (404). Stay stateless.
        default_options={"store": False},
    )
    log.info("built harness agent '%s' (model=%s, base_url=%s)", cfg.agent_name, cfg.model, cfg.base_url)
    return agent


def enable_inrun_history_reload(agent: Agent) -> int:
    """Flip every HistoryProvider's load_messages to True after server construction.

    ResponsesHostServer rejects providers with load_messages=True at startup
    (history is supposedly host-managed), but the harness tool-calling loop only
    reloads the running [user, tool_call, tool_result] history between brain calls
    when load_messages is True. Build with False to pass the guard, then enable it
    here so multi-step (tool-calling) requests retain the user query for the
    post-tool summary turn. Returns the number of providers flipped.
    """
    flipped = 0
    for provider in getattr(agent, "context_providers", []) or []:
        if isinstance(provider, InMemoryHistoryProvider) and not provider.load_messages:
            provider.load_messages = True
            flipped += 1
    return flipped
