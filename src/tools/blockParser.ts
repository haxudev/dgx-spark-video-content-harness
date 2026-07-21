import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode, Element } from "domhandler";
import {
  type Block,
  type BlocksFile,
  type DataPoint,
  BlocksFileSchema,
} from "../schemas/block.js";

/**
 * Structure-agnostic HTML report → Block[] parser.
 *
 * Heuristics only — no business-specific section names are required.
 * Unknown subtrees fall through to `unknown` blocks so the pipeline never
 * fails on a new report layout.
 */
export function parseHtmlToBlocks(html: string, reportPath: string): BlocksFile {
  const $ = cheerio.load(html);
  const ctx: ParseCtx = { $, blocks: [], headingStack: [], idSeq: 0 };

  // Drop noise
  $("script, style, noscript").remove();

  // Hero / meta first
  emitMeta($, ctx);

  // Walk body in order; track h2/h3/h4 for headingPath
  walk($, $("body"), ctx);

  // Compute stats
  const byKind: Record<string, number> = {};
  for (const b of ctx.blocks) byKind[b.kind] = (byKind[b.kind] ?? 0) + 1;
  const total = ctx.blocks.length;
  const unknownPct = total === 0 ? 0 : (byKind["unknown"] ?? 0) / total;
  const highImportanceCount = ctx.blocks.filter(b => b.importance >= 0.7).length;

  const file: BlocksFile = {
    reportPath,
    parsedAt: new Date().toISOString(),
    blocks: ctx.blocks,
    stats: { total, byKind, unknownPct, highImportanceCount },
  };
  return BlocksFileSchema.parse(file);
}

interface ParseCtx {
  $: CheerioAPI;
  blocks: Block[];
  headingStack: { level: number; text: string }[];
  idSeq: number;
}

function nextId(ctx: ParseCtx, prefix: string): string {
  ctx.idSeq += 1;
  return `b${String(ctx.idSeq).padStart(3, "0")}-${prefix}`;
}

function headingPath(ctx: ParseCtx): string[] {
  return ctx.headingStack.map(h => h.text);
}

// Set of .mr-* class prefixes that indicate structural wrappers (descend into them, don't emit as blocks)
const MR_WRAPPERS = new Set([
  "mr-card", "mr-cs-body", "mr-cs-matrix", "mr-wdl-block", "mr-tg-columns",
  "mr-findings", "mr-complexity-grid", "mr-pred-grid", "mr-upset-scores-wrap",
  "mr-finding", "mr-finding-body", "mr-finding-title", "mr-complexity",
  "mr-complexity-metric", "mr-complexity-grid", "mr-complexity-driver",
  "mr-upset-hero", "mr-upset-value", "mr-upset-narrative", "mr-upset-score",
  "mr-upset-meter", "mr-upset-meter-fill", "mr-upset-head", "mr-upset-hint",
  "mr-pred-summary", "mr-pred-grid", "mr-om-head", "mr-om-summary", "mr-om-chart",
  "mr-om-block-title", "mr-om-odds-line", "mr-om-odds-item", "mr-om-kpi",
  "mr-om-deltas", "mr-om-delta", "mr-om-bars", "mr-om-bar-row",
  "mr-od-tabs", "mr-od-summary", "mr-od-legend", "mr-od-table-wrap",
  "mr-od-c-sel", "mr-od-c-odds", "mr-od-c-bars", "mr-od-c-num",
  "mr-tg-summary", "mr-cs-toplist", "mr-cs-item", "mr-cs-tail",
  "mr-htft", "mr-wdl-block-title", "mr-tg-col", "mr-tg-labels",
  "mr-hero-head", "mr-hero-times", "mr-hero-title", "mr-hero-time-item",
  "mr-teams", "mr-team-home", "mr-team-away", "mr-vs", "mr-meta",
  "mr-match-report",
]);

// Noise class prefixes to skip entirely
const MR_NOISE = new Set([
  "mr-banner", "mr-hero", "mr-footer", "mr-crumb",
  "app-banner", "brand", "banner-nav", "banner-nav-link",
  "live-pill", "brand-title", "brand-thesis", "brand-logo", "brand-text",
  "brand-thesis-symbol", "brand-manifesto-layer",
  "mr-banner-dot", "mr-team-name", "mr-vs",
]);

