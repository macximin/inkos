import { createHash } from "node:crypto";
import { FireflySpineRetentionContractV2Schema, hashPitchReviewCanonicalJson, type BoundedJsonRepairIssue } from "@actalk/inkos-core";

type JsonObject = Record<string, unknown>;
export type PitchPlanningMode = "general" | "source-first";
const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const EVALUATION_MASK = "[작성자 평가값 제외]";
const SCORE_PREFIX = String.raw`(?:상업(?:성)?\s*(?:점수|평점)|(?:자기|자체|자가|생성자)\s*(?:점수|평가(?:\s*점수)?)|(?:이|이번)\s*(?:기획|후보)의?\s*(?:점수|평점|총점)|self[- ]?(?:score|rating|rated)|commercial\s*score)\s*(?:는|은|:|=|is|of)?\s*[\x60*_]*\s*`;
const VERDICT_PREFIX = String.raw`(?:후보\s*상태|기획\s*판정|(?:자기|자체|자가|생성자)\s*판정|self[- ]?(?:verdict|judgment)|(?:candidate|author)\s*(?:verdict|decision|status)|(?:verdict|decision)(?=\s*[:=]))\s*(?:는|은|:|=|is)?\s*[\x60*_]*\s*`;
const SCORE_VALUE = String.raw`\d[\d,.]*\s*(?:/\s*100|점(?:\s*/\s*100)?|out of\s*100)?`;
const VERDICT_VALUE = String.raw`(?:pending|SURVIVE|HOLD|KILL|PASS|FAIL|검토\s*대기|선택\s*대기|통과|보류|탈락|추천)`;
const SELF_JUDGMENT_KEYS = new Set(["commercialScore", "decision", "independentScore", "selfScore", "selfEvaluation", "selfJudgment", "verdict", "winnerCandidateId", "ranking", "humanDecision"]);

export interface PitchReviewRedaction {
  path: string;
  kind: "field" | "text-value";
  removed: unknown;
  /** UTF-8 coordinates in the original string, never the already masked copy. */
  startByte?: number;
  endByte?: number;
  replacement?: string;
  beforeSha256?: string;
  afterSha256?: string;
}

export interface PitchReviewProjection {
  candidates: JsonObject[];
  audit: {
    kind: "pitch-review-input-projection/v1";
    sourceCandidatesSha256: string;
    reviewCandidatesSha256: string;
    redactions: PitchReviewRedaction[];
    verificationLayer: "cli-candidate-payload";
    limitations: string[];
  };
}

const stringSha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const pointerToken = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");
const sourceFactPath = (path: string) => /\/spineRetention\/(?:sourceReconstruction(?:\/|$)|primaryReference(?:\/|$))|\/(?:sourceChoice|sourceGain|sourceReward)$/u.test(path);

/** Detect explicit author-evaluation markers, not every possible natural-language endorsement. */
function remainingSelfJudgment(value: string): boolean {
  const withoutMasks = value
    .replace(new RegExp(`(?:${SCORE_PREFIX}|${VERDICT_PREFIX})\\[작성자 평가값 제외\\]`, "giu"), "")
    .replaceAll(EVALUATION_MASK, "");
  return new RegExp(`${SCORE_PREFIX}|${VERDICT_PREFIX}|(?:총점|자체\\s*등급)\\s*(?:은|는|:|=)?\\s*\\S|\\b(?:commercialScore|selfScore|selfEvaluation|selfJudgment|independentScore)\\b|\\b(?:SURVIVE|HOLD|KILL|PASS|FAIL|pending)\\b`, "iu").test(withoutMasks);
}

