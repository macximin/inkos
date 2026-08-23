import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  composeCurrentArcProse,
  extractCollaboratorRows,
  extractOpponentRows,
  extractProtagonistRow,
  extractRelevantThreads,
  formatRecyclableHooks,
  formatRecentSummaries,
  readCharacterMatrix,
} from "../agents/planner-context.js";

// Real column layouts match the production truth-file schemas under story/.
// Keeping these literal samples in tests guards against the kind of
// off-by-one column bug that slipped past Phase 3 review.
const EMOTIONAL_ARCS_SAMPLE = `
| 角色 | 章节 | 情绪状态 | 触发事件 | 强度(1-10) | 弧线方向 |
|------|------|----------|----------|-------------|----------|
| 周谨川 | 36 | 紧绷 | 门前对峙 | 8 | 升级 |
| 周谨川 | 37 | 克制发热 | 逼对方亮身份 | 9 | 升级 |
| 周谨川 | 38 | 骤亮后阴冷 | 看见顾明诚收 | 10 | 顶点 |
`;

const CHARACTER_MATRIX_SAMPLE = `
| 角色 | 核心标签 | 反差细节 | 说话风格 | 性格底色 | 与主角关系 | 核心动机 | 当前目标 |
|------|----------|----------|----------|----------|------------|----------|----------|
| 周谨川 | 带伤守证者 | 起不来身却硬顶 | 短、硬 | 克制耐痛 | 主角本人 | 不让资料被收走 | 守现场 |
| 草帽男 | 止损执行节点 | 明对手却急坏 | 装熟翻脸 | 控场欲 | 敌对监视者 | 护住七号门 | 顶住门边 |
| 修锁老师傅 | 一线手艺证人 | 不抢话却硬护场 | 平、稳 | 老练 | 临时协力 | 看锁说锁 | 守住现场事实 |
`;

const PROSE_ROLE_CONTEXT_SAMPLE = `
---ROLE---
tier: major
name: 한도경
protagonist: true
---CONTENT---
## 핵심 태그
냉정한 현장형 경영자다.

## 관계망
윤서진과는 정보를 값으로 매기는 금융 동맹이다.

---ROLE---
tier: major
name: 한재욱
protagonist: false
---CONTENT---
## 핵심 태그
품위 있는 포식자다.

## 관계망
한도경의 적이지만 겉으로는 동생 대우를 한다.

---ROLE---
tier: major
name: 윤서진
protagonist: false
---CONTENT---
## 핵심 태그
정확한 야심가다.

## 관계망
한도경과는 서로의 허점을 아는 금융 동맹이다.

---ROLE---
tier: major
name: 이상호
protagonist: false
---CONTENT---
## 관계망
과거 한도경의 경쟁자였지만 현재는 한도경의 금융 동맹이다.

---ROLE---
tier: minor
name: 박성호
protagonist: false
---CONTENT---
## 주인공과의 관계
한재욱은 오랜 경쟁자다. 한도경에게는 현장 조력자다.

---ROLE---
tier: minor
name: 김정민
protagonist: false
---CONTENT---
## 핵심 태그
합리적이다. 전략적으로 움직이고 매력적인 제안을 고른다.
`;

const SUBPLOT_BOARD_SAMPLE = `
| S001 | 三担保排查 | 主角 | ch1 | ch38 | 0 | 推进 | 核心旧账线 | 1章 |
| S007 | 货款线 | 主角 | ch3 | ch4 | 34 | 暂挂 | 冻结 | 4-6章 |
`;

