import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApplyStoryRailReflowTool,
  createDiscardStoryRailReflowTool,
  createGetStoryRailsTool,
  createReplaceStoryRailsTool,
} from "../agent/story-rail-tools.js";
import type { StoryRailPlanInput } from "../arc/rail-schema.js";
import { StoryRailStore } from "../arc/rail-store.js";
import type { ArcPacket } from "../arc/schema.js";
import { ArcStore } from "../arc/store.js";
import { StateManager } from "../state/manager.js";

describe("story rail agent tools", () => {
  let projectRoot: string;
  let bookDir: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "inkos-story-rail-tools-"));
    bookDir = join(projectRoot, "books", "book-a");
    await mkdir(bookDir, { recursive: true });
    await writeFile(join(bookDir, "book.json"), JSON.stringify({
      id: "book-a",
      title: "Book A",
      platform: "tomato",
      genre: "urban",
      status: "active",
      targetChapters: 18,
      chapterWordCount: 2200,
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    }), "utf-8");
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("reads a missing or existing complete rail plan without mutating it", async () => {
    const getTool = createGetStoryRailsTool("book-a", projectRoot);
    const missing = await getTool.execute("get-missing", {});

    expect(resultText(missing)).toContain("No A/B Rail plan exists");
    expect((missing.details as { plan: unknown }).plan).toBeNull();

    const saved = await new StoryRailStore(bookDir).replace("book-a", makeRailInput());
    const found = await getTool.execute("get-existing", {});

    expect(resultText(found)).toContain("Complete A/B Rail plan");
    expect(resultText(found)).toContain('"bId": "B001"');
    expect((found.details as { plan: unknown }).plan).toEqual(saved);
  });

  it("fully replaces the plan and binds an unbound active B to the current active Arc", async () => {
    const arcStore = new ArcStore(bookDir);
    const activeArc = await arcStore.save(makeArc("arc-current"));
    await arcStore.setActive(activeArc.id);

    const replaceTool = createReplaceStoryRailsTool("book-a", projectRoot);
    const result = await replaceTool.execute("replace", makeRailInput());

    expect(resultText(result)).toContain("Bound current active Arc");
    expect(result.details).toMatchObject({
      kind: "story_rails_replaced",
      binding: {
        status: "bound",
        changed: true,
        bId: "B001",
        arcId: "arc-current",
      },
      warnings: [],
    });
    await expect(new StoryRailStore(bookDir).load()).resolves.toMatchObject({
      arcRouteRail: {
        entries: [expect.objectContaining({ bId: "B001", arcId: "arc-current" })],
      },
    });
  });

  it("rejects replacement while the Book is busy and releases its lock after success", async () => {
    const state = new StateManager(projectRoot);
    const releaseCompetingLock = await state.acquireBookLock("book-a");
    const replaceTool = createReplaceStoryRailsTool("book-a", projectRoot);

    try {
      await expect(replaceTool.execute("replace-busy", makeRailInput()))
        .rejects.toMatchObject({ code: "BOOK_BUSY" });
      await expect(new StoryRailStore(bookDir).load()).resolves.toBeNull();
    } finally {
      await releaseCompetingLock();
    }

    await expect(replaceTool.execute("replace-after-busy", makeRailInput())).resolves.toBeDefined();
    const releaseAfterReplacement = await new StateManager(projectRoot).acquireBookLock("book-a");
    await releaseAfterReplacement();
  });

  it("releases the Book lock when non-destructive replacement validation fails", async () => {
    await new StoryRailStore(bookDir).replace("book-a", makeRailInput());
    const invalidReplacement = makeRailInput();
    invalidReplacement.arcRouteRail.entries[0]!.bId = "B002";

    await expect(createReplaceStoryRailsTool("book-a", projectRoot)
      .execute("replace-omitting-id", invalidReplacement)).rejects.toThrow(/cannot be omitted/i);

    const releaseAfterFailure = await new StateManager(projectRoot).acquireBookLock("book-a");
    await releaseAfterFailure();
  });

  it("does not create a ghost Book directory for an explicit missing bookId", async () => {
    const missingBookDir = join(projectRoot, "books", "missing-book");

    await expect(createReplaceStoryRailsTool(null, projectRoot).execute("replace-missing", {
      ...makeRailInput(),
      bookId: "missing-book",
    })).rejects.toThrow();

    await expect(access(missingBookDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a conflicting active B binding and reports the warning", async () => {
    const arcStore = new ArcStore(bookDir);
    const activeArc = await arcStore.save(makeArc("arc-current"));
    await arcStore.setActive(activeArc.id);
    const input = makeRailInput();
    input.arcRouteRail.entries[0]!.arcId = "arc-protected";

    const result = await createReplaceStoryRailsTool("book-a", projectRoot)
      .execute("replace-conflict", input);

    expect(resultText(result)).toContain("WARNING:");
    expect(resultText(result)).toContain("was not allowed to overwrite it");
    expect(result.details).toMatchObject({
      binding: {
        status: "conflict",
        reason: "active_b_already_bound",
        existingArcId: "arc-protected",
        requestedArcId: "arc-current",
      },
    });
    await expect(new StoryRailStore(bookDir).load()).resolves.toMatchObject({
      arcRouteRail: {
        entries: [expect.objectContaining({ bId: "B001", arcId: "arc-protected" })],
      },
    });
  });

  it("advertises tombstone-safe full replacement and requires an active-book match", async () => {
    const replaceTool = createReplaceStoryRailsTool("book-a", projectRoot);

    expect(replaceTool.description).toContain("Always call get_story_rails first");
    expect(replaceTool.description).toContain("omission is rejected");
    expect(replaceTool.description).toContain("1-3 chapter Arc cap");
    await expect(replaceTool.execute("wrong-book", {
      ...makeRailInput(),
      bookId: "book-b",
    })).rejects.toThrow(/must match the active book/i);
  });

  it("exposes reflow only as an explicit all-decisions atomic apply", async () => {
    const tool = createApplyStoryRailReflowTool("book-a", projectRoot);

    expect(tool.name).toBe("apply_story_rail_reflow");
    expect(tool.description).toContain("exactly one keep/revise/retire decision");
    expect(tool.description).toContain("never silently promotes");
    await expect(tool.execute("wrong-book", {
      bookId: "book-b",
      pendingId: "reflow-one",
      expectedPlanUpdatedAt: "2026-08-09T10:00:00.000Z",
      closeout: {
        startState: "before",
        actualOutcome: "after",
        irreversibleSettlement: "settled",
        humanRemainder: "remains",
        readerDebt: { paid: [], carried: [], retired: [], emerged: [] },
        emergence: [],
        anchorImpact: { anchorId: "A01", decision: "keep", reason: "unchanged" },
        stateThroughChapter: 1,
      },
      nextActiveBId: "B002",
      decisions: [],
    })).rejects.toThrow(/must match the active book/i);
  });

  it("exposes pending discard only as an explicit receipt-backed escape", async () => {
    const tool = createDiscardStoryRailReflowTool("book-a", projectRoot);

    expect(tool.name).toBe("discard_story_rail_reflow");
    expect(tool.description).toContain("immutable discard receipt");
    expect(tool.description).toContain("does not change Chapters");
    await expect(tool.execute("wrong-book", {
      bookId: "book-b",
      pendingId: "reflow-one",
      expectedPlanUpdatedAt: "2026-08-09T10:00:00.000Z",
      reason: "Direct production continued.",
    })).rejects.toThrow(/must match the active book/i);
  });
});

