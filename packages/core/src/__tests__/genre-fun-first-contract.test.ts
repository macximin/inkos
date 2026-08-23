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

  it("keeps hard-sf reasoning and CP interaction visible without per-chapter quotas", async () => {
    const sciFi = await readGenre("sci-fi");
    expect(sciFi).toContain("use recent chapters to diagnose");
    expect(sciFi).not.toContain("each chapter should advance understanding");

    const cp = buildFanficCanonSection("## 角色档案\n", "cp");
    expect(cp).toContain("不把每章同场变成配额");
    expect(cp).not.toContain("配对双方每章必须有有效互动");

    const cpCheck = buildFanficModeInstructions("cp", []);
    expect(cpCheck).toContain("最近几章");
    expect(cpCheck).toContain("不要把本章同场或推进当成硬指标");
    expect(cpCheck).not.toContain("配对双方本章是否有有效互动？关系发展是否推进？");
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
