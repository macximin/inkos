import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeGovernedChapter, type CompressibleContextCompileRequest } from "../agents/composer.js";
import { PlannerAgent, type PlanChapterOutput } from "../agents/planner.js";
import { WriterAgent, type WriteChapterOutput } from "../agents/writer.js";
import * as llmProvider from "../llm/provider.js";
import type { LLMClient } from "../llm/provider.js";
import type { BookConfig } from "../models/book.js";
import { RuntimeStateDeltaSchema } from "../models/runtime-state.js";
import { runChapterPersistenceTransaction } from "../pipeline/chapter-persistence.js";
import { buildStateDegradedPersistenceOutput } from "../pipeline/chapter-state-recovery.js";
import { StateManager } from "../state/manager.js";
import { ENTITY_OBSERVATION_CONTEXT_SOURCE, readEntityObservationContext } from "../state/entity-observations.js";
import { loadRuntimeStateSnapshot } from "../state/runtime-state-store.js";
import { buildLengthSpec } from "../utils/length-metrics.js";

const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
const CLIENT: LLMClient = {
  provider: "openai",
  apiFormat: "chat",
  stream: false,
  defaults: { temperature: 0.7, maxTokens: 2048, thinkingBudget: 0, maxTokensCap: null, extra: {} },
};
const PERSON_EVIDENCE = "Harbor introduced herself as the courier.";
const COMPANY_EVIDENCE = "Harbor was the shipping company handling the order.";
const FIRST_BODY = `${PERSON_EVIDENCE}\n\n${COMPANY_EVIDENCE}`;
const ROLE_CARD = "## Identity\nMin Seo owns the shop. Her past career is undisclosed.\n";
const roots: string[] = [];

function observations() {
  return [
    { kind: "person" as const, name: "Harbor", evidence: PERSON_EVIDENCE },
    { kind: "organization" as const, name: "Harbor", evidence: COMPANY_EVIDENCE },
  ];
}

