import { describe, expect, it } from "vitest";
import {
  PROTAGONIST_CONTEXT_POLICY,
  protagonistContextReviewGuidance,
  validateProtagonistContextReview,
  renderProtagonistContextReview,
} from "../planning/protagonist-context.js";

const references = [{
  path: "/references/pottery-opening.txt", sha256: "a".repeat(64),
  content: "서윤은 자기 공방과 저축을 가진 도예가다.\r\n오랫동안 가마를 다뤄 유약의 특성을 알고 있었다.\r\n그는 자기 작품을 더 비싸게 팔기 위해 새 유약을 시험했다.\r\n회귀나 초능력에 관한 설명은 없다.\r\n",
}];
const coordinate = () => ({ referencePath: references[0]!.path, lineStart: 1, lineEnd: 3, basis: "direct-text" as const });
const paths = ["/protagonist/startingIdentity", "/entryContract/purpose/seriesWhat",
  "/entryContract/commercialPromise/howAdvantage", "/openingEpisodes/0/event", "/projectPlan/markdown"];
function candidate(id = "p01") {
  return { candidateId: id, protagonist: { startingIdentity: "자기 공방과 저축을 갖추고 숙련을 쌓은 도예가" },
    entryContract: { purpose: { seriesWhat: "자기 작품의 값을 높여 자기 공방을 확장한다." },
      commercialPromise: { howAdvantage: "가마와 유약을 다룬 경험으로 실험 조건을 정한다." } },
    openingEpisodes: [{ episode: 1, event: "자기 가마에서 새 유약을 시험한다.", visiblePayoff: "자기 작품의 색이 선명해진다." }],
    projectPlan: { markdown: "숙련된 도예가는 자기 공방의 가마로 유약을 시험하고 작품의 값을 올린다." } };
}
function context() {
  const facet = (account: string) => ({ status: "established" as string, account, evidence: [coordinate()] });
  return { sourceFacets: { background: facet("자기 공방과 저축을 갖췄다."), priorExperience: facet("오랫동안 가마와 유약을 다뤘다."), currentSituation: facet("자기 작품 값을 높이려고 새 유약을 시험한다.") },
    causalLinks: [{ sourceExplanation: "공방 소유와 오랜 숙련 덕에 자기 작품에 직접 실험한다.", targetExplanation: "자기 공방과 경험을 가진 인물이 작품 값을 높이려 직접 시험한다.", sourceEvidence: [coordinate()], candidatePaths: [...paths] }],
    sourceFacts: { passed: true, evidence: "제공 원문 1~3행의 소유·숙련·실험을 대조했다." },
    goalAndMeans: { passed: true, evidence: "가격을 올릴 목적과 기존 설비·경험을 사용하는 선택이 이어진다." },
    readablePlan: { passed: true, evidence: "기획 본문과 1화 실험 행동에서 같은 이유가 읽힌다." } };
}
function verdict(id = "p01") {
  return { candidateId: id, verdict: "SURVIVE", protagonistContext: context(),
    entryGate: { passed: true, failureReasons: [] as string[] },
    sourceChecks: { sourceFidelity: { passed: true, evidence: "제공 원문과 인물의 실험 조건을 대조했다." } } };
}
const validate = (item = verdict(), value: Record<string, unknown> = candidate()) =>
  validateProtagonistContextReview({ verdicts: [item] }, [value], references);

