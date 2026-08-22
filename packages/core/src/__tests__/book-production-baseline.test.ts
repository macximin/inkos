import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NARRATIVE_ARC_ALLOCATION_STORE_PATH,
  approveNarrativeArcAllocation,
  saveNarrativeArcAllocationDraft,
} from "../arc/allocation-store.js";
import { StoryRailPlanSchema } from "../arc/rail-schema.js";
import { ArcPacketSchema, type ArcPacket } from "../arc/schema.js";
import { ArcStore } from "../arc/store.js";
import {
  BOOK_PRODUCTION_BASELINE_STORE_PATH,
  approveBookProductionBaseline,
  inspectBookProductionBaseline,
  loadBookProductionBaselineStore,
  saveBookProductionBaselineDraft,
} from "../production/baseline-store.js";
import { approveGoldRouteReceipt } from "../references/gold-route-receipt.js";

describe("Book Production Baseline v1", () => {
  let projectRoot: string;
  let referenceRoot: string;
  const bookId = "baseline-book";
  const bookDir = () => join(projectRoot, "books", bookId);
  const repositoryRoots = () => ({ firefly_reference_lab: referenceRoot });

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "inkos-baseline-project-"));
    referenceRoot = await mkdtemp(join(tmpdir(), "inkos-baseline-reference-"));
    await Promise.all([
      mkdir(join(bookDir(), "story", "rails"), { recursive: true }),
      mkdir(join(referenceRoot, "analyses", "gold", "qa"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(bookDir(), "project_pitch.md"), "# 프로젝트 피치\nIMF 직전, 미래를 아는 재벌 3세가 판을 선점한다.\n", "utf8"),
      writeFile(join(referenceRoot, "analyses/gold/card.md"), "# Gold\n인수전과 공개 보상\n", "utf8"),
      writeFile(join(referenceRoot, "analyses/gold/qa/receipt.json"), '{"qa":"PASS"}\n', "utf8"),
    ]);
    await installArcAndReadyRail();
    await installApprovedGoldRoute();
    await installApprovedAllocation();
  });

  afterEach(async () => {
    await Promise.all([
      rm(projectRoot, { recursive: true, force: true }),
      rm(referenceRoot, { recursive: true, force: true }),
    ]);
  });

  it("freezes pitch, ready Rails, approved NarrativeArc allocation, ArcPacket, and Gold route", async () => {
    const draft = await saveDraft();
    expect(draft.review.status).toBe("draft");
    expect(draft.pitch.path).toBe("project_pitch.md");
    expect(draft.storyRail.path).toBe("story/rails/plan.json");
    expect(draft.narrativeArcs).toEqual([expect.objectContaining({
      narrativeArcId: "NA-001",
      allocationId: "ALLOC-001",
      approvedAllocationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })]);
    expect(draft.arcPackets).toEqual([expect.objectContaining({
      arcPacketId: "arc-na1-01",
      status: "ready",
      chapterNumbers: [1, 2],
    })]);
    expect(draft.goldRoutes).toEqual([expect.objectContaining({ receiptId: "GRR-001" })]);

    await expect(inspectBookProductionBaseline(
      projectRoot,
      bookId,
      draft.baselineId,
      repositoryRoots(),
    )).resolves.toMatchObject({
      reviewStatus: "draft",
      status: "pending",
      evidenceStatus: "current",
    });

    const approved = await approveBookProductionBaseline(
      projectRoot,
      bookId,
      draft.baselineId,
      "owner",
      { repositoryRoots: repositoryRoots(), now: () => new Date("2026-08-22T05:00:00.000Z") },
    );
    expect(approved.review).toMatchObject({
      status: "approved",
      approvedBy: "owner",
      approvedAt: "2026-08-22T05:00:00.000Z",
      approvedBaselineSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(inspectBookProductionBaseline(
      projectRoot,
      bookId,
      draft.baselineId,
      repositoryRoots(),
    )).resolves.toMatchObject({ reviewStatus: "approved", status: "current" });
  });

  it("reports a baseline that was never created as missing", async () => {
    await expect(inspectBookProductionBaseline(
      projectRoot,
      bookId,
      "BASELINE-MISSING",
      repositoryRoots(),
    )).resolves.toEqual({
      baselineId: "BASELINE-MISSING",
      reviewStatus: "missing",
      status: "missing",
      evidenceStatus: "missing",
      narrativeArcs: [],
      arcPackets: [],
      goldRoutes: [],
    });
  });

  it("requires a non-empty project pitch and ready A/B Rails", async () => {
    await writeFile(join(bookDir(), "project_pitch.md"), "\n", "utf8");
    await expect(saveDraft()).rejects.toThrow(/non-empty project_pitch\.md/i);

    await writeFile(join(bookDir(), "project_pitch.md"), "# 복구된 피치\n", "utf8");
    const railPath = join(bookDir(), "story", "rails", "plan.json");
    const rail = JSON.parse(await readFile(railPath, "utf8")) as {
      anchorRail: { status: string };
      arcRouteRail: { status: string };
    };
    rail.anchorRail.status = "draft";
    rail.arcRouteRail.status = "draft";
    await writeFile(railPath, `${JSON.stringify(rail, null, 2)}\n`, "utf8");
    await expect(saveDraft()).rejects.toThrow(/requires ready A-Rail and B-Rail/i);
  });

  it("rejects an unapproved NarrativeArc allocation and a draft ArcPacket", async () => {
    await saveNarrativeArcAllocationDraft(projectRoot, bookId, allocationInput(), {
      now: () => new Date("2026-08-22T04:10:00.000Z"),
    });
    await expect(saveDraft()).rejects.toThrow(/not approved/i);

    await approveNarrativeArcAllocation(projectRoot, bookId, "ALLOC-001", "owner", {
      repositoryRoots: repositoryRoots(),
      now: () => new Date("2026-08-22T04:20:00.000Z"),
    });
    const arcStore = new ArcStore(bookDir());
    const arc = await arcStore.load("arc-na1-01");
    await arcStore.save({ ...arc, status: "draft" });
    await expect(saveDraft()).rejects.toThrow(/current NarrativeArc allocation|draft ArcPacket/i);
  });

  it("refuses approval when the project pitch changes after the draft", async () => {
    const draft = await saveDraft();
    await writeFile(join(bookDir(), "project_pitch.md"), "# 승인 직전 바뀐 피치\n", "utf8");
    await expect(approveBookProductionBaseline(
      projectRoot,
      bookId,
      draft.baselineId,
      "owner",
      { repositoryRoots: repositoryRoots() },
    )).rejects.toThrow(/evidence is stale/i);
  });

  it("marks an approved baseline stale when an ArcPacket changes", async () => {
    const approved = await approveDraft();
    const arcStore = new ArcStore(bookDir());
    const arc = await arcStore.load("arc-na1-01");
    await arcStore.save({
      ...arc,
      payoff: "기준선 뒤 바뀐 보상",
      updatedAt: "2026-08-22T06:00:00.000Z",
    });
    await expect(inspectBookProductionBaseline(
      projectRoot,
      bookId,
      approved.baselineId,
      repositoryRoots(),
    )).resolves.toMatchObject({
      status: "stale",
      arcPackets: [{ arcPacketId: "arc-na1-01", status: "stale", reason: "arc-packet-changed" }],
    });
  });

  it("marks an approved baseline missing when Gold source evidence disappears", async () => {
    const approved = await approveDraft();
    await unlink(join(referenceRoot, "analyses/gold/card.md"));
    await expect(inspectBookProductionBaseline(
      projectRoot,
      bookId,
      approved.baselineId,
      repositoryRoots(),
    )).resolves.toMatchObject({
      status: "missing",
      goldRoutes: [{ receiptId: "GRR-001", status: "missing", reason: "gold-evidence-missing" }],
    });
  });

  it("rejects an approved baseline changed after human approval", async () => {
    await approveDraft();
    const storePath = join(bookDir(), BOOK_PRODUCTION_BASELINE_STORE_PATH);
    const store = JSON.parse(await readFile(storePath, "utf8")) as {
      baselines: Array<{ pitch: { sha256: string } }>;
    };
    store.baselines[0]!.pitch.sha256 = "a".repeat(64);
    await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await expect(loadBookProductionBaselineStore(projectRoot, bookId)).rejects.toThrow(
      /approval hash mismatch/i,
    );
  });

  async function saveDraft() {
    return saveBookProductionBaselineDraft(projectRoot, bookId, {
      baselineId: "BASELINE-001",
      narrativeArcAllocationIds: ["ALLOC-001"],
    }, {
      repositoryRoots: repositoryRoots(),
      now: () => new Date("2026-08-22T04:30:00.000Z"),
    });
  }

  async function approveDraft() {
    const draft = await saveDraft();
    return approveBookProductionBaseline(projectRoot, bookId, draft.baselineId, "owner", {
      repositoryRoots: repositoryRoots(),
      now: () => new Date("2026-08-22T05:00:00.000Z"),
    });
  }

  async function installArcAndReadyRail(): Promise<void> {
    const arc = makeArc();
    await new ArcStore(bookDir()).save(arc);
    const anchors = Array.from({ length: 6 }, (_, index) => ({
      id: `A00${index + 1}`,
      routeOrder: index,
      title: `${index + 1}차 장기 목적지`,
      detailLevel: index < 2 ? "compound" as const : "sparse" as const,
      state: "planned" as const,
      entryState: "직전 사업 상태",
      trigger: "새 기회가 열린다",
      irreversibleChange: "지분과 책임이 커진다",
      humanAftermath: "가족과 동료의 위치가 바뀐다",
      readerDebt: "더 큰 승부를 갚아야 한다",
      payoffAxis: "사업과 지위 상승",
      nextPressure: "더 강한 상대가 움직인다",
    }));
    const rail = StoryRailPlanSchema.parse({
      version: 1,
      bookId,
      anchorRail: { status: "ready", anchors },
      arcRouteRail: {
        status: "ready",
        entries: Array.from({ length: 34 }, (_, index) => ({
          bId: `B${String(index + 1).padStart(3, "0")}`,
          routeOrder: index,
          status: index === 0 ? "active" as const : "hypothesis" as const,
          targetAnchorId: `A00${Math.floor((index * 6) / 34) + 1}`,
          ...(index === 0 ? { arcId: arc.id } : {}),
          narrativeFunction: `${index + 1}차 사업 승부를 전진시킨다`,
          payoffAxis: "현금과 후계 지위",
          carriedReaderDebt: "외환위기 본게임을 기다리게 한다",
          contrastRequirement: "쉬운 예언이 아니라 실행 저항을 보여 준다",
        })),
      },
      routeCapacity: { targetChaptersSnapshot: 100, arcEpisodeCap: 3 },
      createdAt: "2026-08-22T03:00:00.000Z",
      updatedAt: "2026-08-22T03:00:00.000Z",
    });
    await writeFile(join(bookDir(), "story", "rails", "plan.json"), `${JSON.stringify(rail, null, 2)}\n`, "utf8");
  }

  async function installApprovedGoldRoute(): Promise<void> {
    await approveGoldRouteReceipt(projectRoot, bookId, {
      receiptId: "GRR-001",
      originArtifact: await artifact("analyses/gold/card.md"),
      qaReceiptArtifact: await artifact("analyses/gold/qa/receipt.json"),
      role: "payoff",
      allowedUses: ["인수전 사건과 공개 보상"],
      selectedSources: [{ kind: "event", id: "E-ACQUIRE" }],
      forbiddenSourceSurfaces: ["원작 기업명", "원작 인물명"],
      transformationRationale: "인수전의 기능만 새 산업과 새로운 가족 구도에 맞춰 변환한다.",
      targets: [{ kind: "narrative-arc", id: "NA-001" }],
      approvedBy: "owner",
    }, {
      repositoryRoots: repositoryRoots(),
      now: () => new Date("2026-08-22T03:10:00.000Z"),
    });
  }

  async function installApprovedAllocation(): Promise<void> {
    await saveNarrativeArcAllocationDraft(projectRoot, bookId, allocationInput(), {
      now: () => new Date("2026-08-22T03:20:00.000Z"),
    });
    await approveNarrativeArcAllocation(projectRoot, bookId, "ALLOC-001", "owner", {
      repositoryRoots: repositoryRoots(),
      now: () => new Date("2026-08-22T03:30:00.000Z"),
    });
  }

  function allocationInput() {
    return {
      allocationId: "ALLOC-001",
      narrativeArcId: "NA-001",
      title: "첫 선점",
      entryState: "가족 안에서 힘이 없다",
      exitState: "첫 사업 실적과 발언권을 얻는다",
      irreversibleChange: "후계 경쟁에 공식 진입한다",
      sourceGoldRouteReceiptIds: ["GRR-001"],
      packetAssignments: [{
        arcPacketId: "arc-na1-01",
        bRailEntryId: "B001",
        events: ["부실 매물을 먼저 잡는다"],
        pressures: ["시간과 자금이 부족하다"],
        microPayoffs: ["첫 현금흐름을 만든다"],
        relationshipChanges: ["회장이 주인공을 다시 본다"],
        obligationIds: ["OB-001"],
      }],
      obligations: [{
        obligationId: "OB-001",
        sourceReceiptId: "GRR-001",
        sourceKind: "event" as const,
        sourceId: "E-ACQUIRE",
        disposition: "assigned" as const,
        targetArcPacketId: "arc-na1-01",
        note: "원작 표면은 버리고 부실기업 선점의 기능만 새 사건으로 변환한다.",
      }],
    };
  }

  async function artifact(path: string) {
    return {
      repository: "firefly_reference_lab",
      commit: "9e10a3f",
      path,
      sha256: createHash("sha256").update(await readFile(join(referenceRoot, path))).digest("hex"),
    };
  }
});