function makeRailInput(): StoryRailPlanInput {
  return {
    anchorRail: {
      status: "draft",
      anchors: [{
        id: "A01",
        routeOrder: 100,
        title: "첫 장기 목적지",
        detailLevel: "compound",
        state: "planned",
        entryState: "빚 독촉이 시작됐다.",
        trigger: "주인공이 첫 거래를 선택한다.",
        irreversibleChange: "첫 고객과 계약이 생긴다.",
        humanAftermath: "가족의 역할이 달라진다.",
        readerDebt: "첫 약속의 실제 대가를 보여준다.",
        payoffAxis: "신뢰와 현금흐름",
        nextPressure: "더 큰 주문을 감당해야 한다.",
      }],
    },
    arcRouteRail: {
      status: "draft",
      entries: [{
        bId: "B001",
        routeOrder: 100,
        status: "active",
        targetAnchorId: "A01",
        narrativeFunction: "첫 거래를 반복 가능한 계약으로 바꾼다.",
        payoffAxis: "첫 신뢰",
        carriedReaderDebt: "약속을 실제로 지킬 수 있는가",
        contrastRequirement: "설명보다 선택과 비용으로 증명한다.",
      }],
    },
  };
}

function makeArc(id: string): ArcPacket {
  return {
    version: 1,
    id,
    bookId: "book-a",
    title: "첫 거래",
    status: "draft",
    episodeCount: 1,
    chapterNumbers: [1],
    openingState: "빚 독촉이 시작됐다.",
    promise: "첫 거래를 성사시킨다.",
    goal: "계약을 확보한다.",
    obstacle: "상대가 조건을 숨긴다.",
    pressure: "마감이 다가온다.",
    turn: "주인공이 비용을 감수한다.",
    payoff: "첫 계약을 얻는다.",
    irreversibleChange: "고객과 관계가 생긴다.",
    nextHook: "다음 주문은 더 크다.",
    episodeBeats: [{
      chapterNumber: 1,
      role: "payoff",
      beats: ["첫 계약을 얻는다."],
      endingHook: "더 큰 주문이 들어온다.",
    }],
    characterChanges: [],
    relationshipChanges: [],
    worldChanges: [],
    hookOperations: [],
    mustKeep: [],
    mustAvoid: [],
    styleEmphasis: [],
    createdAt: "2026-08-09T10:00:00.000Z",
    updatedAt: "2026-08-09T10:00:00.000Z",
  };
}

function resultText(result: { readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }> }): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}