/** Check if a class attribute string contains a structural wrapper class */
function isMrWrapper(cls?: string): boolean {
  if (!cls) return false;
  for (const c of cls.split(/\s+/)) {
    if (MR_WRAPPERS.has(c)) return true;
  }
  return false;
}

/** Check if a class attribute string is pure noise to skip */
function isMrNoise(cls?: string): boolean {
  if (!cls) return false;
  for (const c of cls.split(/\s+/)) {
    if (MR_NOISE.has(c)) return true;
  }
  return false;
}

// ----------------------------------------------------------------------------
// Walker
// ----------------------------------------------------------------------------

function walk($: CheerioAPI, $node: Cheerio<AnyNode>, ctx: ParseCtx): void {
  $node.children().each((_, raw) => {
    if (raw.type !== "tag") return;
    const el = raw as Element;
    const $el = $(el);
    const tag = el.tagName.toLowerCase();
    const cls = $el.attr("class");

    // Structural wrappers — descend BEFORE any descendant-find heuristic
    if (tag === "body" || $el.hasClass("wrap")) {
      walk($, $el, ctx);
      return;
    }

    // New SPA structural wrappers (.mr-card, .mr-finding, etc.) — descend into them
    if (isMrWrapper(cls) && tag === "div") {
      walk($, $el, ctx);
      return;
    }

    // Skip SPA header/nav/brand noise (only at top level)
    if (ctx.headingStack.length === 0 && ($el.hasClass("compliance") || $el.hasClass("hero") || isMrNoise(cls))) {
      return;
    }

    // In-body compliance callouts (e.g. Falsification Firewall) ARE useful
    if ($el.hasClass("compliance")) {
      handleCompliance($, $el, ctx);
      return;
    }

    if (/^h[1-6]$/.test(tag)) {
      const level = parseInt(tag.slice(1), 10);
      const text = norm($el.text());
      // pop stack until last < level
      while (ctx.headingStack.length && ctx.headingStack[ctx.headingStack.length - 1]!.level >= level) {
        ctx.headingStack.pop();
      }
      ctx.headingStack.push({ level, text });
      ctx.blocks.push({
        kind: "heading",
        id: nextId(ctx, `h${level}`),
        level,
        text,
        anchor: $el.attr("id"),
        headingPath: headingPath(ctx).slice(0, -1),
        importance: level === 2 ? 0.5 : level === 3 ? 0.4 : 0.3,
        dataPoints: [],
      });
      return;
    }

    if (tag === "table") {
      handleTable($, $el, ctx);
      return;
    }

    if (tag === "ul" || tag === "ol") {
      handleList($, $el, ctx, tag === "ol");
      return;
    }

    if (tag === "p") {
      handleParagraph($, $el, ctx);
      return;
    }

    // SPA .mr-finding blocks — extract title+body and emit as paragraph
    if ($el.hasClass("mr-finding")) {
      const title = norm($el.find(".mr-finding-title").first().text());
      const body = norm($el.find(".mr-finding-body").first().text());
      if (body) {
        const text = title ? `${title}: ${body}` : body;
        ctx.blocks.push({
          kind: "paragraph",
          emphasis: [],
          containsSimulated: false,
          id: nextId(ctx, "finding"),
          text,
          headingPath: headingPath(ctx),
          importance: 0.5,
          dataPoints: extractNumbersFromText(body).slice(0, 8).map((dp, i) => ({
            ...dp,
            id: `b${String(ctx.idSeq + 1).padStart(3, "0")}.n${i}`,
          })),
        });
      }
      // Still descend to catch child tables/cards
      walk($, $el, ctx);
      return;
    }

    // SPA .mr-finding-body — emit as paragraph
    if ($el.hasClass("mr-finding-body")) {
      const text = norm($el.text());
      if (text) {
        ctx.blocks.push({
          kind: "paragraph",
          emphasis: [],
          containsSimulated: false,
          id: nextId(ctx, "finding-body"),
          text,
          headingPath: headingPath(ctx),
          importance: 0.4,
          dataPoints: extractNumbersFromText(text).slice(0, 6).map((dp, i) => ({
            ...dp,
            id: `b${String(ctx.idSeq + 1).padStart(3, "0")}.n${i}`,
          })),
        });
        return;
      }
    }

    // SPA .mr-pred-summary — emit as paragraph with data extraction
    if ($el.hasClass("mr-pred-summary")) {
      const text = norm($el.text());
      if (text) {
        ctx.blocks.push({
          kind: "paragraph",
          emphasis: [],
          containsSimulated: false,
          id: nextId(ctx, "pred-summary"),
          text,
          headingPath: headingPath(ctx),
          importance: 0.6,
          dataPoints: extractNumbersFromText(text).slice(0, 8).map((dp, i) => ({
            ...dp,
            id: `b${String(ctx.idSeq + 1).padStart(3, "0")}.n${i}`,
          })),
        });
        return;
      }
    }

    // SPA .mr-tg-summary — emit as paragraph
    if ($el.hasClass("mr-tg-summary")) {
      const text = norm($el.text());
      if (text) {
        ctx.blocks.push({
          kind: "paragraph",
          emphasis: [],
          containsSimulated: false,
          id: nextId(ctx, "tg-summary"),
          text,
          headingPath: headingPath(ctx),
          importance: 0.55,
          dataPoints: extractNumbersFromText(text).slice(0, 6).map((dp, i) => ({
            ...dp,
            id: `b${String(ctx.idSeq + 1).padStart(3, "0")}.n${i}`,
          })),
        });
        return;
      }
    }

    // SPA .mr-om-summary — emit as paragraph
    if ($el.hasClass("mr-om-summary")) {
      const text = norm($el.text());
      if (text) {
        ctx.blocks.push({
          kind: "paragraph",
          emphasis: [],
          containsSimulated: false,
          id: nextId(ctx, "om-summary"),
          text,
          headingPath: headingPath(ctx),
          importance: 0.55,
          dataPoints: extractNumbersFromText(text).slice(0, 6).map((dp, i) => ({
            ...dp,
            id: `b${String(ctx.idSeq + 1).padStart(3, "0")}.n${i}`,
          })),
        });
        return;
      }
    }

    // SPA .mr-upset-narrative — emit as paragraph
    if ($el.hasClass("mr-upset-narrative")) {
      const text = norm($el.text());
      if (text) {
        ctx.blocks.push({
          kind: "paragraph",
          emphasis: [],
          containsSimulated: false,
          id: nextId(ctx, "upset-narrative"),
          text,
          headingPath: headingPath(ctx),
          importance: 0.5,
          dataPoints: extractNumbersFromText(text).slice(0, 4).map((dp, i) => ({
            ...dp,
            id: `b${String(ctx.idSeq + 1).padStart(3, "0")}.n${i}`,
          })),
        });
        return;
      }
    }

    // SPA .mr-upset-meter-fill (percentage values) — skip, belongs to meter container
    if ($el.hasClass("mr-upset-meter-fill") && tag === "div") {
      return;
    }

    // SPA .mr-om-odds-line — odds line data, emit as paragraph
    if ($el.hasClass("mr-om-odds-line")) {
      const text = norm($el.text());
      if (text) {
        ctx.blocks.push({
          kind: "paragraph",
          emphasis: [],
          containsSimulated: false,
          id: nextId(ctx, "odds-line"),
          text,
          headingPath: headingPath(ctx),
          importance: 0.35,
          dataPoints: extractNumbersFromText(text).slice(0, 4).map((dp, i) => ({
            ...dp,
            id: `b${String(ctx.idSeq + 1).padStart(3, "0")}.n${i}`,
          })),
        });
        return;
      }
    }

    // SPA .mr-od-summary — odds summary
    if ($el.hasClass("mr-od-summary")) {
      const text = norm($el.text());
      if (text) {
        ctx.blocks.push({
          kind: "paragraph",
          emphasis: [],
          containsSimulated: false,
          id: nextId(ctx, "od-summary"),
          text,
          headingPath: headingPath(ctx),
          importance: 0.4,
          dataPoints: extractNumbersFromText(text).slice(0, 4).map((dp, i) => ({
            ...dp,
            id: `b${String(ctx.idSeq + 1).padStart(3, "0")}.n${i}`,
          })),
        });
        return;
      }
    }

    // SPA .mr-complexity-metric — complexity metric
    if ($el.hasClass("mr-complexity-metric")) {
      const text = norm($el.text());
      if (text) {
        ctx.blocks.push({
          kind: "paragraph",
          emphasis: [],
          containsSimulated: false,
          id: nextId(ctx, "complexity-metric"),
          text,
          headingPath: headingPath(ctx),
          importance: 0.4,
          dataPoints: extractNumbersFromText(text).slice(0, 4).map((dp, i) => ({
            ...dp,
            id: `b${String(ctx.idSeq + 1).padStart(3, "0")}.n${i}`,
          })),
        });
        return;
      }
    }

    // SPA .mr-upset-value — upset value analysis
    if ($el.hasClass("mr-upset-value")) {
      const text = norm($el.text());
      if (text) {
        ctx.blocks.push({
          kind: "paragraph",
          emphasis: [],
          containsSimulated: false,
          id: nextId(ctx, "upset-value"),
          text,
          headingPath: headingPath(ctx),
          importance: 0.5,
          dataPoints: extractNumbersFromText(text).slice(0, 6).map((dp, i) => ({
            ...dp,
            id: `b${String(ctx.idSeq + 1).padStart(3, "0")}.n${i}`,
          })),
        });
        return;
      }
    }

    // KPI grids: a wrapper whose DIRECT children are .kpi
    if ($el.children(".kpi").length >= 2) {
      handleKpiGrid($, $el, ctx);
      return;
    }

    // Strategy card: this element IS a .strat
    if ($el.hasClass("strat")) {
      handleStrategyCard($, $el, ctx);
      return;
    }
    // Strategy-card cluster: wrapper whose DIRECT children are .strat (not nested)
    if ($el.children(".strat").length >= 1) {
      $el.children(".strat").each((_i, strat) => { handleStrategyCard($, $(strat), ctx); });
      return;
    }

    // .card / .grid — these are layout wrappers; descend
    if ($el.hasClass("card") || $el.hasClass("grid")) {
      walk($, $el, ctx);
      return;
    }

    // Footer note / muted disclaimer
    if ($el.hasClass("foot") || $el.hasClass("mr-om-foot") || $el.hasClass("mr-od-foot")) {
      const text = norm($el.text());
      if (text) {
        ctx.blocks.push({
          kind: "callout",
          id: nextId(ctx, "foot"),
          tone: "info",
          text,
          headingPath: headingPath(ctx),
          importance: 0.2,
          dataPoints: [],
        });
      }
      return;
    }

    // Default: descend or emit unknown
    if ($el.children().length > 0) {
      walk($, $el, ctx);
    } else {
      const text = norm($el.text());
      // Skip single-character noise, pure percentages, and noise that slipped through
      if (text && !text.match(/^\s*$/) && !(tag === "span" && text.length <= 2) && !text.match(/^\d+\.?\d*%$/)) {
        ctx.blocks.push({
          kind: "unknown",
          id: nextId(ctx, "u"),
          rawHtml: $.html($el) ?? "",
          text,
          headingPath: headingPath(ctx),
          importance: 0.1,
          dataPoints: [],
        });
      }
    }
  });
}