function makeArc(): ArcPacket {
  return ArcPacketSchema.parse({
    version: 1,
    id: "arc-na1-01",
    bookId: "baseline-book",
    title: "첫 선점",
    status: "ready",
    episodeCount: 2,
    chapterNumbers: [1, 2],
    openingState: "가족 안에서 힘이 없다",
    promise: "미래 지식으로 첫 매물을 선점한다",
    goal: "부실기업을 싸게 인수한다",
    obstacle: "자금과 가족의 반대가 막는다",
    pressure: "외환위기 전에 계약해야 한다",
    turn: "숨은 자산을 증명한다",
    payoff: "현금흐름과 회장의 인정을 얻는다",
    irreversibleChange: "후계 경쟁에 공식 진입한다",
    nextHook: "더 큰 매물이 시장에 나온다",
    episodeBeats: [
      { chapterNumber: 1, role: "promise", beats: ["매물을 발견한다"], endingHook: "입찰 기한이 당겨진다" },
      { chapterNumber: 2, role: "payoff", beats: ["숨은 자산을 증명한다"], endingHook: "가족이 견제에 나선다" },
    ],
    characterChanges: ["주인공이 실행자로 인정받는다"],
    relationshipChanges: ["회장이 주인공을 다시 본다"],
    worldChanges: ["첫 계열사를 확보한다"],
    hookOperations: ["다음 매물을 연다"],
    mustKeep: [],
    mustAvoid: [],
    styleEmphasis: [],
    createdAt: "2026-08-22T03:00:00.000Z",
    updatedAt: "2026-08-22T03:00:00.000Z",
  });
}