describe("composeCurrentArcProse reads chapter from emotional_arcs column 1", () => {
  it("filters rows by chapter from column index 1 (章节), not column 0 (角色)", () => {
    // Previously the function filtered where row[0] matched /^\d+$/.
    // Since row[0] is "周谨川" here, the old predicate produced zero matches
    // and "近期情感线" fell out of the composed prose entirely.
    const prose = composeCurrentArcProse(
      SUBPLOT_BOARD_SAMPLE,
      EMOTIONAL_ARCS_SAMPLE,
      39,
    );
    expect(prose).toContain("近期情感线");
    expect(prose).toContain("紧绷");
    expect(prose).toContain("克制发热");
    expect(prose).toContain("骤亮后阴冷");
  });

  it("excludes rows at or beyond the current chapter", () => {
    const prose = composeCurrentArcProse(
      SUBPLOT_BOARD_SAMPLE,
      EMOTIONAL_ARCS_SAMPLE,
      37,
    );
    expect(prose).toContain("紧绷");
    expect(prose).not.toContain("克制发热");
    expect(prose).not.toContain("骤亮后阴冷");
  });

  it("still composes active subplots when emotional arcs are empty", () => {
    const prose = composeCurrentArcProse(SUBPLOT_BOARD_SAMPLE, "", 39);
    expect(prose).toContain("活跃支线");
    expect(prose).toContain("S001");
    expect(prose).not.toContain("S007");
  });

  it("returns the empty-state sentinel only when nothing is extractable", () => {
    const prose = composeCurrentArcProse("", "", 1);
    expect(prose).toContain("暂无 arc 数据");
  });
});

describe("extractProtagonistRow", () => {
  it("matches the real convention '主角本人', not only the exact token '主角'", () => {
    const row = extractProtagonistRow(CHARACTER_MATRIX_SAMPLE);
    expect(row).toContain("周谨川");
    expect(row).toContain("主角本人");
  });

  it("falls back to the first data row when no protagonist marker is found", () => {
    const noMarker = `
| 角色 | 核心标签 | 与主角关系 |
|------|----------|------------|
| 李沉 | 重生者 | — |
| 王一 | 对手 | 敌对 |
`;
    const row = extractProtagonistRow(noMarker);
    expect(row).toContain("李沉");
  });

  it("returns the sentinel only when the matrix has zero data rows", () => {
    const empty = `
| 角色 | 核心标签 |
|------|----------|
`;
    const row = extractProtagonistRow(empty);
    expect(row).toContain("未找到主角行");
  });

  it("reads the protagonist's full modern prose role card", () => {
    const card = extractProtagonistRow(PROSE_ROLE_CONTEXT_SAMPLE, "ko");
    expect(card).toContain("### 한도경");
    expect(card).toContain("냉정한 현장형 경영자");
    expect(card).not.toContain("한재욱과는 서로 다른 승계 원리");
  });
});