// ----------------------------------------------------------------------------
// Meta
// ----------------------------------------------------------------------------

function emitMeta($: CheerioAPI, ctx: ParseCtx): void {
  // Support both legacy .hero and newer .mr-hero (Next.js SPA)
  const $hero = $(".hero, .mr-hero").first();
  const title = norm($("title").text());
  // Also try .mr-hero-title if .hero wasn't found
  const $heroTitle = $(".mr-hero-title, .hero h1").first();
  const matchZh = norm($heroTitle.text()) || norm($hero.find("h1").text()) || title;

  // Extract obvious meta from .hero .meta spans or .mr-hero-sub
  const metaSpans: string[] = [];
  $hero.find(".meta span, .mr-hero-sub").each((_, el) => { metaSpans.push(norm($(el).text())); });
  const tags: string[] = [];
  $hero.find(".tags span, .mr-agent-badge").each((_, el) => { tags.push(norm($(el).text())); });

  const kickoff = metaSpans.find(s => /\d{4}[-\/]\d{1,2}/.test(s));
  const league = metaSpans.find(s => /英超|西甲|意甲|德甲|法甲|欧冠|亚冠|中超|EPL|Premier|League|Liga|Serie|Bundesliga|UCL/.test(s));
  const venue = metaSpans.find(s => /Stadium|主场|球场|Arena|Park/i.test(s));

  // Heuristic team extract from title: "A VS B" / "A vs B" / "A 对 B"
  const m = matchZh.match(/(.+?)\s*(?:VS|vs|对|对阵)\s*(.+?)(?:\s|·|$)/);
  const englishParens = matchZh.match(/\(([^)]+)\)\s*VS\s*[^()]*\(([^)]+)\)/);
  let matchEn = "";
  if (englishParens) matchEn = `${englishParens[1]} vs ${englishParens[2]}`;
  else if (m) matchEn = `${m[1]} vs ${m[2]}`;

  ctx.blocks.push({
    kind: "meta",
    id: nextId(ctx, "meta"),
    match: matchEn || matchZh,
    matchZh,
    kickoff,
    league,
    venue,
    tags,
    headingPath: [],
    importance: 1.0,
    dataPoints: [],
  });

  // Compliance banner at top — legacy .compliance or newer .mr-banner
  const $cb = $(".compliance, .mr-banner, footer.mr-footer").first();
  if ($cb.length) {
    ctx.blocks.push({
      kind: "callout",
      id: nextId(ctx, "compliance"),
      tone: "compliance",
      text: norm($cb.text()),
      headingPath: [],
      importance: 0.6,
      dataPoints: [],
    });
  }
}

