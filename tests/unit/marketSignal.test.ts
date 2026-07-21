import { test } from "node:test";
import { strict as assert } from "node:assert";
import { extractMarketDataFromHtml } from "../../src/tools/marketExtractor.js";
import { buildSignal1x2, result1x2 } from "../../src/tools/hfmlBuilder.js";

// A compact SPA-format (.mr-*) report fragment carrying the v2 regions:
// total-goals bars, the odds→probability decomposition table, the 盘口解读
// finding, and the upset complexity metrics + drivers.
const HTML = `<!doctype html><html><body><div class="mr-hero"><h1 class="mr-hero-title">法国 对 塞内加尔 比赛分析</h1></div>
<section class="mr-section"><h2 class="mr-section-title"><span class="mr-ordinal">②</span>模型预测与赔率分析</h2>
<div class="mr-card mr-mkt-1x2"><div class="mr-outcome lead"><div class="mr-outcome-role">主胜</div><div class="mr-outcome-team">法国</div><div class="mr-outcome-pct">51.4%</div></div><div class="mr-outcome"><div class="mr-outcome-role">平局</div><div class="mr-outcome-team">—</div><div class="mr-outcome-pct">23.7%</div></div><div class="mr-outcome"><div class="mr-outcome-role">客胜</div><div class="mr-outcome-team">塞内加尔</div><div class="mr-outcome-pct">24.9%</div></div></div>
<div class="mr-card mr-mkt-om"><div class="mr-om-odds-line">
<span class="mr-om-odds-item"><span class="mr-om-odds-role">主胜</span><span class="num">1.37</span><span class="mr-om-odds-arrow pos">→</span><span class="num pos">1.35</span></span>
<span class="mr-om-odds-item"><span class="mr-om-odds-role">平局</span><span class="num">3.95</span><span class="mr-om-odds-arrow neg">→</span><span class="num neg">4.02</span></span>
<span class="mr-om-odds-item"><span class="mr-om-odds-role">客胜</span><span class="num">6.85</span><span class="mr-om-odds-arrow neg">→</span><span class="num neg">7.15</span></span>
</div></div>
<div class="mr-card mr-mkt-tg"><div class="mr-tg-columns">
<div class="mr-tg-col"><span class="mr-tg-pct">5.9%</span></div>
<div class="mr-tg-col"><span class="mr-tg-pct">16.9%</span></div>
<div class="mr-tg-col peak"><span class="mr-tg-pct">23.8%</span></div>
<div class="mr-tg-col"><span class="mr-tg-pct">22.6%</span></div>
</div><div class="mr-tg-labels"><span>0</span><span>1</span><span>2</span><span>3</span></div></div>
<table class="mr-od-table"><tbody>
<tr><td class="mr-od-c-sel">主胜</td><td class="mr-od-c-odds num">1.35</td><td class="mr-od-c-bars"></td><td class="mr-od-c-num num">74.1%</td><td class="mr-od-c-num num">65.6%</td><td class="mr-od-c-num num">51.4%</td><td class="mr-od-c-num num">-14.2pp</td><td class="mr-od-c-num num">-30.6%</td></tr>
<tr><td class="mr-od-c-sel">客胜</td><td class="mr-od-c-odds num">7.15</td><td class="mr-od-c-bars"></td><td class="mr-od-c-num num">14.0%</td><td class="mr-od-c-num num">12.4%</td><td class="mr-od-c-num num">24.9%</td><td class="mr-od-c-num num">+12.5pp</td><td class="mr-od-c-num num">+78.0%</td></tr>
</tbody></table>
<div class="mr-findings"><div class="mr-finding"><div class="mr-finding-title">盘口解读</div><div class="mr-finding-body"><ul><li>开盘法国1.37、平3.95、塞内加尔6.85；最新变为法国1.35、平4.02、塞内加尔7.15。</li></ul></div></div></div>
</section>
<section class="mr-section"><h2 class="mr-section-title"><span class="mr-ordinal">③</span>爆冷可能性分析</h2>
<div class="mr-upset-hero"><div class="mr-upset-gauge"><div class="mr-upset-value">48.6%</div></div><div class="mr-upset-narrative"><p>模型把 法国 视为 热门略占优（最被看好概率 51.4%）。</p></div></div>
<div class="mr-complexity"><div class="mr-complexity-grid">
<div class="mr-complexity-metric"><span class="mr-complexity-label">爆冷压力</span><span class="mr-complexity-value">26.5%</span><span class="mr-complexity-detail">综合冷门强度</span></div>
<div class="mr-complexity-metric"><span class="mr-complexity-label">赛果分散度</span><span class="mr-complexity-value">1.03</span><span class="mr-complexity-detail">越分散越不确定</span></div>
</div>
<div class="mr-complexity-drivers"><div class="mr-complexity-drivers-title">主要驱动</div>
<div class="mr-complexity-driver"><span class="mr-complexity-driver-label">赔率压缩</span><span class="mr-complexity-driver-bar"><span style="width: 93.7%;"></span></span><span class="mr-complexity-driver-value">93.7%</span></div>
</div></div>
<div class="mr-upset-scores"><div class="mr-upset-score top"><div class="mr-upset-score-head"><span class="mr-upset-score-val">1-1</span><span class="mr-upset-score-pct">11.3%</span></div><div class="mr-upset-interp">平局</div></div></div>
</section></body></html>`;

