import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPitchCandidateIssues, createPitchCommand, preparePitchSurvivalReview, validatePitchCandidate, validatePitchSurvivalReview } from "../commands/pitch.js";
import { assertNoPitchSelfJudgment, preparePitchReviewCandidates, sourceFirstCandidateGuidance, SOURCE_FIRST_REVIEW_GUIDANCE } from "../commands/source-first-pitch.js";

const mocks = vi.hoisted(() => ({
  projectRoot: "/tmp/inkos-pitch-test",
  runAgentSession: vi.fn(),
}));

vi.mock("@actalk/inkos-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actalk/inkos-core")>();
  return {
    ...actual,
    defaultChapterLength: vi.fn(() => 5000),
    normalizePlatformOrOther: vi.fn(() => "other"),
    PipelineRunner: class PipelineRunnerMock {
      constructor(_config: unknown) {}
    },
    runAgentSession: mocks.runAgentSession,
    loadBuiltinSkillResource: vi.fn(async (skillId: string) => `rubric for ${skillId}`),
  };
});

vi.mock("../utils.js", () => ({
  buildPipelineConfig: vi.fn(() => ({})),
  createClient: vi.fn(() => ({
    _piModel: { id: "test", provider: "openai", api: "openai-completions" },
    _apiKey: "test-key",
  })),
  findProjectRoot: vi.fn(() => mocks.projectRoot),
  loadConfig: vi.fn(async () => ({
    language: "ko",
    llm: { provider: "openai", model: "test" },
  })),
}));

function candidate(candidateId = "p01") {
  return {
    candidateId,
    titleCandidates: ["망한 그룹을 먹는 재벌 3세", "부도 직전, 막내가 돌아왔다"],
    oneLinePromise: "회귀한 실무자가 부실 계열사를 헐값에 사들여 그룹의 주인이 된다.",
    primaryReference: "주축 참고작의 인수 성장 사다리와 지급 리듬",
    preservedSkeleton: ["부실기업 인수", "숫자로 승부", "가족의 대우 변화"],
    surfaceVariation: "증권 대신 구조조정 현장과 지방 공장으로 옮긴다.",
    linkedCausalAdjustments: ["담보, 채권자, 자금 조달과 첫 고용 승계를 함께 바꾼다."],
    protagonist: {
      startingIdentity: "그룹에서 쫓겨난 구조조정 실무자",
      repeatedVerb: "싸게 사고 정상화한다",
      firstAsset: "부도 기업의 숨은 수주 장부",
    },
    entryContract: {
      humanDrive: {
        lackOrHumiliation: "그룹에서 쫓겨나 전생의 구조조정 책임까지 뒤집어썼다.",
        personalDesire: "자기 이름으로 그룹의 주인이 되어 누구도 다시 내쫓지 못하게 한다.",
        selfInterest: "첫 공장과 현금을 자기 법인의 소유로 확정한다.",
        emotionalCostLimit: "모욕은 첫 장면에서 끝내고 주인공이 곧바로 거래 선택권을 행사한다.",
      },
      purpose: {
        seriesWhat: "재벌그룹의 지배권을 자기 이름으로 확보한다.",
        arcWhat: "첫 공장과 운영팀을 소유한 독립 법인 대표가 된다.",
        chapterWant: "오늘 채권 매각 전에 계약금을 걸고 공장 열쇠를 확보한다.",
        whyNow: "오늘 입찰을 놓치면 공장이 철거되고 숨은 수주 장부도 사라진다.",
      },
      commercialPromise: {
        currentSituation: "철거 입찰까지 세 시간이 남은 지방 공장에서 비서실장이 출입을 막는다.",
        repeatableReaderFantasy: "버려진 남자가 남들이 버린 회사를 먼저 사서 자기 기업 제국으로 키운다.",
        howAdvantage: "전생의 부도 시점과 숨은 수주를 알고 실제 채권 계약으로 선점한다.",
        firstPayoff: "공장 열쇠와 법인 소유권, 첫 입금 3천만 원을 얻는다.",
        payoffWitness: "그를 내쫓던 비서실장과 현장 직원들이 대표라고 부른다.",
        nextPaymentQuestion: "첫 공장의 숨은 수주로 다음 부실 계열사까지 살 수 있는가.",
      },
    },
    openingEpisodes: [1, 2, 3, 4].map((episode) => ({
      episode,
      event: `${episode}화 행동과 압박`,
      visiblePayoff: `${episode}화 돈과 대우 변화`,
    })),
    firstReward: "2화에 현금 3천만 원, 4화에 가족 식탁의 자리를 얻는다.",
    railA: ["첫 공장", "계열사 편입", "그룹 지배"],
    railB: ["아버지의 인정", "형제의 견제", "현장 동료의 선택"],
    arcLadder: [1, 2, 3, 4, 5, 6].map((arc) => ({
      arc,
      externalMove: `${arc}단계 인수 승부`,
      visibleReward: `${arc}단계 돈과 자산`,
      relationshipConversion: `${arc}단계 대우 변화`,
    })),
    supportingReferenceRoutes: [{ reference: "보조 참고작", role: "가족 보상 장면", targetArc: "Arc 1" }],
    longRunRisk: "인수 대상이 반복적으로 보일 수 있다.",
    commercialScore: {
      promise: 19,
      earlyPayoff: 19,
      repeatEngine: 18,
      railConversion: 18,
      longRunSupply: 17,
      total: 91,
    },
    decision: "pending",
  };
}

function survivalReview() {
  return {
    winnerCandidateId: "p01",
    ranking: ["p01", "p02"],
    verdicts: [
      {
        candidateId: "p01",
        verdict: "SURVIVE",
        independentScore: { promise: 19, earlyPayoff: 19, repeatEngine: 18, railConversion: 18, longRunSupply: 18, total: 92 },
        entryGate: {
          passed: true,
          protagonistNow: "쫓겨난 구조조정 실무자",
          personalWant: "자기 이름으로 그룹을 차지한다",
          whyNow: "오늘 공장이 철거된다",
          repeatableFantasy: "버린 회사를 사서 기업 제국을 만든다",
          chapterGoal: "채권 계약금을 걸고 공장 열쇠를 얻는다",
          failureReasons: [] as string[],
        },
        decisiveStrength: "첫 보상이 더 빠르고 관계 변화가 선명하다.",
        decisiveRisk: "중반 인수전이 반복될 수 있다.",
        requiredRepair: "Arc별 승부 수단을 분리한다.",
      },
      {
        candidateId: "p02",
        verdict: "HOLD",
        independentScore: { promise: 18, earlyPayoff: 17, repeatEngine: 18, railConversion: 17, longRunSupply: 18, total: 88 },
        entryGate: {
          passed: true,
          protagonistNow: "쫓겨난 구조조정 실무자",
          personalWant: "자기 이름으로 그룹을 차지한다",
          whyNow: "오늘 공장이 철거된다",
          repeatableFantasy: "버린 회사를 사서 기업 제국을 만든다",
          chapterGoal: "채권 계약금을 걸고 공장 열쇠를 얻는다",
          failureReasons: [] as string[],
        },
        decisiveStrength: "채권 회수 엔진이 명확하다.",
        decisiveRisk: "초반 개인 소유권이 약하다.",
        requiredRepair: "첫 자산의 개인 귀속을 명시한다.",
      },
    ],
    comparisonReason: "p01이 더 빨리 결제되고 가족 대우 변화가 강하다.",
    humanDecision: "pending",
  };
}

