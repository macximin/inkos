import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BookConfig } from "../models/book.js";
import { ArcStore } from "../arc/store.js";
import { StoryRailStore } from "../arc/rail-store.js";
import { StoryRailPlanSchema, type StoryRailPlan } from "../arc/rail-schema.js";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";
import {
  ReferenceStoryIndexEntrySchema,
  ReferenceTransformationSchema,
  type ReferenceTransformation,
} from "./schema.js";
import { ReferencePackStore } from "./store.js";
import { assertApprovedFireflyPlanningAdmission } from "../planning/entry-contract.js";

export interface FireflyPreflightReceipt {
  readonly referencePackId?: string;
  readonly spineReference?: string;
  readonly transformationCreated: boolean;
  readonly railCreated: boolean;
  readonly transformationSha256?: string;
  readonly railPlanSha256?: string;
  readonly arcId?: string;
  readonly planningAdmissionSha256?: string;
}

async function fileSha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function ensureFireflyLongformPreflight(input: {
  readonly projectRoot: string;
  readonly bookDir: string;
  readonly book: BookConfig;
  readonly now?: () => Date;
}): Promise<FireflyPreflightReceipt> {
  const planningRequired = input.book.writing?.entryContractPolicy === "auto-required";
  const referenceRequired = input.book.writing?.referencePolicy === "auto-required";
  const railRequired = input.book.writing?.railPolicy === "auto-required";
  const planningAdmission = planningRequired
    ? await assertApprovedFireflyPlanningAdmission({ bookDir: input.bookDir, bookId: input.book.id })
    : null;
  if (!referenceRequired && !railRequired) {
    return {
      transformationCreated: false,
      railCreated: false,
      ...(planningAdmission ? { planningAdmissionSha256: planningAdmission.entryContractSha256 } : {}),
    };
  }

  const now = input.now ?? (() => new Date());
  const referenceStore = new ReferencePackStore(input.projectRoot, input.bookDir);
  const readyReference = referenceRequired
    ? await referenceStore.assertReady(input.book)
    : null;
  let transformation = referenceRequired
    ? await referenceStore.loadTransformation(false)
    : null;
  const railStore = new StoryRailStore(input.bookDir, { now });
  let railPlan = railRequired ? await railStore.load() : null;
  const activeArc = await new ArcStore(input.bookDir).getActive();
  if (!activeArc) {
    throw new Error("Firefly auto-required preflight needs an active NarrativeArc before chapter production.");
  }
  if (activeArc.bookId !== input.book.id) {
    throw new Error("Firefly active NarrativeArc belongs to a different Book.");
  }
  if (activeArc.status !== "ready") {
    throw new Error(`Firefly auto-required preflight needs a ready NarrativeArc; active Arc ${JSON.stringify(activeArc.id)} is ${activeArc.status}.`);
  }
  if (transformation && !transformation.sourceSegments.some((segment) => segment.targetArcIds.includes(activeArc.id))) {
    throw new Error(`Reference transformation has no source segment mapped to active Arc ${JSON.stringify(activeArc.id)}.`);
  }
  if (railPlan) {
    if (railPlan.anchorRail.status !== "ready" || railPlan.arcRouteRail.status !== "ready") {
      throw new Error("Firefly auto-required preflight needs ready A-Rail and B-Rail state.");
    }
    const activeRoute = railPlan.arcRouteRail.entries.find((entry) => entry.status === "active");
    if (!activeRoute || activeRoute.arcId !== activeArc.id) {
      throw new Error(`Firefly ready B-Rail is not bound to active Arc ${JSON.stringify(activeArc.id)}.`);
    }
  }
  if (transformation && railPlan) {
    return {
      referencePackId: readyReference?.binding.referencePackId,
      spineReference: readyReference?.binding.spineReference,
      transformationCreated: false,
      railCreated: false,
      transformationSha256: await fileSha256(referenceStore.transformationPath),
      railPlanSha256: await fileSha256(join(input.bookDir, "story", "rails", "plan.json")),
      arcId: activeArc.id,
      ...(planningAdmission ? { planningAdmissionSha256: planningAdmission.entryContractSha256 } : {}),
    };
  }

  const timestamp = now().toISOString();
  const activeAnchorId = railPlan?.arcRouteRail.entries.find((entry) => entry.status === "active")?.targetAnchorId
    ?? "A1-entry-proof";

  if (!transformation) {
    if (!readyReference) throw new Error("Reference pack is required to create the transformation map.");
    const installedStoryIndex = join(
      referenceStore.installedPackDir(readyReference.binding),
      "story-index.jsonl",
    );
    const entries = (await readFile(installedStoryIndex, "utf8"))
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => ReferenceStoryIndexEntrySchema.parse(JSON.parse(line)));
    const progress = Math.max(0, (activeArc.chapterNumbers[0]! - 1) / input.book.targetChapters);
    const center = Math.min(
      entries.length - 2,
      Math.max(1, Math.floor(progress * entries.length) + 1),
    );
    const selected = entries.slice(center - 1, center + 2);
    transformation = ReferenceTransformationSchema.parse({
      version: 1,
      kind: "reference-transformation",
      bookId: input.book.id,
      referencePackId: readyReference.binding.referencePackId,
      spineReference: readyReference.binding.spineReference,
      supportingReferences: [],
      sourceSegments: [{
        id: `source-${selected[0]!.sequence}-${selected.at(-1)!.sequence}-to-${activeArc.id}`,
        sourceArcIds: [...new Set(selected.map((entry) => entry.arcId))],
        sourceChapterIds: selected.map((entry) => entry.sequence),
        targetRailAnchorIds: [activeAnchorId],
        targetArcIds: [activeArc.id],
        retain: ["engine", "event-order", "character-role", "pressure", "payoff", "hook"],
        varySurface: ["people", "organization", "object", "location", "local-cause"],
        linkedConsequences: ["money", "evidence", "procedure", "role", "result"],
      }],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  if (!railPlan) {
    railPlan = buildReferenceDerivedRail({
      book: input.book,
      activeArcId: activeArc.id,
      activeArcTitle: activeArc.title,
      activeArcPayoff: activeArc.payoff,
      spineReference: transformation.spineReference,
      now: timestamp,
    });
    await railStore.validateForSave(railPlan);
  }

  const writes = [];
  const transformationMissing = !(await referenceStore.loadTransformation(false));
  const railMissing = !(await railStore.load());
  if (transformationMissing) {
    writes.push({
      relativePath: join("story", "reference_transformation.json"),
      content: `${JSON.stringify(transformation, null, 2)}\n`,
    });
  }
  if (railMissing) {
    writes.push({
      relativePath: join("story", "rails", "plan.json"),
      content: `${JSON.stringify(railPlan, null, 2)}\n`,
    });
  }
  if (writes.length > 0) {
    await commitAtomicFileSet({ rootDir: input.bookDir, writes });
  }
  return {
    referencePackId: readyReference?.binding.referencePackId,
    spineReference: readyReference?.binding.spineReference,
    transformationCreated: transformationMissing,
    railCreated: railMissing,
    transformationSha256: await fileSha256(referenceStore.transformationPath),
    railPlanSha256: await fileSha256(join(input.bookDir, "story", "rails", "plan.json")),
    arcId: activeArc.id,
    ...(planningAdmission ? { planningAdmissionSha256: planningAdmission.entryContractSha256 } : {}),
  };
}

function buildReferenceDerivedRail(input: {
  readonly book: BookConfig;
  readonly activeArcId: string;
  readonly activeArcTitle: string;
  readonly activeArcPayoff: string;
  readonly spineReference: string;
  readonly now: string;
}): StoryRailPlan {
  const anchorSpecs = [
    ["A1-entry-proof", `${input.activeArcTitle}: 첫 증명`, "현재의 무시와 결핍을 구체적 행동으로 뒤집는다", input.activeArcPayoff || "첫 보상을 눈에 보이게 지급한다"],
    ["A2-independent-leverage", "독립 지렛대 확보", "타인의 허락 없이 다음 판을 고를 자원과 실행자를 확보한다", "돈·계약·권한의 첫 비가역 지급"],
    ["A3-operating-expansion", "운영 확장", "한 번의 성공을 반복 가능한 조직과 거래 엔진으로 바꾼다", "소유권과 실행권의 누적"],
    ["A4-public-reversal", "공개 역전", "반대자가 보는 앞에서 힘의 순서를 뒤집는다", "평판·관계·직책의 공개 지급"],
    ["A5-ownership-leap", "소유권 도약", "부분 승리를 산업·계열·가문의 지배권으로 확장한다", "더 큰 자산과 선택권"],
    ["A6-final-choice", "최종 선택", "축적한 힘으로 작품의 최초 결핍과 관계 약속을 닫는다", "물질 결산과 인간적 결산의 동시 지급"],
  ] as const;
  const anchors = anchorSpecs.map(([id, title, irreversibleChange, payoffAxis], index) => ({
    id,
    routeOrder: index,
    title,
    detailLevel: index < 2 ? "compound" as const : "sparse" as const,
    state: "planned" as const,
    entryState: index < 2 ? `주축 ${input.spineReference}의 직전 보상에서 더 큰 압력이 열린 상태` : "",
    trigger: index < 2 ? "주인공이 저평가된 자산·인물·정보를 실제 거래로 바꿀 기회를 포착한다" : "",
    irreversibleChange,
    humanAftermath: index < 2 ? "상대와 가족·동료가 주인공의 새 권한을 행동과 호칭으로 인정한다" : "",
    readerDebt: "현재 지급에서 열린 더 큰 상대·자산·관계 질문을 갚는다",
    payoffAxis,
    nextPressure: "지급 직후 더 큰 자산·상대·실행 비용이 열린다",
  }));
  const remainingArcSlots = Math.max(5, Math.ceil((input.book.targetChapters - 3) / 3));
  const base = Math.floor(remainingArcSlots / 5);
  const extra = remainingArcSlots % 5;
  const capacityReservations = anchors.slice(1).map((anchor, index) => ({
    targetAnchorId: anchor.id,
    arcCount: Math.max(1, base + (index >= 5 - extra ? 1 : 0)),
  }));
  return StoryRailPlanSchema.parse({
    version: 1,
    bookId: input.book.id,
    anchorRail: { status: "ready", anchors },
    arcRouteRail: {
      status: "ready",
      entries: [{
        bId: "B1-active-entry",
        routeOrder: 0,
        status: "active",
        targetAnchorId: anchors[0]!.id,
        arcId: input.activeArcId,
        narrativeFunction: "주축 레퍼런스의 Entry→압박→첫 지급을 현재 작품 표면으로 변형한다",
        payoffAxis: anchors[0]!.payoffAxis,
        carriedReaderDebt: anchors[0]!.readerDebt,
        contrastRequirement: "무시받던 위치와 지급 뒤의 권한 변화를 같은 회차 안에서 대비한다",
      }],
      capacityReservations,
    },
    routeCapacity: {
      targetChaptersSnapshot: input.book.targetChapters,
      arcEpisodeCap: 3,
    },
    createdAt: input.now,
    updatedAt: input.now,
  });
}