describe("protagonist context internal review", () => {
  it("accepts an already prosperous skilled protagonist without reincarnation, deprivation, or tragedy", () => {
    const input = verdict();
    const before = structuredClone(input);
    expect(validate(input)).toEqual([]);
    expect(input).toEqual(before);
    expect(PROTAGONIST_CONTEXT_POLICY).toBe("protagonist-context/v1");
  });

  it.each(["not-disclosed", "not-in-provided-scope", "not-applicable"])("preserves %s when the inspected scope and its limits are recorded", (status) => {
    const input = verdict();
    input.protagonistContext.sourceFacets.priorExperience = {
      status, account: "이 범위에서는 공방을 갖기 전의 이력을 확인할 수 없다. 과거를 새로 보충하지 않는다.", evidence: [coordinate()],
    };
    expect(validate(input)).toEqual([]);
    expect(input.protagonistContext.sourceFacets.priorExperience.status).toBe(status);
    expect(renderProtagonistContextReview(input.protagonistContext).join("\n")).toContain("과거를 새로 보충하지 않는다");
  });

  it.each(["sourceFacts", "goalAndMeans"] as const)("requires a failed %s judgment to close every existing survival gate", (name) => {
    const input = verdict();
    input.protagonistContext[name] = { passed: false, evidence: "심사자가 원문에 없는 수단을 신작이 근거 없이 사용한다고 판단했다." };
    const errors = validate(input);
    expect(errors.some((error) => error.includes("cannot SURVIVE"))).toBe(true);
    expect(errors.some((error) => error.includes("entryGate.passed=false"))).toBe(true);
    expect(errors.some((error) => error.includes("sourceChecks.sourceFidelity.passed=false"))).toBe(true);
    input.verdict = "HOLD";
    input.entryGate = { passed: false, failureReasons: ["원문에 없는 수단의 출처를 재검토한다."] };
    input.sourceChecks.sourceFidelity.passed = false;
    expect(validate(input)).toEqual([]);
    input.entryGate.failureReasons = ["  "];
    expect(validate(input).some((error) => error.includes("failureReasons"))).toBe(true);
  });

  it("holds an unreadable plan without treating presentation omission as a source-fact failure", () => {
    const input = verdict();
    input.protagonistContext.readablePlan = { passed: false, evidence: "원작 근거와 수단은 맞지만 본문에서 실험을 택한 이유가 빠졌다." };
    expect(validate(input).some((error) => error.includes("cannot SURVIVE"))).toBe(true);
    input.verdict = "HOLD";
    input.entryGate = { passed: false, failureReasons: ["본문에 기존 경험과 실험 선택의 연결을 드러낸다."] };
    expect(input.sourceChecks.sourceFidelity.passed).toBe(true);
    expect(validate(input)).toEqual([]);
  });

  it("does not claim to detect invented means or relevance from prose: those remain reviewer judgments", () => {
    const input = verdict();
    input.protagonistContext.sourceFacts.evidence = "이 문장은 원문을 제대로 대조하지 않은 모델의 확언일 수도 있다.";
    input.protagonistContext.causalLinks[0]!.sourceExplanation = "원문과 무관한 설명도 내용만으로 기계가 진위를 판정하지는 않는다.";
    expect(validate(input)).toEqual([]);
    const guidance = protagonistContextReviewGuidance(references);
    expect(guidance).toContain("인용의 의미와 인과의 타당성은 당신이 직접 판단");
  });

  it("requires evidence for unknown facets, causal links, and each judgment", () => {
    const invalid: ReturnType<typeof verdict>[] = [];
    for (const key of ["background", "priorExperience", "currentSituation"] as const) {
      const input = verdict();
      input.protagonistContext.sourceFacets[key].status = "not-in-provided-scope";
      input.protagonistContext.sourceFacets[key].evidence = [];
      invalid.push(input);
    }
    const link = verdict();
    link.protagonistContext.causalLinks[0]!.sourceEvidence = [];
    invalid.push(link);
    for (const key of ["sourceFacts", "goalAndMeans", "readablePlan"] as const) {
      const input = verdict();
      input.protagonistContext[key].evidence = " \n ";
      invalid.push(input);
    }
    for (const input of invalid) expect(validate(input).length).toBeGreaterThan(0);
  });

  it.each([
    { lineStart: 0, lineEnd: 1 }, { lineStart: 2, lineEnd: 1 }, { lineStart: 1, lineEnd: 5 },
    { lineStart: 1.5, lineEnd: 2 }, { lineStart: 1, lineEnd: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects invalid physical source ranges %j", (range) => {
    const input = verdict();
    Object.assign(input.protagonistContext.causalLinks[0]!.sourceEvidence[0]!, range);
    expect(validate(input).length).toBeGreaterThan(0);
  });

  it("requires an exact provided reference path, including for derived analysis", () => {
    const input = verdict();
    input.protagonistContext.sourceFacets.background.evidence[0]!.referencePath = "/references/unprovided.txt";
    expect(validate(input).some((error) => error.includes("not a provided reference"))).toBe(true);
    input.protagonistContext.sourceFacets.background.evidence[0]!.referencePath = references[0]!.path;
    Object.assign(input.protagonistContext.sourceFacets.background.evidence[0]!, { basis: "derived-analysis" });
    expect(validate(input)).toEqual([]);
  });

  it.each(["protagonist/startingIdentity", "/protagonist/missing", "/protagonist", "/openingEpisodes/0/episode",
    "/openingEpisodes/00/event", "/openingEpisodes/-/event", "/constructor/name", "/toString", "/projectPlan/~2markdown"])("rejects invalid or non-text pointer %s", (pointer) => {
    const input = verdict();
    input.protagonistContext.causalLinks[0]!.candidatePaths.push(pointer);
    expect(validate(input).some((error) => error.includes("text leaf"))).toBe(true);
  });

  it.each(paths)("requires actual coverage of %s", (missing) => {
    const input = verdict();
    input.protagonistContext.causalLinks[0]!.candidatePaths = paths.filter((path) => path !== missing);
    expect(validate(input).some((error) => error.includes("does not cover"))).toBe(true);
  });

  it("accepts coverage distributed across links and valid escaped JSON pointer keys", () => {
    const input = verdict();
    const first = input.protagonistContext.causalLinks[0]!;
    first.candidatePaths = paths.slice(0, 2);
    input.protagonistContext.causalLinks.push({ ...structuredClone(first), candidatePaths: paths.slice(2) });
    input.protagonistContext.causalLinks[0]!.candidatePaths.push("/entryContract/purpose/a~1b~0c");
    const withEscapedKey = candidate();
    Object.assign(withEscapedKey.entryContract.purpose, { "a/b~c": "실제 후보 문자열" });
    expect(validate(input, withEscapedKey)).toEqual([]);
    const empty = candidate();
    empty.projectPlan.markdown = " \n ";
    expect(validate(verdict(), empty).length).toBeGreaterThan(0);
  });

  it("allows source-context support but rejects author decisions and unrelated candidate text", () => {
    const input = verdict();
    const value = { ...candidate(), decision: "SURVIVE", unrelated: "이 문자열은 선택 근거가 아니다.",
      spineRetention: { sourceReconstruction: { protagonist: "원작에서 이미 공방을 소유한 숙련 도예가다." },
        decisionComparisons: [{ sourceChoice: "자기 가마에 새 유약을 쓴다.", preservedReason: "이미 가진 설비와 숙련이 수단을 설명한다." }],
        referenceDisclosure: { selectionReason: "숙련을 자기 작품 값으로 바꾸는 선택을 참고한다." } } };
    input.protagonistContext.causalLinks[0]!.candidatePaths.push("/spineRetention/sourceReconstruction/protagonist",
      "/spineRetention/decisionComparisons/0/sourceChoice", "/spineRetention/referenceDisclosure/selectionReason");
    expect(validate(input, value)).toEqual([]);
    for (const pointer of ["/decision", "/unrelated"]) {
      const invalid = structuredClone(input);
      invalid.protagonistContext.causalLinks[0]!.candidatePaths.push(pointer);
      expect(validate(invalid, value).some((error) => error.includes("outside the allowed"))).toBe(true);
    }
  });

  it("rejects missing/duplicate/foreign verdicts, duplicate candidates, and unknown context keys", () => {
    const two = [candidate(), candidate("p02")];
    for (const verdicts of [[verdict()], [verdict(), verdict()], [verdict(), verdict("p03")]]) {
      expect(validateProtagonistContextReview({ verdicts }, two, references).length).toBeGreaterThan(0);
    }
    expect(validateProtagonistContextReview({ verdicts: [verdict(), verdict("p02")] }, two, references)).toEqual([]);
    expect(validateProtagonistContextReview({ verdicts: [verdict()] }, [candidate(), candidate()], references).length).toBeGreaterThan(0);
    expect(validateProtagonistContextReview({}, two, references).length).toBeGreaterThan(0);
    const input = verdict();
    Object.assign(input.protagonistContext, { forcedTragedy: true });
    expect(validate(input).length).toBeGreaterThan(0);
    delete (input as Record<string, unknown>).protagonistContext;
    expect(validate(input).length).toBeGreaterThan(0);
  });

  it("uses exact physical line counts without repeating source contents in the guidance", () => {
    const guidance = protagonistContextReviewGuidance(references);
    expect(guidance).toContain('"lineCount": 4');
    expect(guidance).toContain(references[0]!.path);
    expect(guidance).toContain(references[0]!.sha256);
    expect(guidance).not.toContain(references[0]!.content);
    expect(guidance).toContain("유복한 현재형 인물과 과거 미공개는 정상");
    expect(guidance).toContain("경험·학습·기억과 고유 능력을 구분");
    expect(guidance).toContain("원작 불일치라는 이유로 탈락시키지");
    expect(() => protagonistContextReviewGuidance([...references, ...references])).toThrow("duplicate");
    expect(validateProtagonistContextReview({ verdicts: [verdict()] }, [candidate()], []).length).toBeGreaterThan(0);
    expect(validateProtagonistContextReview({ verdicts: [verdict()] }, [candidate()], [{ ...references[0]!, content: "" }]).length).toBeGreaterThan(0);
  });

  it("renders the checked facets, source coordinates, candidate paths, and separate judgments", () => {
    const rendered = renderProtagonistContextReview(context()).join("\n");
    for (const fragment of ["출발배경", "이전경험", "현재상황", references[0]!.path, "/projectPlan/markdown", "원작 사실", "목적·선택·수단", "기획 본문의 연결"]) expect(rendered).toContain(fragment);
    expect(renderProtagonistContextReview(null)).toEqual([]);
    expect(renderProtagonistContextReview({ sourceFacets: {} })).toEqual([]);
  });
});
