# 项目报告书（三）· Nvidia DGX Spark Qwen3.6 使用详情说明

> 配套文档：`01-名称-目标-背景.md`、`02-作品介绍-功能与亮点.md`、`04-分镜脚本.md`、`05-开发复盘-团队故事.md`

本篇聚焦一个问题：**Nvidia DGX Spark 上的 Qwen3.6 到底在这条生产线里扮演了什么角色、怎么接、怎么调、踩过什么坑。**

---

## 一、Nvidia DGX Spark 是什么

**Nvidia DGX Spark 是团队本地的一台私有 AI 推理网关**，以 OpenAI 兼容协议对外服务。它同时承载三种能力，且这三种能力**共享同一批 GPU**：

| 能力               | 角色                                             | 端点（内网）                                          |
| ------------------ | ------------------------------------------------ | ----------------------------------------------------- |
| **LLM 大脑** | **Qwen3.6-35B**「思考型」大模型            | `http://gx10.haxu.home:8000/v1`                     |
| **语音合成** | Qwen3-TTS 统一网关（音色注册 / ICL 克隆 / 合成） | `<origin>/api/voices`、`<origin>/v1/audio/speech` |
| **数字人**   | LongCat-Video-Avatar 口播视频生成                | `<host>/avatar`（`LONGCAT_AVATAR_BASE_URL`）      |

> **核心约束**：大脑、嗓子、脸共用显存——**数字人一开工，同机的 Qwen 大脑就得让出 GPU、暂停约 10 分钟**。这条物理约束贯穿了本项目大量的工程设计（见第五节）。

Qwen3.6 在本项目里出现在**三个位置**：① WRITE 写稿大脑；② MAF 托管 agent 的编排大脑；③ 与数字人生成的 GPU 时间片让渡。下面逐一说明。

---

## 二、Nvidia DGX Spark 的接入与配置

### 2.1 环境变量（唯一配置入口）

Nvidia DGX Spark 完全通过环境变量注册，实现于 `src/tools/llmClient.ts`：

| 环境变量                             | 作用                                                 | 默认 / 行为          |
| ------------------------------------ | ---------------------------------------------------- | -------------------- |
| `Nvidia DGX Spark_OPENAI_BASE_URL` | 网关 OpenAI 兼容 base URL                            | 必填                 |
| `Nvidia DGX Spark_OPENAI_API_KEY`  | API Key                                              | 必填                 |
| `Nvidia DGX Spark_MODEL_NAME`      | 模型 id（如`qwen3.6-35b`）                         | 必填                 |
| `Nvidia DGX Spark_THINKING_EFFORT` | 思考强度，作为 body 额外字段`thinking_effort` 注入 | 未设/空 →`"none"` |

三个必填变量**全部齐全**时，Nvidia DGX Spark 才注册为 provider，并被排在 **Nvidia DGX Spark → Azure** 的**首位**（优先尝试）。核心构造逻辑：

```ts
// src/tools/llmClient.ts
if (process.env.Nvidia DGX Spark_OPENAI_BASE_URL && process.env.Nvidia DGX Spark_OPENAI_API_KEY && process.env.Nvidia DGX Spark_MODEL_NAME) {
  const thinkingEffort = (process.env.Nvidia DGX Spark_THINKING_EFFORT && process.env.Nvidia DGX Spark_THINKING_EFFORT.trim() !== "")
    ? process.env.Nvidia DGX Spark_THINKING_EFFORT.toLowerCase() : "none";
  Nvidia DGX Spark.push({
    name: "Nvidia DGX Spark",
    client: new OpenAI({ baseURL: process.env.Nvidia DGX Spark_OPENAI_BASE_URL, apiKey: process.env.Nvidia DGX Spark_OPENAI_API_KEY }),
    model: process.env.Nvidia DGX Spark_MODEL_NAME,
    extra: { thinking_effort: thinkingEffort },
  });
}
```

### 2.2 provider 责任链

```
Nvidia DGX Spark (Qwen3.6-35B, 主)  →  Azure AI Foundry (gpt-5.4 / DeepSeek-V4-Flash, 兜底)  →  确定性模板 (离线)
```

- `chatJson()` 按顺序尝试每个 provider，带重试与退避，强制 JSON-object 响应格式，自动剥离代码围栏。
- `HARNESS_DISABLE_LLM=1` 或所有 provider 失败时，落到内建确定性模板（气隙测试 / CI 冒烟）。

---

## 三、Nvidia DGX Spark Qwen3.6 的三大用途

### 用途 1 · WRITE 写稿大脑（最核心）

**整条生产线里，Qwen3.6 最主要的工作是「写稿」。** WRITE 阶段是一次「结论先行」的**整篇创作**调用：把一份「市场派生的简报」喂给 Qwen3.6，让它一次性把四幕的口播稿全写出来。

