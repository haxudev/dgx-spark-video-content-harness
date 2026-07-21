import { test } from "node:test";
import { strict as assert } from "node:assert";
import { lineToSsml, estimateLineDuration, VOICE, SPEAKER_DISPLAY } from "../../src/tools/ssml.js";

test("SSML wraps text with voice + prosody + break tags", () => {
  const ssml = lineToSsml("今天有一场比赛，赛前有哪些变量？", "Anchor");
  assert.match(ssml, /<voice name="zh-CN-XiaoxiaoNeural">/);
  assert.match(ssml, /express-as style="chat"/);
  assert.match(ssml, /<break time="160ms"\/>/);
  assert.match(ssml, /<break time="280ms"\/>/);
  assert.match(ssml, /<\/speak>/);
});

test("XML special chars escaped (but <break> survives)", () => {
  const ssml = lineToSsml("A & B < C，到底能不能？", "Analyst");
  assert.match(ssml, /A &amp; B &lt; C/);
  assert.match(ssml, /<break time="160ms"\/>/);
});

test("estimateLineDuration scales with CJK char count", () => {
  const a = estimateLineDuration("一二三四五"); // 5 chars
  const b = estimateLineDuration("一二三四五六七八九十");  // 10 chars
  assert.ok(b > a, "longer text → longer duration");
  assert.ok(a > 0.5 && a < 2, `5-char duration ${a} reasonable`);
});

test("Analyst voice differs from Anchor", () => {
  const a = lineToSsml("测试", "Anchor");
  const b = lineToSsml("测试", "Analyst");
  assert.notEqual(a, b, "different speakers → different SSML");
  assert.match(b, /YunxiNeural/);
});

test("Azure neural voices default to Xiaoxiao and Yunxi", () => {
  assert.equal(VOICE.Anchor, "zh-CN-XiaoxiaoNeural");
  assert.equal(VOICE.Analyst, "zh-CN-YunxiNeural");
  assert.equal(SPEAKER_DISPLAY.Anchor, "小美");
  assert.equal(SPEAKER_DISPLAY.Analyst, "小帅");
});