test("marketExtractor v2: topGoals are the top-3 goal counts by probability", () => {
  const m = extractMarketDataFromHtml(HTML);
  assert.ok(m.totalGoals, "totalGoals region should be parsed");
  assert.deepEqual(
    m.totalGoals!.topGoals.map(g => [g.goals, g.pct]),
    [["2", 23.8], ["3", 22.6], ["1", 16.9]],
  );
});

test("marketExtractor v2: marketSignal carries implied/fair/model + mismatch (no odds)", () => {
  const m = extractMarketDataFromHtml(HTML);
  assert.ok(m.marketSignal, "marketSignal should be parsed");
  const home = m.marketSignal!.rows.find(r => r.role === "主胜");
  assert.deepEqual(
    [home!.implied, home!.fair, home!.model, home!.mismatchPp],
    [74.1, 65.6, 51.4, -14.2],
  );
  const away = m.marketSignal!.rows.find(r => r.role === "客胜");
  assert.equal(away!.mismatchPp, 12.5);
});

test("marketExtractor v2: drift is normalised implied probability open→last", () => {
  const m = extractMarketDataFromHtml(HTML);
  const drift = m.marketSignal!.drift;
  assert.ok(Array.isArray(drift) && drift.length === 3, "drift should have 3 outcomes");
  const home = drift!.find(d => d.role === "主胜")!;
  // 1/1.37 normalised ≈ 64.6%, 1/1.35 ≈ 65.6%
  assert.ok(home.open > 63 && home.open < 66, `open ${home.open}`);
  assert.ok(home.last > 64 && home.last < 67, `last ${home.last}`);
  assert.ok(home.last > home.open, "favourite implied probability drifted up");
});

test("marketExtractor v2: complexity metrics + de-sensitised drivers", () => {
  const m = extractMarketDataFromHtml(HTML);
  const cm = m.upset!.complexityMetrics;
  const pressure = cm.find(c => c.label === "爆冷压力");
  assert.equal(pressure!.pct, 26.5);
  const dispersion = cm.find(c => c.label === "赛果分散度");
  assert.equal(dispersion!.pct, null, "non-% metric keeps pct null");
  // 赔率压缩 must be de-sensitised to 市场压缩 (no restricted '赔率' term reaches visuals)
  const drivers = m.upset!.drivers;
  assert.equal(drivers[0]!.label, "市场压缩");
  assert.equal(drivers[0]!.pct, 93.7);
});

test("marketExtractor v2: oddsMovement parses 胜负平 open→last 票面赔率", () => {
  const m = extractMarketDataFromHtml(HTML);
  assert.ok(m.oddsMovement, "oddsMovement should be parsed from .mr-om-odds-line");
  const pts = m.oddsMovement!.points;
  assert.equal(pts.length, 3, "three 胜负平 outcomes");
  const home = pts.find(p => p.role === "主胜")!;
  assert.deepEqual([home.open, home.last], [1.37, 1.35]);
  const away = pts.find(p => p.role === "客胜")!;
  assert.deepEqual([away.open, away.last], [6.85, 7.15]);
});

test("buildSignal1x2: Act-2 风向标 = three bars (隐含/公允/模型) derived from odds", () => {
  const m = extractMarketDataFromHtml(HTML);
  const sig = buildSignal1x2(m)!;
  assert.ok(sig, "signal should be built");
  assert.ok(sig.hasImplied && sig.hasFair && sig.hasModel, "all three series present");
  const home = sig.rows.find(r => r.role === "主胜")!;
  // 隐含 (含抽水) = 1/1.35 = 74.1%; matches the report's 概率深度分解 隐含 column
  assert.equal(home.implied, 74.1);
  // 公允 (去抽水) = (1/1.35) / Σ(1/last) ≈ 65.6%; matches the report's 公允 column
  assert.ok(home.fair! > 64 && home.fair! < 67, `fair ${home.fair}`);
  // 模型 comes from market1x2
  assert.equal(home.model, 51.4);
});

