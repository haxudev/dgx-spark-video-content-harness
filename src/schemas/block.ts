import { z } from "zod";

// -------------------- DataPoint --------------------
// Any numeric / string-numeric value extracted from a Block. The dialogue writer
// is only allowed to quote values that appear here (verify-text enforces this).
export const DataPointSchema = z.object({
  id: z.string(),                       // e.g. "b03.kpi.1" / "b07.row[2].col[3]"
  label: z.string(),                    // human-readable label (header / kpi label)
  value: z.union([z.number(), z.string()]),
  unit: z.string().optional(),          // "%", "元", "倍", ""
  kind: z.enum([
    "probability", "money", "ratio", "elo", "score", "count", "rate", "raw",
  ]).default("raw"),
  tone: z.enum(["good", "bad", "warn", "hl", "neutral"]).default("neutral"),
  provenance: z.string().optional(),    // DOM xpath or selector
});
export type DataPoint = z.infer<typeof DataPointSchema>;

// -------------------- Block --------------------
const Base = {
  id: z.string(),
  headingPath: z.array(z.string()).default([]),
  importance: z.number().min(0).max(1).default(0.3),
  dataPoints: z.array(DataPointSchema).default([]),
  sourceText: z.string().optional(),    // raw text fallback (for unknown / paragraph)
};

export const MetaBlockSchema = z.object({
  ...Base,
  kind: z.literal("meta"),
  match: z.string(),                    // "Bournemouth vs Man City"
  matchZh: z.string().optional(),       // "伯恩茅斯 VS 曼城"
  kickoff: z.string().optional(),       // ISO or display text
  league: z.string().optional(),
  venue: z.string().optional(),
  tags: z.array(z.string()).default([]),
});

export const HeadingBlockSchema = z.object({
  ...Base,
  kind: z.literal("heading"),
  level: z.number().int().min(1).max(6),
  text: z.string(),
  anchor: z.string().optional(),
});

export const ParagraphBlockSchema = z.object({
  ...Base,
  kind: z.literal("paragraph"),
  text: z.string(),
  emphasis: z.array(z.string()).default([]),  // bolded / hl spans
  containsSimulated: z.boolean().default(false),
});

export const KpiItemSchema = z.object({
  id: z.string(),
  value: z.string(),
  label: z.string(),
  tone: z.enum(["good", "bad", "warn", "hl", "neutral"]).default("neutral"),
  numeric: z.number().optional(),
});
export const KpiGridBlockSchema = z.object({
  ...Base,
  kind: z.literal("kpi-grid"),
  items: z.array(KpiItemSchema).min(2).max(8),
});

export const TableCellSchema = z.object({
  text: z.string(),
  numeric: z.number().optional(),
  tone: z.enum(["good", "bad", "warn", "hl", "neutral"]).default("neutral"),
  pills: z.array(z.string()).default([]),
});
export const TableBlockSchema = z.object({
  ...Base,
  kind: z.literal("table"),
  headers: z.array(z.string()),
  rows: z.array(z.array(TableCellSchema)),
  caption: z.string().optional(),
});

export const BarItemSchema = z.object({
  label: z.string(),
  probability: z.number().min(0).max(1),
  pills: z.array(z.string()).default([]),
});
export const BarListBlockSchema = z.object({
  ...Base,
  kind: z.literal("bar-list"),
  title: z.string().optional(),
  items: z.array(BarItemSchema),
});

export const AllocationRowSchema = z.object({
  market: z.string(),     // 比分 / 总进球 / 胜平负 / 半全场
  option: z.string(),     // 0:2 / 1球 / 主胜 ...
  units: z.number().int().optional(),
  amount: z.number().optional(),  // 元
  note: z.string().optional(),
});
export const StrategyCardBlockSchema = z.object({
  ...Base,
  kind: z.literal("strategy-card"),
  name: z.string(),                 // 稳健流 / 激进流 / 猎手流 / 爆冷强化
  badge: z.string().optional(),     // safe / aggr / hunt / hunt-v2
  goal: z.string().optional(),      // 一句话目标
  allocations: z.array(AllocationRowSchema),
  summary: z.array(z.string()).default([]),   // e.g. ["命中场景≥1项 92%", "E[PnL] +52"]
  total: z.object({ units: z.number().int(), amount: z.number() }).optional(),
});

export const CalloutBlockSchema = z.object({
  ...Base,
  kind: z.literal("callout"),
  tone: z.enum(["compliance", "warn", "info", "risk"]),
  text: z.string(),
});

export const ListItemSchema = z.object({
  text: z.string(),
  emphasis: z.array(z.string()).default([]),
});
export const ListBlockSchema = z.object({
  ...Base,
  kind: z.literal("list"),
  ordered: z.boolean().default(false),
  items: z.array(ListItemSchema),
});

export const ChartHintBlockSchema = z.object({
  ...Base,
  kind: z.literal("chart-hint"),
  chartType: z.enum(["bar", "heat", "line", "pie"]),
  xlabel: z.string().optional(),
  ylabel: z.string().optional(),
  raw: z.unknown().optional(),
});

export const UnknownBlockSchema = z.object({
  ...Base,
  kind: z.literal("unknown"),
  rawHtml: z.string(),
  text: z.string(),
});

export const BlockSchema = z.discriminatedUnion("kind", [
  MetaBlockSchema,
  HeadingBlockSchema,
  ParagraphBlockSchema,
  KpiGridBlockSchema,
  TableBlockSchema,
  BarListBlockSchema,
  StrategyCardBlockSchema,
  CalloutBlockSchema,
  ListBlockSchema,
  ChartHintBlockSchema,
  UnknownBlockSchema,
]);
export type Block = z.infer<typeof BlockSchema>;
export type BlockKind = Block["kind"];

export const BlocksFileSchema = z.object({
  reportPath: z.string(),
  parsedAt: z.string(),
  blocks: z.array(BlockSchema),
  stats: z.object({
    total: z.number(),
    byKind: z.record(z.string(), z.number()),
    unknownPct: z.number(),
    highImportanceCount: z.number(),
  }),
});
export type BlocksFile = z.infer<typeof BlocksFileSchema>;