- **入口**：`src/phases/03-write.ts` 调用 `chatJson()`。
- **agent-first**：`retries: 2`（共 3 次），确保 provider 抖动时坚持用 agent 而非退回模板；`creativeSeed` 让每场稿子不雷同；`authoredBy` 落章标记 `agent` 还是 `deterministic`。
- **约束注入**：system prompt 里写死双主持/单主播角色、直白球赛术语规则、禁抽象隐喻、概率口径（不许赔率）、合规必念句、术语→大白话替换、所有数字念中文、每行 ≤28 字等。
- **数字保真**：只允许引用简报里可回溯的数字，`sanitiseNumbers` 抑制幻觉数字。

> 注：其余阶段（PLAN / TTS / RENDER / 各 VERIFY）基本是**确定性/规则化**的，不调用 LLM。PLAN/WRITE 里硬编码的 `CPS=3.7`（每秒中文字数）是**为 Qwen3-TTS 语速标定**的常量，是 Qwen 影响 PLAN 的唯一方式。

### 用途 2 · MAF 托管 agent 的编排大脑

容器化把整条 harness 封装成一个 **Microsoft Agent Framework agent**，走 Foundry **RESPONSES** 协议（端口 8088），对外暴露单个 35B 友好的工具 `generate_match_video`。

- **agent 大脑 = Nvidia DGX Spark `qwen3.6-35b`**，默认复用 `Nvidia DGX Spark_OPENAI_*`：

```python
# agent/football_agent/config.py
base_url = _env("AGENT_MODEL_BASE_URL", "Nvidia DGX Spark_OPENAI_BASE_URL")
api_key  = _env("AGENT_MODEL_API_KEY",  "Nvidia DGX Spark_OPENAI_API_KEY")
model    = _env("AGENT_MODEL_NAME",     "Nvidia DGX Spark_MODEL_NAME")
```

- 上游传 `report_url` + 风格参数（`mode`/`profile`/`cover`/`skip_render` 及可选 Qwen3-TTS 音色），工具内部调 `harness fetch` + `harness run --url … --result-json …`，返回 `mp4Path`。
- **两层大脑各司其职**：agent 大脑（编排、选工具、填参数）是 Nvidia DGX Spark Qwen3.6；harness 内部 WRITE 阶段仍走自己的 Nvidia DGX Spark→Azure 责任链，互不干扰。
- 为省显存/依赖，只装精简 MAF 依赖（`agent-framework-openai` + `foundry-hosting` + `mcp`），绝不装 `agent-framework[all]` 元包。

### 用途 3 · 数字人生成与 Qwen 大脑的 GPU 时间片让渡

数字人（LongCat-Video-Avatar，「移动的 Nvidia DGX Spark 主播」）在 Nvidia DGX Spark 上生成时**单任务、GPU 独占**，一段 480p ~3.7s 片段要 ~10–12 分钟，**期间同机 Qwen 大脑被暂停以让出显存**，队列排空后再拉起。

工程上对此做了严格隔离：

- **流水线内的 AVATAR 阶段是纯缓存消费**（`src/phases/06b-avatar.ts`）：只从版本库 `assets/avatar-clips/<mode>-<分辨率>-seg<段数>.mp4` 拷贝，**绝不联网、绝不触发 longcat**——所以一次正常 `harness run` 永远不会把大脑卡住。
- **生成放在带外命令** `harness avatar-prewarm`（**唯一的 longcat 调用方**）：独占 `mkdir` 锁、`/healthz` 预检、生成后用 `waitForBrainOnline()` 作为屏障，确认大脑（`qwen_active && running==0`）回来才返回。
- 缓存缺失**非阻塞**（WARN + 占位带），除非 `HARNESS_REQUIRE_AVATAR=1`；`fast`/`draft` profile 默认 `HARNESS_SKIP_AVATAR=1`。

---

## 四、`Nvidia DGX Spark_THINKING_EFFORT` 与「思考模型」处理

Qwen3.6-35B 是**思考型（reasoning）模型**，会产出隐藏的思维链，这带来三处专门处理：

1. **额外字段注入**：`thinking_effort`（默认 `"none"`）作为 body 额外字段随每次请求发送。
2. **token 预算加倍**：因为思考要吃掉一部分输出预算，Nvidia DGX Spark 的输出预算被裁剪加厚——
   ```ts
   const tokens = p.name === "Nvidia DGX Spark" ? Math.max(baseTokens, baseTokens * 2 + 400) : baseTokens;
   ```

   Azure 用原始 `baseTokens`。
3. **更长超时 + 剥离思维链**：Nvidia DGX Spark 硬超时 300s（Azure 120s）；`extractContent()` 会剥掉 `<think>…</think>` 块，保证下游 `JSON.parse` 只看到答案（早期版本则是「只读 `content`、故意忽略 `reasoning`」）。

### 关键坑：思考模型太慢，WRITE 会超时

这是全项目最重要的运维经验之一：

> **Nvidia DGX Spark 的思考模型对 WRITE 阶段太慢。** 即便 `Nvidia DGX Spark_THINKING_EFFORT=low`，它仍返回大段推理、预算被 ×2+400 加厚，叠加 `chatJson` 每 provider 重试 2 次、每场 ~6 幕，WRITE 会 **>10 分钟、撞 600s 超时**。