test("buildSignal1x2: 概率漂移 derived from open→last de-vig (matches report sign)", () => {
  const m = extractMarketDataFromHtml(HTML);
  const sig = buildSignal1x2(m)!;
  assert.equal(sig.drift.length, 3, "three drift cards when odds moved");
  const home = sig.drift.find(d => d.role === "主胜")!;
  // favourite shortened 1.37 → 1.35 ⇒ implied probability drifted up
  assert.equal(home.dir, "up");
  assert.ok(home.delta > 0 && home.absDelta === Math.abs(home.delta), `delta ${home.delta}`);
  const away = sig.drift.find(d => d.role === "客胜")!;
  assert.equal(away.dir, "down", "outsider lengthened ⇒ implied drifted down");
});

test("buildSignal1x2: flat odds suppress the drift cards (hasMove guard)", () => {
  const flat = HTML
    .replace('<span class="num">1.37</span><span class="mr-om-odds-arrow pos">→</span><span class="num pos">1.35</span>',
             '<span class="num">1.35</span><span class="mr-om-odds-arrow">→</span><span class="num">1.35</span>')
    .replace('<span class="num">3.95</span><span class="mr-om-odds-arrow neg">→</span><span class="num neg">4.02</span>',
             '<span class="num">4.02</span><span class="mr-om-odds-arrow">→</span><span class="num">4.02</span>')
    .replace('<span class="num">6.85</span><span class="mr-om-odds-arrow neg">→</span><span class="num neg">7.15</span>',
             '<span class="num">7.15</span><span class="mr-om-odds-arrow">→</span><span class="num">7.15</span>');
  const sig = buildSignal1x2(extractMarketDataFromHtml(flat))!;
  assert.equal(sig.drift.length, 0, "no drift cards when odds never moved");
  assert.ok(sig.hasImplied && sig.hasFair && sig.hasModel, "three bars still present");
});

test("buildSignal1x2: Act-2 风向标 excludes 让球 (handicap) outcomes — 胜负平 only", () => {
  // Real 1x2 cards also carry 让球 rows (让胜/让平/让负) in the same .mr-outcome
  // list. The Act-2 风向标 must drop them and show only 主胜/平局/客胜 (+ 漂移).
  const withHandicap = HTML.replace(
    '<div class="mr-outcome"><div class="mr-outcome-role">客胜</div><div class="mr-outcome-team">塞内加尔</div><div class="mr-outcome-pct">24.9%</div></div></div>',
    '<div class="mr-outcome"><div class="mr-outcome-role">客胜</div><div class="mr-outcome-team">塞内加尔</div><div class="mr-outcome-pct">24.9%</div></div>'
      + '<div class="mr-outcome"><div class="mr-outcome-role">让胜</div><div class="mr-outcome-team">—</div><div class="mr-outcome-pct">31.2%</div></div>'
      + '<div class="mr-outcome"><div class="mr-outcome-role">让平</div><div class="mr-outcome-team">—</div><div class="mr-outcome-pct">28.5%</div></div>'
      + '<div class="mr-outcome lead"><div class="mr-outcome-role">让负</div><div class="mr-outcome-team">—</div><div class="mr-outcome-pct">40.3%</div></div></div>',
  );
  const m = extractMarketDataFromHtml(withHandicap);
  // The extractor itself keeps all six outcomes in market1x2 (used elsewhere)…
  assert.equal(m.market1x2!.outcomes.length, 6, "extractor keeps 让球 in market1x2");
  // …but the Act-2 signal must be 胜负平-only.
  const sig = buildSignal1x2(m)!;
  assert.deepEqual(sig.rows.map(r => r.role), ["主胜", "平局", "客胜"], "marketSignal rows are 胜负平-only");
  assert.ok(!sig.rows.some(r => r.role.startsWith("让")), "no 让球 rows leak into Act-2");
  assert.ok(sig.drift.every(d => !d.role.startsWith("让")), "no 让球 drift");
});

test("buildSignal1x2: 隐含/公允 sourced from 赔率→概率深度分解 table, not just odds", () => {
  // Set the od-table 主胜 隐含=70.0 / 公允=62.0 — distinct from 1/last (1/1.35≈74.1) —
  // to prove the bars read the report's decomposition columns when present.
  const faithful = HTML.replace(
    '<td class="mr-od-c-num num">74.1%</td><td class="mr-od-c-num num">65.6%</td><td class="mr-od-c-num num">51.4%</td>',
    '<td class="mr-od-c-num num">70.0%</td><td class="mr-od-c-num num">62.0%</td><td class="mr-od-c-num num">51.4%</td>',
  );
  const sig = buildSignal1x2(extractMarketDataFromHtml(faithful))!;
  const home = sig.rows.find(r => r.role === "主胜")!;
  assert.equal(home.implied, 70.0, "隐含 reads the 概率深度分解 column");
  assert.equal(home.fair, 62.0, "公允 reads the 概率深度分解 column");
  assert.equal(home.model, 51.4);
});

