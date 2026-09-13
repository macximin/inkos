import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChapterMemo } from "../models/input-governance.js";
import { BookConfigSchema } from "../models/book.js";
import { PlannerAgent } from "../agents/planner.js";
import { WriterAgent } from "../agents/writer.js";
import { readSceneDecision, projectSceneDecisionForWriter, recordSceneDecision } from "../planning/scene-decision.js";

const decision = `## 장면 선택 기록
독자 경험: 가족이 각자 받아들이는 보상의 차이
선택: B
근거: 수입보다 함께 살 시간이 지금의 욕망이다.
| 후보 | 행동 | 상대·환경의 제약 | 읽는 경험 | 감수할 것 |
| --- | --- | --- | --- | --- |
| A | 버린 선택지: 금괴를 전부 쌓는다 | 창고 부족 | 숫자 비교 | 시간을 쓰지 못한다 |
| B | 식탁에 가족의 자리를 마련한다 | 야간 근무를 바꿔야 한다 | 먼저 앉으라는 권유 | 휴일 수입을 포기한다 |
`;
const memo = (body = `## 현재 작업\n이번에 함께 먹는 저녁을 위해 사람마다 다른 조건을 확인한다.\n\n${decision}\n## 다음 기록\n변경하지 않는 항목`): ChapterMemo => ({ chapter: 4, goal: "함께 저녁 먹기", body, isGoldenOpening: false, threadRefs: [] });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function rootFixture() { const root = await mkdtemp(join(tmpdir(), "scene-decision-")); roots.push(root); await mkdir(join(root, "story")); return root; }
const client = { provider: "openai" as const, apiFormat: "chat" as const, stream: false, defaults: { temperature: 0.7, maxTokens: 2048, thinkingBudget: 0, extra: {} } };

