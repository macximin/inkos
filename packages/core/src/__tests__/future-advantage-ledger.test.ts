import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditResult } from "../agents/continuity.js";
import type { ChapterArcProvenance, ChapterMeta } from "../models/chapter.js";
import { FutureAdvantageCanonLedgerSchema, FutureAdvantageResearchReceiptStoreSchema } from "../models/future-advantage-ledger.js";
import { StateManager } from "../state/manager.js";
import {
  FUTURE_ADVANTAGE_CANON_PATH,
  FUTURE_ADVANTAGE_RESEARCH_RECEIPTS_PATH,
  buildChapterFutureAdvantageExecution,
  rebuildApprovedFutureAdvantageCanon,
} from "../state/future-advantage-ledger.js";

const BODY = "퇴직 기술자 영입이 끝났다. 시험 라인 확보 뒤 첫 납품 검사 통과를 받아 계열사 우선 공급권까지 손에 넣었다.";

describe("Future Advantage canon ledger", () => {
  it("promotes only body-proven approved moves and restores fiction/research truth with snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-future-ledger-test-"));
    const bookDir = join(root, "books", "future-book");
    const storyDir = join(bookDir, "story");
    const chaptersDir = join(bookDir, "chapters");
    await Promise.all([
      mkdir(chaptersDir, { recursive: true }),
      mkdir(storyDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(storyDir, "current_state.md"), "# 현재 상태\n", "utf8"),
      writeFile(join(storyDir, "pending_hooks.md"), "# 복선 목록\n", "utf8"),
      writeFile(join(chaptersDir, "0001_첫-납품.md"), `# 첫 납품\n\n${BODY}`, "utf8"),
    ]);
    const state = new StateManager(root);
    await state.snapshotState("future-book", 0);
    await state.snapshotState("future-book", 1);

    const provenance = makeProvenance();
    const auditResult: AuditResult = {
      passed: true,
      creativePassed: true,
      researchStatus: "needs-research",
      issues: [],
      summary: "실행 확인",
      futureAdvantageExecution: {
        moveId: "FA-001",
        implemented: true,
        bridgeEvidence: ["퇴직 기술자 영입", "시험 라인 확보"],
        proofEvidence: ["첫 납품 검사 통과"],
        rewardEvidence: ["계열사 우선 공급권"],
        worldChanges: [{ change: "장비 공급 시계가 앞당겨졌다", evidence: "첫 납품 검사 통과" }],
        memoryReliability: "strained",
        memoryEvidence: ["시험 라인 확보 뒤"],
        note: "계획이 본문에서 실행됨",
      },
    };
    const execution = buildChapterFutureAdvantageExecution({
      chapterNumber: 1,
      chapterContent: BODY,
      arcProvenance: provenance,
      auditResult,
    });
    expect(execution).toBeDefined();

    const pending = makeChapter("ready-for-review", provenance, execution);
    const beforeApproval = await rebuildApprovedFutureAdvantageCanon({ bookDir, chapters: [pending] });
    expect(beforeApproval.executedMoveCount).toBe(0);
    expect(await readCanon(bookDir)).toEqual([]);

    const approved = { ...pending, status: "approved" as const, updatedAt: "2026-08-20T01:00:00.000Z" };
    const result = await rebuildApprovedFutureAdvantageCanon({ bookDir, chapters: [approved] });
    expect(result.executedMoveCount).toBe(1);
    expect(await readCanon(bookDir)).toEqual([
      expect.objectContaining({
        chapterNumber: 1,
        moveId: "FA-001",
        memoryReliability: "strained",
        researchStatus: "needs-research",
      }),
    ]);
    const research = FutureAdvantageResearchReceiptStoreSchema.parse(JSON.parse(
      await readFile(join(bookDir, FUTURE_ADVANTAGE_RESEARCH_RECEIPTS_PATH), "utf8"),
    ));
    expect(research.receipts[0]).toMatchObject({
      moveId: "FA-001",
      claimIds: ["RC-SEMICON-001"],
      status: "needs-research",
    });

    await state.restoreState("future-book", 0);
    expect(await readCanon(bookDir)).toEqual([]);
    await state.restoreState("future-book", 1);
    expect(await readCanon(bookDir)).toHaveLength(1);
    await rm(root, { recursive: true, force: true });
  });

  it("rejects stale edited content instead of canonizing an old execution receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-future-ledger-stale-test-"));
    const bookDir = join(root, "book");
    await mkdir(join(bookDir, "chapters"), { recursive: true });
    await writeFile(join(bookDir, "chapters", "0001_첫-납품.md"), `# 첫 납품\n\n${BODY}`, "utf8");
    const provenance = makeProvenance();
    const execution = buildChapterFutureAdvantageExecution({
      chapterNumber: 1,
      chapterContent: BODY,
      arcProvenance: provenance,
      auditResult: {
        passed: true,
        researchStatus: "verified",
        issues: [],
        summary: "ok",
        futureAdvantageExecution: {
          moveId: "FA-001",
          implemented: true,
          bridgeEvidence: ["퇴직 기술자 영입"],
          proofEvidence: ["첫 납품 검사 통과"],
          rewardEvidence: ["계열사 우선 공급권"],
          worldChanges: [],
          memoryReliability: "intact",
          memoryEvidence: [],
          note: "ok",
        },
      },
    });
    await writeFile(join(bookDir, "chapters", "0001_첫-납품.md"), "# 첫 납품\n\n실행 장면을 삭제했다.", "utf8");
    await expect(rebuildApprovedFutureAdvantageCanon({
      bookDir,
      chapters: [makeChapter("approved", provenance, execution)],
    })).rejects.toThrow(/stale.*re-audit/i);
    await rm(root, { recursive: true, force: true });
  });
});