test("buildSignal1x2: falls back to 让球 only when 胜负平 has no 赔率/概率 data", () => {
  // A market that never listed 胜负平 (only a handicap line). The 风向标 card then
  // shows the 让球 outcomes as the sole available market signal.
  const onlyHandicap = `<!doctype html><html><body>
<section class="mr-section"><div class="mr-card mr-mkt-1x2">
<div class="mr-outcome"><div class="mr-outcome-role">让胜</div><div class="mr-outcome-team">—</div><div class="mr-outcome-pct">31.2%</div></div>
<div class="mr-outcome"><div class="mr-outcome-role">让平</div><div class="mr-outcome-team">—</div><div class="mr-outcome-pct">28.5%</div></div>
<div class="mr-outcome lead"><div class="mr-outcome-role">让负</div><div class="mr-outcome-team">—</div><div class="mr-outcome-pct">40.3%</div></div>
</div></section></body></html>`;
  const sig = buildSignal1x2(extractMarketDataFromHtml(onlyHandicap))!;
  assert.deepEqual(sig.rows.map(r => r.role), ["让胜", "让平", "让负"], "让球 fills the card when 胜负平 is absent");
  assert.ok(sig.hasModel, "让球 模型 bars present");
});

test("buildSignal1x2: keeps 模型-only 胜负平 bars (no 让球 fallback) when only probability exists", () => {
  // 胜负平 has model probability but no odds/隐含/公允 (degraded market). Per spec the
  // 让球 fallback must NOT trigger — the card stays 胜负平 with 模型-only bars.
  const noOdds = `<!doctype html><html><body>
<section class="mr-section"><div class="mr-card mr-mkt-1x2">
<div class="mr-outcome lead"><div class="mr-outcome-role">主胜</div><div class="mr-outcome-team">法国</div><div class="mr-outcome-pct">76.9%</div></div>
<div class="mr-outcome"><div class="mr-outcome-role">平局</div><div class="mr-outcome-team">—</div><div class="mr-outcome-pct">15.3%</div></div>
<div class="mr-outcome"><div class="mr-outcome-role">客胜</div><div class="mr-outcome-team">伊拉克</div><div class="mr-outcome-pct">7.8%</div></div>
<div class="mr-outcome"><div class="mr-outcome-role">让胜</div><div class="mr-outcome-team">—</div><div class="mr-outcome-pct">15.5%</div></div>
<div class="mr-outcome lead"><div class="mr-outcome-role">让负</div><div class="mr-outcome-team">—</div><div class="mr-outcome-pct">68.4%</div></div>
</div></section></body></html>`;
  const sig = buildSignal1x2(extractMarketDataFromHtml(noOdds))!;
  assert.deepEqual(sig.rows.map(r => r.role), ["主胜", "平局", "客胜"], "stays 胜负平");
  assert.ok(sig.hasModel && !sig.hasImplied && !sig.hasFair, "模型-only bars");
  assert.equal(sig.drift.length, 0, "no drift without odds movement");
});

test("result1x2: Act-3 赛果分布 keeps only 胜负平 (drops 让球)", () => {
  const withHandicap = HTML.replace(
    '<div class="mr-outcome"><div class="mr-outcome-role">客胜</div><div class="mr-outcome-team">塞内加尔</div><div class="mr-outcome-pct">24.9%</div></div></div>',
    '<div class="mr-outcome"><div class="mr-outcome-role">客胜</div><div class="mr-outcome-team">塞内加尔</div><div class="mr-outcome-pct">24.9%</div></div>'
      + '<div class="mr-outcome"><div class="mr-outcome-role">让胜</div><div class="mr-outcome-team">—</div><div class="mr-outcome-pct">31.2%</div></div>'
      + '<div class="mr-outcome lead"><div class="mr-outcome-role">让负</div><div class="mr-outcome-team">—</div><div class="mr-outcome-pct">40.3%</div></div></div>',
  );
  const m = extractMarketDataFromHtml(withHandicap);
  assert.equal(m.market1x2!.outcomes.length, 5, "extractor keeps 让球 in market1x2");
  const res = result1x2(m)!;
  assert.deepEqual(res.outcomes.map(o => o.role), ["主胜", "平局", "客胜"], "donut data is 胜负平-only");
  assert.ok(!res.outcomes.some(o => o.role.startsWith("让")), "no 让球 slice in 赛果分布");
});