// ----------------------------------------------------------------------------
// Specific handlers
// ----------------------------------------------------------------------------

function handleParagraph($: CheerioAPI, $el: Cheerio<AnyNode>, ctx: ParseCtx): void {
  const text = norm($el.text());
  if (!text) return;
  const emphasis: string[] = [];
  $el.find("b, strong, .hl, .good, .bad, .warn").each((_, e) => {
    const t = norm($(e).text());
    if (t) emphasis.push(t);
  });
  const containsSimulated = /simulated_|模拟/.test(text);
  let importance = 0.3;
  if ($el.hasClass("muted") || $el.hasClass("small")) importance = 0.2;
  if ($el.parents().filter(".card").length && emphasis.length > 0) importance = Math.max(importance, 0.55);
  if (emphasis.length >= 2) importance = Math.max(importance, 0.6);

  const dataPoints = extractNumbersFromText(text).map((dp, i) => ({
    ...dp,
    id: `b${String(ctx.idSeq + 1).padStart(3, "0")}.n${i}`,
  }));

  ctx.blocks.push({
    kind: "paragraph",
    id: nextId(ctx, "p"),
    text,
    emphasis,
    containsSimulated,
    headingPath: headingPath(ctx),
    importance,
    dataPoints,
  });
}

function handleList($: CheerioAPI, $el: Cheerio<AnyNode>, ctx: ParseCtx, ordered: boolean): void {
  const items: { text: string; emphasis: string[] }[] = [];
  $el.find("> li").each((_, li) => {
    const $li = $(li);
    const text = norm($li.text());
    if (!text) return;
    const emphasis: string[] = [];
    $li.find("b, strong, .hl, .good, .bad").each((_, e) => {
      const t = norm($(e).text());
      if (t) emphasis.push(t);
    });
    items.push({ text, emphasis });
  });
  if (!items.length) return;

  const allText = items.map(i => i.text).join(" / ");
  const dataPoints = extractNumbersFromText(allText).map((dp, i) => ({
    ...dp,
    id: `b${String(ctx.idSeq + 1).padStart(3, "0")}.n${i}`,
  }));

  let importance = 0.35;
  if (items.some(i => i.emphasis.length > 0)) importance = 0.5;
  if ($el.hasClass("clean") && items.length >= 3) importance = 0.5;

  ctx.blocks.push({
    kind: "list",
    id: nextId(ctx, ordered ? "ol" : "ul"),
    ordered,
    items,
    headingPath: headingPath(ctx),
    importance,
    dataPoints,
  });
}