export function assertNoPitchSelfJudgment(candidates: ReadonlyArray<JsonObject>): void {
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "string" && remainingSelfJudgment(value)) throw new Error(`Unresolved author evaluation in review input at ${path}; separate author metadata without deleting story/source content`);
    if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}/${index}`));
    else if (object(value)) for (const [key, child] of Object.entries(value)) {
      if (SELF_JUDGMENT_KEYS.has(key)) throw new Error(`Author evaluation field remains in review input at ${path}/${pointerToken(key)}`);
      visit(child, `${path}/${pointerToken(key)}`);
    }
  };
  visit(candidates, "/candidates");
}

/** Keep all creative/source content; only remove typed metadata and mask explicit assessment values. */
export function preparePitchReviewCandidates(candidates: ReadonlyArray<JsonObject>): PitchReviewProjection {
  const redactions: PitchReviewRedaction[] = [];
  const visit = (value: unknown, path: string): unknown => {
    if (typeof value === "string") {
      const spans: { start: number; end: number }[] = [];
      for (const expression of [new RegExp(`(${SCORE_PREFIX})(${SCORE_VALUE})`, "giu"), new RegExp(`(${VERDICT_PREFIX})(${VERDICT_VALUE})`, "giu"), /(상태\s*(?:는|:|=)\s*)(검토\s*대기|선택\s*대기)/gu]) {
        for (const match of value.matchAll(expression)) {
          const captured = match[2] ?? match[1];
          const start = match.index! + (match[2] === undefined ? 0 : match[1].length);
          const end = start + captured.length;
          if (!spans.some((span) => start < span.end && end > span.start)) spans.push({ start, end });
        }
      }
      if (spans.length && sourceFactPath(path)) throw new Error(`Author evaluation overlaps source facts at ${path}; source statements must remain unchanged`);
      spans.sort((left, right) => left.start - right.start);
      let masked = "";
      let cursor = 0;
      for (const span of spans) { masked += value.slice(cursor, span.start) + EVALUATION_MASK; cursor = span.end; }
      masked += value.slice(cursor);
      for (const span of spans) redactions.push({ path, kind: "text-value", removed: value.slice(span.start, span.end), startByte: Buffer.byteLength(value.slice(0, span.start)), endByte: Buffer.byteLength(value.slice(0, span.end)), replacement: EVALUATION_MASK, beforeSha256: stringSha256(value), afterSha256: stringSha256(masked) });
      return masked;
    }
    if (Array.isArray(value)) return value.map((child, index) => visit(child, `${path}/${index}`));
    if (object(value)) return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
      const childPath = `${path}/${pointerToken(key)}`;
      if (SELF_JUDGMENT_KEYS.has(key)) {
        // These two top-level fields are the existing producer contract. Unknown
        // nested "decision" prose must not silently disappear from a story.
        if (!/^\/candidates\/\d+$/u.test(path) || !["commercialScore", "decision"].includes(key)) throw new Error(`Unstructured author evaluation field at ${childPath}; separate metadata before review`);
        redactions.push({ path: childPath, kind: "field", removed: structuredClone(child) });
        return [];
      }
      return [[key, visit(child, childPath)]];
    }));
    return value;
  };
  const projected = visit(candidates, "/candidates") as JsonObject[];
  assertNoPitchSelfJudgment(projected);
  return { candidates: projected, audit: {
    kind: "pitch-review-input-projection/v1",
    sourceCandidatesSha256: hashPitchReviewCanonicalJson(candidates),
    reviewCandidatesSha256: hashPitchReviewCanonicalJson(projected),
    redactions,
    verificationLayer: "cli-candidate-payload",
    limitations: ["Typed fields and explicit score/verdict markers are checked; arbitrary implicit self-praise cannot be exhaustively classified by this deterministic check.", "This records the CLI candidate payload, not a readback of the final provider context. Original references are supplied unchanged and are not redacted."],
  } };
}

/** Normalize model text before it is reviewed and hashed, never only at export. */
export function normalizeSourceFirstOutput(value: JsonObject): JsonObject {
  const normalize = (item: unknown): unknown => typeof item === "string" ? item.trim()
    : Array.isArray(item) ? item.map(normalize)
    : object(item) ? Object.fromEntries(Object.entries(item).map(([key, child]) => [key, normalize(child)])) : item;
  return normalize(value) as JsonObject;
}

export function pitchPlanningMode(slate: JsonObject): PitchPlanningMode {
  if (slate.planningMode !== undefined && slate.planningMode !== "general" && slate.planningMode !== "source-first") {
    throw new Error("Unknown pitch planning mode");
  }
  const mode = slate.planningMode === "source-first" ? "source-first" : "general";
  if (!Array.isArray(slate.candidates)) throw new Error("Pitch candidates are missing");
  for (const candidate of slate.candidates) {
    if (!object(candidate)) throw new Error("Invalid pitch candidate");
    const v2 = object(candidate.spineRetention) && candidate.spineRetention.schemaVersion === "firefly_spine_retention/v2";
    if ((mode === "source-first") !== v2) throw new Error("Pitch planning mode and source evidence version differ");
    if (mode === "source-first" && (candidate.sourcePremise !== undefined || candidate.humanPremise !== undefined || slate.sourcePremiseBinding !== undefined)) {
      throw new Error("Source-first planning cannot invent or reuse a Human Premise binding");
    }
  }
  return mode;
}

export function collectSourceFirstCandidateIssues(candidate: JsonObject, binding?: JsonObject): BoundedJsonRepairIssue[] {
  const issues: BoundedJsonRepairIssue[] = [];
  const add = (path: (string | number)[], message: string, code = "invalid_source_contract") => issues.push({ path, code, message });
  const result = FireflySpineRetentionContractV2Schema.safeParse(candidate.spineRetention);
  if (!result.success) {
    for (const issue of result.error.issues) add(["spineRetention", ...issue.path.map((part) => typeof part === "number" ? part : String(part))], `spineRetention must satisfy firefly_spine_retention/v2: ${issue.message}`, issue.code);
  }
  if (candidate.sourcePremise !== undefined) add(["sourcePremise"], "source-first candidates must not contain a Human Premise");
  if (candidate.humanPremise !== undefined) add(["humanPremise"], "source-first candidates must not contain a Human Premise");
  if (binding && result.success) {
    for (const key of ["packId", "packSha256", "sourceSha256"] as const) {
      if (result.data.primaryReference[key] !== binding[key]) add(["spineRetention", "primaryReference", key], `spineRetention.primaryReference.${key} differs from the selected source pack`);
    }
    if (result.data.referenceDisclosure.workSlug !== binding.workSlug) add(["spineRetention", "referenceDisclosure", "workSlug"], "source workSlug differs from the selected source pack");
    for (const [index, comparison] of result.data.decisionComparisons.entries()) {
      if (comparison.sourceSequenceEnd > Number(binding.chapterCount)) add(["spineRetention", "decisionComparisons", index, "sourceSequenceEnd"], "source comparison exceeds the source chapter range");
    }
    for (const [index, mapping] of result.data.openingEpisodeMappings.entries()) {
      if (mapping.sourceBeatSequence > Number(binding.chapterCount)) add(["spineRetention", "openingEpisodeMappings", index, "sourceBeatSequence"], "opening source mapping exceeds the source chapter range");
    }
  }
  const plan = candidate.projectPlan;
  if (!object(plan) || Object.keys(plan).some((key) => !["format", "markdown"].includes(key))
    || plan.format !== "webnovel-project-plan/v1" || !text(plan.markdown)
    || plan.markdown.trim().length < 600 || plan.markdown.trim().length > 30_000) {
    add(["projectPlan"], "projectPlan requires webnovel-project-plan/v1 and a 600-30000 character complete Markdown plan");
  }
  return issues;
}

export function validateSourceFirstCandidate(candidate: JsonObject, binding?: JsonObject): string[] {
  return collectSourceFirstCandidateIssues(candidate, binding).map((issue) => issue.message);
}

export function sourceFirstCandidateGuidance(binding: JsonObject): string {
  return `## 원작 중심 재설계 실행
