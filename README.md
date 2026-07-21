# dgx-spark-video-content-harness

> **DGX Spark (Qwen3.6-35B) 驱动的 agent-first 足球数据观察短视频自动生产线**
> Input: 任意结构的 HTML 单场分析报告 / `--url` 网页 / 一整天的赛前预测数据
> Output: 3–6 分钟、中文口播、9:16 竖屏、合规标注完整的成片 MP4

把一份「结构任意」的足球分析报告（HTML）或「一整天」的赛前预测数据，自动加工成竖屏解说视频——**数据一进，成片就出**。同一套「解析 → 规划 → 写稿 → 校验 → 配音 → 数字人 → 合成 → 渲染 → 交付」引擎支持三种成片风格。

> 📊 项目报告书（在线阅读）：**https://haxudev.github.io/dgx-spark-video-content-harness/**
> 源文档见 [`项目报告书/`](项目报告书/)。

## 三种成片风格（同一条生产线）

| 风格 | `ScriptMode` | 形态 | 输入源 |
|------|--------------|------|--------|
| 单人新闻播报 · 每日「全量串讲」 | `digest` | 一位女主播「小美」串讲当天全部比赛 | Azure Blob 当天全量数据 |
| 双人播客对谈（本仓库 v2） | `podcast` | 男女双主持「小美 + 小帅」逐场深聊 | 单场 HTML 报告 / `--url` |
| 单人第一人称解说 | `monologue` | 一位「解局人」悬念口播 | 单场 HTML 报告 / `--url` |

## 设计要点

- **结构无关**：报告解析层只识别通用 Block 类型（KPI 卡 / 表格 / 卡组 / 告示框 / 列表 / 图表提示…），新版式降级为 `unknown` 而非崩溃；数字必须可回溯到原始数据块。
- **音频即时间基准**：先 TTS 拿到精确时长，再据此排布 GSAP 时间轴，最后 hyperframes 无头 Chrome 确定性逐帧渲染 + ffprobe 校验音画同步（`|Δduration| ≤ 0.5s`）——「口播说到哪、画面就到哪」靠同源而非对齐。
- **plan-exec-verify 状态机**：14 个阶段各自「计划-执行-校验」，自带重试 / 回滚 / 问题路由 / 升级 `escalation.json`，产物落盘 `out/`，支持断点续跑。
- **内容与工程解耦**：写作规则、术语、合规话术、拒绝词全由 `config/*.yaml` 管控，业务方不动 TypeScript。
- **合规优先、默认去投注化**：只做赛前概率观察 / 体育数据讨论，成片不出现彩票、投注、赔率、庄家、推荐、资金等引导性表达；开场收场固定念免责声明；数字「画面给、口播不报」。
- **Agent-first、CLI 优先、无 MCP**：稳定接口是 `harness` 命令行，pi / Microsoft Agent Framework 托管 agent 都能直接驱动。

## 六大亮点

1. **Agent 现场创作，不套模板**：WRITE 是一次「结论先行」的整篇 LLM 创作；`creativeSeed` 保证每场不雷同，`retries: 2` 抗抖动，`authoredBy` 落章标记 `agent`/`deterministic`，离线回退确定性模板。
2. **直白球赛术语 · 反抽象隐喻**：比喻只能用球场上看得见的画面（控球 / 反击 / 压迫 / 防线 / 定位球…），禁「门缝 / 钥匙 / 一盘棋 / 资本」等抽象隐喻，中学文化程度也一听就懂。
3. **音频即时间基准 + 确定性渲染 = 帧级音画同步**。
4. **数字人主播 + AI 生成美术**：LongCat-Video-Avatar 口播带替代字幕，gpt-image-2 生成封面 / 背景 / 队徽；AVATAR 阶段**缓存-only、绝不联网、绝不卡大脑**。
5. **专属音色克隆 + 音色一致性**：Qwen3-TTS 自定义 / 克隆音色，`QWEN_TTS_SEED=7` 固定采样，女主播 x-vector 克隆消除音色漂移。
6. **合规是构造出来的**：数据源入口即丢弃赔率字段、配置驱动拒绝词、文本双闸校验、画面契约、敏感词自动改写。