function handleKpiGrid($: CheerioAPI, $el: Cheerio<AnyNode>, ctx: ParseCtx): void {
  const items: { id: string; value: string; label: string; tone: any; numeric?: number }[] = [];
  $el.children(".kpi").each((_, k) => {
    const $k = $(k);
    const valTxt = norm($k.find(".v").text());
    const label = norm($k.find(".l").text());
    if (!valTxt || !label) return;
    const numeric = parseFirstNumber(valTxt);
    const tone = inferToneFromStyle($k.find(".v").attr("style")) ?? "neutral";
    items.push({ id: `k${items.length + 1}`, value: valTxt, label, tone, numeric });
  });
  if (items.length < 2) return;

  const baseId = nextId(ctx, "kpi");
  const dataPoints: DataPoint[] = items.map((it, i) => ({
    id: `${baseId}.k${i + 1}`,
    label: it.label,
    value: it.numeric ?? it.value,
    kind: classifyNumericKind(it.value, it.label),
    tone: it.tone,
    unit: extractUnit(it.value),
  }));

  ctx.blocks.push({
    kind: "kpi-grid",
    id: baseId,
    items,
    headingPath: headingPath(ctx),
    importance: 0.85,
    dataPoints,
  });
}

function handleTable($: CheerioAPI, $el: Cheerio<AnyNode>, ctx: ParseCtx): void {
  // headers — accept th anywhere in the first row that has any th
  const headers: string[] = [];
  const $firstHdr = $el.find("tr:has(th)").first();
  $firstHdr.find("th").each((_, th) => { headers.push(norm($(th).text())); });

  const allRows: { cells: { text: string; numeric?: number; tone: any; pills: string[]; barProb?: number }[] }[] = [];
  $el.find("tr").each((_, tr) => {
    const $tr = $(tr);
    const ths = $tr.find("> th").length;
    if (ths > 0 && allRows.length === 0) return; // header row
    const cells: { text: string; numeric?: number; tone: any; pills: string[]; barProb?: number }[] = [];
    $tr.find("> td").each((_, td) => {
      const $td = $(td);
      const text = norm($td.text());
      const numeric = parseFirstNumber(text);
      const tone = inferToneFromClass($td.attr("class")) ?? "neutral";
      const pills: string[] = [];
      $td.find(".pill").each((_, p) => { pills.push(norm($(p).text())); });
      const $bar = $td.find(".bar .fill");
      const barWidth = $bar.attr("style")?.match(/width\s*:\s*([\d.]+)%/);
      const barProb = barWidth ? parseFloat(barWidth[1]!) / 100 : undefined;
      cells.push({ text, numeric, tone, pills, barProb });
    });
    if (cells.length > 0) allRows.push({ cells });
  });

  if (allRows.length === 0) return;

  // Detect bar-list: table with bar fills in column N
  const hasBars = allRows.some(r => r.cells.some(c => c.barProb !== undefined));
  if (hasBars && headers.length <= 4) {
    const items = allRows
      .map(r => {
        const labelCell = r.cells[0];
        const probCell = r.cells.find(c => c.barProb !== undefined) ?? r.cells.find(c => c.numeric !== undefined);
        if (!labelCell || !probCell) return null;
        const prob = probCell.barProb ?? (probCell.numeric ? probCell.numeric / 100 : undefined);
        if (prob === undefined) return null;
        const pills = r.cells.flatMap(c => c.pills);
        return { label: stripPillNoise(labelCell.text), probability: clamp01(prob), pills };
      })
      .filter((x): x is { label: string; probability: number; pills: string[] } => !!x);

    if (items.length >= 2) {
      const baseId = nextId(ctx, "bars");
      const dataPoints: DataPoint[] = items.map((it, i) => ({
        id: `${baseId}.i${i + 1}`,
        label: it.label,
        value: round(it.probability, 4),
        kind: "probability",
        unit: "",
        tone: "neutral" as const,
      }));
      ctx.blocks.push({
        kind: "bar-list",
        id: baseId,
        title: headers.length > 1 ? headers[0] : undefined,
        items,
        headingPath: headingPath(ctx),
        importance: 0.8,
        dataPoints,
      });
      return;
    }
  }

  // Default: emit as generic table
  const tableRows = allRows.map(r => r.cells.map(c => ({
    text: c.text,
    numeric: c.numeric,
    tone: c.tone,
    pills: c.pills,
  })));

  const baseId = nextId(ctx, "tbl");
  const dataPoints: DataPoint[] = [];
  allRows.forEach((row, ri) => {
    row.cells.forEach((cell, ci) => {
      if (cell.numeric !== undefined) {
        dataPoints.push({
          id: `${baseId}.r${ri + 1}c${ci + 1}`,
          label: `${headers[ci] ?? `col${ci+1}`}: ${row.cells[0]?.text ?? ""}`.trim(),
          value: cell.numeric,
          kind: classifyNumericKind(cell.text, headers[ci] ?? ""),
          tone: cell.tone,
          unit: extractUnit(cell.text),
        });
      }
    });
  });

  let importance = 0.55;
  if (allRows.length >= 6) importance = 0.65;
  if (dataPoints.length >= 10) importance = 0.7;

  ctx.blocks.push({
    kind: "table",
    id: baseId,
    headers,
    rows: tableRows,
    headingPath: headingPath(ctx),
    importance,
    dataPoints,
  });
}

