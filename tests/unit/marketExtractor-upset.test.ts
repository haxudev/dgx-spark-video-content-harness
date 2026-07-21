import { test } from "node:test";
import { strict as assert } from "node:assert";
import { extractMarketDataFromHtml } from "../../src/tools/marketExtractor.js";

// Minimal SPA-shaped upset section: the Top-N scores live in a *sibling*
// `.mr-upset-scores-wrap` of the hero, not inside it. Regression guard for the
// bug where `scores` came back empty and favTeam/band/favPct were mis-parsed.
const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<div class="mr-report">
  <div class="mr-section">
    <h3 class="mr-section-title"><span class="mr-ordinal">③</span>爆冷可能性分析</h3>
    <div class="mr-upset-hero">
      <div class="mr-upset-gauge"><div class="mr-upset-value">43.8%</div><div class="mr-upset-caption">爆冷概率</div></div>
      <div class="mr-upset-narrative"><p>模型把 <b>墨西哥</b> 视为 <b>热门略占优</b>（最被看好概率 56.2%）。 爆冷意味着 客队不输（客胜+平），合计概率约 <b>43.8%</b>。</p></div>
    </div>
    <div class="mr-upset-scores-wrap">
      <div class="mr-upset-head"><h4>潜在爆冷比分</h4><p class="mr-upset-hint">Top 4 合计 33.0%</p></div>
      <div class="mr-upset-scores">
        <div class="mr-upset-score top"><div class="mr-upset-score-head"><span class="mr-upset-score-val">1-1</span><span class="mr-upset-score-pct">12.2%</span></div><div class="mr-upset-interp interp-draw">平局</div></div>
        <div class="mr-upset-score "><div class="mr-upset-score-head"><span class="mr-upset-score-val">0-0</span><span class="mr-upset-score-pct">8.2%</span></div><div class="mr-upset-interp interp-draw">平局</div></div>
        <div class="mr-upset-score "><div class="mr-upset-score-head"><span class="mr-upset-score-val">0-1</span><span class="mr-upset-score-pct">7.2%</span></div><div class="mr-upset-interp interp-away">客胜 · 南非</div></div>
        <div class="mr-upset-score "><div class="mr-upset-score-head"><span class="mr-upset-score-val">1-2</span><span class="mr-upset-score-pct">5.5%</span></div><div class="mr-upset-interp interp-away">客胜 · 南非</div></div>
      </div>
    </div>
  </div>
</div>
</body></html>`;

test("upset extraction reads Top-N scores from the sibling scores-wrap (not the hero)", () => {
  const u = extractMarketDataFromHtml(HTML).upset;
  assert.ok(u, "upset block should be present");
  const scores = u!.scores;
  assert.equal(scores.length, 4, `expected 4 upset scores, got ${scores.length}`);

  assert.deepEqual(
    scores.map(s => s.score),
    ["1-1", "0-0", "0-1", "1-2"],
    "scorelines in source order",
  );
  assert.deepEqual(
    scores.map(s => s.pct),
    [12.2, 8.2, 7.2, 5.5],
    "score percentages parsed",
  );
  assert.equal(scores[0]!.top, true, "first score flagged top");
  assert.equal(scores[0]!.interp, "平局");
  assert.equal(scores[2]!.interp, "客胜 · 南非");
});

test("upset narrative parses favTeam / band / favPct (not the whole sentence)", () => {
  const u = extractMarketDataFromHtml(HTML).upset;
  assert.ok(u);
  assert.equal(u!.favTeam, "墨西哥", "favTeam is the team name, not the sentence");
  assert.equal(u!.band, "热门略占优");
  assert.equal(u!.favPct, "56.2%");
  assert.equal(u!.probPct, "43.8%");
});
