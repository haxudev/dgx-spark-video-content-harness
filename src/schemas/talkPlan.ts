import { z } from "zod";

export const VisualKindSchema = z.enum([
  "hook",
  "kpi-grid",
  "comparison",
  "bars",
  "strategy-cards",
  "callout",
  "list-beats",
  "quote",
  "table-row-focus",
  "paragraph-flow",
  "risk",
  "compliance",
  "outro",
  // M5 extensions
  "timeline",            // horizontal time series of events / form
  "side-by-side-cards",  // 2-up comparison cards (richer than `comparison`)
  "probability-map",     // heatmap matrix (e.g. half-time × full-time)
  "kelly-bar",           // single stacked allocation bar (per-strategy)
  // M6 — ECharts-driven dashboards for football reports
  "team-fundamentals",   // side-by-side team form summary with bars
  "market-grid",         // 2x2 market dashboard: 1x2 donut + goals bars + score heatmap + ht/ft
  "upset-dashboard",     // gauge + upset score chips + complexity narrative
  "strategy-board",      // 4 strategy profile cards + 1 payoff scenario
  "watch-boundary",      // visual-only card dashboard for safe viewing strategy
  // v2 — simplified 4-act deck
  "cover-anime",         // Act 1: full-screen anime AI cover (双方 + 胜平负 + 比分top3 + 球数top3)
  "fundamentals-signal", // Act 2: team-compare chart + 风向标 (隐含/公允/模型概率 + 漂移)
]);
export type VisualKind = z.infer<typeof VisualKindSchema>;

export const NarrativeBeatSchema = z.enum([
  "hook", "comparison", "reveal", "data-drill", "recommendation", "risk", "compliance", "outro",
]);
export type NarrativeBeat = z.infer<typeof NarrativeBeatSchema>;

export const SceneSchema = z.object({
  id: z.string(),                          // "s01" .. "sNN"
  title: z.string(),                       // agent-named, e.g. "曼城真的稳？看这几个数"
  narrativeBeat: NarrativeBeatSchema,
  blockRefs: z.array(z.string()).default([]),
  dataPointRefs: z.array(z.string()).default([]),
  targetSec: z.number().min(5).max(120),
  transitionIn: z.enum(["none", "fade", "flash-through-white", "cross-fade-soft"]).default("none"),
  visualSpec: z.object({
    kind: VisualKindSchema,
    props: z.record(z.string(), z.any()).default({}),
  }),
  notes: z.string().optional(),
});
export type Scene = z.infer<typeof SceneSchema>;

export const TalkPlanSchema = z.object({
  matchId: z.string(),
  totalTargetSec: z.number().min(60).max(360),
  scenes: z.array(SceneSchema).min(3),
  dropped: z.array(z.object({
    blockId: z.string(),
    reason: z.string(),
  })).default([]),
  rationale: z.string().optional(),
  createdAt: z.string(),
});
export type TalkPlan = z.infer<typeof TalkPlanSchema>;