describe("optional scene decisions", () => {
  it("keeps old memos exactly unchanged and ignores fenced examples", () => {
    const original = memo("## 현재 작업\n선택 기록 없이 휴식을 마무리한다.");
    expect(readSceneDecision(original).status).toBe("missing");
    expect(projectSceneDecisionForWriter(original)).toBe(original);
    expect(readSceneDecision(memo(`\`\`\`markdown\n${decision}\n\`\`\``)).status).toBe("missing");
  });
  it("retains alternatives in exact planning evidence but passes only the selected scene", () => {
    const original = memo(); const before = JSON.stringify(original);
    const record = readSceneDecision(original);
    expect(record).toMatchObject({ status: "recorded", memoSha256: sha(original.body), authority: "advisory-plan", modelCallsAdded: 0 });
    expect(record.decision?.options).toHaveLength(2);
    const projected = projectSceneDecisionForWriter(original);
    expect(projected.body).toContain("식탁에 가족의 자리를 마련한다");
    expect(projected.body).toContain("수입보다 함께 살 시간");
    expect(projected.body).toContain("실제로 벌어진 사건이 아닙니다");
    expect(projected.body).not.toContain("버린 선택지");
    expect(projected.body).toContain("## 다음 기록\n변경하지 않는 항목");
    expect(JSON.stringify(original)).toBe(before);
  });
  it.each([
    decision.replace("선택: B", "선택: C"),
    decision.replace("| A |", "| B |"),
    decision.replace("근거: 수입보다 함께 살 시간이 지금의 욕망이다.", "근거:"),
    `${decision}\n${decision}`,
  ])("does not turn malformed alternatives into writing instructions", (text) => {
    const original = memo(text);
    expect(readSceneDecision(original).status).toBe("invalid");
    expect(projectSceneDecisionForWriter(original).body).not.toContain("버린 선택지");
    expect(original.body).toBe(text);
  });
  it("allows one complete option and preserves escaped pipes", () => {
    const text = decision.split("\n").filter((line) => !line.startsWith("| A |")).join("\n").replace("식탁에", "식탁\\|거실에");
    const parsed = readSceneDecision(memo(text));
    expect(parsed.status).toBe("recorded");
    expect(parsed.decision?.options).toHaveLength(1);
    expect(parsed.decision?.options[0]?.action).toContain("식탁|거실");
  });
  it("records immutable receipts for exact memo versions and detects conflict", async () => {
    const root = await rootFixture(); const original = memo();
    const first = await recordSceneDecision(root, original);
    expect((await recordSceneDecision(root, original)).path).toBe(first.path);
    expect(JSON.parse(await readFile(first.path, "utf8")).memoSha256).toBe(sha(original.body));
    expect((await recordSceneDecision(root, memo(`${original.body}\n`))).path).not.toBe(first.path);
    await writeFile(first.path, "{}");
    await expect(recordSceneDecision(root, original)).rejects.toThrow("receipt conflict");
  });
  it("requests a decision in the existing Planner call without retrying optional invalid data", async () => {
    const root = await rootFixture();
    const agent = new PlannerAgent({ client, model: "test", projectRoot: root });
    const headers = ["현재 작업", "독자가 지금 기다리는 것", "이번 화에 지급할 것 / 감출 것", "일상/전환 장면의 기능", "핵심 선택 세 가지 점검", "화말에 반드시 바뀔 것", "이번 화 훅 장부"];
    const body = `## 회차 목표\n가족의 약속을 잡는다\n${headers.map((header) => `## ${header}\n가족이 저녁에 함께 모일 수 있도록 각자의 시간을 확인하고 조정한다.`).join("\n")}\n## 금지\n없음\n${decision.replace("선택: B", "선택: missing")}`;
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat").mockResolvedValue({ content: body, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
    const result = await agent.planChapterMemo({ storyDir: join(root, "story"), bookDir: root, chapterNumber: 4, isGoldenOpening: false, fallbackGoal: "가족", chapterSummariesRaw: "", language: "ko", sceneDecisionEnabled: true });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(readSceneDecision(result).status).toBe("invalid");
    expect((chat.mock.calls[0]![0] as Array<{content:string}>)[0]!.content).toContain("선택을 짧게 남기기");
  });
  it("filters duplicate composer memo context in the actual Writer call", async () => {
    const root = await rootFixture();
    const book = BookConfigSchema.parse({ id: "scene-book", title: "가족", platform: "other", genre: "other", language: "ko", status: "active", createdAt: "2026-09-12T00:00:00Z", updatedAt: "2026-09-12T00:00:00Z" });
    await writeFile(join(root, "book.json"), JSON.stringify(book));
    const agent = new WriterAgent({ client, model: "test", projectRoot: root });
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat").mockRejectedValue(new Error("captured"));
    const original = memo();
    await expect(agent.writeChapter({ book, bookDir: root, chapterNumber: 4, chapterMemo: original,
      contextPackage: { chapter: 4, selectedContext: [{ source: "runtime/chapter_memo", reason: "memo", excerpt: original.body }] },
      ruleStack: { layers: [], sections: { hard: [], soft: [], diagnostic: [] }, overrideEdges: [], activeOverrides: [] },
    })).rejects.toThrow("captured");
    expect(chat).toHaveBeenCalledTimes(1);
    const prompt = (chat.mock.calls[0]![0] as Array<{content:string}>).map((entry) => entry.content).join("\n");
    expect(prompt).toContain("식탁에 가족의 자리를 마련한다");
    expect(prompt).not.toContain("버린 선택지");
    expect(original.body).toContain("버린 선택지");
  });
});

it("finishes a valid plan when its optional decision receipt directory cannot be written", async () => {
  const root = await rootFixture();
  await mkdir(join(root, "story/runtime"), { recursive: true });
  await writeFile(join(root, "story/runtime/scene-decisions"), "preserved file");
  const book = BookConfigSchema.parse({ id: "scene-book", title: "가족", platform: "other", genre: "other", language: "ko", status: "active", createdAt: "2026-09-12T00:00:00Z", updatedAt: "2026-09-12T00:00:00Z" });
  const headers = ["현재 작업", "독자가 지금 기다리는 것", "이번 화에 지급할 것 / 감출 것", "일상/전환 장면의 기능", "핵심 선택 세 가지 점검", "화말에 반드시 바뀔 것", "이번 화 훅 장부"];
  const raw = `## 회차 목표\n함께 먹는 저녁\n${headers.map((header) => `## ${header}\n가족이 저녁에 함께 모일 수 있도록 각자의 시간을 확인하고 조정한다.`).join("\n")}\n## 금지\n없음\n${decision}`;
  const planner = new PlannerAgent({ client, model: "test", projectRoot: root });
  const chat = vi.spyOn(planner as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat").mockResolvedValue({ content: raw, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
  const result = await planner.planChapter({ book, bookDir: root, chapterNumber: 4 });
  expect(chat).toHaveBeenCalledTimes(1); expect(readSceneDecision(result.memo).status).toBe("recorded");
  expect(result.sceneDecisionReceiptPath).toBeUndefined();
  expect(await readFile(join(root, "story/runtime/scene-decisions"), "utf8")).toBe("preserved file");
});