원작 복원 자료를 먼저 읽고, 실제 주인공의 자기 목표·선택·우위·이득의 귀속을 보존하세요. 돈·권력·지분을 제거하거나 우정·존중 욕망으로 바꾸지 마세요. 원문에 가족 보호나 타인 배려가 있으면 그 사실을 숨기지 말고 이번 자기 이익 우선 기준과의 차이를 밝혀야 합니다. 이미 주인공에게 있는 돈·능력·자산을 남의 허가 없이는 못 쓰는 자원으로 바꾸거나, 없는 결핍·제약을 만들어 칸을 채우지 마세요. 미성년자의 거래 실행 방식처럼 실제 있는 조건은 소유권과 구별합니다. 원작 인물이 실용적으로 쓰는 인맥·관계·정보를 후보에서 도덕적 이유로 금지하는 새 원칙도 임의로 추가하지 마세요. 국소 협상 전략을 바꾸는 것과 인물의 선택 기준을 바꾸는 것은 다릅니다.
먼저 원작 주인공의 출발 배경(가정·신분·직업·재산·관계), 이전 경험, 첫 사건의 현재 상황과 실제 가용 자원을 복원하세요. 각 사실이 지금의 자기 목적, 행동 선택, 우위 사용을 어떻게 설명하는지 연결합니다. 경험으로 익힌 지식·정보, 원래 가진 자원, 작품에서 새로 얻은 능력을 구별하세요. 과거가 미공개인 것, 제공된 구간 밖이라 미확인인 것, 해당 없는 설정은 다릅니다. 빈칸을 회귀·불행·실패·결핍·트라우마로 채우거나 모든 능력이 약점을 보완해야 한다고 가정하지 않습니다. 풍족하고 평온한 출발에서도 자기 이익과 취향에 따른 목적이 가능합니다.
원작 사실은 sourceReconstruction.protagonist에 배경·경험·현재 상황이 드러나는 문단으로 쓰고, 근거 범위와 미확인은 verifiedScope/uncertainty에 구분합니다. sourceChoice와 preservedReason에는 왜 이 인물이 이 목적 때문에 이 수단을 택하는지 씁니다. 후보의 protagonist.startingIdentity, entryContract의 purpose/howAdvantage, openingEpisodes, 기획서 2·4·5절을 같은 인과로 잇습니다. 사람이 읽는 등장인물 소개와 이야기 출발에 드러내고 상세 원문 좌표는 기획서 8절에 모으세요. 새 실행의 독립심사는 이 연결을 원문과 후보 필드에서 직접 복원하여 확인합니다.
주축 원작의 결속은 유지하되 발주가 허용한 사건 교체·다른 작품의 실제 사건 조합·배치 변경·투자 아이템 변경도 가능합니다. 기존 발주가 이름·표면·특정 순서만 허용했다면 그 좁은 범위를 그대로 지키세요. 변경 범위가 없는 상태에서 임의로 확대하지 않습니다. 별개 욕망이나 다른 사업 엔진을 발명해 차별화하지 마세요.
보존할 것은 자기 목적→개입 이유→우위 사용→자기 이익→구체 쾌감→다음 목적의 연결입니다. '유능함을 증명한다'만으로 사건 기능을 설명하지 마세요. 무엇을 위해 끼어들고, 어떤 우위를 어떻게 써서, 누구에게서 무엇을 자기 몫으로 얻으며, 독자가 어떤 승리를 즐기는지 구체 행동으로 씁니다. 원작의 경험·기억·능력은 구별하고 단순 시연이나 타인의 행정 불편 해소로 대체하지 않습니다.
supportingReferenceRoutes는 보조 원문을 실제 사용할 때만 채우며 없으면 []입니다. 각 reference에 제공받은 작품·파일과 원문 회차/행 좌표, role에 실제 사건과 취할 이익·쾌감 및 바꿀 인과, targetArc에 후보 배치를 기록하세요. 받지 않은 작품이나 사건을 읽은 것처럼 꾸미지 않습니다. 교체·조합·재배치는 surfaceVariation, linkedCausalAdjustments, spineRetention의 targetChoice/targetGain/preservedReason과 기획서8절에서 연결하고 선행 자금·정보·인재와 다음 보상의 인과를 맞춥니다.
sourceReconstruction와 sourceChoice/sourceGain/sourceReward는 실제 주축 원작의 사실로 남깁니다. 다른 작품의 사건을 주축 원작의 사실이나 sourceArcId로 위장하지 마세요. openingEpisodeMappings의 episode는 후보1~4화, sourceBeatSequence/sourceArcId는 대응 기능을 가져온 실제 주축 원작 좌표입니다. 후보의 사건 순서와 원작 좌표가 같을 필요는 없습니다. 보조 사건의 별도 좌표는 supportingReferenceRoutes와 transformedEvent에 밝혀 구별합니다.
아래 일반 후보의 JSON 구조를 사용하되 다음을 반영하세요. railA는 성과 누적, railB는 실제 관계 변화 자료이며 실행 A/B레일이 아닙니다. railB는 [] 가능, arcLadder의 relationshipConversion은 실제 없을 때 null(키는 유지)입니다. 관계를 지우는 것도 의무가 아닙니다.
projectPlan={"format":"webnovel-project-plan/v1","markdown":"기획서 전체 Markdown"}를 추가하세요. 본문은 1. 작품 정보와 독자 약속 2. 작품의 육하원칙 3. 장기·구간·회차 목적 연결 4. 등장인물과 관계 5. 무대·시간·우위 6. 전체 줄거리와 장기 전개 7. 독자 보상과 연재 지속성 8. 참고작 역설계·유지·변주 9. 기획 의도와 집필 계획을 담습니다. 표와 문단으로 사람이 읽는 기획서를 쓰고 JSON 항목의 짧은 문장을 나열하는 데 그치지 마세요. 전체 줄거리에서 확인한 근거와 먼 가설을 구별하세요. 상세 원고를 쓰지는 않습니다.
기획 본문에는 인물·사건·목적·독자 보상을 씁니다. 비정본/pending/Book/ArcPacket/승인 경계 같은 운영 설명을 각 절에 반복하지 말고, 근거 범위와 장기 가설은8절에서 한 번 정리하세요. 생성자의 점수·등급·추천·자기 판정은 오직 최상위 commercialScore/decision에만 기록하고 기획 본문이나 다른 문자열에 되풀이하지 마세요.
sourcePremise/humanPremise는 넣지 않습니다. 대신 spineRetention을 아래 구조로 추가하세요. 값은 실제 원문과 이번 후보의 구체 인물·행동·사건으로 작성하고 해시는 아래 값을 그대로 사용하세요.
${JSON.stringify({
    schemaVersion: "firefly_spine_retention/v2",
    primaryReference: { packId: binding.packId, packSha256: binding.packSha256, sourceSha256: binding.sourceSha256 },
    referenceDisclosure: { workSlug: binding.workSlug, workTitle: binding.workTitle, usageRoles: ["commercial-engine", "opening-event", "payoff"], selectionReason: "왜 이 원작이 이번 목표에 맞는가", preservedElements: ["원작 목적", "자기 이득을 얻는 선택", "우위 사용", "구체 쾌감과 다음 목적의 연결"], transformedElements: ["발주가 허용한 표면·사건·배치 변경"] },
    preservedEngine: { industry: "유지한 사업 영역", repeatedVerb: "반복 행동", progressionLadder: "장기 확장 근거", rewardGrammar: "실제 보상과 호흡" },
    sourceReconstruction: { protagonist: "원작의 실제 출발 배경·이전 경험·현재 처지와 자기 목적/선택의 연결", personalGoal: "원작의 자기 목표", longTermGoal: "원작의 장기 목표와 근거", firstArcGoal: "원작 도입 사건에서 얻으려는 것", priorityRule: "실제 선택에서 무엇을 우선하는가", verifiedScope: "직접 읽은 범위와 분석 근거 범위", uncertainty: "미확인 지점 또는 확인 범위의 한계" },
    decisionComparisons: [{ sourceSequenceStart: 1, sourceSequenceEnd: 2, sourceArcId: "실제 원작 구간 ID", sourceChoice: "원작 인물이 자기 목적 때문에 실제 한 선택", sourceGain: "원작의 실제 자기 이득", targetChoice: "후보의 개입 이유와 우위 사용, 허용된 사건 교체", targetGain: "후보가 얻는 자기 이익과 구체 쾌감", preservedReason: "자기 목적부터 다음 목적까지 유지한 연결, 변경 이유와 선행 조건" }],
    openingEpisodeMappings: [1, 2, 3, 4].map((episode) => ({ episode, sourceBeatSequence: episode, sourceArcId: "실제 원작 구간 ID", retainedFunction: "구체적으로 보존한 선택과 보상", transformedEvent: "후보의 실제 인물과 사건" })),
    surfaceChanges: [{ layer: "people", change: "실제 지정 변경", causalAdjustment: "함께 달라지는 인과 또는 유지되는 이유" }],
    rewards: [{ kind: "소유", sourceReward: "원작 지급", targetReward: "후보 지급", beneficiary: "누가 실제 이득을 갖는가", witness: null }],
    relationshipConversion: null,
    hookProgression: [{ sourceArcId: "실제 원작 구간 ID", retainedFunction: "그 구간에서 다음 선택을 기대하게 하는 인과", transformedHook: "후보에서 이어지는 구체 선택과 기대" }],
  }, null, 2)}