function handleStrategyCard($: CheerioAPI, $el: Cheerio<AnyNode>, ctx: ParseCtx): void {
  const name = norm($el.find("h3").first().text());
  const badge = norm($el.find(".badge").first().text()) || undefined;
  const goal = norm($el.find("p.small.muted").first().text()) || undefined;

  // Allocation table inside .alloc table
  const allocations: { market: string; option: string; units?: number; amount?: number; note?: string }[] = [];
  $el.find(".alloc table tr").each((_, tr) => {
    const $tr = $(tr);
    if ($tr.find("th").length > 0) return;
    if ($tr.hasClass("tot")) return;
    const tds = $tr.find("> td").toArray();
    if (tds.length < 2) return;
    const get = (i: number) => norm($(tds[i]).text());
    const num = (s: string) => parseFirstNumber(s);
    if (tds.length === 5) {
      allocations.push({
        market: get(0),
        option: get(1),
        units: num(get(2)),
        amount: num(get(3)),
        note: get(4) || undefined,
      });
    } else {
      allocations.push({
        market: get(0),
        option: get(1),
        units: tds.length > 2 ? num(get(2)) : undefined,
        amount: tds.length > 3 ? num(get(3)) : undefined,
      });
    }
  });

  // Totals row
  const $totRow = $el.find(".alloc table tr.tot").first();
  let total: { units: number; amount: number } | undefined;
  if ($totRow.length) {
    const cells = $totRow.find("td").toArray();
    const last = cells.length > 0 ? norm($(cells[cells.length - 1]).text()) : "";
    const second = cells.length > 1 ? norm($(cells[cells.length - 2]).text()) : "";
    const units = parseFirstNumber(second);
    const amount = parseFirstNumber(last);
    if (units !== undefined && amount !== undefined) total = { units, amount };
  }

  // Summary pills + muted lines
  const summary: string[] = [];
  $el.find("p.small").each((_, p) => {
    const t = norm($(p).text());
    if (t) summary.push(t);
  });

  const baseId = nextId(ctx, "strat");
  const dataPoints: DataPoint[] = [];
  allocations.forEach((a, i) => {
    if (a.units !== undefined) {
      dataPoints.push({
        id: `${baseId}.a${i + 1}.units`,
        label: `${a.market} ${a.option} 注数`,
        value: a.units,
        kind: "count",
        tone: "neutral",
        unit: "注",
      });
    }
    if (a.amount !== undefined) {
      dataPoints.push({
        id: `${baseId}.a${i + 1}.amount`,
        label: `${a.market} ${a.option} 金额`,
        value: a.amount,
        kind: "money",
        tone: "neutral",
        unit: "元",
      });
    }
  });
  if (total) {
    dataPoints.push({
      id: `${baseId}.total.units`,
      label: "总注数",
      value: total.units,
      kind: "count",
      tone: "neutral",
      unit: "注",
    });
    dataPoints.push({
      id: `${baseId}.total.amount`,
      label: "总金额",
      value: total.amount,
      kind: "money",
      tone: "neutral",
      unit: "元",
    });
  }
  // Pull EV / 命中概率 / E[PnL] numbers from summary lines
  summary.forEach((s, i) => {
    extractNumbersFromText(s).forEach((dp, j) => {
      dataPoints.push({
        ...dp,
        id: `${baseId}.sum${i + 1}.n${j + 1}`,
        label: `${name} 摘要: ${dp.label}`,
      });
    });
  });

  ctx.blocks.push({
    kind: "strategy-card",
    id: baseId,
    name,
    badge,
    goal,
    allocations,
    summary,
    total,
    headingPath: headingPath(ctx),
    importance: 0.85,
    dataPoints,
  });
}

