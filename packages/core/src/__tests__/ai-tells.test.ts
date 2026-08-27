import { describe, it, expect } from "vitest";
import { analyzeAITells } from "../agents/ai-tells.js";

describe("analyzeAITells", () => {
  it("returns no issues for varied paragraph lengths", () => {
    const content = [
      "短段。",
      "",
      "这是一个中等长度的段落，包含一些描述性的内容，让这个段落稍微长一些。",
      "",
      "很长的段落。这个段落包含了大量的内容，描述了各种各样的场景和人物。角色们在这里进行了激烈的讨论，关于未来的计划和当前的困境。他们需要找到一种方式来解决眼前的问题。",
    ].join("\n");

    const result = analyzeAITells(content);
    const paraIssues = result.issues.filter((i) => i.category === "段落等长");
    expect(paraIssues).toHaveLength(0);
  });

  it("detects uniform paragraph lengths (dim 20)", () => {
    // Generate paragraphs of nearly identical length
    const para = "这是一个测试段落的内容，长度大约相同。";
    const content = [para, "", para, "", para, "", para].join("\n");

    const result = analyzeAITells(content);
    const paraIssues = result.issues.filter((i) => i.category === "段落等长");
    expect(paraIssues.length).toBeGreaterThan(0);
    expect(paraIssues[0]!.severity).toBe("warning");
  });

  it("detects high hedge word density (dim 21)", () => {
    const content = [
      "他似乎觉得这件事可能不太对劲。",
      "",
      "或许他应该大概去看看。似乎有什么东西在那里。",
      "",
      "可能是一种错觉，大概只是风声。某种程度上他也不太确定。",
    ].join("\n");

    const result = analyzeAITells(content);
    const hedgeIssues = result.issues.filter((i) => i.category === "套话密度");
    expect(hedgeIssues.length).toBeGreaterThan(0);
  });

  it("detects formulaic transition repetition (dim 22)", () => {
    const content = [
      "第一段内容。然而事情并不简单。",
      "",
      "第二段内容。然而他没有放弃。",
      "",
      "第三段内容。然而命运弄人。",
    ].join("\n");

    const result = analyzeAITells(content);
    const transIssues = result.issues.filter((i) => i.category === "公式化转折");
    expect(transIssues.length).toBeGreaterThan(0);
    expect(transIssues[0]!.description).toContain("然而");
  });

  it("detects list-like sentence structure (dim 23)", () => {
    const content = [
      "他看着远方的山峰。他看着脚下的深渊。他看着身旁的同伴。他看着手中的剑。",
    ].join("\n");

    const result = analyzeAITells(content);
    const listIssues = result.issues.filter((i) => i.category === "列表式结构");
    expect(listIssues.length).toBeGreaterThan(0);
    expect(listIssues[0]!.severity).toBe("info");
  });

  it("returns Korean labels and guidance for Korean transition and list patterns", () => {
    const content = [
      "하지만 그는 장부를 놓지 않았다. 하지만 그는 결재선을 다시 읽었다. 하지만 그는 팩스를 챙겼다.",
      "도경은 문을 열었다. 도경은 복도를 건넜다. 도경은 차에 올랐다.",
    ].join("\n");

    const result = analyzeAITells(content, "ko");

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: "접속어 반복",
        description: expect.stringContaining("같은 접속어"),
        suggestion: expect.stringContaining("행동"),
      }),
      expect.objectContaining({
        category: "나열식 문장 구조",
        description: expect.stringContaining("연속"),
        suggestion: expect.stringContaining("주어"),
      }),
    ]));
    expect(result.issues.flatMap((issue) => [issue.category, issue.description, issue.suggestion]).join(" "))
      .not.toMatch(/[\u4e00-\u9fff]/);
  });

  it("detects high-confidence Korean assistant-response residue", () => {
    const content = "요청하신 수정본입니다.\n\n남자는 계약서를 접어 주머니에 넣었다.";

    const result = analyzeAITells(content, "ko");

    expect(result.issues).toContainEqual(expect.objectContaining({
      severity: "warning",
      category: "응답문 잔재",
      suggestion: expect.stringContaining("국소적으로"),
    }));
  });

  it("detects manuscript-format residue without rejecting a single chapter title", () => {
    const cleanChapter = analyzeAITells([
      "# 1화 계약서",
      "",
      "- 잔금은 오늘 들어옵니까?",
      "",
      "- 계약서부터 보시죠.",
      "",
      "남자는 도장을 찍었다.",
    ].join("\n"), "ko");
    expect(cleanChapter.issues.some((issue) => issue.category === "원고 형식 잔재")).toBe(false);

    const contaminated = analyzeAITells([
      "# 수정 포인트",
      "1. 갈등을 강화했습니다.",
      "2. 대사를 정리했습니다.",
      "3. 후킹을 추가했습니다.",
      "## 수정 원고",
      "남자는 도장을 찍었다.",
    ].join("\n"), "ko");

    expect(contaminated.issues).toContainEqual(expect.objectContaining({
      severity: "warning",
      category: "원고 형식 잔재",
    }));
  });

  it("detects repeated interpretive closures but preserves a single necessary explanation", () => {
    const single = analyzeAITells("문제는 잔금이었다. 그는 통장을 내밀었다.", "ko");
    expect(single.issues.some((issue) => issue.category === "해설식 결론 반복")).toBe(false);

    const repeated = analyzeAITells([
      "문제는 잔금이었다.",
      "중요한 것은 소유권이었다.",
      "이는 그가 협상에서 이겼다는 뜻했다.",
      "분명한 것은 공장이 이제 그의 손에 있다는 점이었다.",
    ].join("\n"), "ko");

    expect(repeated.issues).toContainEqual(expect.objectContaining({
      severity: "warning",
      category: "해설식 결론 반복",
    }));
  });

  it("reports dense binary-contrast scaffolding as information, not a rewrite trigger", () => {
    const content = [
      "승부는 돈이 아니라 권리였다.",
      "필요한 건 약속이 아니라 계약이었다.",
      "그가 원한 것은 칭찬이 아니라 지분이었다.",
      "상대가 내민 것은 사과가 아니라 담보였다.",
      "마지막에 남은 건 체면이 아니라 현금이었다.",
    ].join(" ");

    const result = analyzeAITells(content, "ko");

    expect(result.issues).toContainEqual(expect.objectContaining({
      severity: "info",
      category: "대조 문장틀 반복",
    }));
  });

  it("does not flag a concrete Korean commercial-fiction beat", () => {
    const content = [
      "도경은 밀린 급여가 적힌 장부를 책상 위에 폈다.",
      "직원들의 시선이 통장 사본으로 몰렸다. 입금액은 삼억 이천이었다.",
      "문제는 소유권이 아니라 오늘 밤 멈출 압류 트럭이었다. 그는 공장 열쇠를 집어 들고 정문으로 걸어갔다.",
    ].join("\n\n");

    const result = analyzeAITells(content, "ko");
    const koreanFictionSignals = new Set(["응답문 잔재", "원고 형식 잔재", "해설식 결론 반복", "대조 문장틀 반복"]);

    expect(result.issues.filter((issue) => koreanFictionSignals.has(issue.category))).toHaveLength(0);
  });

  it("returns no issues for content with fewer than 3 paragraphs", () => {
    const content = "只有一段话。";
    const result = analyzeAITells(content);
    expect(result.issues).toHaveLength(0);
  });

  it("returns no issues for clean varied text", () => {
    const content = [
      "陈风一脚踩碎了脚下的石板。碎石飞溅，打在旁边的墙壁上发出清脆的声响。",
      "",
      "短暂的沉默。空气中弥漫着灰尘的味道，呛得他咳嗽了两声。远处传来脚步声。",
      "",
      "\"谁？\"他低喝一声，手已经按上了腰间的刀柄。指尖触到冰凉的金属，心跳稍微稳了一些。黑暗中，一双眼睛正盯着他。那目光冰冷得像冬夜的寒风，带着审视和一丝不易察觉的警惕。",
    ].join("\n");

    const result = analyzeAITells(content);
    // Should have no or few issues for natural-looking text
    const warningIssues = result.issues.filter((i) => i.severity === "warning");
    expect(warningIssues).toHaveLength(0);
  });
});