이 예시의 원작 회차 번호를 기계적으로 복사하지 마세요. 제공한 원문 좌표로 바꾸세요. hookProgression은 위 객체의 배열이며 문자열 배열이 아닙니다. 실제 해당 사항이 없으면 []로 둡니다.
spineRetention.relationshipConversion은 관계 변화가 없으면 null, 있으면 정확히 {"sourceFunction":"원작에서 실제 관계가 선택과 이득에 미친 기능","transformedExpression":"후보 인물의 대응 행동과 달라진 관계"}입니다. 문자열이나 배열은 허용하지 않습니다. arcLadder 각 항목의 relationshipConversion은 별개 필드로 문자열 또는 null입니다.
surfaceChanges.layer는 people/organization/object/location/local-cause/number/scene-dressing 중 하나이며 사건 교체·재배치의 인과는 local-cause에 설명하세요. 새 enum이나 원문 사실을 만들지 마세요. 원문 문장·대사를 복사하지 말고 파생 분석과 새 기획으로 작성하세요.`;
}

export const SOURCE_FIRST_REVIEW_GUIDANCE = `## 원문 대조 독립 심사
제공한 동일 원문·복원 자료와 실제 발주 변경 범위를 직접 읽고 후보를 대조하세요. 원작 복원 사실검사와 신작의 유지/변경 이행 심사를 구분합니다. sourceReconstruction, sourceChoice/sourceGain/sourceReward 등 원작 사실 주장은 원문 좌표와 정확히 일치해야 합니다. 신작의 명시적 사건 교체·타작 실제 사건 참조·배치·투자 아이템 변경은 발주가 허용한 범위에서 평가하며, 의도한 차이를 원작 불일치라는 이유로 탈락시키지 마세요. 기존 근접복원 발주는 그 좁은 유지 조건대로 심사합니다. 발주 없이 후보가 스스로 허용 범위를 넓힌 것과 승인된 변주도 구별하세요.
신작은 자기 목적→개입 이유→우위 사용→자기 이익→구체 쾌감→다음 목적을 보존하는지 실제 행동으로 대조합니다. '유능함 증명'이나 적극적인 행동만으로 충분하지 않습니다. 원작의 경험과 고유 능력을 혼동하거나 자기 이득을 남의 문제 해결·칭찬으로 바꾼 경우를 찾으세요. 사건을 바꾸었어도 같은 구체 이익과 쾌감이 인과에 맞게 살아 있으면 변주 이행입니다. 원작의 가족 보호·희생 동기를 숨겨 이기적인 원작으로 위조해서도 안 됩니다.
sourceFidelity.evidence 안에서 '원작 사실', '신작 유지·변경 이행', '입력의 모호성/미확인'을 구분해 기록하세요. 보조 사건은 supportingReferenceRoutes의 작품·원문 좌표·기능·후보 배치와 실제 제공된 원문으로 확인하며, 주축 원작의 사건으로 위장하지 않았는지 봅니다. 타작 원문이 없으면 사용 근거가 없다고 보고하고 새 원작 사실을 만들어 메우지 않습니다.
각 verdict에 sourceChecks를 추가하세요: {"selfInterest":{"passed":true,"evidence":"원작/후보의 실제 선택 비교"},"sourceFidelity":{"passed":true,"evidence":"원문 위치와 보존/변경 비교"},"commercialReading":{"assessment":"읽히는 재미의 판단","evidence":"후보의 행동/보상 근거"}}.
앞의 두 판단 중 하나라도 false이면 entryGate.passed=false와 구체 failureReasons를 기록하고 SURVIVE로 추천하지 않습니다. 이는 모델의 의미 판단이며 사람의 최종 선택을 대신하지 않습니다. projectPlan 전체도 후보의 구조화된 목적·변형 근거와 대조하고 불일치가 있으면 최소 수정을 제시하세요.`;

export function sourceFirstReviewErrors(review: JsonObject): string[] {
  const errors: string[] = [];
  if (!Array.isArray(review.verdicts)) return ["source-first review verdicts are missing"];
  for (const verdict of review.verdicts) {
    if (!object(verdict) || !object(verdict.sourceChecks)) { errors.push("each source-first verdict requires sourceChecks"); continue; }
    const checks = verdict.sourceChecks;
    for (const key of ["selfInterest", "sourceFidelity"] as const) {
      const check = checks[key];
      if (!object(check) || typeof check.passed !== "boolean" || !text(check.evidence)) errors.push(`${key} requires a verdict and source/target evidence`);
      else if (!check.passed && (verdict.verdict === "SURVIVE" || !object(verdict.entryGate) || verdict.entryGate.passed !== false)) errors.push(`${key} failed: cannot recommend SURVIVE or a passed entry gate`);
    }
    if (!object(checks.commercialReading) || !text(checks.commercialReading.assessment) || !text(checks.commercialReading.evidence)) errors.push("commercialReading requires an assessment and evidence");
  }
  return errors;
}

export function renderSourceFirstEvidence(candidate: JsonObject): string[] {
  const parsed = FireflySpineRetentionContractV2Schema.safeParse(candidate.spineRetention);
  if (!parsed.success) return [];
  const spine = parsed.data;
  return [
    "", "### 원작 복원과 변주 근거", "",
    `- 원작: ${spine.referenceDisclosure.workTitle}`,
    `- 실제 주인공: ${spine.sourceReconstruction.protagonist}`,
    `- 원작 목표: ${spine.sourceReconstruction.personalGoal}`,
    `- 장기 목적: ${spine.sourceReconstruction.longTermGoal}`,
    `- 도입 구간 목적: ${spine.sourceReconstruction.firstArcGoal}`,
    `- 우선순위: ${spine.sourceReconstruction.priorityRule}`,
    `- 확인 범위: ${spine.sourceReconstruction.verifiedScope}`,
    `- 한계: ${spine.sourceReconstruction.uncertainty}`,
    ...spine.decisionComparisons.flatMap((item) => [
      `- 원문 ${item.sourceSequenceStart}~${item.sourceSequenceEnd}화 (${item.sourceArcId}): ${item.sourceChoice} → ${item.sourceGain}`,
      `  - 후보: ${item.targetChoice} → ${item.targetGain}. ${item.preservedReason}`,
    ]),
    ...spine.rewards.map((reward) => `- 실제 지급: ${reward.targetReward} / 수혜자: ${reward.beneficiary}${reward.witness ? ` / 목격: ${reward.witness}` : ""}`),
    "", "### 작품 기획서 전체", "",
    object(candidate.projectPlan) && text(candidate.projectPlan.markdown) ? candidate.projectPlan.markdown : "기획서 누락",
  ];
}