function output(content = FIRST_BODY): WriteChapterOutput {
  return {
    chapterNumber: 1,
    title: "The Order",
    content,
    wordCount: content.split(/\s+/u).length,
    preWriteCheck: "",
    postSettlement: "",
    updatedState: "",
    updatedLedger: "",
    updatedHooks: "",
    chapterSummary: "",
    updatedSubplots: "",
    updatedEmotionalArcs: "",
    updatedCharacterMatrix: "",
    postWriteErrors: [],
    postWriteWarnings: [],
    tokenUsage: ZERO_USAGE,
    runtimeStateDelta: RuntimeStateDeltaSchema.parse({ chapter: 1, entityObservations: observations() }),
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inkos-entity-observations-"));
  roots.push(root);
  const manager = new StateManager(root);
  const book: BookConfig = {
    id: "entity-book", title: "Entity Book", platform: "other", genre: "other",
    status: "active", language: "en", targetChapters: 20, chapterWordCount: 1200,
    createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z",
  };
  await manager.saveBookConfig(book.id, book);
  const bookDir = manager.bookDir(book.id);
  const storyDir = join(bookDir, "story");
  const stateDir = join(storyDir, "state");
  const rolePath = join(storyDir, "roles", "major", "Min Seo.md");
  await Promise.all([
    mkdir(stateDir, { recursive: true }),
    mkdir(join(storyDir, "roles", "major"), { recursive: true }),
    mkdir(join(bookDir, "chapters"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(rolePath, ROLE_CARD),
    writeFile(join(storyDir, "story_bible.md"), "# Story\nMin Seo owns a small shop.\n"),
    writeFile(join(storyDir, "volume_outline.md"), "# Outline\n## Chapter 2\nMin Seo checks the order.\n"),
    writeFile(join(storyDir, "style_guide.md"), "# Style\nUse concrete actions.\n"),
    writeFile(join(storyDir, "current_state.md"), "# Current State\n\n| Field | Value |\n| --- | --- |\n| Current Chapter | 0 |\n"),
    writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n"),
    writeFile(join(storyDir, "chapter_summaries.md"), "# Chapter Summaries\n"),
    writeFile(join(bookDir, "chapters", "index.json"), "[]"),
    writeFile(join(stateDir, "manifest.json"), JSON.stringify({ schemaVersion: 2, language: "en", lastAppliedChapter: 0, projectionVersion: 1, migrationWarnings: [] })),
    writeFile(join(stateDir, "current_state.json"), JSON.stringify({ chapter: 0, facts: [] })),
    writeFile(join(stateDir, "hooks.json"), JSON.stringify({ hooks: [] })),
    writeFile(join(stateDir, "chapter_summaries.json"), JSON.stringify({ rows: [] })),
  ]);
  const writer = new WriterAgent({ client: CLIENT, model: "test-model", projectRoot: root });
  const statePath = join(stateDir, "current_state.json");
  return { root, manager, book, bookDir, storyDir, rolePath, statePath, writer };
}

function mockWriterCalls() {
  return vi.spyOn(WriterAgent.prototype as never, "chat" as never)
    .mockResolvedValueOnce({
      content: "=== CHAPTER_TITLE ===\nThe Next Order\n=== CHAPTER_CONTENT ===\nMin Seo counts the sealed boxes.\n=== PRE_WRITE_CHECK ===\n- checked",
      usage: ZERO_USAGE,
    })
    .mockResolvedValueOnce({ content: "=== OBSERVATIONS ===\n- The boxes are counted.", usage: ZERO_USAGE })
    .mockResolvedValueOnce({
      content: `=== POST_SETTLEMENT ===\n- settled\n=== RUNTIME_STATE_DELTA ===\n${JSON.stringify({ chapter: 2, entityObservations: [] })}`,
      usage: ZERO_USAGE,
    });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("entity observation persistence and consumer boundaries", () => {
  it.each(["legacy", "v2"] as const)("feeds saved observations into the next %s Writer call despite existing role cards", async (mode) => {
    const f = await fixture();
    await f.writer.saveChapter(f.bookDir, output(), false, "en");
    const current = JSON.parse(await readFile(f.statePath, "utf-8"));
    expect(current.entityObservations).toEqual(expect.arrayContaining(observations().map((item) => expect.objectContaining({
      ...item, sourceChapter: 1, chapterTextHash: createHash("sha256").update(FIRST_BODY).digest("hex"),
    }))));
    expect(current.entityObservations).toHaveLength(2);

    // Isolate the registered-memory path: an adjacent chapter excerpt must not
    // accidentally satisfy these assertions when the new reader is disconnected.
    vi.spyOn(WriterAgent.prototype as never, "loadRecentChapters" as never).mockResolvedValue("");
    const chat = mockWriterCalls();
    await f.writer.writeChapter({
      book: f.book, bookDir: f.bookDir, chapterNumber: 2,
      lengthSpec: buildLengthSpec(1200, "en"),
      ...(mode === "v2" ? {
        chapterMemo: { chapter: 2, goal: "Check the order.", isGoldenOpening: false, body: "", threadRefs: [] },
        contextPackage: { chapter: 2, selectedContext: [] },
        ruleStack: { layers: [{ id: "L4", name: "current_task", precedence: 70, scope: "local" as const }], sections: { hard: [], soft: [], diagnostic: [] }, overrideEdges: [], activeOverrides: [] },
      } : {}),
    });
    const messages = chat.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }>;
    const creativeInput = messages.map((message) => message.content).join("\n");
    expect(creativeInput).toContain(PERSON_EVIDENCE);
    expect(creativeInput).toContain(COMPANY_EVIDENCE);
    expect(await readFile(f.rolePath, "utf-8")).toBe(ROLE_CARD);
  });

  it("feeds saved observations into a real Planner model request with existing role cards", async () => {
    const f = await fixture();
    await f.writer.saveChapter(f.bookDir, output(), false, "en");
    const chat = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: "# Chapter 2 memo\n\n## Chapter Goal\nCheck the order.\n\n## Current Task\nCount the boxes and compare the order.\n\n## Ending Change\nThe correct shipment is identified.",
      usage: ZERO_USAGE,
    } as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);
    const planner = new PlannerAgent({ client: CLIENT, model: "test-model", projectRoot: f.root, bookId: f.book.id });
    await planner.planChapter({ book: f.book, bookDir: f.bookDir, chapterNumber: 2 });
    const messages = chat.mock.calls[0]?.[2] as ReadonlyArray<{ content: string }>;
    const input = messages.map((message) => message.content).join("\n");
    expect(input).toContain(PERSON_EVIDENCE);
    expect(input).toContain(COMPANY_EVIDENCE);
    expect(await readFile(f.rolePath, "utf-8")).toBe(ROLE_CARD);
  });

  it.each(["normal", "character-limited", "token-limited"] as const)("refreshes stale and future cached entity evidence within its %s slot and records the actual creative input", async (slot) => {
    const f = await fixture();
    const cjkEvidence = `林舟说：${"货物已经送达。".repeat(30)}`;
    const saved = slot === "token-limited" ? {
      ...output(cjkEvidence),
      runtimeStateDelta: RuntimeStateDeltaSchema.parse({
        chapter: 1, entityObservations: [{ kind: "person", name: "林舟", evidence: cjkEvidence }],
      }),
    } : output();
    await f.writer.saveChapter(f.bookDir, saved, false, "en");
    const futureEvidence = "Future Merger became the logistics director.";
    await f.writer.saveChapter(f.bookDir, {
      ...output(futureEvidence), chapterNumber: 2,
      runtimeStateDelta: RuntimeStateDeltaSchema.parse({
        chapter: 2, entityObservations: [{ kind: "person", name: "Future Merger", evidence: futureEvidence }],
      }),
    }, false, "en");

    const cachedExcerpt = "Discarded Founder was the owner. Future Merger was the director."
      .padEnd(slot === "normal" ? 1600 : slot === "token-limited" ? 700 : 80, "x");
    const fresh = await readEntityObservationContext(f.bookDir, { throughChapter: 1, language: "en" });
    if (slot === "token-limited") {
      // An ASCII slot can fit the new quotation by characters but not tokens.
      // This makes the token boundary independently observable.
      expect(fresh.length).toBeLessThan(cachedExcerpt.length);
      expect(llmProvider.estimateTextTokens(fresh)).toBeGreaterThan(llmProvider.estimateTextTokens(cachedExcerpt));
    }
    const before = await readFile(f.statePath, "utf-8");
    vi.spyOn(WriterAgent.prototype as never, "loadRecentChapters" as never).mockResolvedValue("");
    const chat = vi.spyOn(WriterAgent.prototype as never, "chat" as never)
      .mockRejectedValueOnce(new Error("stop after capturing refreshed input"));
    await expect(f.writer.writeChapter({
      book: f.book, bookDir: f.bookDir, chapterNumber: 2,
      chapterMemo: { chapter: 2, goal: "Check the order.", isGoldenOpening: false, body: "", threadRefs: [] },
      contextPackage: { chapter: 2, selectedContext: [
        { source: "story/setting.md", reason: "The current location.", excerpt: "The shop opens at dawn." },
        { source: ENTITY_OBSERVATION_CONTEXT_SOURCE, reason: "Prior named entities.", excerpt: cachedExcerpt },
      ] },
      ruleStack: { layers: [{ id: "L4", name: "current_task", precedence: 70, scope: "local" }], sections: { hard: [], soft: [], diagnostic: [] }, overrideEdges: [], activeOverrides: [] },
      lengthSpec: buildLengthSpec(1200, "en"),
    })).rejects.toThrow("stop after capturing refreshed input");
    const messages = chat.mock.calls[0]?.[0] as ReadonlyArray<{ role: string; content: string }>;
    const creativeInput = messages.map((message) => message.content).join("\n");
    const creativeUserInput = messages.find((message) => message.role === "user")!.content;
    const receipt = JSON.parse(await readFile(join(f.storyDir, "runtime", "chapter-0002.entity-context.json"), "utf-8"));
    expect(receipt).toMatchObject({ chapter: 2, throughChapter: 1, source: ENTITY_OBSERVATION_CONTEXT_SOURCE });
    expect(receipt.excerpt.length).toBeLessThanOrEqual(cachedExcerpt.length);
    expect(receipt.estimatedTokens).toBe(llmProvider.estimateTextTokens(receipt.excerpt));
    expect(receipt.estimatedTokens).toBeLessThanOrEqual(llmProvider.estimateTextTokens(cachedExcerpt));
    expect(creativeInput).not.toContain("Discarded Founder");
    expect(creativeInput).not.toContain("Future Merger");
    expect(creativeUserInput).toContain("The shop opens at dawn.");
    if (slot === "normal") {
      expect(receipt.excerpt).toBe(fresh);
      expect(receipt.excerpt).toContain(PERSON_EVIDENCE);
      expect(receipt.excerpt).toContain(COMPANY_EVIDENCE);
      expect(creativeUserInput).toContain(receipt.excerpt);
    } else {
      expect(receipt.excerpt).toBe("");
      expect(creativeInput).not.toContain("People and organizations observed in the manuscript");
      expect(creativeInput).not.toContain("[Person] Harbor");
      expect(creativeInput).not.toContain("林舟");
    }
    expect(await readFile(f.statePath, "utf-8")).toBe(before);
    expect(await readFile(f.rolePath, "utf-8")).toBe(ROLE_CARD);
  });

  it("does not leak a chapter's observations into an earlier v2 writing or planning request", async () => {
    const f = await fixture();
    await f.writer.saveChapter(f.bookDir, output(), false, "en");
    const before = await readFile(f.statePath, "utf-8");
    vi.spyOn(WriterAgent.prototype as never, "loadRecentChapters" as never).mockResolvedValue("");
    const writerChat = vi.spyOn(WriterAgent.prototype as never, "chat" as never)
      .mockRejectedValueOnce(new Error("stop after capturing creative input"));
    await expect(f.writer.writeChapter({
      book: f.book, bookDir: f.bookDir, chapterNumber: 1,
      chapterMemo: { chapter: 1, goal: "Open the shop.", isGoldenOpening: true, body: "", threadRefs: [] },
      contextPackage: { chapter: 1, selectedContext: [] },
      ruleStack: { layers: [{ id: "L4", name: "current_task", precedence: 70, scope: "local" }], sections: { hard: [], soft: [], diagnostic: [] }, overrideEdges: [], activeOverrides: [] },
      lengthSpec: buildLengthSpec(1200, "en"),
    })).rejects.toThrow("stop after capturing creative input");
    const writerMessages = writerChat.mock.calls[0]?.[0] as ReadonlyArray<{ content: string }>;
    const creativeInput = writerMessages.map((message) => message.content).join("\n");
    expect(creativeInput).not.toContain(PERSON_EVIDENCE);
    expect(creativeInput).not.toContain(COMPANY_EVIDENCE);

    const plannerChat = vi.spyOn(llmProvider, "chatCompletion").mockResolvedValue({
      content: "# Chapter 1 memo\n\n## Chapter Goal\nOpen the shop.\n\n## Current Task\nCount the boxes.",
      usage: ZERO_USAGE,
    } as Awaited<ReturnType<typeof llmProvider.chatCompletion>>);
    const planner = new PlannerAgent({ client: CLIENT, model: "test-model", projectRoot: f.root, bookId: f.book.id });
    await planner.planChapter({ book: f.book, bookDir: f.bookDir, chapterNumber: 1 });
    const plannerMessages = plannerChat.mock.calls[0]?.[2] as ReadonlyArray<{ content: string }>;
    const planningInput = plannerMessages.map((message) => message.content).join("\n");
    expect(planningInput).not.toContain(PERSON_EVIDENCE);
    expect(planningInput).not.toContain(COMPANY_EVIDENCE);
    expect(await readFile(f.statePath, "utf-8")).toBe(before);
  });

  it("replaces this chapter's observations when its revised body removes the entities", async () => {
    const f = await fixture();
    await f.writer.saveChapter(f.bookDir, output(), false, "en");
    const revised: WriteChapterOutput = {
      ...output("Min Seo counts the boxes alone."),
      runtimeStateDelta: RuntimeStateDeltaSchema.parse({ chapter: 1, entityObservations: [] }),
    };
    await f.writer.saveChapter(f.bookDir, revised, false, "en");
    const firstRevision = await readFile(f.statePath, "utf-8");
    await f.writer.saveChapter(f.bookDir, revised, false, "en");
    expect(await readFile(f.statePath, "utf-8")).toBe(firstRevision);
    const current = JSON.parse(await readFile(f.statePath, "utf-8"));
    expect(current.entityObservations ?? []).toEqual([]);
    expect(await readFile(f.rolePath, "utf-8")).toBe(ROLE_CARD);
  });

  it("recomputes observations from disk, the delta, and final text instead of trusting a cached snapshot", async () => {
    const f = await fixture();
    const snapshot = await loadRuntimeStateSnapshot(f.bookDir);
    const cached: WriteChapterOutput = {
      ...output(),
      updatedState: "# Current State\n\n| Field | Value |\n| --- | --- |\n| Current Chapter | 1 |\n",
      updatedHooks: "# Pending Hooks\n",
      updatedChapterSummaries: "# Chapter Summaries\n",
      runtimeStateSnapshot: {
        ...snapshot,
        manifest: { ...snapshot.manifest, lastAppliedChapter: 1 },
        currentState: {
          chapter: 1, facts: [],
          entityObservations: [{
            kind: "person", name: "Discarded Founder", evidence: "Discarded Founder owned the company.",
            sourceChapter: 1, chapterTextHash: "0".repeat(64),
          }],
        },
      },
    };
    await f.writer.saveChapter(f.bookDir, cached, false, "en");
    const persisted = JSON.parse(await readFile(f.statePath, "utf-8"));
    expect(persisted.entityObservations).toHaveLength(2);
    expect(persisted.entityObservations).toEqual(expect.arrayContaining(observations().map((item) => expect.objectContaining(item))));
    expect(JSON.stringify(persisted)).not.toContain("Discarded Founder");
    expect(await readFile(f.rolePath, "utf-8")).toBe(ROLE_CARD);
  });

  it.each(["missing", "invalid-type", "invented-evidence", "missing-structured-tag"] as const)("rejects a new Settler delta with %s observations without falling back to legacy truth", async (invalidity) => {
    const f = await fixture();
    const before = await readFile(f.statePath, "utf-8");
    const delta = invalidity === "missing" ? { chapter: 1 }
      : invalidity === "invalid-type" ? { chapter: 1, entityObservations: "not an array" }
        : { chapter: 1, entityObservations: [{ kind: "person", name: "Harbor", evidence: "Harbor founded the shipping company." }] };
    const chat = vi.spyOn(WriterAgent.prototype as never, "chat" as never)
      .mockResolvedValueOnce({ content: `=== OBSERVATIONS ===\n${PERSON_EVIDENCE}`, usage: ZERO_USAGE })
      .mockResolvedValueOnce({
        content: invalidity === "missing-structured-tag"
          ? "=== POST_SETTLEMENT ===\n- checked\n=== UPDATED_STATE ===\nLEGACY FALLBACK MUST NOT BE USED\n=== UPDATED_HOOKS ===\n# Pending Hooks"
          : `=== POST_SETTLEMENT ===\n- checked\n=== RUNTIME_STATE_DELTA ===\n${JSON.stringify(delta)}\n=== UPDATED_STATE ===\nLEGACY FALLBACK MUST NOT BE USED`,
        usage: ZERO_USAGE,
      });
    await expect(f.writer.settleChapterState({
      book: f.book, bookDir: f.bookDir, chapterNumber: 1, title: "The Order", content: FIRST_BODY,
    })).rejects.toThrow();
    expect(chat).toHaveBeenCalledTimes(2);
    expect(await readFile(f.statePath, "utf-8")).toBe(before);
    expect((await readdir(join(f.bookDir, "chapters"))).filter((name) => name.endsWith(".md"))).toEqual([]);
    expect(await readFile(f.rolePath, "utf-8")).toBe(ROLE_CARD);
  });

  it("keeps the Composer observation source intact through compression and excludes it before its source chapter", async () => {
    const f = await fixture();
    await f.writer.saveChapter(f.bookDir, output(), false, "en");
    await writeFile(join(f.storyDir, "chapter_summaries.md"), [
      "| chapter | title | characters | events | stateChanges | hookActivity | mood | chapterType |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      `| 1 | ${"An old cargo order ".repeat(700)} | Min Seo | A past order | None | none | calm | transition |`,
    ].join("\n"));
    const plan = (chapter: number): PlanChapterOutput => ({
      intent: { chapter, goal: "Check the order.", mustKeep: [], mustAvoid: [], styleEmphasis: [] },
      memo: { chapter, goal: "Check the order.", isGoldenOpening: chapter === 1, body: "", threadRefs: [] },
      intentMarkdown: "# Chapter Intent\n\nCheck the order.",
      plannerInputs: [], runtimePath: join(f.storyDir, "runtime", `chapter-${chapter}.intent.md`),
    });
    const compiler = vi.fn(async (_request: CompressibleContextCompileRequest) => "A prior order was completed.");
    const composed = await composeGovernedChapter({
      book: f.book, bookDir: f.bookDir, chapterNumber: 2, plan: plan(2),
      contextBudget: { contextWindowTokens: 900, reservedOutputTokens: 0 },
      compressibleContextCompiler: compiler,
    });
    expect(compiler).toHaveBeenCalledTimes(1);
    const compileInput = compiler.mock.calls[0]![0];
    expect(compileInput.protectedEntries.map((entry) => entry.source)).toContain(ENTITY_OBSERVATION_CONTEXT_SOURCE);
    expect(compileInput.compressibleEntries.map((entry) => entry.source)).not.toContain(ENTITY_OBSERVATION_CONTEXT_SOURCE);
    const selected = composed.contextPackage.selectedContext.find((entry) => entry.source === ENTITY_OBSERVATION_CONTEXT_SOURCE);
    expect(selected?.excerpt).toContain(PERSON_EVIDENCE);
    expect(selected?.excerpt).toContain(COMPANY_EVIDENCE);
    expect(await readFile(composed.contextPath, "utf-8")).toContain(ENTITY_OBSERVATION_CONTEXT_SOURCE);

    const earlier = await composeGovernedChapter({ book: f.book, bookDir: f.bookDir, chapterNumber: 1, plan: plan(1) });
    expect(earlier.contextPackage.selectedContext.some((entry) => entry.source === ENTITY_OBSERVATION_CONTEXT_SOURCE)).toBe(false);
  });

  it("restores an older structured snapshot without retaining a later observation field", async () => {
    const f = await fixture();
    const before = await readFile(f.statePath, "utf-8");
    await f.manager.snapshotState(f.book.id, 0);
    await f.writer.saveChapter(f.bookDir, output(), false, "en");
    expect(JSON.parse(await readFile(f.statePath, "utf-8")).entityObservations).toHaveLength(2);
    expect(await f.manager.restoreState(f.book.id, 0)).toBe(true);
    expect(await readFile(f.statePath, "utf-8")).toBe(before);
    expect(await readFile(f.rolePath, "utf-8")).toBe(ROLE_CARD);
  });

  it("rolls back newly stored observations with the body after a late persistence failure", async () => {
    const f = await fixture();
    const before = await readFile(f.statePath, "utf-8");
    await expect(runChapterPersistenceTransaction({
      bookDir: f.bookDir, chapterNumber: 1,
      persist: async () => {
        await f.writer.saveChapter(f.bookDir, output(), false, "en");
        throw new Error("injected late index failure");
      },
    })).rejects.toThrow("injected late index failure");
    expect(await readFile(f.statePath, "utf-8")).toBe(before);
    expect((await readdir(join(f.bookDir, "chapters"))).filter((name) => name.endsWith(".md"))).toEqual([]);
    expect(await readFile(f.rolePath, "utf-8")).toBe(ROLE_CARD);
  });

  it("preserves the chapter body but does not register observations for state-degraded persistence", async () => {
    const f = await fixture();
    const before = await readFile(f.statePath, "utf-8");
    const degraded = buildStateDegradedPersistenceOutput({
      output: output(), oldState: await readFile(join(f.storyDir, "current_state.md"), "utf-8"),
      oldHooks: await readFile(join(f.storyDir, "pending_hooks.md"), "utf-8"), oldLedger: "",
    });
    await f.writer.saveChapter(f.bookDir, degraded, false, "en");
    const chapterFiles = (await readdir(join(f.bookDir, "chapters"))).filter((name) => name.endsWith(".md"));
    expect(chapterFiles).toHaveLength(1);
    expect(await readFile(join(f.bookDir, "chapters", chapterFiles[0]!), "utf-8")).toContain(FIRST_BODY);
    expect(await readFile(f.statePath, "utf-8")).toBe(before);
    expect(await readFile(f.rolePath, "utf-8")).toBe(ROLE_CARD);
  });

  it("rejects an invented observation before saving a chapter or changing structured state", async () => {
    const f = await fixture();
    const before = await readFile(f.statePath, "utf-8");
    const invented = output();
    const poisoned: WriteChapterOutput = {
      ...invented,
      runtimeStateDelta: RuntimeStateDeltaSchema.parse({
        chapter: 1,
        entityObservations: [{ kind: "person", name: "Harbor", evidence: "Harbor was the company's founder." }],
      }),
    };
    await expect(f.writer.saveChapter(f.bookDir, poisoned, false, "en")).rejects.toThrow();
    expect(await readFile(f.statePath, "utf-8")).toBe(before);
    expect((await readdir(join(f.bookDir, "chapters"))).filter((name) => name.endsWith(".md"))).toEqual([]);
    expect(await readFile(f.rolePath, "utf-8")).toBe(ROLE_CARD);
  });
});
