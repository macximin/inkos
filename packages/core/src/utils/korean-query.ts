/** Conservative Korean query variants; this is lexical retrieval, not a parser. */
const STOP = new Set([
  "이번", "회차", "장면", "이야기", "주인공", "현재", "계속", "다음", "먼저", "다시",
  "중심", "중심으로", "초점", "초점을", "집중", "진행", "서술", "묘사", "작성", "기획",
  "한다", "했다", "된다", "되었다", "있다", "없다", "않는다", "않았다", "그리고", "하지만",
]);
const MEANINGFUL_SHORT = new Set(["돈", "빚", "땅", "집", "칼", "왕", "힘", "꿈"]);

export function extractKoreanQueryTerms(text: string): string[] {
  const tokens = text.normalize("NFKC")
    .replace(/(?:제\s*)?\d+\s*(?:화|회|장)/g, " ")
    .match(/[가-힣]+/g) ?? [];
  const result: string[] = [];
  const keep = (word: string) => {
    if ((word.length >= 2 || MEANINGFUL_SHORT.has(word)) && !STOP.has(word) && !result.includes(word)) result.push(word);
  };
  for (const token of tokens) {
    if (STOP.has(token)) continue;
    // Keep the original as well: a proper name can coincidentally end in a particle.
    const stem = token.replace(/(?:으로부터|에서부터|에게서|한테서|께서는|에서는|으로는|에게는|한테는|에서|에게|한테|께서|으로|부터|까지|처럼|보다|하고|과|와|을|를|은|는|이|가|의|도|만|로)$/, "");
    if (stem !== token) keep(stem);
    const action = token.replace(/(?:한다|했다|하는|하여|하며|하기|하게|하지)$/, "");
    if (action !== token) keep(action);
    keep(token);
  }
  return result;
}

/** Only explicitly labelled exclusions are removed; a character's refusal is a fact. */
export function stripKoreanQueryExclusions(text: string): string {
  return text.replace(/(?:^|\n)\s*(?:[-*]\s*)?(?:금지(?:사항)?|제외(?:할\s*전개)?|피할\s*것)\s*[:：][^\n]*/g, "\n");
}