async function readCanon(bookDir: string) {
  const parsed = FutureAdvantageCanonLedgerSchema.parse(JSON.parse(
    await readFile(join(bookDir, FUTURE_ADVANTAGE_CANON_PATH), "utf8"),
  ));
  return parsed.executedMoves;
}

function makeChapter(
  status: ChapterMeta["status"],
  arcProvenance: ChapterArcProvenance,
  futureAdvantageExecution: ChapterMeta["futureAdvantageExecution"],
): ChapterMeta {
  return {
    number: 1,
    title: "첫 납품",
    status,
    wordCount: BODY.length,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    auditIssues: [],
    lengthWarnings: [],
    arcProvenance,
    futureAdvantageExecution,
  };
}

function makeProvenance(): ChapterArcProvenance {
  return {
    version: 1,
    bookId: "future-book",
    arcId: "arc-future-001",
    arcUpdatedAt: "2026-08-20T00:00:00.000Z",
    arcTitle: "먼저 만든 생산선",
    chapterNumber: 1,
    episodeRole: "payoff",
    openingState: "장비가 없다.",
    promise: "미래 수요를 현재 생산으로 바꾼다.",
    goal: "첫 납품을 끝낸다.",
    obstacle: "시험 라인이 없다.",
    pressure: "경쟁사가 기술자를 빼간다.",
    turn: "퇴직 기술자를 영입한다.",
    payoff: "검사 통과와 공급권을 얻는다.",
    irreversibleChange: "장비 공급 시계가 앞당겨진다.",
    nextHook: "기억과 현실의 오차가 시작된다.",
    beats: ["시험 라인을 확보한다.", "첫 납품 검사를 통과한다."],
    endingHook: "다음 기억의 날짜가 어긋난다.",
    characterChanges: [],
    relationshipChanges: [],
    worldChanges: ["장비 공급 시계가 앞당겨진다."],
    hookOperations: [],
    mustKeep: [],
    mustAvoid: [],
    styleEmphasis: [],
    futureAdvantageMove: {
      moveId: "FA-001",
      mode: "introduce",
      domain: "기술",
      target: "반도체 장비 국산화",
      rememberedOutcome: "향후 장비 수요가 폭증한다.",
      baselineQuestions: ["1997년 장비 공급망은 어디까지였나"],
      researchClaimIds: ["RC-SEMICON-001"],
      authorizedDivergences: ["첫 상용 납품을 실제보다 3년 앞당긴다"],
      bridgeSteps: ["퇴직 기술자 영입", "시험 라인 확보"],
      resistance: ["임원회의 반대"],
      proof: "첫 납품 검사 통과",
      reward: "계열사 우선 공급권",
      downstreamConsequences: ["기억의 날짜가 어긋나기 시작한다"],
    },
  };
}