describe("extractOpponentRows / extractCollaboratorRows", () => {
  it("picks opponents by 与主角关系 semantic keywords", () => {
    const rows = extractOpponentRows(CHARACTER_MATRIX_SAMPLE, 3);
    expect(rows).toContain("草帽男");
    expect(rows).not.toContain("周谨川");
  });

  it("picks collaborators by 与主角关系 semantic keywords", () => {
    const rows = extractCollaboratorRows(CHARACTER_MATRIX_SAMPLE, 3);
    expect(rows).toContain("修锁老师傅");
    expect(rows).not.toContain("草帽男");
  });

  it("classifies opponents and collaborators from modern Korean prose role cards", () => {
    const opponents = extractOpponentRows(PROSE_ROLE_CONTEXT_SAMPLE, 3, "ko");
    const collaborators = extractCollaboratorRows(PROSE_ROLE_CONTEXT_SAMPLE, 3, "ko");

    expect(opponents).toContain("한재욱 (major)");
    expect(opponents).not.toContain("한도경 (major)");
    expect(opponents).not.toContain("김정민 (minor)");
    expect(opponents).not.toContain("이상호 (major)");
    expect(opponents).not.toContain("박성호 (minor)");
    expect(collaborators).toContain("윤서진 (major)");
    expect(collaborators).toContain("이상호 (major)");
    expect(collaborators).toContain("박성호 (minor)");
    expect(collaborators).not.toContain("한도경 (major)");
    expect(opponents).not.toContain("핵심 태그");
    expect(collaborators).not.toContain("냉정한 현장형 경영자");
  });

  it("recognizes a unique Korean given-name shorthand in protagonist relations", () => {
    const shorthandRoles = `
---ROLE---
tier: major
name: 한도경
protagonist: true
---CONTENT---
## 관계망
가족과 거리를 둔다.

---ROLE---
tier: major
name: 한재욱
protagonist: false
---CONTENT---
## 관계망
도경과는 서로 다른 승계 원리를 대표하는 적이다.

---ROLE---
tier: major
name: 윤서진
protagonist: false
---CONTENT---
## 관계망
도경과는 서로의 허점을 아는 금융 동맹이다.

---ROLE---
tier: major
name: 서민재
protagonist: false
---CONTENT---
## 관계망
도경에게는 경영권을 요구하는 공동 전선이다.
`;
    expect(extractOpponentRows(shorthandRoles, 3, "ko")).toContain("한재욱 (major)");
    const collaborators = extractCollaboratorRows(shorthandRoles, 3, "ko");
    expect(collaborators).toContain("윤서진 (major)");
    expect(collaborators).toContain("서민재 (major)");
  });

  it("does not use a Korean given-name shorthand when another role shares it", () => {
    const ambiguousShorthandRoles = `
---ROLE---
tier: major
name: 한서진
protagonist: true
---CONTENT---
## 관계망
독립적으로 움직인다.

---ROLE---
tier: major
name: 윤서진
protagonist: false
---CONTENT---
## 관계망
중립이다.

---ROLE---
tier: major
name: 최민호
protagonist: false
---CONTENT---
## 관계망
서진과는 공개적인 적이다.
`;
    expect(extractOpponentRows(ambiguousShorthandRoles, 3, "ko")).not.toContain("최민호 (major)");
  });

  it("uses current, protagonist-scoped relation evidence without substring or negation false positives", () => {
    const multilingualRoles = `
---ROLE---
tier: major
name: Alex
protagonist: true
---CONTENT---
## Protagonist_Arc
Alex learns to choose.

---ROLE---
tier: major
name: Mara
protagonist: false
---CONTENT---
## Relationships
Alex isn't an enemy; currently a partner.

---ROLE---
tier: major
name: June
protagonist: false
---CONTENT---
## Relationships
After Alex arrived, June stays neutral. June and Alex usually disagree professionally. Alexandra's rival is Rowan.

---ROLE---
tier: major
name: Li
protagonist: false
---CONTENT---
## Relationship_to_Protagonist
主角并不敌对，目前是盟友。

---ROLE---
tier: major
name: Rowan
protagonist: false
---CONTENT---
## Relationships
June and Mara are rivals. Rowan remains neutral.

---ROLE---
tier: major
name: Doyoung
protagonist: false
---CONTENT---
## 주인공과의 관계
주인공과 적대하지 않는다. 주인공의 동맹이며 현재도 신뢰한다.

---ROLE---
tier: major
name: Taylor
protagonist: false
---CONTENT---
## Relationships
Alex used to be an enemy. She is now a partner.

---ROLE---
tier: major
name: Victor
protagonist: false
---CONTENT---
## Relationships
Victor is Alex's enemy.

---ROLE---
tier: major
name: RowanTwo
protagonist: false
---CONTENT---
## Relationships
Alex's enemy is Victor.

---ROLE---
tier: major
name: Morgan
protagonist: false
---CONTENT---
## Relationships
Alex was an enemy. Morgan is now neutral.

---ROLE---
tier: major
name: Casey
protagonist: false
---CONTENT---
## Relationships
Alex is not currently an enemy.

---ROLE---
tier: major
name: Blair
protagonist: false
---CONTENT---
## Relationships
Alex is not really an enemy.

---ROLE---
tier: major
name: Nova
protagonist: false
---CONTENT---
## Relationships
Nova is no ally of Alex.

---ROLE---
tier: major
name: Riley
protagonist: false
---CONTENT---
## Relationships
Alex was an enemy. Later she became a partner.
`;

    const opponents = extractOpponentRows(multilingualRoles, 20, "en");
    const collaborators = extractCollaboratorRows(multilingualRoles, 20, "en");

    expect(opponents).toContain("Victor (major)");
    expect(opponents).not.toContain("Mara (major)");
    expect(opponents).not.toContain("June (major)");
    expect(opponents).not.toContain("Rowan (major)");
    expect(opponents).not.toContain("RowanTwo (major)");
    expect(opponents).not.toContain("Morgan (major)");
    expect(opponents).not.toContain("Casey (major)");
    expect(opponents).not.toContain("Blair (major)");
    expect(opponents).not.toContain("Riley (major)");
    expect(opponents).not.toContain("Taylor (major)");
    expect(collaborators).toContain("Mara (major)");
    expect(collaborators).toContain("Li (major)");
    expect(collaborators).toContain("Doyoung (major)");
    expect(collaborators).toContain("Taylor (major)");
    expect(collaborators).toContain("Riley (major)");
    expect(collaborators).not.toContain("Nova (major)");
    expect(collaborators).not.toContain("June (major)");
    expect(collaborators).not.toContain("Rowan (major)");
  });

  it("recognizes natural Korean friend and recovery-target relations used by the canary", () => {
    const canaryRoles = `
---ROLE---
tier: major
name: 한서진
protagonist: true
---CONTENT---
## 관계망
사람들의 선택을 대신하지 않는다.

---ROLE---
tier: minor
name: 윤가을
protagonist: false
---CONTENT---
## 주인공과의 관계
서진의 오래된 친구로서 그가 도움을 청하지 않으려 할 때도 사람들의 말을 기록으로 모으게 한다.

---ROLE---
tier: minor
name: 회수국 단말
protagonist: false
---CONTENT---
## 주인공과의 관계
서진의 서점과 책갈피를 회수 대상으로 판정하며, 계약 증거가 확보되면 봉인될 수 있다.
`;
    expect(extractCollaboratorRows(canaryRoles, 3, "ko")).toContain("윤가을 (minor)");
    expect(extractOpponentRows(canaryRoles, 3, "ko")).toContain("회수국 단말 (minor)");
  });

  it("fails closed when several modern role cards have no reliable protagonist marker", () => {
    const ambiguousRoles = `
---ROLE---
tier: major
name: First
protagonist: false
---CONTENT---
## Relationships
Second is an enemy.

---ROLE---
tier: major
name: Second
protagonist: false
---CONTENT---
## Relationships
First is a rival.
`;
    expect(extractProtagonistRow(ambiguousRoles, "en")).toContain("could not be identified reliably");
    expect(extractOpponentRows(ambiguousRoles, 3, "en")).toContain("no clear opponent");
  });

  it("renders production roles/ files into planner-readable role blocks", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-planner-modern-roles-"));
    const roleDir = join(bookDir, "story", "roles", "major");
    await mkdir(roleDir, { recursive: true });
    try {
      await Promise.all([
        writeFile(join(roleDir, "한도경.md"), "## 주인공 변화선\n시작과 끝이 달라진다.\n\n## 관계망\n한재욱과는 적이다.\n", "utf-8"),
        writeFile(join(roleDir, "윤서진.md"), "## 관계망\n한도경과는 금융 동맹이다.\n", "utf-8"),
        writeFile(join(bookDir, "story", "book_rules.md"), "## 주인공\n- 이름: 한도경\n", "utf-8"),
      ]);

      const raw = await readCharacterMatrix(join(bookDir, "story"));
      expect(raw).toContain("name: 한도경");
      expect(raw).toContain("protagonist: true");
      expect(extractProtagonistRow(raw, "ko")).toContain("시작과 끝이 달라진다");
      expect(extractCollaboratorRows(raw, 3, "ko")).toContain("윤서진");
    } finally {
      await rm(bookDir, { recursive: true, force: true });
    }
  });

  it("matches configured protagonist names after the production filename sanitizer", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-planner-sanitized-role-"));
    const roleDir = join(bookDir, "story", "roles", "major");
    await mkdir(roleDir, { recursive: true });
    try {
      await Promise.all([
        writeFile(join(roleDir, "John _Red_ Smith.md"), "## Relationships\nMara is a partner.\n", "utf-8"),
        writeFile(join(roleDir, "Mara.md"), "## Relationships\nJohn _Red_ Smith is a partner.\n", "utf-8"),
        writeFile(join(bookDir, "story", "book_rules.md"), "## Protagonist\n- Name: John \"Red\" Smith\n", "utf-8"),
      ]);

      const raw = await readCharacterMatrix(join(bookDir, "story"));
      expect(raw).toMatch(/name: John _Red_ Smith\nprotagonist: true/);
    } finally {
      await rm(bookDir, { recursive: true, force: true });
    }
  });

  it("does not infer a protagonist from a generic arc heading shared by several major cards", async () => {
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-planner-ambiguous-roles-"));
    const roleDir = join(bookDir, "story", "roles", "major");
    await mkdir(roleDir, { recursive: true });
    try {
      await Promise.all([
        writeFile(join(roleDir, "A.md"), "## 처음과 끝\nA가 달라진다.\n", "utf-8"),
        writeFile(join(roleDir, "B.md"), "## 처음과 끝\nB가 달라진다.\n", "utf-8"),
        writeFile(join(bookDir, "story", "book_rules.md"), "## 주인공\n- 이름: 존재하지 않음\n", "utf-8"),
      ]);

      const raw = await readCharacterMatrix(join(bookDir, "story"));
      expect(raw).not.toContain("protagonist: true");
      expect(extractProtagonistRow(raw, "ko")).toContain("신뢰성 있게 식별하지 못함");
    } finally {
      await rm(bookDir, { recursive: true, force: true });
    }
  });
});

