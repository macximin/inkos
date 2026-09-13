import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorCraftConfigSchema, AuthorCraftPackSchema, type AuthorCraftPack } from "../models/author-craft.js";
import { BookConfigSchema } from "../models/book.js";
import { authorCraftPackPath, installAuthorCraftPack, loadAuthorCraftPack, resolveAuthorCraftContext, resolveAuthorCraftInputReceipt, selectAuthorCraftContext, recordAuthorCraftContext, availableAuthorCraftTokens, readAuthorCraftHistory } from "../reference/author-craft.js";
import { createProductionInputReceipt, runWithProductionInputBundle, sha256Bytes } from "../production/production-input.js";
import { WriterAgent } from "../agents/writer.js";
import { PlannerAgent } from "../agents/planner.js";
import { ReviserAgent } from "../agents/reviser.js";
import { configureBookAuthorCraft } from "../reference/author-craft-config.js";

function fixture(): AuthorCraftPack {
  return {
    schemaVersion: "author-craft-pack/v1", id: "craft-test", language: "ko", authority: "advisory",
    sources: [{ id: "s1", title: "독립적인 시험 사례", reference: "fixture", readingScope: "자동 입력 시험용 자체 작성 데이터", kind: "research-summary" }],
    cases: [
      { id: "dialogue", title: "상대의 거래 목적", stages: ["planning", "writing", "revision"], functions: ["dialogue"], triggers: ["협상", "거래", "대사"], observation: "같은 제안을 다른 이유로 수락할 수 있다.", method: "상대의 제약 때문에 바뀌는 행동을 쓴다.", preserve: ["명시된 장점과 사적 욕망을 남긴다."], counterexamples: ["모든 조연을 반대자로 바꾸지 않는다."], sourceIds: ["s1"] },
      { id: "interior", title: "결단을 위한 내면", stages: ["writing", "revision"], functions: ["interiority"], triggers: ["내면", "독백"], observation: "행동에 필요한 내면은 기능이 있다.", method: "위험을 알아도 행동하는 이유를 남긴다.", preserve: [], counterexamples: ["모든 행동 앞에 긴 해설을 붙이지 않는다."], sourceIds: ["s1"] },
      { id: "revision", title: "수정의 목적", stages: ["revision"], functions: ["revision"], triggers: ["수정", "퇴고"], observation: "어휘보다 원인이 먼저일 수 있다.", method: "문제 위치와 의도한 변화를 연결한다.", preserve: [], counterexamples: ["항상 고칠 필요는 없다."], sourceIds: ["s1"] },
    ],
  };
}

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "inkos-author-craft-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

async function install(pack = fixture()) {
  const source = join(root, "pack.json");
  await writeFile(source, JSON.stringify(pack));
  const receipt = await installAuthorCraftPack(root, source);
  return { receipt, config: AuthorCraftConfigSchema.parse({ packSha256: receipt.packSha256 }) };
}