function handleCompliance($: CheerioAPI, $el: Cheerio<AnyNode>, ctx: ParseCtx): void {
  const text = norm($el.text());
  if (!text) return;
  ctx.blocks.push({
    kind: "callout",
    id: nextId(ctx, "callout"),
    tone: $el.hasClass("compliance") ? "compliance" : ($el.text().match(/风险|危险|警告|warn/) ? "warn" : "info"),
    text,
    headingPath: headingPath(ctx),
    importance: 0.7,
    dataPoints: [],
  });
}

// ----------------------------------------------------------------------------
// Utilities
// ----------------------------------------------------------------------------

function norm(s: string | undefined | null): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function parseFirstNumber(s: string): number | undefined {
  if (!s) return undefined;
  const m = s.replace(/,/g, "").match(/[-+]?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : undefined;
}

function extractUnit(s: string): string | undefined {
  if (/%/.test(s)) return "%";
  if (/元|￥|¥/.test(s)) return "元";
  if (/倍/.test(s)) return "倍";
  if (/pp$/i.test(s) || /pp\b/i.test(s)) return "pp";
  if (/球$/.test(s)) return "球";
  return undefined;
}

function classifyNumericKind(text: string, label: string): DataPoint["kind"] {
  const t = `${text} ${label}`;
  if (/%|概率|P\b|p\b|pct/.test(t)) return "probability";
  if (/元|￥|¥|金额|amount/i.test(t)) return "money";
  if (/赔率|倍|odds/i.test(t)) return "ratio";
  if (/Elo/i.test(t)) return "elo";
  if (/进球|比分|球数|score/i.test(t)) return "score";
  if (/注数|count|场|次/i.test(t)) return "count";
  if (/率/.test(t) && !/概率/.test(t)) return "rate";
  return "raw";
}

function extractNumbersFromText(text: string): Array<Omit<DataPoint, "id">> {
  // Matches: 32.1%, +0.996, 100元, 1.5倍, 596,390, 28.8%, −0.103 etc.
  const re = /([+\-−]?\d{1,3}(?:[,，]\d{3})*(?:\.\d+)?)\s*(%|元|倍|pp|球|分|场|岁|st|次)?/g;
  const out: Array<Omit<DataPoint, "id">> = [];
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1]!.replace(/[,，]/g, "").replace("−", "-");
    const num = parseFloat(raw);
    if (!Number.isFinite(num)) continue;
    const unit = m[2];
    const ctxBefore = text.slice(Math.max(0, m.index - 12), m.index).trim();
    const ctxAfter = text.slice(m.index + m[0].length, m.index + m[0].length + 12).trim();
    out.push({
      label: `${ctxBefore}${m[0]}${ctxAfter}`.slice(0, 40),
      value: num,
      kind: classifyNumericKind(m[0], ctxBefore + ctxAfter),
      tone: "neutral",
      unit,
    });
    i += 1;
    if (i > 60) break;
  }
  return out;
}