## Pipeline（双人 v2 · 14 阶段）

```
INGEST → PLAN → WRITE → VERIFY_TEXT → AUDIT_TALK → TTS → VERIFY_AUDIO
       → AVATAR → COMPOSE → VERIFY_VISUAL → RENDER → VERIFY_AV → AUDIT_VISUAL → POST
```

## DGX Spark / Qwen3.6 的角色

**DGX Spark（内网代号 `GX10`）是团队本地的私有 AI 推理网关**，以 OpenAI 兼容协议对外服务，同时承载 **Qwen3.6-35B「思考型」大脑**、**Qwen3-TTS 语音合成** 与 **LongCat-Video-Avatar 数字人**——三者共享同一批 GPU。Qwen3.6 出现在四个位置：① WRITE 写稿大脑；② MAF 托管 agent 的编排大脑；③ digest 版网关 TTS；④ 与数字人生成的 GPU 时间片让渡。详见 [`项目报告书/`](项目报告书/)。

> ⚠️ 运维要点：思考模型对逐幕 WRITE 太慢（易撞超时），标准做法是**在命令行把 `GX10_*` 变量置空**强制回退 Azure 快模型（`dotenv` 只填未设置的变量，故空字符串会压过 `.env`）。详见 `docs/runbook-execution.md`。

## Requirements

- Node.js ≥ 22
- FFmpeg in PATH
- Chrome / Chromium（hyperframes 渲染需要，`PUPPETEER_EXECUTABLE_PATH`）
- DGX Spark（`GX10_*`）或 Azure OpenAI（写稿 LLM，可离线回退确定性模板）
- Qwen3-TTS（本地）或 Azure Speech（TTS，可回退占位音频）

## Quick start

```bash
npm install
cp .env.example .env        # 填入 GX10_* / Azure key（离线可留空）
npm run harness -- run inputs/20260522/2026-05-22_ajax-vs-groningen.html
```

快速离线冒烟（无需云凭证）：

```bash
HARNESS_SKIP_RENDER=1 npm run harness -- run inputs/20260522/2026-05-22_ajax-vs-groningen.html --to POST
```

## Pi agent runtime

本项目现在带有 pi coding-agent 兼容层，面向“无 MCP、CLI 优先”的极简 agent 运行方式：

- `AGENTS.md`：pi 自动加载的项目上下文。
- `.pi/settings.json`：把现有 `skills/` 暴露给 pi，并启用 skill slash command。
- `.pi/skills/podcast-football-harness/`：专门给 pi 使用的 pipeline 操作 skill。
- `.pi/prompts/*.md`：`/inspect-report`、`/run-pipeline`、`/fix-escalation` 等 prompt templates。
- `scripts/pi-agent-harness.ts`：可选的 pi 启动包装器，不引入 MCP 或硬依赖。

安装 pi 后可直接使用：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
npm run pi:prompt -- --input inputs/20260522/2026-05-22_ajax-vs-groningen.html "inspect this report"
npm run pi -- --input inputs/20260522/2026-05-22_ajax-vs-groningen.html "inspect this report and fix parser gaps if needed"
npm run pi -- --mode print "summarize the current pipeline readiness"
npm run pi -- --mode rpc --no-session
```

更多细节见 `docs/pi-agent-runtime.md`。

子命令：

```bash
harness run <html|dir>            # 全流程
harness run <html> --phase=ingest # 单阶段
harness inspect <html>            # 仅看 Block[] 概览，评估是否需要加新启发式
```

## 辅助工具

### `scripts/fetch-jina.mjs` — Jina Reader 网页抓取

将任意 URL 转换为 LLM 友好的 Markdown / HTML / Text 输出，自动保存到 `inputs/<date>/`。

```bash
# 抓取并保存为 markdown（默认）
node scripts/fetch-jina.mjs https://example.com