describe("pitch slate command", () => {
  let root: string;
  let stdout: string[];

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(join(tmpdir(), "inkos-pitch-"));
    mocks.projectRoot = root;
    stdout = [];
    process.exitCode = 0;
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = 0;
    await rm(root, { recursive: true, force: true });
  });

  async function sourceFirstSetup() {
    const packet = JSON.parse(readFileSync(new URL("../../../core/src/__tests__/fixtures/source-first-pitch-review-v3.json", import.meta.url), "utf8"));
    const fixture = packet.candidates[0];
    const pack = { kind: "reference-transformation-pack", id: fixture.spineRetention.primaryReference.packId,
      source: { workSlug: fixture.spineRetention.referenceDisclosure.workSlug, workTitle: fixture.spineRetention.referenceDisclosure.workTitle,
        sourceSha256: fixture.spineRetention.primaryReference.sourceSha256, chapterCount: 100 } };
    const packText = JSON.stringify(pack);
    const packPath = join(root, "source-pack.json");
    const sourcePath = join(root, "source.md");
    await writeFile(packPath, packText);
    await writeFile(sourcePath, "검수된 원문: 칭찬만 받지 않고 자기 지분을 요구하여 얻는다.");
    const binding = { ...fixture.spineRetention.primaryReference, packSha256: createHash("sha256").update(packText).digest("hex") };
    function sourceCandidate(id = "p01") {
      return { ...candidate(id), railB: [], supportingReferenceRoutes: [] as Array<{ reference: string; role: string; targetArc: string }>,
        arcLadder: candidate(id).arcLadder.map((arc) => ({ ...arc, relationshipConversion: null })),
        spineRetention: { ...fixture.spineRetention, primaryReference: binding }, projectPlan: fixture.projectPlan };
    }
    const review = survivalReview();
    const sourceReview = { ...review, verdicts: review.verdicts.map((verdict) => ({ ...verdict,
      sourceChecks: { selfInterest: { passed: true, evidence: "자기 지분을 먼저 요구하는 선택을 확인했다." },
        sourceFidelity: { passed: true, evidence: "원문과 후보의 지분 요구·회수 순서가 일치한다." },
        commercialReading: { assessment: "소유 보상이 읽힌다.", evidence: "직함 대신 지분을 받는 장면이다." } } })) };
    // These are mocked reviewer decisions to test transport/gates, not a semantic oracle.
    const evidence = [{ referencePath: sourcePath, lineStart: 1, lineEnd: 1, basis: "direct-text" }];
    const protagonistContext = {
      sourceFacets: {
        background: { status: "not-in-provided-scope", account: "제공된 한 문장에 출발 배경은 없다.", evidence },
        priorExperience: { status: "not-in-provided-scope", account: "제공된 한 문장으로 과거 경험을 확정하지 않는다.", evidence },
        currentSituation: { status: "established", account: "칭찬 대신 자기 지분을 요구해 얻는다.", evidence },
      },
      causalLinks: [{ sourceExplanation: "현재 선택은 자기 몫을 확보하려는 목적을 드러낸다. 과거 원인은 미확인이다.",
        targetExplanation: "후보가 소유를 얻으려는 목적과 시작 행동을 제시한다. 이 fixture는 심사 전달만 검증한다.", sourceEvidence: evidence,
        candidatePaths: ["/protagonist/startingIdentity", "/entryContract/purpose/seriesWhat", "/entryContract/commercialPromise/howAdvantage", "/openingEpisodes/0/event", "/projectPlan/markdown"] }],
      sourceFacts: { passed: true, evidence: "미확인 과거를 원작의 확정 사실로 보충하지 않았다." },
      goalAndMeans: { passed: true, evidence: "목적과 수단의 후보 위치를 대조한 mock 판단이다." },
      readablePlan: { passed: true, evidence: "기획서 인물 소개와 첫 사건의 연결을 대조한 mock 판단이다." },
    };
    return { packPath, sourcePath, sourceCandidate, sourceReview: { ...sourceReview,
      verdicts: sourceReview.verdicts.map((verdict) => ({ ...verdict, protagonistContext: structuredClone(protagonistContext) })) } };
  }

  it("runs single-source planning, sends the same evidence to review, exports the full plan, and stops promotion", async () => {
    const setup = await sourceFirstSetup();
    mocks.runAgentSession.mockImplementation(async (config: { sessionKind: string }, prompt: string) => ({
      responseText: JSON.stringify(config.sessionKind === "pitch-review" ? setup.sourceReview
        : setup.sourceCandidate(prompt.match(/candidateId는 정확히 (p\d{2})/)?.[1] ?? "p01")), messages: [] }));
    await createPitchCommand({ readInput: async () => "원작의 자기 이익 우선과 가까운 변주만 유지" }).parseAsync([
      "slate", "--id", "source-first", "--source-first", "--source-pack", setup.packPath,
      "--count", "2", "--reference", setup.sourcePath, "--json"], { from: "user" });
    expect(process.exitCode, stdout.join("")).toBe(0);
    const slate = JSON.parse(await readFile(join(root, ".inkos/pitch-slates/source-first/slate.json"), "utf8"));
    expect(slate.planningMode).toBe("source-first");
    expect(slate.protagonistContextPolicy).toBe("protagonist-context/v1");
    expect(slate.candidates[0].supportingReferenceRoutes).toEqual([]);
    await createPitchCommand().parseAsync(["review", "--id", "source-first", "--json"], { from: "user" });
    expect(process.exitCode, stdout.join("")).toBe(0);
    const reviewConfig = mocks.runAgentSession.mock.calls.at(-1)?.[0];
    expect(reviewConfig.backgroundTaskContext).toContain("검수된 원문: 칭찬만 받지 않고 자기 지분을 요구하여 얻는다.");
    expect(reviewConfig.backgroundTaskContext).toContain("source-pack.json");
    const reviewPrompt = mocks.runAgentSession.mock.calls.at(-1)?.[1];
    expect(reviewPrompt).toContain("protagonistContext");
    expect(reviewPrompt).toContain(setup.sourcePath);
    const reviewDocument = JSON.parse(await readFile(join(root, ".inkos/pitch-slates/source-first/survival-review/review.json"), "utf8"));
    expect(reviewDocument.protagonistContextPolicy).toBe(slate.protagonistContextPolicy);
    expect(reviewDocument.verdicts[0].protagonistContext).toEqual(setup.sourceReview.verdicts[0].protagonistContext);
    const reviewText = await readFile(join(root, ".inkos/pitch-slates/source-first/survival-review/review.md"), "utf8");
    expect(reviewText).toContain("제공된 한 문장에 출발 배경은 없다.");
    await createPitchCommand().parseAsync(["export-storyyard", "--id", "source-first", "--out", "review-packet.json", "--json"], { from: "user" });
    expect(process.exitCode, stdout.join("")).toBe(0);
    const exported = JSON.parse(await readFile(join(root, "review-packet.json"), "utf8"));
    expect(exported.candidates[0].sourcePremise).toBeUndefined();
    expect(exported.candidates[0].independentReview.protagonistContext).toBeUndefined();
    expect(exported.schemaVersion).toBe("firefly_review_packet/v3");
    expect(exported.candidates[0].projectPlan).toEqual(setup.sourceCandidate().projectPlan);
    expect(exported.candidates[0].spineRetention.schemaVersion).toBe("firefly_spine_retention/v2");
    expect(exported.candidates[0].independentReview.sourceChecks).toEqual(setup.sourceReview.verdicts[0].sourceChecks);
    const readable = await readFile(join(root, ".inkos/pitch-slates/source-first/review.md"), "utf8");
    expect(readable).toContain(setup.sourceCandidate().projectPlan.markdown);
    await createPitchCommand({ readInput: async () => "test fixture selection" }).parseAsync(["decision", "--id", "source-first", "--candidate", "p01", "--decision", "select", "--json"], { from: "user" });
    expect(process.exitCode, stdout.join("")).toBe(0);
    const decision = JSON.parse(await readFile(join(root, ".inkos/pitch-slates/source-first/human-decision/decision.json"), "utf8"));
    expect(decision.canonEffect).toBe("planning-selection-only");
    await createPitchCommand().parseAsync(["promote", "--id", "source-first", "--book", "not-created", "--json"], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect(stdout.join("")).toContain("Source-first Book promotion is not supported");
    await expect(readFile(join(root, "books/not-created/book.json"))).rejects.toThrow();
  });

  it("requires the new independent context record and rechecks it on export and decision", async () => {
    const setup = await sourceFirstSetup();
    mocks.runAgentSession.mockImplementation(async (config: { sessionKind: string }, prompt: string) => ({
      responseText: JSON.stringify(config.sessionKind === "pitch-review" ? setup.sourceReview
        : setup.sourceCandidate(prompt.match(/candidateId는 정확히 (p\d{2})/)?.[1] ?? "p01")), messages: [] }));
    await createPitchCommand({ readInput: async () => "배경과 선택을 복원한다" }).parseAsync([
      "slate", "--id", "context-gate", "--source-first", "--source-pack", setup.packPath,
      "--count", "2", "--reference", setup.sourcePath, "--json"], { from: "user" });
    expect(process.exitCode, stdout.join("")).toBe(0);
    const valid = structuredClone(setup.sourceReview);
    for (const verdict of setup.sourceReview.verdicts) delete (verdict as Record<string, unknown>).protagonistContext;
    await createPitchCommand().parseAsync(["review", "--id", "context-gate", "--json"], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect(stdout.join("")).toContain("protagonistContext");
    const reviewPath = join(root, ".inkos/pitch-slates/context-gate/survival-review/review.json");
    await expect(readFile(reviewPath)).rejects.toThrow();
    setup.sourceReview = valid;
    process.exitCode = 0;
    await createPitchCommand().parseAsync(["review", "--id", "context-gate", "--session", "context-valid", "--json"], { from: "user" });
    expect(process.exitCode, stdout.join("")).toBe(0);
    const stored = JSON.parse(await readFile(reviewPath, "utf8"));
    stored.verdicts[0].protagonistContext.goalAndMeans = { passed: false, evidence: "출처 없는 능력을 추가했다." };
    await writeFile(reviewPath, JSON.stringify(stored));
    await createPitchCommand().parseAsync(["export-storyyard", "--id", "context-gate", "--out", "blocked-context.json", "--json"], { from: "user" });
    expect(process.exitCode).toBe(1);
    await expect(readFile(join(root, "blocked-context.json"))).rejects.toThrow();
    process.exitCode = 0;
    await createPitchCommand({ readInput: async () => "test" }).parseAsync(["decision", "--id", "context-gate", "--candidate", "p01", "--decision", "select", "--json"], { from: "user" });
    expect(process.exitCode).toBe(1);
    await expect(readFile(join(root, ".inkos/pitch-slates/context-gate/human-decision/decision.json"))).rejects.toThrow();
  });

  it("keeps old source-first slates readable without rewriting them or claiming the new review", async () => {
    const setup = await sourceFirstSetup();
    mocks.runAgentSession.mockImplementation(async (config: { sessionKind: string }, prompt: string) => ({
      responseText: JSON.stringify(config.sessionKind === "pitch-review" ? setup.sourceReview
        : setup.sourceCandidate(prompt.match(/candidateId는 정확히 (p\d{2})/)?.[1] ?? "p01")), messages: [] }));
    await createPitchCommand({ readInput: async () => "이전 기획 fixture" }).parseAsync([
      "slate", "--id", "legacy-context", "--source-first", "--source-pack", setup.packPath,
      "--count", "2", "--reference", setup.sourcePath, "--json"], { from: "user" });
    const path = join(root, ".inkos/pitch-slates/legacy-context/slate.json");
    const slate = JSON.parse(await readFile(path, "utf8"));
    delete slate.protagonistContextPolicy;
    const legacyBytes = JSON.stringify(slate);
    await writeFile(path, legacyBytes);
    for (const verdict of setup.sourceReview.verdicts) delete (verdict as Record<string, unknown>).protagonistContext;
    await createPitchCommand().parseAsync(["review", "--id", "legacy-context", "--json"], { from: "user" });
    expect(process.exitCode, stdout.join("")).toBe(0);
    await createPitchCommand().parseAsync(["export-storyyard", "--id", "legacy-context", "--out", "legacy-context.json", "--json"], { from: "user" });
    expect(process.exitCode, stdout.join("")).toBe(0);
    expect(await readFile(path, "utf8")).toBe(legacyBytes);
    const stored = JSON.parse(await readFile(join(root, ".inkos/pitch-slates/legacy-context/survival-review/review.json"), "utf8"));
    expect(stored.protagonistContextPolicy).toBeUndefined();
    expect(await readFile(join(root, ".inkos/pitch-slates/legacy-context/survival-review/review.md"), "utf8")).toContain("새 기준 미검증");
  });

  it("normalizes source-first prose before storage and reviews and exports those exact plan and evidence values", async () => {
    const setup = await sourceFirstSetup();
    const expected = structuredClone(setup.sourceCandidate());
    mocks.runAgentSession.mockImplementation(async (config: { sessionKind: string }, prompt: string) => {
      if (config.sessionKind === "pitch-review") return { responseText: JSON.stringify(setup.sourceReview), messages: [] };
      const generated = structuredClone(setup.sourceCandidate(prompt.match(/candidateId는 정확히 (p\d{2})/)?.[1] ?? "p01"));
      generated.projectPlan.markdown = `\n ${generated.projectPlan.markdown}\n\t`;
      generated.spineRetention.sourceReconstruction.personalGoal = `\t${generated.spineRetention.sourceReconstruction.personalGoal}\n`;
      generated.spineRetention.rewards[0].targetReward = ` ${generated.spineRetention.rewards[0].targetReward} `;
      return { responseText: JSON.stringify(generated), messages: [] };
    });
    await createPitchCommand({ readInput: async () => "원작의 목적과 지급을 유지한다" }).parseAsync([
      "slate", "--id", "source-normalization", "--source-first", "--source-pack", setup.packPath,
      "--count", "2", "--reference", setup.sourcePath, "--json"], { from: "user" });
    expect(process.exitCode, stdout.join("")).toBe(0);
    const slatePath = join(root, ".inkos/pitch-slates/source-normalization/slate.json");
    const originalBytes = await readFile(slatePath);
    const slate = JSON.parse(originalBytes.toString("utf8"));
    expect(slate.candidates[0].projectPlan).toEqual(expected.projectPlan);
    expect(slate.candidates[0].spineRetention).toEqual(expected.spineRetention);

    await createPitchCommand().parseAsync(["review", "--id", "source-normalization", "--json"], { from: "user" });
    expect(process.exitCode, stdout.join("")).toBe(0);
    const reviewPrompt = mocks.runAgentSession.mock.calls.at(-1)?.[1] as string;
    expect(reviewPrompt).toContain(JSON.stringify(slate.candidates[0].projectPlan.markdown));
    expect(reviewPrompt).toContain(JSON.stringify(slate.candidates[0].spineRetention.sourceReconstruction.personalGoal));

    await createPitchCommand().parseAsync(["export-storyyard", "--id", "source-normalization", "--out", "normalized-packet.json", "--json"], { from: "user" });
    expect(process.exitCode, stdout.join("")).toBe(0);
    const exported = JSON.parse(await readFile(join(root, "normalized-packet.json"), "utf8"));
    const { FireflyPitchReviewPacketV3Schema } = await import("@actalk/inkos-core");
    expect(FireflyPitchReviewPacketV3Schema.safeParse(exported).success).toBe(true);
    expect(exported.candidates[0].projectPlan).toEqual(slate.candidates[0].projectPlan);
    expect(exported.candidates[0].spineRetention).toEqual(slate.candidates[0].spineRetention);
    expect(await readFile(slatePath)).toEqual(originalBytes);
  });

  it("allows instructed source event combinations and reordered mappings while retaining legacy close-scope guidance", async () => {
    const setup = await sourceFirstSetup();
    const value = setup.sourceCandidate();
    value.supportingReferenceRoutes = [{ reference: "제공된 보조 원작 donor.txt 3화 L20~40", role: "자기 물건을 되찾는 실제 사건의 이익·쾌감을 가져온다", targetArc: "후보1화, 투자자금 확보보다 앞에 배치" }];
    value.spineRetention.openingEpisodeMappings[0].sourceBeatSequence = 7;
    value.spineRetention.openingEpisodeMappings[1].sourceBeatSequence = 3;
    value.spineRetention.relationshipConversion = { sourceFunction: "소유를 얻은 뒤 달라지는 원작의 관계", transformedExpression: "새 사건에서 주인공의 소유를 확인한 상대가 물러난다" };
    expect(validatePitchCandidate(value, "p01", "source-first", { ...value.spineRetention.primaryReference, workSlug: value.spineRetention.referenceDisclosure.workSlug, chapterCount: 100 })).toEqual([]);
    const guidance = sourceFirstCandidateGuidance(value.spineRetention.primaryReference);
    expect(guidance).toContain("사건 교체·다른 작품의 실제 사건 조합·배치 변경·투자 아이템 변경");
    expect(guidance).toContain("기존 발주가 이름·표면·특정 순서만 허용했다면 그 좁은 범위를 그대로 지키세요");
    expect(guidance).toContain("자기 목적→개입 이유→우위 사용→자기 이익→구체 쾌감→다음 목적");
    expect(guidance).toContain('"sourceFunction"');
    expect(guidance).toContain('"transformedExpression"');
    expect(guidance).not.toContain("주축 하나만 사용합니다. supportingReferenceRoutes는 []입니다");
    expect(SOURCE_FIRST_REVIEW_GUIDANCE).toContain("원작 복원 사실검사와 신작의 유지/변경 이행 심사를 구분");
    const prepared = preparePitchSurvivalReview({ planningMode: "source-first", instruction: "이름·첫 연회 외장은 유지하되 후반 사건을1화로 옮기고 보조 원작 사건을 조합한다", candidates: [value] });
    expect(prepared.prompt).toContain("후반 사건을1화로 옮기고");
    expect(prepared.prompt).toContain("의도적인 차이와 한 작품 안의 모순은 다릅니다");
    expect(prepared.prompt).toContain("donor.txt");
  });

  it("masks only exact author-score/verdict values across the full plan and proves preserved UTF-8 spans", () => {
    const prose = "# 7. 독자 보상\n도윤은 1,210억 원으로 자기 회사를 키운다. 상업 점수 92점은 편집 가설일 뿐이다.\n# 9. 집필 계획\n후보 상태는 pending으로 둔다. next investment 93억은 남긴다.";
    const original = { ...candidate(), projectPlan: { format: "webnovel-project-plan/v1", markdown: prose }, nested: { note: "Self-score: 93/100. Verdict: SURVIVE. 분석력 S급과 수익20~30%는 원작 근거다." } };
    const snapshot = structuredClone(original);
    const projection = preparePitchReviewCandidates([original]);
    expect(original).toEqual(snapshot);
    expect(() => assertNoPitchSelfJudgment(projection.candidates)).not.toThrow();
    const projected = projection.candidates[0];
    expect(projected.commercialScore).toBeUndefined();
    expect(projected.decision).toBeUndefined();
    expect((projected.projectPlan as { markdown: string }).markdown).toBe(prose.replace("92점", "[작성자 평가값 제외]").replace("pending", "[작성자 평가값 제외]"));
    expect(JSON.stringify(projected)).toContain("1,210억");
    expect(JSON.stringify(projected)).toContain("93억");
    expect(JSON.stringify(projected)).toContain("분석력 S급과 수익20~30%");
    const spans = projection.audit.redactions.filter((redaction) => redaction.path === "/candidates/0/projectPlan/markdown");
    let restored = Buffer.from(prose);
    for (const span of [...spans].reverse()) {
      expect(restored.subarray(span.startByte, span.endByte).toString("utf8")).toBe(span.removed);
      restored = Buffer.concat([restored.subarray(0, span.startByte), Buffer.from(span.replacement!), restored.subarray(span.endByte)]);
    }
    expect(restored.toString("utf8")).toBe((projected.projectPlan as { markdown: string }).markdown);
    expect(projection.audit.verificationLayer).toBe("cli-candidate-payload");
  });

  it("refuses unclear self-evaluation or source-fact edits rather than deleting source or whole plan sections", () => {
    expect(() => preparePitchReviewCandidates([{ ...candidate(), nested: { commercialScore: 92 } }])).toThrow("separate metadata before review");
    expect(() => preparePitchReviewCandidates([{ ...candidate(), projectPlan: { markdown: "상업 점수는 구십이 점이며 인수 사건도 여기에 있다." } }])).toThrow("Unresolved author evaluation");
    expect(() => preparePitchReviewCandidates([{ ...candidate(), spineRetention: { sourceReconstruction: { protagonist: "원작 인물의 자기 점수92점은 검정고시 성적이었다." } } }])).toThrow("source statements must remain unchanged");
    expect(() => preparePitchReviewCandidates([{ ...candidate(), primaryReference: "원작의 PASS 회사는 실제 고유명이다." }])).toThrow("Unresolved author evaluation");
  });

  it("sends and audits the masked full plan in the real review call, preserves references and exports the original plan", async () => {
    const setup = await sourceFirstSetup();
    const value = setup.sourceCandidate();
    value.projectPlan.markdown += "\n상업 점수 92점은 후보 자체의 편집 가설이다. 후보 상태는 pending으로 둔다.";
    mocks.runAgentSession.mockImplementation(async (config: { sessionKind: string }, prompt: string) => ({ responseText: JSON.stringify(config.sessionKind === "pitch-review" ? setup.sourceReview : { ...value, candidateId: prompt.match(/candidateId는 정확히 (p\d{2})/)?.[1] ?? "p01" }), messages: [] }));
    await createPitchCommand({ readInput: async () => "원작의 자기 이익을 유지하고 발주한 사건만 바꾼다" }).parseAsync(["slate", "--id", "masked-source", "--source-first", "--source-pack", setup.packPath, "--count", "2", "--reference", setup.sourcePath, "--json"], { from: "user" });
    expect(process.exitCode, stdout.join("")).toBe(0);
    const path = join(root, ".inkos/pitch-slates/masked-source");
    const originalSlate = await readFile(join(path, "slate.json"));
    await createPitchCommand().parseAsync(["review", "--id", "masked-source", "--json"], { from: "user" });
    expect(process.exitCode, stdout.join("")).toBe(0);
    const call = mocks.runAgentSession.mock.calls.at(-1)!;
    expect(call[0].backgroundTaskContext).toContain(await readFile(setup.sourcePath, "utf8"));
    const payload = JSON.parse(call[1].split("<pitch_candidates>\n")[1].split("\n</pitch_candidates>")[0]);
    expect(payload[0].projectPlan.markdown).toBe(value.projectPlan.markdown.replace("92점", "[작성자 평가값 제외]").replace("pending", "[작성자 평가값 제외]"));
    const audit = JSON.parse(await readFile(join(path, "survival-review/input-projection.json"), "utf8"));
    expect(audit.userPromptSha256).toBe(createHash("sha256").update(call[1]).digest("hex"));
    expect(audit.payloadReadbackVerified).toBe(true);
    expect(audit.redactions.some((item: { path: string }) => item.path === "/candidates/0/projectPlan/markdown")).toBe(true);
    const review = JSON.parse(await readFile(join(path, "survival-review/review.json"), "utf8"));
    expect(review.reviewInputAudit.sha256).toBe(createHash("sha256").update(await readFile(join(path, "survival-review/input-projection.json"))).digest("hex"));
    await createPitchCommand().parseAsync(["export-storyyard", "--id", "masked-source", "--out", "original-content.json", "--json"], { from: "user" });
    expect(process.exitCode, stdout.join("")).toBe(0);
    const exported = JSON.parse(await readFile(join(root, "original-content.json"), "utf8"));
    expect(exported.candidates[0].projectPlan.markdown).toBe(value.projectPlan.markdown);
    expect(await readFile(join(path, "slate.json"))).toEqual(originalSlate);
  });

  it("refuses restored review history before any model call and preserves the old transcript", async () => {
    const slateDir = join(root, ".inkos/pitch-slates/history-leak");
    await mkdir(slateDir, { recursive: true });
    await mkdir(join(root, ".inkos/sessions"), { recursive: true });
    await writeFile(join(slateDir, "slate.json"), JSON.stringify({ schemaVersion: 2, slateId: "history-leak", canonStatus: "non-canonical", candidates: [candidate(), candidate("p02")] }));
    const transcript = join(root, ".inkos/sessions/old-review.jsonl");
    const leaked = '{"message":"기존 입력에 생성자의 상업 점수92점이 있다"}\n';
    await writeFile(transcript, leaked);
    await createPitchCommand().parseAsync(["review", "--id", "history-leak", "--session", "old-review", "--json"], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect(stdout.join("")).toContain("requires a fresh session");
    expect(mocks.runAgentSession).not.toHaveBeenCalled();
    expect(await readFile(transcript, "utf8")).toBe(leaked);
  });

  it("keeps host review identity and reference bindings when the model returns conflicting metadata", async () => {
    const setup = await sourceFirstSetup();
    const overriddenReview = {
      ...setup.sourceReview,
      schemaVersion: 999,
      slateId: "different-model-slate",
      sourceSlateSha256: "b".repeat(64),
      planningMode: "general",
      referenceInputs: [{ path: "unread-source.md", sha256: "c".repeat(64), bytes: 1 }],
      reviewKind: "model-self-review",
      reviewedAt: "1900-01-01T00:00:00.000Z",
      unauthorizedExtra: "This must not become receipt metadata.",
    };
    mocks.runAgentSession.mockImplementation(async (config: { sessionKind: string }, prompt: string) => ({
      responseText: JSON.stringify(config.sessionKind === "pitch-review" ? overriddenReview
        : setup.sourceCandidate(prompt.match(/candidateId는 정확히 (p\d{2})/)?.[1] ?? "p01")), messages: [] }));
    await createPitchCommand({ readInput: async () => "원작의 목적과 지급을 유지한다" }).parseAsync([
      "slate", "--id", "source-review-metadata", "--source-first", "--source-pack", setup.packPath,
      "--count", "2", "--reference", setup.sourcePath, "--json"], { from: "user" });
    expect(process.exitCode, stdout.join("")).toBe(0);
    const slateDir = join(root, ".inkos/pitch-slates/source-review-metadata");
    const slateBytes = await readFile(join(slateDir, "slate.json"));
    const slate = JSON.parse(slateBytes.toString("utf8"));

    await createPitchCommand().parseAsync(["review", "--id", "source-review-metadata", "--json"], { from: "user" });
    expect(process.exitCode, stdout.join("")).toBe(0);
    const review = JSON.parse(await readFile(join(slateDir, "survival-review/review.json"), "utf8"));
    expect(review).toMatchObject({
      schemaVersion: 2,
      slateId: slate.slateId,
      sourceSlateSha256: createHash("sha256").update(slateBytes).digest("hex"),
      planningMode: "source-first",
      reviewKind: "independent-blind-comparison",
      referenceInputs: slate.referenceInputs,
      verdicts: setup.sourceReview.verdicts,
    });
    expect(review.reviewedAt).not.toBe(overriddenReview.reviewedAt);
    expect(review).not.toHaveProperty("unauthorizedExtra");

    await createPitchCommand().parseAsync(["export-storyyard", "--id", "source-review-metadata", "--out", "metadata-packet.json", "--json"], { from: "user" });
    expect(process.exitCode, stdout.join("")).toBe(0);
    const packet = JSON.parse(await readFile(join(root, "metadata-packet.json"), "utf8"));
    expect(packet.candidates[0].independentReview.sourceChecks).toEqual(setup.sourceReview.verdicts[0].sourceChecks);
  });

  it("does not persist a review when its source slate changes while the reviewer is running", async () => {
    const setup = await sourceFirstSetup();
    const slateDir = join(root, ".inkos/pitch-slates/source-review-drift");
    mocks.runAgentSession.mockImplementation(async (config: { sessionKind: string }, prompt: string) => {
      if (config.sessionKind === "pitch-review") {
        const slatePath = join(slateDir, "slate.json");
        const changed = JSON.parse(await readFile(slatePath, "utf8"));
        changed.candidates[0].projectPlan.markdown += "\n\n심사 입력 이후 달라진 기획 내용이다.";
        await writeFile(slatePath, `${JSON.stringify(changed, null, 2)}\n`);
        return { responseText: JSON.stringify(setup.sourceReview), messages: [] };
      }
      return { responseText: JSON.stringify(setup.sourceCandidate(prompt.match(/candidateId는 정확히 (p\d{2})/)?.[1] ?? "p01")), messages: [] };
    });
    await createPitchCommand({ readInput: async () => "원작의 목적과 지급을 유지한다" }).parseAsync([
      "slate", "--id", "source-review-drift", "--source-first", "--source-pack", setup.packPath,
      "--count", "2", "--reference", setup.sourcePath, "--json"], { from: "user" });
    expect(process.exitCode, stdout.join("")).toBe(0);

    await createPitchCommand().parseAsync(["review", "--id", "source-review-drift", "--json"], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect(stdout.join("")).toContain("Pitch slate changed during review");
    await expect(readFile(join(slateDir, "survival-review/review.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(slateDir, "survival-review/review.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects source drift before review and v2 evidence in an unmarked execution", async () => {
    const setup = await sourceFirstSetup();
    expect(validatePitchCandidate(setup.sourceCandidate(), "p01").join(" ")).toContain("explicit source-first");
    mocks.runAgentSession.mockImplementation(async (_config: unknown, prompt: string) => ({
      responseText: JSON.stringify(setup.sourceCandidate(prompt.match(/candidateId는 정확히 (p\d{2})/)?.[1] ?? "p01")), messages: [] }));
    await createPitchCommand({ readInput: async () => "원작 변주" }).parseAsync(["slate", "--id", "source-drift", "--source-first", "--source-pack", setup.packPath,
      "--count", "2", "--reference", setup.sourcePath, "--json"], { from: "user" });
    expect(process.exitCode, stdout.join("")).toBe(0);
    await writeFile(setup.sourcePath, "바뀐 원문");
    mocks.runAgentSession.mockClear();
    await createPitchCommand().parseAsync(["review", "--id", "source-drift", "--json"], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect(mocks.runAgentSession).not.toHaveBeenCalled();
    expect(stdout.join("")).toContain("reference inputs changed since generation");
  });

  it("rejects incomplete candidates and originality-free score drift", () => {
    const invalid = candidate();
    invalid.arcLadder = invalid.arcLadder.slice(0, 5);
    invalid.commercialScore.total = 99;
    const errors = validatePitchCandidate(invalid, "p01");
    expect(errors).toContain("arcLadder must contain at least 6 arcs");
    expect(errors).toContain("commercialScore.total must equal the five component scores");
  });

  it("rejects candidates without the human desire and purpose entry contract", () => {
    const invalid = candidate();
    delete (invalid as Partial<typeof invalid>).entryContract;
    expect(validatePitchCandidate(invalid, "p01")).toContain(
      "entryContract must fully define human drive, purpose, situation, HOW, and payment promise",
    );
  });

  it("rejects survival reviews that restore multiple winners or omit candidates", () => {
    const invalid = survivalReview();
    invalid.verdicts[1].verdict = "SURVIVE";
    invalid.ranking = ["p01"];
    const errors = validatePitchSurvivalReview(invalid, ["p01", "p02"]);
    expect(errors).toContain("ranking must contain every candidate exactly once");
    expect(errors).toContain("at most one candidate may be SURVIVE");
  });

  it("forbids SURVIVE when the semantic entry gate fails", () => {
    const invalid = survivalReview();
    invalid.verdicts[0].entryGate = {
      ...invalid.verdicts[0].entryGate,
      passed: false,
      failureReasons: ["개인 욕망을 복원할 수 없다"],
    };
    expect(validatePitchSurvivalReview(invalid, ["p01", "p02"])).toContain(
      "verdicts[0] cannot SURVIVE after failing the entry gate",
    );
  });

  it("generates candidates serially and publishes one non-canonical slate atomically", async () => {
    const referenceDir = join(root, "references");
    await mkdir(referenceDir, { recursive: true });
    const referencePath = join(referenceDir, "commercial-pack.md");
    await writeFile(referencePath, "주축: 인수 성장 사다리\n보조: 가족 식탁 보상\n", "utf8");
    mocks.runAgentSession.mockImplementation(async (_config: unknown, prompt: string) => {
      const candidateId = prompt.match(/candidateId는 정확히 (p\d{2})/)?.[1] ?? "p01";
      return { responseText: JSON.stringify(candidate(candidateId)), messages: [] };
    });

    const command = createPitchCommand({
      readInput: async () => "현대판타지 재벌물. 상업성을 최우선으로 한다.",
      now: () => new Date("2026-08-26T12:00:00.000Z"),
    });
    await command.parseAsync([
      "slate",
      "--id", "chaebol-canary",
      "--count", "2",
      "--reference", referencePath,
      "--session", "hq-chaebol-canary",
      "--json",
    ], { from: "user" });

    expect(process.exitCode).toBe(0);
    expect(mocks.runAgentSession).toHaveBeenCalledTimes(2);
    expect(mocks.runAgentSession.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      bookId: null,
      sessionKind: "pitch-slate",
      requestedSkills: ["inkos-commercial-webnovel-pitch"],
      toolPolicy: "none",
      modelInvocation: { stage: "pitch-candidate-generation", candidateId: "p01", attempt: 1 },
    }));
    expect(String(mocks.runAgentSession.mock.calls[0]?.[1])).toContain(
      "각각 0~20점, total은 그 합계인 0~100점",
    );
    expect(String(mocks.runAgentSession.mock.calls[0]?.[0]?.backgroundTaskContext)).toContain(
      "rubric for inkos-commercial-webnovel-pitch",
    );
    const generationPrompt = String(mocks.runAgentSession.mock.calls[0]?.[1]);
    expect(generationPrompt).toContain("작품 기획서 v1 · pitch");
    expect(generationPrompt).toContain("실제 시한이 있을 때만");
    const output = JSON.parse(stdout.join(""));
    expect(output).toEqual(expect.objectContaining({
      slateId: "chaebol-canary",
      candidateCount: 2,
      canonStatus: "non-canonical",
      reviewStatus: "pending",
    }));
    expect(JSON.parse(await readFile(join(root, ".inkos", "pitch-slates", "chaebol-canary", "slate.json"), "utf8"))).toEqual(
      expect.objectContaining({ schemaVersion: 2, genre: "modern-fantasy-ko", targetChapters: 200 }),
    );
    expect(output.artifacts.map((artifact: { role: string }) => artifact.role)).toEqual([
      "pitch-slate-data",
      "pitch-slate-review",
    ]);

    const slate = JSON.parse(await readFile(join(root, ".inkos", "pitch-slates", "chaebol-canary", "slate.json"), "utf8"));
    expect(slate.candidates).toHaveLength(2);
    expect(slate.candidates.every((item: { decision: string }) => item.decision === "pending")).toBe(true);
    const review = await readFile(join(root, ".inkos", "pitch-slates", "chaebol-canary", "review.md"), "utf8");
    expect(review).toContain("## 빠른 생존심사");
    expect(review).toContain("비평가 항목: 독창성, 원작과의 거리, 표면 유사성");
    await expect(readFile(join(root, "books", "book.json"), "utf8")).rejects.toThrow();
  });

  it("preserves malformed JSON and fails without a second generation or a partial slate", async () => {
    const referencePath = join(root, "reference.md");
    await writeFile(referencePath, "검증된 상업 레퍼런스\n", "utf8");
    const responseText = '  {"candidateId":"p01", broken JSON\n';
    mocks.runAgentSession.mockResolvedValue({ responseText, messages: [] });
    await createPitchCommand({ readInput: async () => "재벌물 한 개" }).parseAsync([
      "slate", "--id", "repair-canary", "--count", "1", "--reference", referencePath, "--json",
    ], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect(mocks.runAgentSession).toHaveBeenCalledTimes(1);
    const output = JSON.parse(stdout.join(""));
    expect(output.error).toContain("no full regeneration");
    const receiptPath = output.error.split("Diagnostic: ")[1];
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    expect(receipt).toMatchObject({ outcome: "failed", modelCalls: 0, originalSha256: null, completeContractPassed: false,
      responseSha256: createHash("sha256").update(responseText).digest("hex"),
      issues: [{ path: [], code: "unparseable_or_unsafe_json", located: false }] });
    expect(await readFile(receiptPath.replace("diagnostic.json", "response.txt"), "utf8")).toBe(responseText);
    await expect(readFile(join(root, ".inkos/pitch-slates/repair-canary/slate.json"))).rejects.toThrow();
  });

  it("repairs numeric formatting and total without a model call or changing source evidence and the complete plan", async () => {
    const setup = await sourceFirstSetup();
    const expected = setup.sourceCandidate();
    const malformed = { ...expected, commercialScore: { ...expected.commercialScore, promise: "19", total: 4 } };
    const responseText = JSON.stringify(malformed);
    mocks.runAgentSession.mockResolvedValue({ responseText, messages: [] });
    await createPitchCommand({ readInput: async () => "원작 변주" }).parseAsync([
      "slate", "--id", "deterministic-repair", "--source-first", "--source-pack", setup.packPath,
      "--count", "1", "--reference", setup.sourcePath, "--json",
    ], { from: "user" });
    expect(process.exitCode, stdout.join("")).toBe(0);
    expect(mocks.runAgentSession).toHaveBeenCalledTimes(1);
    const output = JSON.parse(stdout.join(""));
    const receiptPath = join(root, output.formatRepairs[0]);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    expect(receipt).toMatchObject({ strategy: "deterministic-score-only", modelCalls: 0, outcome: "repaired", completeContractPassed: true,
      issues: [
        { path: ["commercialScore", "promise"], before: { exists: true, value: "19" } },
        { path: ["commercialScore", "total"], before: { exists: true, value: 4 } },
      ] });
    expect(receipt.originalSha256).not.toBe(receipt.repairedSha256);
    const slate = JSON.parse(await readFile(join(root, ".inkos/pitch-slates/deterministic-repair/slate.json"), "utf8"));
    expect(slate.candidates[0]).toEqual(expected);
    expect(await readFile(receiptPath.replace("diagnostic.json", "response.txt"), "utf8")).toBe(responseText);
    const patch = JSON.parse(await readFile(receiptPath.replace("diagnostic.json", "patch.json"), "utf8"));
    expect(patch.changes.map((change: { path: string[] }) => change.path)).toEqual([["commercialScore", "promise"], ["commercialScore", "total"]]);
  });

  it("does not fill missing source facts and keeps each failure diagnostic separately", async () => {
    const setup = await sourceFirstSetup();
    const incomplete = structuredClone(setup.sourceCandidate());
    delete (incomplete.spineRetention.sourceReconstruction as Record<string, unknown>).personalGoal;
    mocks.runAgentSession.mockResolvedValue({ responseText: JSON.stringify(incomplete), messages: [] });
    for (let attempt = 0; attempt < 2; attempt++) {
      await createPitchCommand({ readInput: async () => "원작 변주" }).parseAsync([
        "slate", "--id", "missing-source", "--source-first", "--source-pack", setup.packPath,
        "--count", "1", "--reference", setup.sourcePath, "--json",
      ], { from: "user" });
      expect(process.exitCode).toBe(1);
    }
    expect(mocks.runAgentSession).toHaveBeenCalledTimes(2);
    const diagnosticParent = join(root, ".inkos/pitch-diagnostics/missing-source/p01");
    const attempts = await readdir(diagnosticParent);
    expect(attempts).toHaveLength(2);
    const receipt = JSON.parse(await readFile(join(diagnosticParent, attempts[0]!, "diagnostic.json"), "utf8"));
    expect(receipt).toMatchObject({ outcome: "failed", modelCalls: 0, requestSha256: null,
      issues: [{ path: ["spineRetention", "sourceReconstruction", "personalGoal"], located: true, before: { exists: false } }] });
    await expect(readFile(join(root, ".inkos/pitch-slates/missing-source/slate.json"))).rejects.toThrow();
  });

  it("retains exact manual and schema paths for source anchors, identity and entry-contract diagnostics", async () => {
    const setup = await sourceFirstSetup();
    const invalid = structuredClone(setup.sourceCandidate());
    invalid.candidateId = "p02";
    invalid.spineRetention.decisionComparisons[0].sourceSequenceEnd = 101;
    delete (invalid.entryContract.purpose as Record<string, unknown>).seriesWhat;
    const found = collectPitchCandidateIssues(invalid, "p01", "source-first", {
      ...invalid.spineRetention.primaryReference, workSlug: invalid.spineRetention.referenceDisclosure.workSlug, chapterCount: 100,
    });
    expect(found.map((issue) => issue.path)).toContainEqual(["candidateId"]);
    expect(found.map((issue) => issue.path)).toContainEqual(["spineRetention", "decisionComparisons", 0, "sourceSequenceEnd"]);
    expect(found.map((issue) => issue.path)).toContainEqual(["entryContract", "purpose", "seriesWhat"]);
  });

  it("reviews a slate without exposing generator scores or changing the slate", async () => {
    const slateDir = join(root, ".inkos", "pitch-slates", "review-canary");
    await mkdir(slateDir, { recursive: true });
    const p01 = candidate("p01");
    const p02 = candidate("p02");
    await writeFile(join(slateDir, "slate.json"), JSON.stringify({
      schemaVersion: 1,
      slateId: "review-canary",
      canonStatus: "non-canonical",
      reviewStatus: "pending",
      candidateCount: 2,
      candidates: [p01, p02],
    }), "utf8");
    mocks.runAgentSession.mockResolvedValueOnce({ responseText: JSON.stringify(survivalReview()), messages: [] });

    const command = createPitchCommand();
    await command.parseAsync([
      "review",
      "--id", "review-canary",
      "--session", "review-canary-session",
      "--json",
    ], { from: "user" });

    expect(process.exitCode).toBe(0);
    expect(mocks.runAgentSession).toHaveBeenCalledTimes(1);
    const reviewPrompt = String(mocks.runAgentSession.mock.calls[0]?.[1]);
    expect(reviewPrompt).not.toContain('"commercialScore"');
    expect(reviewPrompt).not.toContain('"decision"');
    expect(reviewPrompt).toContain("entryGate");
    expect(reviewPrompt).toContain("작품 기획서 v1 · review");
    expect(reviewPrompt).toContain("새 탈락 조건으로 만들지 않습니다");
    expect(mocks.runAgentSession.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      bookId: null,
      sessionKind: "pitch-review",
      requestedSkills: ["inkos-commercial-pitch-review"],
      toolPolicy: "none",
      modelInvocation: { stage: "pitch-review", attempt: 1 },
    }));
    const output = JSON.parse(stdout.join(""));
    expect(output).toEqual(expect.objectContaining({
      slateId: "review-canary",
      reviewStatus: "complete",
      humanDecision: "pending",
      winnerCandidateId: "p01",
    }));
    const persisted = JSON.parse(await readFile(join(slateDir, "survival-review", "review.json"), "utf8"));
    expect(persisted.winnerCandidateId).toBe("p01");
    const originalSlate = JSON.parse(await readFile(join(slateDir, "slate.json"), "utf8"));
    expect(originalSlate.candidates[0].commercialScore.total).toBe(91);
    expect(originalSlate.candidates[0].decision).toBe("pending");
  });

  it("records one immutable hash-bound human decision without mutating the review", async () => {
    const slateDir = join(root, ".inkos", "pitch-slates", "decision-canary");
    const reviewDir = join(slateDir, "survival-review");
    await mkdir(reviewDir, { recursive: true });
    const slate = {
      schemaVersion: 2,
      slateId: "decision-canary",
      canonStatus: "non-canonical",
      reviewStatus: "pending",
      candidateCount: 2,
      candidates: [candidate("p01"), candidate("p02")],
    };
    const slateBytes = Buffer.from(`${JSON.stringify(slate, null, 2)}\n`);
    await writeFile(join(slateDir, "slate.json"), slateBytes);
    await writeFile(join(reviewDir, "review.json"), `${JSON.stringify({
      schemaVersion: 2,
      reviewKind: "independent-blind-comparison",
      slateId: "decision-canary",
      reviewedAt: "2026-08-26T12:00:00.000Z",
      sourceSlateSha256: (await import("node:crypto")).createHash("sha256").update(slateBytes).digest("hex"),
      ...survivalReview(),
    }, null, 2)}\n`);

    const command = createPitchCommand({
      now: () => new Date("2026-08-27T01:00:00.000Z"),
      readInput: async () => "p02의 채권 회수 엔진이 장편 공급량에서 더 유리함.",
    });
    await command.parseAsync([
      "decision", "--id", "decision-canary", "--candidate", "p02", "--decision", "select", "--json",
    ], { from: "user" });

    expect(process.exitCode).toBe(0);
    const output = JSON.parse(stdout.join(""));
    expect(output).toEqual(expect.objectContaining({
      slateId: "decision-canary",
      candidateId: "p02",
      humanDecision: "select",
      canonEffect: "planning-promotion-authorized",
      manuscriptAuthorized: false,
    }));
    const decision = JSON.parse(await readFile(join(slateDir, "human-decision", "decision.json"), "utf8"));
    expect(decision.sourceSlateSha256).toHaveLength(64);
    expect(decision.sourceReviewSha256).toHaveLength(64);
    const unchangedReview = JSON.parse(await readFile(join(reviewDir, "review.json"), "utf8"));
    expect(unchangedReview.humanDecision).toBe("pending");

    stdout = [];
    const replay = createPitchCommand({ readInput: async () => "다른 결정" });
    await replay.parseAsync([
      "decision", "--id", "decision-canary", "--candidate", "p01", "--decision", "select", "--json",
    ], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stdout.join("")).error).toContain("already exists");
  });

  it("promotes only a selected pitch into a planning Book and creates no manuscript", async () => {
    const slateDir = join(root, ".inkos", "pitch-slates", "promote-canary");
    const reviewDir = join(slateDir, "survival-review");
    const decisionDir = join(slateDir, "human-decision");
    await mkdir(reviewDir, { recursive: true });
    await mkdir(decisionDir, { recursive: true });
    const slate = {
      schemaVersion: 2,
      slateId: "promote-canary",
      canonStatus: "non-canonical",
      reviewStatus: "pending",
      candidateCount: 2,
      candidates: [candidate("p01"), candidate("p02")],
    };
    const slateBytes = Buffer.from(`${JSON.stringify(slate, null, 2)}\n`);
    await writeFile(join(slateDir, "slate.json"), slateBytes);
    const { createHash } = await import("node:crypto");
    const review = {
      schemaVersion: 1,
      reviewKind: "independent-blind-comparison",
      slateId: "promote-canary",
      reviewedAt: "2026-08-26T12:00:00.000Z",
      sourceSlateSha256: createHash("sha256").update(slateBytes).digest("hex"),
      ...survivalReview(),
    };
    const reviewBytes = Buffer.from(`${JSON.stringify(review, null, 2)}\n`);
    await writeFile(join(reviewDir, "review.json"), reviewBytes);
    await writeFile(join(decisionDir, "decision.json"), `${JSON.stringify({
      schemaVersion: 1,
      decisionId: "phd-test",
      slateId: "promote-canary",
      candidateId: "p02",
      decision: "select",
      comment: "상업성 우선 선택",
      decidedAt: "2026-08-27T01:00:00.000Z",
      sourceSlateSha256: createHash("sha256").update(slateBytes).digest("hex"),
      sourceReviewSha256: createHash("sha256").update(reviewBytes).digest("hex"),
      canonEffect: "planning-promotion-authorized",
      manuscriptAuthorized: false,
    }, null, 2)}\n`);
    let promotedBrief = "";
    const command = createPitchCommand({
      now: () => new Date("2026-08-27T02:00:00.000Z"),
      initializePromotedBook: async ({ book, brief }) => {
        promotedBrief = brief;
        const bookDir = join(root, "books", book.id);
        await mkdir(join(bookDir, "story"), { recursive: true });
        await writeFile(join(bookDir, "book.json"), `${JSON.stringify(book, null, 2)}\n`);
      },
    });
    await command.parseAsync([
      "promote", "--id", "promote-canary", "--book", "selected-chaebol", "--json",
    ], { from: "user" });

    expect(process.exitCode).toBe(0);
    expect(promotedBrief).toContain("p02");
    for (const field of ["WHO", "WHAT", "HOW", "WHERE", "WHEN", "WHY"]) expect(promotedBrief).toContain(field);
    expect(promotedBrief).toContain(candidate("p02").entryContract.purpose.seriesWhat);
    expect(promotedBrief).toContain(candidate("p02").entryContract.commercialPromise.currentSituation);
    const output = JSON.parse(stdout.join(""));
    expect(output).toEqual(expect.objectContaining({
      bookId: "selected-chaebol",
      candidateId: "p02",
      canonEffect: "planning-seed-created",
      manuscriptCreated: false,
    }));
    const book = JSON.parse(await readFile(join(root, "books", "selected-chaebol", "book.json"), "utf8"));
    expect(book.status).toBe("outlining");
    expect(book.writing.reviewMode).toBe("manual");
    expect(book.writing.entryContractPolicy).toBe("auto-required");
    const admission = JSON.parse(await readFile(join(root, "books", "selected-chaebol", "story", "entry-contract.json"), "utf8"));
    expect(admission).toEqual(expect.objectContaining({
      schemaVersion: "firefly_planning_admission/v1",
      bookId: "selected-chaebol",
      status: "approved",
    }));
    await expect(readFile(join(root, "books", "selected-chaebol", "chapters", "chapter-0001.md"), "utf8"))
      .rejects.toThrow();
    const receipt = JSON.parse(await readFile(join(slateDir, "promotion.json"), "utf8"));
    expect(receipt.lineageEdges.map((edge: { type: string }) => edge.type)).toEqual(["selects", "promotes_to"]);
  });
});
