import { describe, expect, it } from "vitest";
import { extractPOVFromOutline, filterHooksByPOV, filterMatrixByPOV } from "../utils/pov-filter.js";

describe("chapter POV resolution", () => {
  it.each(["## 12화: 협상", "### 제12화 — 협상", "12회: 협상", "- 12장: 협상"])("recognizes Korean chapter heading %s", (heading) => {
    expect(extractPOVFromOutline(`${heading}\n### 장면 의도\n- **시점 인물:** 김지훈\n## 13화\n시점: 서준`, 12)).toBe("김지훈");
  });
  it("does not confuse chapter 2 with 12, prose references, or a nested heading", () => {
    const outline = "## 12화\n시점: 민수\n## 2화\n12화의 사건을 암시한다.\n### 대화\n시점: 서준\n## 3화\n시점: 지훈";
    expect(extractPOVFromOutline(outline, 2)).toBe("서준");
  });
  it.each([["## Chapter 4: Arrival\n- POV: John Smith", "John Smith"], ["## 第 4 章\n视角：林月", "林月"]])("retains existing language support", (outline, expected) => {
    expect(extractPOVFromOutline(outline, 4)).toBe(expected);
  });
  it("keeps a multi-POV chapter unfiltered rather than choosing the first character", () => {
    expect(extractPOVFromOutline("## 4화\n시점: 지훈\n### 장면 2\n시점: 서준", 4)).toBeNull();
    expect(extractPOVFromOutline("## 4화\nPOV: John Smith / Mary Jones", 4)).toBeNull();
    expect(extractPOVFromOutline("## 5화\n시점: 지훈", 4)).toBeNull();
  });
});

describe("POV information projection", () => {
  it("keeps the information boundary active through nested headings and ends it at a sibling section", () => {
    const input = "## 정보 경계\n### 계약 지식\n| 정보 | 인물 |\n| --- | --- |\n| 계약 금액 | 지훈 |\n| 지훈의 숨은 의도 | 서준 |\n### 가족 지식\n| 이름 | 알고 있는 것 |\n| --- | --- |\n| 지훈 | 형의 직장 |\n| 서준 | 형의 비자금 |\n## 관계\n| 서준 | 지훈의 친구 |";
    const output = filterMatrixByPOV(input, "지훈");
    expect(output).toContain("계약 금액");
    expect(output).toContain("형의 직장");
    expect(output).not.toContain("숨은 의도");
    expect(output).not.toContain("비자금");
    expect(output).toContain("| 서준 | 지훈의 친구 |");
    expect(output).toContain("정보 행 2개");
  });
  it("matches the character cell exactly even when another character's secret mentions the POV", () => {
    const input = "# 인물\n## 정보 경계\n| 인물 | 알고 있는 정보 |\n| --- | --- |\n| 지훈 | 계약의 조건 |\n| 김지훈 | 별개의 인물 |\n| 서준 | 지훈을 속일 계획 |\n## 관계\n| 지훈 | 서준의 형 |";
    const result = filterMatrixByPOV(input, "지훈");
    expect(result).toContain("계약의 조건");
    expect(result).not.toContain("별개의 인물");
    expect(result).not.toContain("속일 계획");
    expect(result).toContain("| 지훈 | 서준의 형 |");
    expect(result).toContain("| 인물 | 알고 있는 정보 |");
  });
  it("does not treat Known or Character inside a secret as a table header", () => {
    const input = "### Information Boundaries\n| Character | Known |\n| --- | --- |\n| John Smith | his appointment |\n| Mary | John Smith's Character and Known weakness |";
    const result = filterMatrixByPOV(input, "John Smith");
    expect(result).toContain("his appointment");
    expect(result).not.toContain("weakness");
  });
  it("preserves unrelated sections and handles no matching knowledge row", () => {
    const input = "### 信息边界\n| 角色 | 已知 |\n| --- | --- |\n| 张三 | 林月的秘密 |\n### 关系\n朋友";
    const result = filterMatrixByPOV(input, "林月");
    expect(result).not.toContain("林月的秘密");
    expect(result).toContain("### 关系\n朋友");
    expect(filterMatrixByPOV(input, "")).toBe(input);
  });
});

describe("POV hook projection", () => {
  const summaries = "| 회차 | 등장인물 | 사건 |\n| --- | --- | --- |\n| 1 | 지훈, 서준 | 계약 체결 |\n| 2 | 민수 | 지훈을 몰래 배신하기로 함 |\n| 3 | 김지훈 | 별개 인물의 사건 |";
  it("uses participants instead of mentions in the event and never restores hidden hooks", () => {
    const header = "# 복선\n| hook_id | start_chapter | notes |\n| --- | --- | --- |\n";
    const hooks = header + "| H01 | 1 | 계약의 빈틈 |\n| H02 | 2 | 지훈을 배신할 계획 |\n| H03 | 3 | 이름이 비슷한 다른 인물 |";
    const result = filterHooksByPOV(hooks, "지훈", summaries);
    expect(result).toContain("계약의 빈틈");
    expect(result).not.toContain("배신할 계획");
    expect(result).not.toContain("다른 인물");
    const onlySecret = header + "| H02 | 2 | 지훈을 배신할 계획 |";
    expect(filterHooksByPOV(onlySecret, "지훈", summaries)).not.toContain("배신할 계획");
  });
  it("prefers explicit knowledge, including an empty list and later communication", () => {
    const hooks = "| hook_id | start_chapter | known_by | notes |\n| --- | --- | --- | --- |\n| H1 | 1 | | not yet known |\n| H2 | 2 | 지훈 / 서준 | learned later |\n| H3 | 1 | 김지훈 | different person |";
    const result = filterHooksByPOV(hooks, "지훈", summaries);
    expect(result).toContain("learned later");
    expect(result).not.toContain("not yet known");
    expect(result).not.toContain("different person");
  });
  it("does not parse hook IDs or narrative numbers as source chapters", () => {
    const hooks = "| hook_id | notes |\n| --- | --- |\n| 1 | 지훈에 대한 비밀 |";
    expect(filterHooksByPOV(hooks, "지훈", summaries)).not.toContain("지훈에 대한 비밀");
    expect(filterHooksByPOV(hooks, "", summaries)).toBe(hooks);
  });
});
