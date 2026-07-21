import type { Block, BlocksFile } from "../schemas/block.js";
import type { Scene } from "../schemas/talkPlan.js";
import { sanitizeRestrictedComplianceText } from "./compliancePolicy.js";

/**
 * Build a compact "research brief" object for a single Scene. The brief is
 * what the dialogue-writing LLM sees as user-message content. It packs:
 *   - scene meta (title, beat, target seconds, dual-host names)
 *   - primary blocks: full text + dataPoints for every block in scene.blockRefs
 *   - chapter context: same-chapter siblings (lower priority, helps recover
 *     content like strategy cards that the ingest atomised into many
 *     `unknown` blocks)
 *   - global meta (match name, league, kickoff)
 *
 * Output is deterministic so prompt-cache can kick in across re-runs.
 */
export function buildSceneBrief(
  scene: Scene,
  blocksFile: BlocksFile,
): SceneBrief {
  const blockMap = new Map<string, Block>(blocksFile.blocks.map(b => [b.id, b]));
  const primary = scene.blockRefs.map(id => blockMap.get(id)).filter((b): b is Block => !!b);

  // Chapter context: every block sharing the first heading with any primary block,
  // minus blocks already in primary, minus heading-only and meta blocks.
  const chapterKeys = new Set<string>();
  for (const b of primary) {
    if (b.headingPath[0]) chapterKeys.add(b.headingPath[0]);
  }
  const primaryIds = new Set(primary.map(b => b.id));
  const siblings = blocksFile.blocks.filter(b =>
    !primaryIds.has(b.id)
    && b.kind !== "heading"
    && b.kind !== "meta"
    && b.headingPath[0] !== undefined
    && chapterKeys.has(b.headingPath[0])
  );

  const meta = blocksFile.blocks.find(b => b.kind === "meta") as Extract<Block, { kind: "meta" }> | undefined;

  return {
    sceneId: scene.id,
    sceneTitle: scene.title,
    narrativeBeat: scene.narrativeBeat,
    targetSec: scene.targetSec,
    targetChineseChars: Math.round(scene.targetSec * 3.0),
    match: {
      matchZh: meta?.matchZh ?? meta?.match ?? "",
      league: meta?.league ?? "",
      kickoff: meta?.kickoff ?? "",
      venue: meta?.venue ?? "",
    },
    primaryBlocks: primary.map(blockToDigest),
    contextBlocks: condenseContext(siblings),
  };
}

export interface SceneBrief {
  sceneId: string;
  sceneTitle: string;
  narrativeBeat: string;
  targetSec: number;
  targetChineseChars: number;
  match: { matchZh: string; league: string; kickoff: string; venue: string };
  primaryBlocks: BlockDigest[];
  contextBlocks: BlockDigest[];
}

export interface BlockDigest {
  id: string;
  kind: string;
  importance?: number;
  text?: string;
  items?: Array<{ label?: string; value?: string; pct?: string; amount?: string; market?: string; option?: string; tone?: string }>;
  rows?: Array<Array<string>>;
  headers?: string[];
  name?: string;            // for strategy-card
  summary?: string[];
  tone?: string;
  numbers?: Array<{ label: string; value: string }>;
}

function blockToDigest(b: Block): BlockDigest {
  const base: BlockDigest = { id: b.id, kind: b.kind, importance: round(b.importance, 2) };
  switch (b.kind) {
    case "paragraph":
      return { ...base, text: stripHtml(b.text) };
    case "callout":
      return { ...base, text: stripHtml(b.text), tone: b.tone };
    case "list":
      return { ...base, items: b.items.map(i => ({ label: stripHtml(i.text) })) };
    case "kpi-grid":
      return { ...base, items: b.items.map(i => ({ label: safe(i.label), value: safe(i.value), tone: i.tone })) };
    case "bar-list":
      return {
        ...base,
        text: safe(b.title) ?? undefined,
        items: b.items.map(i => ({ label: safe(i.label), pct: `${(i.probability * 100).toFixed(1)}%` })),
      };
    case "table":
      return {
        ...base,
        headers: b.headers.map(safe),
        rows: b.rows.slice(0, 8).map(r => r.map(c => safe(c.text))),
      };
    case "strategy-card":
      return {
        ...base,
        name: safe(b.name),
        summary: b.summary.map(safe),
        text: safe(b.goal),
        items: b.allocations.map(a => ({
          market: safe(a.market),
          option: safe(a.option),
        })),
      };
    case "chart-hint":
      return { ...base, text: `${b.chartType} chart` };
    case "unknown":
      return { ...base, text: stripHtml(b.text).slice(0, 80) };
    case "heading":
      return { ...base, text: b.text };
    case "meta":
      return { ...base, text: `${b.matchZh ?? b.match} ${b.league ?? ""} ${b.kickoff ?? ""}`.trim() };
    default:
      return base;
  }
}

/**
 * For context blocks, atomised `unknown` text fragments (especially in strategy
 * sections) are noisy. We collapse runs of short `unknown` blocks into a single
 * concatenated digest, keep `strategy-card` / `paragraph` / `callout` intact,
 * and drop pure decorations (single emoji etc).
 */
function condenseContext(blocks: Block[]): BlockDigest[] {
  const out: BlockDigest[] = [];
  let unkRun: string[] = [];

  const flushRun = () => {
    if (unkRun.length === 0) return;
    const joined = unkRun.join(" · ").trim();
    if (joined && joined.length >= 4) {
      out.push({ id: "unk-run", kind: "unknown-run", text: joined.slice(0, 240) });
    }
    unkRun = [];
  };

  for (const b of blocks) {
    if (b.kind === "unknown") {
      const t = stripHtml(b.text).trim();
      if (!t) continue;
      // skip lone emoji / single-symbol garbage
      if (t.length <= 2 && !/[0-9%¥A-Za-z]/.test(t)) continue;
      unkRun.push(t);
    } else {
      flushRun();
      out.push(blockToDigest(b));
    }
  }
  flushRun();
  // Cap volume so prompt stays under model context budget
  return out.slice(0, 30);
}

function stripHtml(s: string | undefined): string {
  if (!s) return "";
  return safe(s.replace(/\s+/g, " ").trim());
}

function safe(s: string | undefined): string {
  if (!s) return "";
  return sanitizeRestrictedComplianceText(s);
}

function round(x: number, p: number): number {
  const f = Math.pow(10, p);
  return Math.round(x * f) / f;
}