function inferToneFromClass(cls?: string): "good" | "bad" | "warn" | "hl" | "neutral" | undefined {
  if (!cls) return undefined;
  if (/\bgood\b/.test(cls)) return "good";
  if (/\bbad\b/.test(cls)) return "bad";
  if (/\bwarn\b/.test(cls)) return "warn";
  if (/\bhl\b/.test(cls)) return "hl";
  return undefined;
}

function inferToneFromStyle(style?: string): "good" | "bad" | "warn" | "hl" | "neutral" | undefined {
  if (!style) return undefined;
  const m = style.match(/color\s*:\s*([^;]+)/);
  if (!m) return undefined;
  const c = m[1]!.toLowerCase();
  if (/#34d399|#10b981|emerald|green/.test(c)) return "good";
  if (/#f87171|#ef4444|red/.test(c)) return "bad";
  if (/#fbbf24|#facc15|amber|yellow/.test(c)) return "warn";
  if (/#a78bfa|#8b5cf6|purple|violet/.test(c)) return "hl";
  return undefined;
}

function stripPillNoise(s: string): string {
  // Pills are appended inline as plain text after the label; we keep the head before space-pill
  return s.replace(/\s+\([^)]*\)\s*$/, "").trim();
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function round(x: number, p: number): number {
  const f = Math.pow(10, p);
  return Math.round(x * f) / f;
}