describe("author craft input", () => {
  it("reads selection history without source text and reports damaged records without overwriting them", async () => {
    const { config } = await install();
    expect(await readAuthorCraftHistory(root)).toEqual([]);
    const context = selectAuthorCraftContext({ pack: fixture(), config, stage: "writing", query: "협상" });
    const path = await recordAuthorCraftContext(root, 2, context);
    await recordAuthorCraftContext(root, 3, context);
    const history = await readAuthorCraftHistory(root);
    expect(history.map((entry) => entry.chapterNumber)).toEqual([3, 2]);
    expect(history.every((entry) => entry.valid)).toBe(true);
    expect(history[0]).not.toHaveProperty("rendered");
    expect(history[0]!.receipt!.selectedCaseIds).toEqual(["dialogue"]);
    expect(await readAuthorCraftHistory(root, { stage: "revision" })).toEqual([]);
    const changed = JSON.parse(await readFile(path!, "utf8")); changed.rendered += "변경";
    const changedBytes = JSON.stringify(changed);
    await writeFile(path!, changedBytes);
    const damaged = await readAuthorCraftHistory(root, { chapterNumber: 2 });
    expect(damaged).toEqual([expect.objectContaining({ valid: false, error: expect.stringContaining("does not match") })]);
    expect(await readFile(path!, "utf8")).toBe(changedBytes);
    await expect(recordAuthorCraftContext(root, 4, { ...context, receipt: { ...context.receipt, characters: 0 } })).rejects.toThrow(/does not match/);
  });

  it("does not retrieve from explicit Korean exclusions or incidental English substrings", async () => {
    const { config } = await install();
    const excluded = selectAuthorCraftContext({ pack: fixture(), config, stage: "writing", query: "금지: 협상 거래\n주차장에 도착한다." });
    expect(excluded.receipt.selectedCaseIds).toEqual([]);
    const english = fixture(); english.language = "en";
    english.cases[0]!.triggers = ["trade"];
    english.cases[0]!.functions = ["negotiation"];
    expect(selectAuthorCraftContext({ pack: english, config, stage: "writing", query: "The trademark is visible." }).rendered).toBe("");
    expect(selectAuthorCraftContext({ pack: english, config, stage: "writing", query: "The trade fails." }).receipt.selectedCaseIds).toEqual(["dialogue"]);
  });
  it("reserves existing prompt/output space and omits whole cases when no token space remains", async () => {
    const { config } = await install();
    const normal = selectAuthorCraftContext({ pack: fixture(), config, stage: "writing", query: "협상" });
    const limited = selectAuthorCraftContext({ pack: fixture(), config, stage: "writing", query: "협상", maxContextTokens: normal.receipt.estimatedTokens - 1 });
    expect(limited.rendered).toBe("");
    expect(limited.receipt.selectedCaseIds).toEqual([]);
    expect(limited.receipt.omittedCaseIds).toEqual(["dialogue"]);
    expect(limited.receipt.estimatedTokens).toBe(0);
    expect(availableAuthorCraftTokens({ contextWindow: 100, outputTokens: 200, reservedText: "기존 입력" })).toBe(0);
    expect(availableAuthorCraftTokens({ outputTokens: 200, reservedText: "기존 입력" })).toBeUndefined();
    expect(() => selectAuthorCraftContext({ pack: fixture(), config, stage: "writing", query: "협상", maxContextTokens: -1 })).toThrow(/token budget/);
  });

  it.each([["en", "Selected craft references", "When not to apply"], ["zh", "已选写作参考", "不适用的情况"]] as const)("localizes %s advisory labels without translating evidence", async (language, heading, limitLabel) => {
    const { config } = await install();
    const result = selectAuthorCraftContext({ pack: { ...fixture(), language }, config, stage: "writing", query: "협상" });
    expect(result.rendered).toContain(heading);
    expect(result.rendered).toContain(limitLabel);
    expect(result.rendered).not.toContain("적용할 선택:");
    expect(result.rendered).toContain(fixture().cases[0]!.observation);
  });

  it("records query identity and selection reasons, including distinct inputs that choose the same case", async () => {
    const { config } = await install();
    const first = selectAuthorCraftContext({ pack: fixture(), config, stage: "writing", query: "협상" });
    const second = selectAuthorCraftContext({ pack: fixture(), config, stage: "writing", query: "거래" });
    expect(first.rendered).toBe(second.rendered);
    expect(first.receipt.querySha256).toBe(sha256Bytes("협상"));
    expect(first.receipt.selectionReasons).toEqual([{ caseId: "dialogue", score: 10, reason: "query-match" }]);
    const firstPath = await recordAuthorCraftContext(root, 1, first);
    expect(await recordAuthorCraftContext(root, 1, first)).toBe(firstPath);
    expect(await recordAuthorCraftContext(root, 1, second)).not.toBe(firstPath);
    expect(JSON.parse(await readFile(firstPath!, "utf8")).rendered).toBe(first.rendered);
  });

  it("selects a relevant complete case and keeps its limitation without requiring feedback", async () => {
    const { config } = await install();
    const result = await resolveAuthorCraftContext({ projectRoot: root, config, language: "ko", stage: "writing", query: "협상에서 거래 조건을 바꾼다" });
    expect(result?.receipt.selectedCaseIds).toEqual(["dialogue"]);
    expect(result?.rendered).toContain("모든 조연을 반대자로 바꾸지 않는다");
    expect(result?.rendered).toContain("필수 규칙·출력 승인으로 사용하지 않는다");
    expect(result?.receipt.renderedSha256).toBe(sha256Bytes(result!.rendered));
    expect(result?.receipt.sourceIds).toEqual(["s1"]);
  });
  it("leaves disabled and unrelated contexts empty rather than inserting the whole archive", async () => {
    expect(await resolveAuthorCraftContext({ projectRoot: root, language: "ko", stage: "writing", query: "협상" })).toBeNull();
    const { config } = await install();
    expect((await resolveAuthorCraftContext({ projectRoot: root, config, language: "ko", stage: "writing", query: "주차장 도착" }))?.rendered).toBe("");
    expect(selectAuthorCraftContext({ pack: fixture(), config: { ...config, caseIds: [] }, stage: "writing", query: "협상" }).rendered).toBe("");
  });
  it("respects stage, explicit selection, and whole-case budget", async () => {
    const { config } = await install();
    const pack = fixture();
    pack.cases[0]!.method = "길게 설명하는 자료. ".repeat(130);
    const result = selectAuthorCraftContext({ pack, config: { ...config, caseIds: ["dialogue", "interior", "revision"], maxCases: 1, maxCharacters: 800 }, stage: "writing", query: "협상 거래" });
    expect(result.receipt.selectedCaseIds).toEqual(["interior"]);
    expect(result.receipt.omittedCaseIds).toContain("dialogue");
    expect(result.rendered.length).toBeLessThanOrEqual(800);
    expect(result.rendered).toContain("모든 행동 앞에 긴 해설");
    expect(result.rendered).not.toContain("수정의 목적");
    expect(() => selectAuthorCraftContext({ pack, config: { ...config, caseIds: ["missing"] }, stage: "writing", query: "" })).toThrow("Unknown author craft case");
  });
  it("rejects duplicate identities, unbound sources, and authority claims", () => {
    const pack = fixture();
    expect(AuthorCraftPackSchema.safeParse({ ...pack, authority: "canon" }).success).toBe(false);
    expect(AuthorCraftPackSchema.safeParse({ ...pack, cases: [...pack.cases, pack.cases[0]] }).success).toBe(false);
    pack.cases[0]!.sourceIds = ["invented"];
    expect(AuthorCraftPackSchema.safeParse(pack).success).toBe(false);
  });
  it("imports idempotently, pins exact bytes, and refuses changed installed input", async () => {
    const { receipt, config } = await install();
    expect((await installAuthorCraftPack(root, join(root, "pack.json"))).packSha256).toBe(receipt.packSha256);
    await writeFile(authorCraftPackPath(root, receipt.packSha256), JSON.stringify({ ...fixture(), id: "changed" }));
    await expect(loadAuthorCraftPack(root, receipt.packSha256)).rejects.toThrow("SHA-256 mismatch");
    await expect(installAuthorCraftPack(root, join(root, "pack.json"))).rejects.toThrow("refusing replacement");
    await expect(resolveAuthorCraftContext({ projectRoot: root, config, language: "ko", stage: "writing", query: "협상" })).rejects.toThrow();
  });
  it("rejects language mismatch, invalid digest paths and malformed selected config", async () => {
    const { config } = await install();
    await expect(resolveAuthorCraftContext({ projectRoot: root, config, language: "en", stage: "writing", query: "trade" })).rejects.toThrow("language");
    expect(() => authorCraftPackPath(root, "../../book.json")).toThrow();
    expect(AuthorCraftConfigSchema.safeParse({ ...config, caseIds: ["dialogue", "dialogue"] }).success).toBe(false);
  });
  it("binds configuration and pack identity at production admission", async () => {
    const { config } = await install();
    const authorCraft = await resolveAuthorCraftInputReceipt(root, config, "ko");
    const receipt = createProductionInputReceipt({ schemaVersion: "production-input-receipt/v1", soul: null, skills: [], authorCraft, externalContextSha256: sha256Bytes(""), promptInjectionSha256: sha256Bytes("") });
    const bundle = { bookId: "book", commandId: "test", productionOperationId: "test", attemptId: "test", promptInjection: "", externalContextText: "", receipt };
    await runWithProductionInputBundle(bundle, async () => {
      expect((await resolveAuthorCraftContext({ projectRoot: root, bookId: "book", config, language: "ko", stage: "writing", query: "협상" }))?.receipt.selectedCaseIds).toEqual(["dialogue"]);
      await expect(resolveAuthorCraftContext({ projectRoot: root, bookId: "book", config: { ...config, maxCases: 1 }, language: "ko", stage: "writing", query: "협상" })).rejects.toThrow("after production admission");
      await expect(resolveAuthorCraftContext({ projectRoot: root, bookId: "book", language: "ko", stage: "writing", query: "협상" })).rejects.toThrow("disappeared");
      await expect(resolveAuthorCraftContext({ projectRoot: root, bookId: "other", config, language: "ko", stage: "writing", query: "협상" })).rejects.toThrow("different production Book");
    });
  });
});