describe("extractRelevantThreads", () => {
  it("selects active hooks and subplots, filtering dormant/stale", () => {
    const hooks = `
| hook_id | 状态 | 最近推进 |
|---------|------|----------|
| H001 | activating | ch38 |
| H002 | dormant | ch20 |
| H003 | partial_payoff | ch37 |
| H004 | pressured | ch39 |
| H005 | near-payoff | ch39 |
| H006 | resolved | ch39 |
`;
    const subplots = `
| S001 | 主线追查 | 推进 |
| S007 | 旁线 | 暂挂 |
`;
    const threads = extractRelevantThreads(hooks, subplots);
    expect(threads).toContain("H001");
    expect(threads).toContain("H003");
    expect(threads).toContain("H004");
    expect(threads).toContain("H005");
    expect(threads).not.toContain("H002");
    expect(threads).not.toContain("H006");
    expect(threads).toContain("S001");
    expect(threads).not.toContain("S007");
  });
});

describe("formatRecyclableHooks", () => {
  it("frames overdue hooks as triage candidates and permits justified deferral", () => {
    const hooks = [{
      hookId: "H-old",
      startChapter: 1,
      type: "foreshadow",
      status: "near_payoff",
      lastAdvancedChapter: 2,
      expectedPayoff: "오래된 계약서",
      notes: "",
      coreHook: false,
    }];

    const ko = formatRecyclableHooks(hooks, 10, "ko");
    expect(ko).toContain("우선 검토 후보이지 장면 할당량이 아닙니다");
    expect(ko).toContain("이유와 다음 점검 시점을 적어 defer");
    expect(ko).toContain("H-old");

    const en = formatRecyclableHooks(hooks, 10, "en");
    expect(en).toContain("priority review candidates, not a scene quota");
    expect(en).toContain("reason plus next review point when deferring");
  });
});

describe("Korean planner context localization", () => {
  it("renders summary and Arc labels in Korean while keeping default Chinese compatibility", () => {
    const summaries = `
| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 첫 거래 | 한도경 | 어음 인수 | 지분 확보 | H001 진전 | 긴장 | 거래 |
`;
    const koreanSummaries = formatRecentSummaries(summaries, 2, 3, "ko");
    expect(koreanSummaries).toContain("| 회차 | 제목 | 등장인물 |");
    expect(koreanSummaries).not.toContain("| 章节 | 标题 | 出场人物 |");

    const koreanArc = composeCurrentArcProse(
      SUBPLOT_BOARD_SAMPLE,
      EMOTIONAL_ARCS_SAMPLE,
      39,
      "ko",
    );
    expect(koreanArc).toContain("활성 보조 줄기:");
    expect(koreanArc).toContain("최근 감정선:");
    expect(koreanArc).not.toContain("活跃支线：");
    expect(koreanArc).not.toContain("近期情感线：");

    expect(composeCurrentArcProse("", "", 1)).toContain("暂无 arc 数据");
  });
});
