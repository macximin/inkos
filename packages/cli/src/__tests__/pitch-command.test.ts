import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPitchCommand, validatePitchCandidate, validatePitchSurvivalReview } from "../commands/pitch.js";

const mocks = vi.hoisted(() => ({
  projectRoot: "/tmp/inkos-pitch-test",
  runAgentSession: vi.fn(),
}));

vi.mock("@actalk/inkos-core", () => ({
  PipelineRunner: class PipelineRunnerMock {
    constructor(_config: unknown) {}
  },
  runAgentSession: mocks.runAgentSession,
  loadBuiltinSkillResource: vi.fn(async (skillId: string) => `rubric for ${skillId}`),
}));

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
        decisiveStrength: "첫 보상이 더 빠르고 관계 변화가 선명하다.",
        decisiveRisk: "중반 인수전이 반복될 수 있다.",
        requiredRepair: "Arc별 승부 수단을 분리한다.",
      },
      {
        candidateId: "p02",
        verdict: "HOLD",
        independentScore: { promise: 18, earlyPayoff: 17, repeatEngine: 18, railConversion: 17, longRunSupply: 18, total: 88 },
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

  it("rejects incomplete candidates and originality-free score drift", () => {
    const invalid = candidate();
    invalid.arcLadder = invalid.arcLadder.slice(0, 5);
    invalid.commercialScore.total = 99;
    const errors = validatePitchCandidate(invalid, "p01");
    expect(errors).toContain("arcLadder must contain at least 6 arcs");
    expect(errors).toContain("commercialScore.total must equal the five component scores");
  });

  it("rejects survival reviews that restore multiple winners or omit candidates", () => {
    const invalid = survivalReview();
    invalid.verdicts[1].verdict = "SURVIVE";
    invalid.ranking = ["p01"];
    const errors = validatePitchSurvivalReview(invalid, ["p01", "p02"]);
    expect(errors).toContain("ranking must contain every candidate exactly once");
    expect(errors).toContain("at most one candidate may be SURVIVE");
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
    }));
    expect(String(mocks.runAgentSession.mock.calls[0]?.[1])).toContain(
      "각각 0~20점, total은 그 합계인 0~100점",
    );
    expect(String(mocks.runAgentSession.mock.calls[0]?.[0]?.backgroundTaskContext)).toContain(
      "rubric for inkos-commercial-webnovel-pitch",
    );
    const output = JSON.parse(stdout.join(""));
    expect(output).toEqual(expect.objectContaining({
      slateId: "chaebol-canary",
      candidateCount: 2,
      canonStatus: "non-canonical",
      reviewStatus: "pending",
    }));
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

  it("repairs one malformed candidate before publishing", async () => {
    const referencePath = join(root, "reference.md");
    await writeFile(referencePath, "검증된 상업 레퍼런스\n", "utf8");
    mocks.runAgentSession
      .mockResolvedValueOnce({ responseText: "not-json", messages: [] })
      .mockResolvedValueOnce({ responseText: JSON.stringify(candidate("p01")), messages: [] });

    const command = createPitchCommand({ readInput: async () => "재벌물 한 개" });
    await command.parseAsync([
      "slate",
      "--id", "repair-canary",
      "--count", "1",
      "--reference", referencePath,
      "--json",
    ], { from: "user" });

    expect(process.exitCode).toBe(0);
    expect(mocks.runAgentSession).toHaveBeenCalledTimes(2);
    expect(String(mocks.runAgentSession.mock.calls[1]?.[1])).toContain("계약 검증에 실패");
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
    expect(mocks.runAgentSession.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      bookId: null,
      sessionKind: "pitch-review",
      requestedSkills: ["inkos-commercial-pitch-review"],
      suppressProductionTools: true,
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
});
