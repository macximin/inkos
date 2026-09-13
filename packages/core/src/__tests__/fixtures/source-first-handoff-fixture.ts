import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WEBNOVEL_PLAN_SECTIONS_V1 } from "../../planning/webnovel-plan-format.js";
import { hashEntryContract } from "../../planning/entry-contract.js";
import { hashCanonicalJson } from "../../storyyard/pitch-review-packet.js";
import type { SourceFirstHandoffSubject } from "../../planning/source-first-handoff.js";

export const HANDOFF_NOW = "2026-09-12T08:00:00.000Z";
export const hashBytes = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
export async function fixtureFile(root: string, path: string, value: unknown) {
  const bytes = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(join(root, path), bytes);
  return { path, sha256: hashBytes(bytes) };
}

/** Deliberately synthetic: these approvals and source passages must never be exported as owner evidence. */
export async function sourceFirstReferenceFixture(root: string) {
  const sourceProse = ["검수된 원문: 칭찬만 받지 않고 자기 지분을 요구하여 얻는다.", "두 번째 거래에서는 상대가 계약의 조건을 바꾼다.", "주인공은 미리 확보한 채권으로 자기 몫을 지킨다.", "입금된 돈으로 다음 거래를 골라 움직인다."];
  const source = sourceProse.map((body, i) => `ⓚ${i + 1}. 합성 사례\n${body}`).join("\n");
  const offsets = [...source.matchAll(/^ⓚ/gmu)].map((match) => match.index!);
  const story = sourceProse.map((prose, i) => ({ sequence: i + 1, visibleLabel: `${i + 1}화`, title: "합성 사례", arcId: "TEST-N01",
    sourceLineRange: { start: i * 2 + 1, end: i * 2 + 2 }, sourceCharacterRange: { start: offsets[i]!, end: offsets[i + 1] ?? source.length }, marker: `ⓚ${i + 1}. 합성 사례`,
    functions: { entryState: "거래 전", readerPromise: "자기 몫", protagonistGoal: "소유", action: "계약", resistanceOrCost: "조건 협상", turnOrReveal: "채권", paidReward: "입금", stateChange: "결정권", endingHook: "다음 거래" },
    surfaceRefs: { peopleAndPlaces: "합성 인물", locations: "회의실" }, rawProseSha256: hashBytes(prose),
  }));
  const styles = sourceProse.slice(0, 3).map((prose, i) => ({ id: `style-${i + 1}`, phaseId: "phase-1", function: ["entry", "escalation", "payoff"][i], sequence: i + 1, arcId: "TEST-N01", prose, rawProseSha256: hashBytes(prose) }));
  const sourceFile = await fixtureFile(root, "source.md", source);
  const storyFile = await fixtureFile(root, "story-index.jsonl", story.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const styleFile = await fixtureFile(root, "style-examples.jsonl", styles.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const pack = {
    version: 1, kind: "reference-transformation-pack", id: "synthetic-ownership-fixture", language: "ko",
    source: { workSlug: "synthetic-ownership-fixture", workTitle: "계약 검증용 합성 원작", sourceSha256: sourceFile.sha256, chapterCount: 4, naturalArcCount: 1, goldStatus: "synthetic-fixture-only" },
    privateInputs: { storyIndexSha256: storyFile.sha256, styleExamplesSha256: styleFile.sha256, privateIndexSha256: hashBytes("synthetic index") },
    storyRetrieval: { indexedChapterCount: 4, defaultMappedChapterLimit: 4, authority: ["raw_source"] },
    styleRetrieval: { method: "synthetic-fixture", sampleCount: 3, samples: styles.map(({ prose: _prose, ...row }) => row), defaultSampleLimit: 3, hilRetrySampleLimit: 5 },
    transformationPolicy: { requiredSpineReference: true, reusableLayers: ["event-order"], selectableSurfaceVariation: ["people"], linkedConsequences: ["money"] },
    commercialPolicy: { priority: ["commerciality"], similarityPenalty: false, minimumDistanceScore: null, automaticRewriteForOverlap: false, humanPolishDecision: true },
    corpusMetrics: {}, phases: [{ phaseId: "phase-1", progressRange: { start: 0, end: 1 }, sourceChapterRange: { start: 1, end: 4 }, metrics: {}, styleSampleIds: styles.map((row) => row.id) }],
  };
  const packFile = await fixtureFile(root, "source-pack.json", pack);
  const receiptFile = await fixtureFile(root, "source-receipt.json", { schemaVersion: "synthetic-source-receipt/v1", packId: pack.id, packSha256: packFile.sha256, sourceSha256: sourceFile.sha256, storyIndexSha256: storyFile.sha256, styleExamplesSha256: styleFile.sha256 });
  const structureInputs = [];
  for (const role of ["project-bible", "chapter-map", "arc-atlas"]) structureInputs.push({ role, ...await fixtureFile(root, `${role}.md`, `# ${role}\n합성 구조 근거만 들어 있다.\n`) });
  const sourceBinding = { schemaVersion: "firefly_pitch_source_binding/v1", packId: pack.id, packSha256: packFile.sha256, sourceSha256: sourceFile.sha256,
    sourceWork: { workSlug: pack.source.workSlug, workTitle: pack.source.workTitle },
    storyIndex: { ...storyFile, selected: story.map(({ sequence, arcId, sourceLineRange, sourceCharacterRange, rawProseSha256 }) => ({ sequence, arcId, sourceLineRange, sourceCharacterRange, rawProseSha256 })) },
    styleExamples: { ...styleFile, selected: styles.map(({ id, sequence, arcId, rawProseSha256 }) => ({ id, sequence, arcId, rawProseSha256 })) }, structureInputs,
  };
  return { pack, sourceBinding, files: { pack: packFile, source: sourceFile, receipt: receiptFile } };
}

export async function sourceFirstHandoffFixture(root: string, subject: SourceFirstHandoffSubject, reference: Awaited<ReturnType<typeof sourceFirstReferenceFixture>>) {
  const bookId = subject.bookId;
  const candidate = subject.candidate as any;
  const railPlan = { version: 1, bookId, anchorRail: { status: "ready", anchors: Array.from({ length: 6 }, (_, i) => ({ id: `A${i + 1}`, routeOrder: i,
    title: `기획 목적지 ${i + 1}`, detailLevel: i < 2 ? "compound" : "sparse", state: "planned", entryState: "이전 구간에서 얻은 자원", trigger: "주인공의 다음 선택",
    irreversibleChange: "자기 몫을 지킨다", humanAftermath: "마음 놓고 다음 거래를 고른다", readerDebt: "기다리던 지급", payoffAxis: "소유", nextPressure: "다음 거래 상대" })) },
    arcRouteRail: { status: "ready", entries: [{ bId: "B1", routeOrder: 0, status: "active", targetAnchorId: "A1", arcId: "opening-arc",
      narrativeFunction: "첫 소유를 얻는 선택", payoffAxis: "소유", carriedReaderDebt: "자기 몫의 지급", contrastRequirement: "다음 상대의 조건은 다르다" }],
      capacityReservations: [2, 3, 4, 5, 6].map((n) => ({ targetAnchorId: `A${n}`, arcCount: 14 })) },
    routeCapacity: { targetChaptersSnapshot: 200, arcEpisodeCap: 3 }, createdAt: HANDOFF_NOW, updatedAt: HANDOFF_NOW };
  const activeArc = { version: 1, id: "opening-arc", bookId, title: "첫 거래의 자기 몫", status: "ready", episodeCount: 1, chapterNumbers: [1],
    openingState: "거래를 앞두었다", promise: "자기 몫을 지키는 선택", goal: "자기 지분 확보", obstacle: "상대의 조건", pressure: "계약 협상", turn: "채권 사용",
    payoff: "자기 계좌의 입금", irreversibleChange: "자기 지분이 생긴다", nextHook: "다음 거래 선택", episodeBeats: [{ chapterNumber: 1, role: "payoff", beats: ["조건 비교", "지분 요구", "자기 몫 지급"], endingHook: "다음 거래 선택" }],
    characterChanges: [], relationshipChanges: [], worldChanges: [], hookOperations: [], mustKeep: [], mustAvoid: [], styleEmphasis: [], createdAt: HANDOFF_NOW, updatedAt: HANDOFF_NOW };
  const transformation = { version: 1, kind: "reference-transformation", bookId, referencePackId: reference.pack.id, spineReference: reference.pack.source.workSlug, supportingReferences: [],
    sourceSegments: [{ id: "opening", sourceArcIds: ["TEST-N01"], sourceChapterIds: [1, 2, 3, 4], targetRailAnchorIds: ["A1"], targetArcIds: ["opening-arc"], retain: ["engine", "payoff"], varySurface: ["people"], linkedConsequences: ["money"] }],
    createdAt: HANDOFF_NOW, updatedAt: HANDOFF_NOW };
  const foundationFiles = [];
  const foundations = { "story_bible.md": "# 이야기\n기획에 있는 자기 소유와 선택의 합성 이야기다.\n", "volume_outline.md": "# 전체 구간\n첫 소유를 얻고 다음 거래를 고른다.\n", "character_matrix.md": "# 인물\n## 정시우\n자기 몫을 고르는 합성 인물이다.\n", "book_rules.md": "# 작품 규칙\n이 fixture에서 새 강제 금지는 지정하지 않았다.\n", "current_state.md": "# 현재 상태\n아직 첫 회차는 시작하지 않았다.\n", "pending_hooks.md": "# 복선\n아직 실제 원고의 복선은 기록되지 않았다.\n" };
  for (const [target, content] of Object.entries(foundations)) foundationFiles.push({ target, file: await fixtureFile(root, `foundation-${target}`, content) });
  const targets = [...foundationFiles.map((item) => `foundation/${item.target}`), ...Object.entries(candidate.entryContract).flatMap(([section, fields]) => Object.keys(fields as object).map((field) => `entryContract/${section}/${field}`)),
    ...railPlan.anchorRail.anchors.map((item) => `anchor/${item.id}`), "route/B1", "arc/opening-arc", "transformation/opening"];
  const { bookId: _book, candidate: _candidate, ...source } = subject;
  const planText = candidate.projectPlan.markdown;
  const mapping = { schemaVersion: "firefly_source_first_handoff_mapping/v1", bookId, source, ...reference, foundationFiles, railPlan, activeArc, transformation,
    evidence: targets.map((target) => ({ target, planSpan: { start: 0, end: planText.length, sha256: hashBytes(planText) }, reason: "합성 fixture의 명시적 매핑이며 내용 심사 결과를 뜻하지 않는다." })) } as any;
  delete mapping.pack;
  const authorization = { schemaVersion: "firefly_source_first_handoff_authorization/v1", mappingSha256: "",
    admission: { schemaVersion: "firefly_planning_admission/v1", bookId, status: "approved", entryContract: candidate.entryContract,
      entryContractSha256: hashEntryContract(candidate.entryContract), sourceSlateId: subject.slateId, sourceSlateSha256: subject.sourceSlateSha256,
      sourceReviewSha256: subject.sourceReviewSha256, sourceDecisionSha256: subject.sourceDecisionSha256, approvedAt: HANDOFF_NOW },
    authorizedBy: "synthetic-test-fixture-never-real-owner-approval", canonEffect: "planning-seed-only", manuscriptAuthorized: false };
  async function save() {
    const mappingRef = await fixtureFile(root, "handoff-mapping.json", mapping);
    authorization.mappingSha256 = mappingRef.sha256;
    const authorizationRef = await fixtureFile(root, "handoff-authorization.json", authorization);
    return fixtureFile(root, "handoff.json", { schemaVersion: "firefly_source_first_handoff/v1", mapping: mappingRef, authorization: authorizationRef });
  }
  await save();
  return { mapping, authorization, save, manifestPath: "handoff.json" };
}

export function handoffFixturePlan(markdown: string): string {
  return markdown.replace(/^## (\d)\. [^\n]+/gmu, (_match, number) => `## ${number}. ${WEBNOVEL_PLAN_SECTIONS_V1[Number(number) - 1]}`);
}

export async function standaloneHandoffFixture(root: string) {
  const reference = await sourceFirstReferenceFixture(root);
  const packet = JSON.parse(await readFile(new URL("./source-first-pitch-review-v3.json", import.meta.url), "utf8"));
  const candidate = packet.candidates[0];
  candidate.projectPlan.markdown = handoffFixturePlan(candidate.projectPlan.markdown);
  candidate.candidateId = candidate.id; delete candidate.id; delete candidate.sha256;
  candidate.spineRetention.primaryReference = { packId: reference.pack.id, packSha256: reference.sourceBinding.packSha256, sourceSha256: reference.sourceBinding.sourceSha256 };
  const nativeDir = ".inkos/pitch-slates/handoff-slate";
  await mkdir(join(root, nativeDir, "survival-review"), { recursive: true });
  await mkdir(join(root, nativeDir, "human-decision"), { recursive: true });
  const slateRef = await fixtureFile(root, `${nativeDir}/slate.json`, { schemaVersion: 2, slateId: "handoff-slate", planningMode: "source-first", canonStatus: "non-canonical", candidates: [candidate] });
  const reviewRef = await fixtureFile(root, `${nativeDir}/survival-review/review.json`, { slateId: "handoff-slate", sourceSlateSha256: slateRef.sha256, reviewKind: "independent-blind-comparison", humanDecision: "pending" });
  const decisionRef = await fixtureFile(root, `${nativeDir}/human-decision/decision.json`, { slateId: "handoff-slate", candidateId: "p01", decision: "select", sourceSlateSha256: slateRef.sha256, sourceReviewSha256: reviewRef.sha256, canonEffect: "planning-selection-only", manuscriptAuthorized: false });
  const subject = { bookId: "handoff-book", slateId: "handoff-slate", candidateId: "p01", candidateSha256: hashCanonicalJson(candidate),
    sourceSlateSha256: slateRef.sha256, sourceReviewSha256: reviewRef.sha256, sourceDecisionSha256: decisionRef.sha256, candidate };
  const handoff = await sourceFirstHandoffFixture(root, subject, reference);
  const book = { id: subject.bookId, title: "합성 전달 검증", platform: "other", genre: "chaebol-modern-fantasy-ko", status: "outlining", targetChapters: 200,
    chapterWordCount: 5000, language: "ko", createdAt: HANDOFF_NOW, updatedAt: HANDOFF_NOW, writing: { reviewMode: "manual", entryContractPolicy: "auto-required", referencePackId: reference.pack.id, spineReference: reference.pack.source.workSlug } } as const;
  async function initBook() { const bookDir = join(root, "books", book.id); await mkdir(join(bookDir, "story"), { recursive: true }); await fixtureFile(root, `books/${book.id}/book.json`, book); return bookDir; }
  return { reference, subject, handoff, book, initBook };
}