describe("Book craft selection", () => {
  async function configuredBook() {
    const { config } = await install();
    const bookDir = join(root, "books", "book");
    await mkdir(join(bookDir, "story"), { recursive: true });
    const book = { ...BookConfigSchema.parse({ id: "book", title: "기존 작품", platform: "other", genre: "other", language: "ko", status: "active", createdAt: "2026-09-12T00:00:00Z", updatedAt: "2026-09-12T00:00:00Z", writing: { reviewMode: "manual" } }), ownerExtension: { keep: true } };
    await writeFile(join(bookDir, "book.json"), JSON.stringify(book));
    await writeFile(join(bookDir, "story", "current_state.md"), "이미 확정된 사건");
    return { config, bookDir, book };
  }
  it("enables and disables only advisory selection and preserves existing settings and canon", async () => {
    const { config, bookDir } = await configuredBook();
    expect(await configureBookAuthorCraft(root, "book", config)).toMatchObject({ enabled: true, changed: true });
    const enabledText = await readFile(join(bookDir, "book.json"), "utf8");
    const enabled = JSON.parse(enabledText);
    expect(enabled.writing).toMatchObject({ reviewMode: "manual", authorCraft: config });
    expect(enabled.ownerExtension).toEqual({ keep: true });
    expect(await configureBookAuthorCraft(root, "book", config)).toMatchObject({ changed: false });
    expect(await readFile(join(bookDir, "book.json"), "utf8")).toBe(enabledText);
    expect(await configureBookAuthorCraft(root, "book", undefined)).toMatchObject({ enabled: false, changed: true });
    const disabled = JSON.parse(await readFile(join(bookDir, "book.json"), "utf8"));
    expect(disabled.writing).toEqual({ reviewMode: "manual" });
    expect(disabled.ownerExtension).toEqual({ keep: true });
    expect(await readFile(join(bookDir, "story", "current_state.md"), "utf8")).toBe("이미 확정된 사건");
    expect(await loadAuthorCraftPack(root, config.packSha256)).toEqual(fixture());
  });
  it("rejects unavailable packs and unknown cases before writing the Book", async () => {
    const { config, bookDir } = await configuredBook();
    const before = await readFile(join(bookDir, "book.json"), "utf8");
    await expect(configureBookAuthorCraft(root, "book", { ...config, caseIds: ["missing"] })).rejects.toThrow("Unknown author craft case");
    await expect(configureBookAuthorCraft(root, "book", { ...config, packSha256: "0".repeat(64) })).rejects.toThrow();
    expect(await readFile(join(bookDir, "book.json"), "utf8")).toBe(before);
    // A failed selection must release the writer lock, allowing a valid retry.
    expect(await configureBookAuthorCraft(root, "book", config)).toMatchObject({ enabled: true });
  });
});