# 带 frontmatter 元数据的 markdown（推荐用于 pipeline 输入）
node scripts/fetch-jina.mjs https://example.com --as frontmatter

# SPA hash 路由（需要 POST）
node scripts/fetch-jina.mjs "https://app.example.com/#/match/42" --post

# 强制浏览器引擎渲染 JS 页面
node scripts/fetch-jina.mjs https://example.com --engine browser --timeout 30

# 指定输出元素（避免导航/侧边栏噪声）
node scripts/fetch-jina.mjs https://example.com --target-selector article.content

# 自定义输出路径
node scripts/fetch-jina.mjs https://example.com --out ./my-report.html --as html

# 搜索模式（需要 API key）
node scripts/fetch-jina.mjs "football prediction 2026" --search

# 使用自托管 Jina Reader
JINA_READER_BASE_URL=http://localhost:3000 node scripts/fetch-jina.mjs https://example.com

# 帮助
node scripts/fetch-jina.mjs --help
```

环境变量：`JINA_READER_BASE_URL`（默认 `https://r.jina.ai`）、`JINA_READER_API_KEY`（可选，提升配额）

完整 headers 列表：`X-Respond-With`、`X-Engine`、`X-Timeout`、`X-Target-Selector`、`X-Max-Tokens`、`X-Retain-Images`、`X-Preset` 等。

## 仓库布局

```
src/
  orchestrator/        # 状态机 + supervisor (plan-exec-verify)
  phases/              # 各 phase 独立可测，含 talk / visual quality gates
  tools/               # 纯函数 (blockParser, azureSpeech, hfmlBuilder, ffprobe, …)
  prompts/             # LLM system prompts
  schemas/             # zod schemas for every artifact
skills/                # agent 本地 skills (football-talktrack, azure-speech-ssml, av-sync-verifier)
templates/             # hyperframes 模板（按 visualSpec.kind 索引的 13 个 partial）
config/                # glossary / banned-terms / compliance-phrases (YAML)
out/{date}/{match}/    # 每场比赛的工作目录（artifact 落盘）
tests/                 # 单测 + 多报告样式 fixture
```

## 状态机

```
INGEST → PLAN → WRITE → VERIFY_TEXT → AUDIT_TALK → TTS → VERIFY_AUDIO
       → AVATAR → COMPOSE → VERIFY_VISUAL → RENDER → VERIFY_AV → AUDIT_VISUAL → POST → DONE
```

每个 phase 都用 `supervisor.runPlanExecVerify(phase)` 封装。失败时按回退表（见 `src/orchestrator/stateMachine.ts`）决定 re-exec / re-plan / 升级 escalation.json。

## 通用化扩展

- 新报告样式不被识别？跑 `harness inspect <html>` 看 `unknown` 比例，按 §10.1 加 `blockParser` 启发式。
- 需要新视觉？按 §10.2 在 `templates/scenes/` 加 partial、注册到 `hfmlBuilder.ts` 与 `talkPlan.ts` 联合类型、补单测。
- 新术语 / 合规句 / 拒绝词？直接改 `config/*.yaml`。

## 内容边界

默认采用中等去投注化口径：保留足球概率、比分情景和赛果走势推演，但公开成片不得出现彩票、投注、下注、购买、推荐、资金安排、收益承诺等引导性表达。开场与收场必须说明“赛前概率观察 / 体育数据讨论”，并强调不作结果承诺、不作为参与决策依据。

## Quality gates

- `AUDIT_TALK`：生成 `verify/talk-track-audit.json`，按双主持节奏、句长、Anchor 占比、合规边界和每幕可理解性给分，并写出逐幕改进意见。
- `AUDIT_VISUAL`：生成 `verify/visual-frame-audit.json`。完整渲染后会用 ffmpeg 为每个 scene 抽取终稿帧到 `verify/visual-frames/*.jpg`；配置 Qwen 视觉模型后可逐图审查可读性、字幕遮挡、视觉层级和改进意见。
