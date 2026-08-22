import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NARRATIVE_ARC_ALLOCATION_STORE_PATH,
  approveNarrativeArcAllocation,
  inspectNarrativeArcAllocation,
  loadNarrativeArcAllocationStore,
  saveNarrativeArcAllocationDraft,
} from "../arc/allocation-store.js";
import type { NarrativeArcAllocationInput } from "../arc/allocation-schema.js";
import { StoryRailPlanSchema } from "../arc/rail-schema.js";
import { ArcPacketSchema, type ArcPacket } from "../arc/schema.js";
import { ArcStore } from "../arc/store.js";
import { approveGoldRouteReceipt } from "../references/gold-route-receipt.js";

describe("NarrativeArcAllocation v1", () => {
  let projectRoot: string;
  let referenceRoot: string;
  const bookId = "allocation-book";
  const bookDir = () => join(projectRoot, "books", bookId);
  const repositoryRoots = () => ({ firefly_reference_lab: referenceRoot });

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "inkos-allocation-project-"));
    referenceRoot = await mkdtemp(join(tmpdir(), "inkos-allocation-reference-"));
    await Promise.all([
      mkdir(join(bookDir(), "story", "rails"), { recursive: true }),
      mkdir(join(referenceRoot, "analyses", "doksik", "qa"), { recursive: true }),
      mkdir(join(referenceRoot, "analyses", "return-ace", "qa"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(referenceRoot, "analyses/doksik/gold.md"), "# 재벌 Gold\n인수전과 지위 보상\n", "utf8"),
      writeFile(join(referenceRoot, "analyses/doksik/qa/receipt.json"), '{"qa":"PASS"}\n', "utf8"),
      writeFile(join(referenceRoot, "analyses/return-ace/gold.md"), "# 경쟁 Gold\n압박과 공개 검증\n", "utf8"),
      writeFile(join(referenceRoot, "analyses/return-ace/qa/receipt.json"), '{"qa":"PASS"}\n', "utf8"),
    ]);
    await installArcsAndRail();
    await installGoldRoutes();
  });

  afterEach(async () => {
    await Promise.all([
      rm(projectRoot, { recursive: true, force: true }),
      rm(referenceRoot, { recursive: true, force: true }),
    ]);
  });

  it("allocates one natural NarrativeArc across ordered 1-3 chapter packets and multiple Gold routes", async () => {
    const draft = await saveDraft();
    expect(draft.review.status).toBe("draft");
    expect(draft.packetAssignments.map((assignment) => assignment.chapterNumbers)).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    expect(draft.sourceGoldRoutes).toHaveLength(2);
    expect(draft.obligations.map((obligation) => obligation.disposition)).toEqual([
      "assigned",
      "deferred",
      "assigned",
      "retired",
    ]);
    await expect(inspectNarrativeArcAllocation(
      projectRoot,
      bookId,
      draft.allocationId,
      repositoryRoots(),
    )).resolves.toMatchObject({ status: "pending", evidenceStatus: "current" });

    const approved = await approveNarrativeArcAllocation(
      projectRoot,
      bookId,
      draft.allocationId,
      "owner",
      { repositoryRoots: repositoryRoots(), now: () => new Date("2026-08-22T03:00:00.000Z") },
    );
    expect(approved.review).toMatchObject({
      status: "approved",
      approvedBy: "owner",
      approvedAt: "2026-08-22T03:00:00.000Z",
      approvedAllocationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(inspectNarrativeArcAllocation(
      projectRoot,
      bookId,
      approved.allocationId,
      repositoryRoots(),
    )).resolves.toMatchObject({
      status: "current",
      packetEvidence: [
        { arcPacketId: "arc-na1-01", status: "current" },
        { arcPacketId: "arc-na1-02", status: "current" },
        { arcPacketId: "arc-na1-03", status: "current" },
      ],
      goldRouteEvidence: [
        { receiptId: "GRR-DOKSIK-001", status: "current" },
        { receiptId: "GRR-RETURN-001", status: "current" },
      ],
    });

    const raw = await readFile(join(bookDir(), NARRATIVE_ARC_ALLOCATION_STORE_PATH), "utf8");
    expect(raw).not.toContain("인수전과 지위 보상");
    expect(raw).not.toContain("압박과 공개 검증");
  });

  it("requires every human-selected Gold source to be assigned, deferred, or retired exactly once", async () => {
    const input = allocationInput();
    input.obligations = input.obligations.slice(0, -1);
    await expect(saveNarrativeArcAllocationDraft(projectRoot, bookId, input)).rejects.toThrow(
      /account exactly once/i,
    );
    expect((await loadNarrativeArcAllocationStore(projectRoot, bookId)).allocations).toEqual([]);
  });

  it("rejects packet order gaps and B-Rail bindings that do not point at the packet", async () => {
    const arcStore = new ArcStore(bookDir());
    const third = await arcStore.load("arc-na1-03");
    await arcStore.save({ ...third, chapterNumbers: [7, 8], episodeBeats: makeBeats([7, 8]), updatedAt: "2026-08-22T02:30:00.000Z" });
    await expect(saveDraft()).rejects.toThrow(/continuous chapter span/i);

    await arcStore.save(third);
    const input = allocationInput();
    input.packetAssignments[1]!.bRailEntryId = "B003";
    input.packetAssignments[2]!.bRailEntryId = "B002";
    await expect(saveNarrativeArcAllocationDraft(projectRoot, bookId, input)).rejects.toThrow(
      /not bound to ArcPacket/i,
    );
  });

  it("refuses approval when an ArcPacket or Gold artifact changed after the draft", async () => {
    const draft = await saveDraft();
    const arcStore = new ArcStore(bookDir());
    const second = await arcStore.load("arc-na1-02");
    await arcStore.save({ ...second, payoff: "바뀐 소지급", updatedAt: "2026-08-22T02:40:00.000Z" });
    await expect(approveNarrativeArcAllocation(
      projectRoot,
      bookId,
      draft.allocationId,
      "owner",
      { repositoryRoots: repositoryRoots() },
    )).rejects.toThrow(/evidence is stale/i);

    await arcStore.save(second);
    await writeFile(join(referenceRoot, "analyses/doksik/gold.md"), "# 승인 뒤 수정된 Gold\n", "utf8");
    await expect(approveNarrativeArcAllocation(
      projectRoot,
      bookId,
      draft.allocationId,
      "owner",
      { repositoryRoots: repositoryRoots() },
    )).rejects.toThrow(/evidence is stale/i);
  });

  it("marks an allocation stale when a Gold route is reapproved even if its source files did not change", async () => {
    const draft = await saveDraft();
    await approveGoldRouteReceipt(projectRoot, bookId, {
      receiptId: "GRR-DOKSIK-001",
      originArtifact: await artifact("analyses/doksik/gold.md"),
      qaReceiptArtifact: await artifact("analyses/doksik/qa/receipt.json"),
      role: "spine",
      allowedUses: ["인수전의 장기 주축과 지위 보상"],
      selectedSources: [
        { kind: "event", id: "E-ACQUIRE" },
        { kind: "reward", id: "R-STATUS" },
      ],
      forbiddenSourceSurfaces: ["원작 기업명", "원작 인물명"],
      transformationRationale: "같은 근거지만 역할을 소지급에서 장기 사업 주축으로 바꿔 다시 승인한다.",
      targets: [{ kind: "narrative-arc", id: "NA-001" }],
      approvedBy: "owner",
    }, { repositoryRoots: repositoryRoots(), now: () => new Date("2026-08-22T02:30:00.000Z") });

    await expect(inspectNarrativeArcAllocation(
      projectRoot,
      bookId,
      draft.allocationId,
      repositoryRoots(),
    )).resolves.toMatchObject({
      status: "pending",
      evidenceStatus: "stale",
      goldRouteEvidence: expect.arrayContaining([
        { receiptId: "GRR-DOKSIK-001", status: "stale", reason: "gold-route-reapproved" },
      ]),
    });
    await expect(approveNarrativeArcAllocation(
      projectRoot,
      bookId,
      draft.allocationId,
      "owner",
      { repositoryRoots: repositoryRoots() },
    )).rejects.toThrow(/evidence is stale/i);
  });

  it("rejects an approved allocation changed after human approval", async () => {
    const draft = await saveDraft();
    await approveNarrativeArcAllocation(projectRoot, bookId, draft.allocationId, "owner", {
      repositoryRoots: repositoryRoots(),
      now: () => new Date("2026-08-22T03:00:00.000Z"),
    });
    const storePath = join(bookDir(), NARRATIVE_ARC_ALLOCATION_STORE_PATH);
    const store = JSON.parse(await readFile(storePath, "utf8")) as {
      allocations: Array<{ exitState: string }>;
    };
    store.allocations[0]!.exitState = "승인 뒤 몰래 바뀐 퇴장 상태";
    await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await expect(loadNarrativeArcAllocationStore(projectRoot, bookId)).rejects.toThrow(
      /approval hash mismatch/i,
    );
  });

  it("reopens an approved allocation as a draft while preserving its identity and creation time", async () => {
    const first = await saveDraft();
    await approveNarrativeArcAllocation(projectRoot, bookId, first.allocationId, "owner", {
      repositoryRoots: repositoryRoots(),
    });
    const revisedInput = allocationInput();
    revisedInput.packetAssignments[2]!.microPayoffs = ["시장에 이름이 박힌다", "다음 인수 후보를 얻는다"];
    const reopened = await saveNarrativeArcAllocationDraft(projectRoot, bookId, revisedInput, {
      now: () => new Date("2026-08-22T04:00:00.000Z"),
    });
    expect(reopened.review.status).toBe("draft");
    expect(reopened.createdAt).toBe(first.createdAt);
    expect(reopened.updatedAt).toBe("2026-08-22T04:00:00.000Z");
    expect((await loadNarrativeArcAllocationStore(projectRoot, bookId)).allocations).toHaveLength(1);
  });

  async function saveDraft() {
    return saveNarrativeArcAllocationDraft(projectRoot, bookId, allocationInput(), {
      now: () => new Date("2026-08-22T02:00:00.000Z"),
    });
  }

  function allocationInput(): NarrativeArcAllocationInput {
    return {
      allocationId: "NAA-001",
      narrativeArcId: "NA-001",
      title: "외환위기 전에 산업 지도를 선점한다",
      entryState: "주인공은 미래 기억만 있고 자기 자본과 의결권이 없다.",
      exitState: "주인공은 공급망 두 곳과 첫 이사회 표를 확보한다.",
      irreversibleChange: "경쟁 재벌이 주인공을 독립된 인수전 상대로 인정한다.",
      sourceGoldRouteReceiptIds: ["GRR-DOKSIK-001", "GRR-RETURN-001"],
      packetAssignments: [
        {
          arcPacketId: "arc-na1-01",
          bRailEntryId: "B001",
          events: ["부실 부품사를 가장 먼저 찾아낸다"],
          pressures: ["가족 이사회가 현금 사용을 막는다"],
          microPayoffs: ["현장 기술자의 신뢰를 얻는다"],
          relationshipChanges: [],
          obligationIds: ["OB-D-EVENT"],
        },
        {
          arcPacketId: "arc-na1-02",
          bRailEntryId: "B002",
          events: ["경쟁사의 방해 속에서 납품 검증을 연다"],
          pressures: ["공개 실패 시 계열사 전체가 손해를 본다"],
          microPayoffs: ["첫 장기 납품 계약을 얻는다"],
          relationshipChanges: ["현장 책임자가 주인공 편에 선다"],
          obligationIds: ["OB-R-EVENT"],
        },
        {
          arcPacketId: "arc-na1-03",
          bRailEntryId: "B003",
          events: ["임시 주총에서 표 대결을 벌인다"],
          pressures: [],
          microPayoffs: ["시장에 이름이 박힌다"],
          relationshipChanges: ["회장이 후계 후보가 아닌 거래 상대로 대한다"],
          obligationIds: [],
        },
      ],
      obligations: [
        {
          obligationId: "OB-D-EVENT",
          sourceReceiptId: "GRR-DOKSIK-001",
          sourceKind: "event",
          sourceId: "E-ACQUIRE",
          disposition: "assigned",
          targetArcPacketId: "arc-na1-01",
          note: "완성 기업 인수 대신 부실 부품사의 기술자와 납품권을 먼저 확보한다.",
        },
        {
          obligationId: "OB-D-REWARD",
          sourceReceiptId: "GRR-DOKSIK-001",
          sourceKind: "reward",
          sourceId: "R-STATUS",
          disposition: "deferred",
          note: "지위 보상은 현장 성공 직후가 아니라 주총 표 대결 뒤 다음 NarrativeArc로 미룬다.",
        },
        {
          obligationId: "OB-R-EVENT",
          sourceReceiptId: "GRR-RETURN-001",
          sourceKind: "event",
          sourceId: "E-PUBLIC-PROOF",
          disposition: "assigned",
          targetArcPacketId: "arc-na1-02",
          note: "경기 공개 검증을 계열사 납품 성능 시험과 언론 공개로 바꾼다.",
        },
        {
          obligationId: "OB-R-REL",
          sourceReceiptId: "GRR-RETURN-001",
          sourceKind: "relationship",
          sourceId: "REL-RIVAL",
          disposition: "retired",
          note: "스포츠 라이벌의 개인적 우정은 재벌 인수전의 이해관계와 맞지 않아 폐기한다.",
        },
      ],
    };
  }

  async function installArcsAndRail(): Promise<void> {
    const arcStore = new ArcStore(bookDir());
    const arcs = [
      makeArc("arc-na1-01", [1, 2], "첫 매물"),
      makeArc("arc-na1-02", [3, 4], "첫 납품"),
      makeArc("arc-na1-03", [5, 6], "첫 표 대결"),
    ];
    await Promise.all(arcs.map((arc) => arcStore.save(arc)));
    const rail = StoryRailPlanSchema.parse({
      version: 1,
      bookId,
      anchorRail: {
        status: "draft",
        anchors: [{
          id: "A001",
          routeOrder: 0,
          title: "첫 독립 지분",
          detailLevel: "compound",
          state: "planned",
          entryState: "",
          trigger: "",
          irreversibleChange: "",
          humanAftermath: "",
          readerDebt: "",
          payoffAxis: "",
          nextPressure: "",
        }],
      },
      arcRouteRail: {
        status: "draft",
        entries: arcs.map((arc, index) => ({
          bId: `B00${index + 1}`,
          routeOrder: index,
          status: "closed",
          targetAnchorId: "A001",
          arcId: arc.id,
          actualEpisodeCount: arc.episodeCount,
          narrativeFunction: "",
          payoffAxis: "",
          carriedReaderDebt: "",
          contrastRequirement: "",
        })),
      },
      routeCapacity: { targetChaptersSnapshot: 100, arcEpisodeCap: 3 },
      createdAt: "2026-08-22T01:00:00.000Z",
      updatedAt: "2026-08-22T01:00:00.000Z",
    });
    await writeFile(join(bookDir(), "story", "rails", "plan.json"), `${JSON.stringify(rail, null, 2)}\n`, "utf8");
  }

  async function installGoldRoutes(): Promise<void> {
    await approveGoldRouteReceipt(projectRoot, bookId, {
      receiptId: "GRR-DOKSIK-001",
      originArtifact: await artifact("analyses/doksik/gold.md"),
      qaReceiptArtifact: await artifact("analyses/doksik/qa/receipt.json"),
      role: "payoff",
      allowedUses: ["인수전 사건과 지위 보상"],
      selectedSources: [
        { kind: "event", id: "E-ACQUIRE" },
        { kind: "reward", id: "R-STATUS" },
      ],
      forbiddenSourceSurfaces: ["원작 기업명", "원작 인물명"],
      transformationRationale: "인수와 지위 보상의 기능만 다른 산업과 가족 구도에 맞춰 사용한다.",
      targets: [{ kind: "narrative-arc", id: "NA-001" }],
      approvedBy: "owner",
    }, { repositoryRoots: repositoryRoots(), now: () => new Date("2026-08-22T01:10:00.000Z") });
    await approveGoldRouteReceipt(projectRoot, bookId, {
      receiptId: "GRR-RETURN-001",
      originArtifact: await artifact("analyses/return-ace/gold.md"),
      qaReceiptArtifact: await artifact("analyses/return-ace/qa/receipt.json"),
      role: "engine",
      allowedUses: ["경쟁 압력과 공개 검증"],
      selectedSources: [
        { kind: "event", id: "E-PUBLIC-PROOF" },
        { kind: "relationship", id: "REL-RIVAL" },
      ],
      forbiddenSourceSurfaces: ["원작 선수명", "원작 경기 결과"],
      transformationRationale: "스포츠 경쟁의 압박과 공개 검증 기능만 기업 승부로 바꿔 사용한다.",
      targets: [{ kind: "narrative-arc", id: "NA-001" }],
      approvedBy: "owner",
    }, { repositoryRoots: repositoryRoots(), now: () => new Date("2026-08-22T01:20:00.000Z") });
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

function makeArc(id: string, chapterNumbers: [number, number], title: string): ArcPacket {
  return ArcPacketSchema.parse({
    version: 1,
    id,
    bookId: "allocation-book",
    title,
    status: "ready",
    episodeCount: 2,
    chapterNumbers,
    openingState: "직전 상태",
    promise: "사업 승부를 전진시킨다",
    goal: "이번 패킷 목표를 달성한다",
    obstacle: "상대가 막는다",
    pressure: "시간이 줄어든다",
    turn: "숨은 수를 꺼낸다",
    payoff: "눈에 보이는 보상을 얻는다",
    irreversibleChange: "이전으로 돌아갈 수 없다",
    nextHook: "더 큰 상대가 움직인다",
    episodeBeats: makeBeats(chapterNumbers),
    characterChanges: [],
    relationshipChanges: [],
    worldChanges: [],
    hookOperations: [],
    mustKeep: [],
    mustAvoid: [],
    styleEmphasis: [],
    createdAt: "2026-08-22T01:00:00.000Z",
    updatedAt: "2026-08-22T01:00:00.000Z",
  });
}

function makeBeats(chapterNumbers: readonly number[]) {
  return chapterNumbers.map((chapterNumber, index) => ({
    chapterNumber,
    role: index === 0 ? "pressure" as const : "payoff" as const,
    beats: [`${chapterNumber}화 사건`],
    endingHook: `${chapterNumber}화 훅`,
  }));
}