describe("existing agent call paths", () => {
  async function bookFixture() {
    const { config } = await install();
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "story"), { recursive: true });
    const book = BookConfigSchema.parse({ id: "book", title: "협상", platform: "other", genre: "other", language: "ko", status: "active", createdAt: "2026-09-12T00:00:00Z", updatedAt: "2026-09-12T00:00:00Z", writing: { authorCraft: config } });
    await writeFile(join(bookDir, "book.json"), JSON.stringify(book));
    await writeFile(join(bookDir, "story", "volume_outline.md"), "# 개요\n## 4화\n협상에서 조건을 바꾼다.\n");
    await writeFile(join(bookDir, "story", "current_state.md"), "# 현재 상태\n계약은 아직 체결되지 않았다.\n");
    await writeFile(join(bookDir, "story", "chapter_summaries.md"), "# 요약\n");
    const ctx = { projectRoot: root, model: "test-model", client: { provider: "openai" as const, apiFormat: "chat" as const, stream: false, defaults: { temperature: 0.7, maxTokens: 2048, thinkingBudget: 0, extra: {} } } };
    return { book, bookDir, ctx };
  }
  it.each(["writer", "planner", "reviser"] as const)("%s leaves no craft text in a model request with exhausted context space", async (kind) => {
    const { book, bookDir, ctx } = await bookFixture();
    Object.defineProperty(ctx.client, "_piModel", { value: { contextWindow: 64 } });
    const agent = kind === "writer" ? new WriterAgent(ctx) : kind === "planner" ? new PlannerAgent(ctx) : new ReviserAgent(ctx);
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat").mockRejectedValue(new Error("captured-before-provider"));
    const operation = agent instanceof WriterAgent
      ? agent.writeChapter({ book, bookDir, chapterNumber: 4, chapterMemo: { chapter: 4, goal: "협상", isGoldenOpening: false, body: "거래", threadRefs: [] }, contextPackage: { chapter: 4, selectedContext: [] }, ruleStack: { layers: [], sections: { hard: [], soft: [], diagnostic: [] }, overrideEdges: [], activeOverrides: [] } })
      : agent instanceof PlannerAgent
        ? agent.planChapter({ book, bookDir, chapterNumber: 4, externalContext: "협상 거래" })
        : agent.reviseChapter(bookDir, "거래를 마쳤다.", 4, [], "polish", "other", { revisionInstruction: "협상 의도를 드러낸다" });
    await expect(operation).rejects.toThrow("captured-before-provider");
    expect(chat).toHaveBeenCalledTimes(1);
    const messages = chat.mock.calls[0]![0] as Array<{ content: string }>;
    expect(messages.map((message) => message.content).join("\n")).not.toContain("상대의 제약 때문에 바뀌는 행동을 쓴다");
    const [receiptFile] = await readdir(join(bookDir, "story", "runtime", "author-craft"));
    const stored = JSON.parse(await readFile(join(bookDir, "story", "runtime", "author-craft", receiptFile!), "utf8"));
    expect(stored.receipt.selectedCaseIds).toEqual([]);
    expect(stored.receipt.tokenBudget).toBe(0);
  });
  it.each(["writer", "planner", "reviser"] as const)("delivers only stage-selected advisory material to %s without an extra model call", async (kind) => {
    const { book, bookDir, ctx } = await bookFixture();
    const originalBook = await readFile(join(bookDir, "book.json"), "utf8");
    const originalState = await readFile(join(bookDir, "story", "current_state.md"), "utf8");
    const agent = kind === "writer" ? new WriterAgent(ctx) : kind === "planner" ? new PlannerAgent(ctx) : new ReviserAgent(ctx);
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat").mockRejectedValue(new Error("captured-before-provider"));
    const operation = agent instanceof WriterAgent
      ? agent.writeChapter({ book, bookDir, chapterNumber: 4, chapterMemo: { chapter: 4, goal: "협상 조건 변경", isGoldenOpening: false, body: "상대가 거래를 거절한다.", threadRefs: [] }, contextPackage: { chapter: 4, selectedContext: [] }, ruleStack: { layers: [], sections: { hard: [], soft: [], diagnostic: [] }, overrideEdges: [], activeOverrides: [] } })
      : agent instanceof PlannerAgent
        ? agent.planChapter({ book, bookDir, chapterNumber: 4, externalContext: "협상 조건 변경" })
        : agent.reviseChapter(bookDir, "거래 조건을 물었다.", 4, [], "polish", "other", { revisionInstruction: "협상 대사의 의도를 명확히 수정" });
    await expect(operation).rejects.toThrow("captured-before-provider");
    expect(chat).toHaveBeenCalledTimes(1);
    const messages = chat.mock.calls[0]![0] as Array<{ role: string; content: string }>;
    expect(messages.find((message) => message.role === "user")!.content).toContain("상대의 제약 때문에 바뀌는 행동");
    expect(messages.find((message) => message.role === "system")!.content).not.toContain("상대의 제약 때문에 바뀌는 행동");
    const receipts = await readdir(join(bookDir, "story", "runtime", "author-craft"));
    expect(receipts).toHaveLength(1);
    expect(await readFile(join(bookDir, "book.json"), "utf8")).toBe(originalBook);
    expect(await readFile(join(bookDir, "story", "current_state.md"), "utf8")).toBe(originalState);
  });
});
