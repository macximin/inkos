import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildFanficCanonSection,
  buildFanficModeInstructions,
} from "../agents/fanfic-prompt-sections.js";

const GENRE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../genres");

async function readGenre(id: string): Promise<string> {
  return readFile(join(GENRE_DIR, `${id}.md`), "utf-8");
}

describe("fun-first raw genre contracts", () => {
  it("keeps cozy downtime useful without turning hooks or visible shifts into scene quotas", async () => {
    const body = await readGenre("cozy");

    expect(body).toContain("plant a future hook only when it grows naturally from the scene");
    expect(body).toContain("earned rest");
    expect(body).not.toContain("Downtime scenes must still plant hooks");
    expect(body).not.toContain("Every quiet scene must shift something");
    expect(body).not.toContain("Each chapter advances an emotional arc or community bond");
  });

  it("treats xuanhuan feedback and scene function as diagnostics rather than fixed quotas", async () => {
    const body = await readGenre("xuanhuan");

    expect(body).toContain("把最近三章当作反馈诊断窗口，不是硬配额");
    expect(body).toContain("不按逐场清单验收");
    expect(body).not.toContain("三章内应有明确反馈");
    expect(body).not.toContain("每个场景至少推进一项");
    expect(body).not.toContain("第三轮必须切入新信息或新动作");
    expect(body).toContain("不是四项硬配额");
    expect(body).toContain("不为惩罚成功强塞寿命、体力、副作用或道德代价");
    expect(body).toContain("不强制补写限制或代价");
    expect(body).toContain("不为惩罚高效成长临时加衰减");
    expect(body).not.toContain("能力上限：必须设定");
    expect(body).not.toContain("金手指/能力系统必须有限制");
    expect(body).not.toContain("同质资源重复吞噬必须写明衰减");
  });

  it("keeps cross-genre cost and punishment causal rather than mandatory", async () => {
    const [otherKo, dungeonCore, englishPrompt, plannerPrompt, writerPrompt] = await Promise.all([
      readGenre("other-ko"),
      readGenre("dungeon-core"),
      readFile(join(dirname(fileURLToPath(import.meta.url)), "../agents/en-prompt-sections.ts"), "utf-8"),
      readFile(join(dirname(fileURLToPath(import.meta.url)), "../agents/planner-prompts.ts"), "utf-8"),
      readFile(join(dirname(fileURLToPath(import.meta.url)), "../agents/writer-prompts.ts"), "utf-8"),
    ]);

    expect(otherKo).toContain("실제 인과가 만들 때는 선택·저항·대가");
    expect(otherKo).toContain("장면마다 대가를 할당하거나");
    expect(otherKo).not.toContain("당장 치러야 할 대가를 장면마다");

    expect(dungeonCore).toContain("let them exploit that opening");
    expect(dungeonCore).toContain("Do not force punishment");
    expect(dungeonCore).not.toContain("adventurers must punish strategic failure");

    expect(englishPrompt).toContain("Do not invent a price merely to punish success");
    expect(englishPrompt).toContain("Do not manufacture moral punishment");
    expect(englishPrompt).not.toContain("Every power, ability, or advantage must have a cost");

    expect(plannerPrompt).toContain("Do not force a cost or growth beat without causal support");
    expect(plannerPrompt).toContain("没有因果依据时不强加代价或成长");
    expect(plannerPrompt).not.toContain("give concrete change and cost enough room to land");

    expect(writerPrompt).toContain("needs no invented cost or growth beat");
    expect(writerPrompt).toContain("也不凭空补代价或成长");
    expect(writerPrompt).toContain("when growth occurs, show its work, but do not require it");
  });

  it("removes fixed opening deadlines from isekai, system-apocalypse, and urban guidance", async () => {
    const [isekai, systemApocalypse, urban] = await Promise.all([
      readGenre("isekai"),
      readGenre("system-apocalypse"),
      readGenre("urban"),
    ]);

    expect(isekai).toContain("no fixed chapter deadline");
    expect(isekai).not.toMatch(/(?:By|after) chapter 3/);

    expect(systemApocalypse).toContain("not fixed chapter ranges");
    expect(systemApocalypse).not.toContain("in chapters 1-3");
    expect(systemApocalypse).not.toMatch(/(?:Early|Mid) \(ch \d+-\d+\)/);

    expect(urban).toContain("不设前五章固定截止线");
    expect(urban).toContain("不按固定数量凑背景");
    expect(urban).not.toContain("必须在前5章内");
    expect(urban).not.toContain("嵌入1-2个时代锚点");
  });

  it("keeps crime possible while grading shortcuts and side characters by causality", async () => {
    const [chaebol, urban, litrpg] = await Promise.all([
      readGenre("chaebol-modern-fantasy-ko"),
      readGenre("urban"),
      readGenre("litrpg"),
    ]);

    expect(chaebol).toContain("정본에서 실제로 필요한 자원·권한·인과 단계");
    expect(chaebol).toContain("전화 한 통에 끝나는 것은 허용");
    expect(chaebol).toContain("조연이 이미 가진 욕망·정보·능력을 이유 없이 버리고");
    expect(chaebol).not.toContain("법과 절차를 건너뛰는 해결");
    expect(chaebol).not.toContain("여성 인물을 혼인 카드나 성공 보상으로만");

    expect(urban).toContain("违法、灰色或越权操作可以发生");
    expect(urban).toContain("不强制补写道德代价");
    expect(urban).toContain("一通电话解决时不算问题");
    expect(urban).not.toContain("女性角色沦为花瓶或奖励");

    expect(litrpg).toContain("discard established goals, knowledge, or competence");
    expect(litrpg).not.toContain("Female characters reduced");
  });

  it("keeps hard-sf reasoning and CP interaction visible without per-chapter quotas", async () => {
    const sciFi = await readGenre("sci-fi");
    expect(sciFi).toContain("use recent chapters to diagnose");
    expect(sciFi).toContain("do not invent a limitation or side effect merely to punish an effective solution");
    expect(sciFi).toContain("instead of imposing a mandatory cost pattern");
    expect(sciFi).not.toContain("each chapter should advance understanding");
    expect(sciFi).not.toContain("every tech must have limitations");
    expect(sciFi).not.toContain("Every technology must have defined limitations and side effects");

    const cp = buildFanficCanonSection("## 角色档案\n", "cp");
    expect(cp).toContain("不把每章同场变成配额");
    expect(cp).not.toContain("配对双方每章必须有有效互动");

    const cpCheck = buildFanficModeInstructions("cp", []);
    expect(cpCheck).toContain("最近几章");
    expect(cpCheck).toContain("不要把本章同场或推进当成硬指标");
    expect(cpCheck).not.toContain("配对双方本章是否有有效互动？关系发展是否推进？");
  });

  it("keeps cultivation payoff causal without forced labor, cost, or breakthrough quotas", async () => {
    const body = await readGenre("cultivation");

    expect(body).toContain("effortless dominance is valid when it is the intended commercial fantasy");
    expect(body).toContain("Do not manufacture hardship merely to penalize an instant gain");
    expect(body).toContain("there is no fixed scene count per stage");
    expect(body).not.toContain("it must read like genuine labor");
    expect(body).not.toContain("each tier transition deserves a full dramatic scene");
    expect(body).not.toContain("Breakthrough scenes show struggle, transformation, and cost");
    expect(body).not.toContain("1-2 detailed breakthrough scenes per cultivation stage");
  });

  it("does not impose hardship or cost as a cross-genre progression tax", async () => {
    const [litrpg, apocalypse, progression, xianxia] = await Promise.all([
      readGenre("litrpg"),
      readGenre("system-apocalypse"),
      readGenre("progression"),
      readGenre("xianxia"),
    ]);

    expect(litrpg).toContain("a clean grant, inheritance, or starting advantage is valid");
    expect(litrpg).toContain("do not invent diminishing returns merely to tax a successful strategy");
    expect(litrpg).not.toContain("Skill unlocks must feel earned");
    expect(litrpg).not.toContain("Overpowered MC from the start");

    expect(apocalypse).toContain("rapid dominance is valid");
    expect(apocalypse).not.toContain("power fantasy must be earned through survival");

    expect(progression).toContain("a deliberately clean advantage are all valid");
    expect(progression).toContain("do not impose a fixed number of breakthrough scenes per tier");
    expect(progression).not.toContain("Internal struggle must escalate with power");
    expect(progression).not.toContain("Earned growth only");

    expect(xianxia).toContain("不强制追加寿元、因果或道德代价");
    expect(xianxia).toContain("不把四项当硬配额");
    expect(xianxia).not.toContain("境界突破必须有积累过程");
    expect(xianxia).not.toContain("附加代价：修炼/使用伴随代价");
  });

  it("keeps Chinese continuation and fanfic foundations free of fixed deadline and freshness quotas", async () => {
    const architectSource = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), "../agents/architect.ts"),
      "utf-8",
    );

    expect(architectSource).toContain("不要设置固定五章期限");
    expect(architectSource).toContain("不按新鲜度百分比凑数");
    expect(architectSource).not.toContain("5章内引爆");
    expect(architectSource).not.toContain("场景新鲜度 ≥ 50%");
  });
});
