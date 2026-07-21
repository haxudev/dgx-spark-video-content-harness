export const COMPLIANCE_POLICY = {
  version: "medium-sports-probability-v1",
  /** Persistent on-screen brand shown top-left for the whole video. */
  brand: "AI球赛观察",
  /** Single concise compliance hint shown top-right (merged from the old label + pill). */
  headerLabel: "本内容由AI生成，不作决策依据",
  footerText: "赛前概率观察 · 仅供体育内容讨论 · 不作结果承诺 · 理性看球",
  restrictedTerms: [
    "推荐",
    "建议",
    "下注",
    "投注",
    "体彩",
    "彩票",
    "足彩",
    "竞彩",
    "购彩",
    "赔率",
    "庄家",
    "抽水",
    "赔付率",
    "敞口",
    "本金",
    "单注",
    "串关",
    "盈利",
    "利润",
    "回报",
    "稳赚",
    "稳胆",
    "必中",
    "命中",
    "买",
    "购买",
    "押注",
    "押",
  ],
} as const;

export interface RestrictedComplianceHit {
  term: string;
  index: number;
}

export function findRestrictedComplianceTerms(text: string): RestrictedComplianceHit[] {
  const hits: RestrictedComplianceHit[] = [];
  const seen = new Set<string>();
  for (const term of COMPLIANCE_POLICY.restrictedTerms) {
    let from = 0;
    while (from < text.length) {
      const index = text.indexOf(term, from);
      if (index < 0) break;
      const key = `${term}@${index}`;
      if (!seen.has(key)) {
        hits.push({ term, index });
        seen.add(key);
      }
      from = index + term.length;
    }
  }
  return hits.sort((a, b) => a.index - b.index || a.term.localeCompare(b.term, "zh-CN"));
}

export function uniqueRestrictedTerms(text: string): string[] {
  return [...new Set(findRestrictedComplianceTerms(text).map(h => h.term))];
}

export function sanitizeRestrictedComplianceText(text: string): string {
  let out = text;
  const replacements: Array<[RegExp, string]> = [
    [/彩票|体彩|足彩|竞彩|购彩/g, "体育内容"],
    [/下注|投注|押注|押/g, "参与"],
    [/赔率/g, "概率数据"],
    [/庄家|抽水|赔付率/g, "市场安全边际"],
    [/margin|vig|juice/gi, "安全边际"],
    [/推荐|建议/g, "观察"],
    [/购买|买/g, "观看"],
    [/敞口|本金|单注|串关/g, "资金安排"],
    [/盈利|利润|回报|稳赚|稳胆|必中|命中/g, "结果表现"],
    // Position / capital action-guidance that can leak from source data into
    // visual card details (e.g. "越高越需要控制仓位") — strip the actionable framing.
    [/[，,]?\s*越高越需要控制仓位/g, "，数值越高越需警惕"],
    [/控制仓位|仓位控制|控制资金|资金管理/g, "保持谨慎"],
    [/仓位/g, "关注度"],
  ];
  for (const [pattern, replacement] of replacements) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
