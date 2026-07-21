import * as fs from "node:fs/promises";
import { parseHtmlToBlocks } from "../tools/blockParser.js";
import { extractMarketDataFromHtml } from "../tools/marketExtractor.js";
import { writeJson, type RunContext } from "../orchestrator/runContext.js";
import type { Issue } from "../orchestrator/supervisor.js";
import type { RunState } from "../orchestrator/stateMachine.js";

export const ingest = async (
  ctx: RunContext,
  _state: RunState,
  _priorIssues: Issue[],
): Promise<{ ok: boolean; issues?: Issue[] }> => {
  const html = await fs.readFile(ctx.reportPath, "utf8");
  const file = parseHtmlToBlocks(html, ctx.reportPath);

  const issues: Issue[] = [];
  if (file.blocks.length < 5) {
    issues.push({
      kind: "ingest-too-few-blocks",
      severity: "error",
      message: `Only ${file.blocks.length} blocks extracted from ${ctx.reportPath}`,
    });
  }
  if (file.stats.unknownPct > 0.25) {
    issues.push({
      kind: "ingest-too-many-unknown",
      severity: "warn",
      message: `unknown blocks = ${(file.stats.unknownPct * 100).toFixed(1)}% (>${25}%); consider extending blockParser heuristics`,
    });
  }
  if (file.stats.highImportanceCount === 0) {
    issues.push({
      kind: "ingest-no-high-importance",
      severity: "warn",
      message: "No high-importance (≥0.7) blocks detected; plan agent may have little to work with",
    });
  }
  if (!file.blocks.find(b => b.kind === "meta")) {
    issues.push({
      kind: "ingest-missing-meta",
      severity: "error",
      message: "No meta block (match name / kickoff) detected",
    });
  }

  await writeJson(ctx.paths.blocks, file);

  // Also extract structured market data for ECharts-driven scene partials.
  // Failures are non-fatal (best-effort) — partials can fall back to text.
  try {
    const market = extractMarketDataFromHtml(html);
    await writeJson(ctx.paths.marketData, market);

    // Wrong-format / empty-report detector. The whole four-act deck and the
    // agent-first WRITE brief are driven by these structured sections. If NONE
    // of the data-bearing modules parsed, the input is almost certainly not a
    // real football.haxu.net SPA report (e.g. a hand-built odds placeholder or
    // an un-hydrated SPA shell). Fail loudly here instead of silently shipping
    // a data-less video whose WRITE degrades to the identical-every-match
    // template. This is the guard that turns the "成片没有数据" failure into a
    // visible, retryable error.
    const hasSignal = Boolean(
      market.market1x2 ||
        market.totalGoals ||
        market.correctScore ||
        market.htft ||
        market.marketSignal ||
        market.upset ||
        market.strategy,
    );
    if (!hasSignal) {
      issues.push({
        kind: "ingest-market-empty",
        severity: "error",
        message:
          `未从报告中解析到任何结构化盘面数据（胜平负/总进球/比分/半全场/风向标/爆冷/策略均为空）。` +
          `${ctx.reportPath} 很可能不是真实的 football.haxu.net SPA 报告（占位/空壳/旧格式）。` +
          `请确认使用 run --url <真实报告URL> 抓取完整渲染后的 SPA，而不是本地占位 HTML。`,
      });
    }
  } catch (e: any) {
    issues.push({
      kind: "ingest-market-extract-failed",
      severity: "warn",
      message: `marketExtractor: ${e?.message ?? e}`,
    });
  }

  const hardErr = issues.some(i => i.severity === "error");
  return { ok: !hardErr, issues };
};