**运维标准做法**（写进 `docs/runbook-execution.md` §1、`AGENTS.md`）：**在命令行把三个 `Nvidia DGX Spark_*` 变量置空**，强制回退 Azure 快速模型：

```bash
env Nvidia DGX Spark_OPENAI_BASE_URL= Nvidia DGX Spark_OPENAI_API_KEY= Nvidia DGX Spark_MODEL_NAME= \
    PUPPETEER_EXECUTABLE_PATH=/home/haxu/.cache/puppeteer/chrome/linux-131.../chrome \
    npm run harness -- run inputs/<日期>/<file>.html
```

**为什么置空能生效**：`src/cli.ts` 顶部 `import "dotenv/config"`，而 `dotenv` **只填未设置的变量**；命令行导出的空字符串已「设置」，会压过 `.env` 默认值，空字符串又是 falsy → Nvidia DGX Spark 不注册 → 落到 Azure。（注意：**不要去改 `.env`**，因为 dotenv 只补空缺。）

> 双人 v2 的注意点略有不同：`Nvidia DGX Spark_OPENAI_API_KEY` 需保留（agent 大脑仍要鉴权），只置空 `Nvidia DGX Spark_OPENAI_BASE_URL`/`Nvidia DGX Spark_MODEL_NAME`，让 chat 回退 Azure `gpt-5.4`，TTS 则走本地 Qwen3-TTS（不再托管在 Nvidia DGX Spark）。

**长期修法（TODO）**：加一个 `Nvidia DGX Spark_THINKING_EFFORT=disabled` 开关或换非思考模型，届时把上面的置空覆盖反转即可。

---

## 五、GPU 时间片：一张图看懂「大脑 vs 脸」的博弈

```
                       Nvidia DGX Spark 单机 GPU 池
   ┌───────────────────────────────────────────────────────┐
   │  Qwen3.6-35B 大脑        Qwen3-TTS 嗓子     LongCat 脸   │
   │  (WRITE/agent/编排)      (本地语音配音)     (数字人生成) │
   └───────────────────────────────────────────────────────┘
        ▲                                          │
        │  正常 harness run：AVATAR 纯缓存消费      │ 生成时独占 GPU
        │  绝不触发生成 → 大脑不受影响              │ 暂停大脑 ~10-12 min
        │                                          ▼
   ┌─────────────────────────┐        ┌──────────────────────────┐
   │  一次正常出片            │        │  带外 avatar-prewarm      │
   │  （消费大脑 + 消费缓存） │        │ （唯一生成方，独占锁+屏障）│
   └─────────────────────────┘        └──────────────────────────┘
```

**设计准则：消费 ≠ 生成。** 流水线只「消费」预热好的数字人片段；「生成」这种会抢占大脑的重活，永远显式、带外、手动触发，并用锁与屏障确保大脑安全归位。

---

## 六、Nvidia DGX Spark 相关配置速查

| 变量                                  | 用途                                          | 典型值                                               |
| ------------------------------------- | --------------------------------------------- | ---------------------------------------------------- |
| `Nvidia DGX Spark_OPENAI_BASE_URL`  | LLM 网关                                      | `http://gx10.haxu.home:8000/v1`                    |
| `Nvidia DGX Spark_OPENAI_API_KEY`   | LLM/网关鉴权                                  | （内网 key）                                         |
| `Nvidia DGX Spark_MODEL_NAME`       | 模型 id                                       | `qwen3.6-35b`                                      |
| `Nvidia DGX Spark_THINKING_EFFORT`  | 思考强度                                      | `none`（默认）/ `low`                            |
| `QWEN_TTS_CLONE_REF_FEMALE`         | 本地克隆兜底参考音                            | `~/openclaw-artifacts/custom_voice/anchor_ref.wav` |
| `QWEN_TTS_SEED`                     | TTS 采样种子                                  | `7`                                                |
| `LONGCAT_AVATAR_BASE_URL`           | 数字人生成端点（**仅 prewarm 需要**）   | `https://<host>/avatar`                            |
| `AGENT_MODEL_*`                     | MAF agent 大脑（缺省复用 Nvidia DGX Spark_*） | 复用 Nvidia DGX Spark                                |

---

## 七、小结

- **Qwen3.6 是这条生产线的「大脑」**：主职写稿（WRITE），兼任 MAF agent 的编排大脑。
- **思考模型是双刃剑**：质量在线但对逐幕写稿太慢——项目用「置空 Nvidia DGX Spark 变量、回退 Azure 快模型」的运维手法绕开，并为其保留了随时切回的通路。
- **GPU 是稀缺资源**：大脑、嗓子、脸共享显存的物理现实，逼出了「缓存-only 消费 + 带外生成 + 锁与屏障」这套让渡机制，是本项目最有工程含金量的设计之一。
