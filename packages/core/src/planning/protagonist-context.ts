import { z } from "zod";

/** Host-selected policy for new source-first runs; never inferred from candidate prose. */
export const PROTAGONIST_CONTEXT_POLICY = "protagonist-context/v1";

type Reference = { path: string; sha256: string; content: string };
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const text = z.string().trim().min(1);
const evidenceSchema = z.object({
  referencePath: text,
  lineStart: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  lineEnd: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  basis: z.enum(["direct-text", "derived-analysis"]),
}).strict().refine((value) => value.lineStart <= value.lineEnd, "source line range must be ordered");
const evidenceArray = z.array(evidenceSchema).min(1);
const facetSchema = z.object({
  status: z.enum(["established", "not-disclosed", "not-in-provided-scope", "not-applicable"]),
  account: text,
  evidence: evidenceArray,
}).strict();
const checkSchema = z.object({ passed: z.boolean(), evidence: text }).strict();
const contextSchema = z.object({
  sourceFacets: z.object({
    background: facetSchema,
    priorExperience: facetSchema,
    currentSituation: facetSchema,
  }).strict(),
  causalLinks: z.array(z.object({
    sourceExplanation: text,
    targetExplanation: text,
    sourceEvidence: evidenceArray,
    candidatePaths: z.array(text).min(1),
  }).strict()).min(1).max(4),
  sourceFacts: checkSchema,
  goalAndMeans: checkSchema,
  readablePlan: checkSchema,
}).strict();

function lineCount(content: string): number {
  // One-based physical lines, preserving CRLF/BOM and not inventing a line after the final newline.
  return (content.match(/[^\n]*\n|[^\n]+$/gu) ?? []).length;
}

function referenceIndex(references: Reference[], errors: string[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const [position, reference] of references.entries()) {
    if (!reference || !nonempty(reference.path) || typeof reference.content !== "string"
      || !/^[a-f0-9]{64}$/u.test(reference.sha256)) {
      errors.push(`references[${position}] requires a path, SHA-256, and actual content`);
      continue;
    }
    if (index.has(reference.path)) errors.push(`references[${position}] has a duplicate reference path`);
    index.set(reference.path, lineCount(reference.content));
  }
  if (index.size === 0) errors.push("protagonist context review requires provided references");
  return index;
}

function pointerParts(pointer: string): string[] | null {
  if (!pointer.startsWith("/")) return null;
  const parts = pointer.slice(1).split("/");
  if (parts.some((part) => /~(?![01])/u.test(part))) return null;
  return parts.map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function resolveTextLeaf(candidate: JsonObject, pointer: string): { parts: string[]; value: string } | null {
  const parts = pointerParts(pointer);
  if (!parts) return null;
  let value: unknown = candidate;
  for (const part of parts) {
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(part) || !Object.hasOwn(value, part)) return null;
      value = value[Number(part)];
    } else if (object(value) && Object.hasOwn(value, part)) value = value[part];
    else return null;
  }
  return nonempty(value) ? { parts, value } : null;
}

function allowedCandidatePath(parts: string[]): boolean {
  if (parts.length === 2 && parts[0] === "protagonist" && parts[1] === "startingIdentity") return true;
  if (parts.length > 2 && parts[0] === "entryContract" && parts[1] === "purpose") return true;
  if (parts.length === 3 && parts[0] === "entryContract" && parts[1] === "commercialPromise" && parts[2] === "howAdvantage") return true;
  if (parts.length > 2 && parts[0] === "openingEpisodes" && /^(?:0|[1-9]\d*)$/u.test(parts[1]!)) return true;
  if (parts.length === 2 && parts[0] === "projectPlan" && parts[1] === "markdown") return true;
  if (parts[0] !== "spineRetention") return false;
  if (parts.length > 2 && parts[1] === "sourceReconstruction") return true;
  if (parts.length === 4 && parts[1] === "decisionComparisons" && /^(?:0|[1-9]\d*)$/u.test(parts[2]!)
    && ["sourceChoice", "sourceGain", "targetChoice", "targetGain", "preservedReason"].includes(parts[3]!)) return true;
  return parts.length === 3 && parts[1] === "referenceDisclosure" && parts[2] === "selectionReason";
}

/**
 * Validates evidence structure, existing coordinates, candidate coverage and verdict consistency.
 * It cannot determine whether cited prose is true, relevant, or causally persuasive. Those are the
 * independent reviewer's judgments; the CLI separately binds the actual reference/candidate hashes.
 */
export function validateProtagonistContextReview(
  review: JsonObject, candidates: JsonObject[], references: Reference[],
): string[] {
  const errors: string[] = [];
  const sources = referenceIndex(references, errors);
  const byId = new Map<string, JsonObject>();
  for (const [index, candidate] of candidates.entries()) {
    if (!object(candidate) || !nonempty(candidate.candidateId)) {
      errors.push(`candidates[${index}] requires candidateId`);
      continue;
    }
    if (byId.has(candidate.candidateId)) errors.push(`candidates[${index}] duplicates candidateId`);
    byId.set(candidate.candidateId, candidate);
  }
  if (byId.size === 0) errors.push("protagonist context review requires candidates");
  if (!Array.isArray(review.verdicts)) return [...errors, "protagonist context review requires verdicts"];
  const seen = new Set<string>();
  for (const [index, verdict] of review.verdicts.entries()) {
    const prefix = `verdicts[${index}]`;
    if (!object(verdict) || !nonempty(verdict.candidateId)) {
      errors.push(`${prefix} requires candidateId`);
      continue;
    }
    const candidate = byId.get(verdict.candidateId);
    if (!candidate || seen.has(verdict.candidateId)) errors.push(`${prefix}.candidateId must identify each candidate exactly once`);
    seen.add(verdict.candidateId);
    const result = contextSchema.safeParse(verdict.protagonistContext);
    if (!result.success) {
      for (const issue of result.error.issues) errors.push(`${prefix}.protagonistContext${issue.path.length ? `.${issue.path.join(".")}` : ""}: ${issue.message}`);
      continue;
    }
    const context = result.data;
    const validateEvidence = (items: z.infer<typeof evidenceSchema>[], path: string): void => {
      for (const [position, evidence] of items.entries()) {
        const count = sources.get(evidence.referencePath);
        if (count === undefined) errors.push(`${path}[${position}] is not a provided reference path`);
        else if (evidence.lineEnd > count) errors.push(`${path}[${position}] exceeds the actual provided content line range`);
      }
    };
    for (const [name, facet] of Object.entries(context.sourceFacets)) {
      validateEvidence(facet.evidence, `${prefix}.protagonistContext.sourceFacets.${name}.evidence`);
    }
    const coverage = { identity: false, purpose: false, means: false, opening: false, plan: false };
    for (const [position, link] of context.causalLinks.entries()) {
      const path = `${prefix}.protagonistContext.causalLinks[${position}]`;
      validateEvidence(link.sourceEvidence, `${path}.sourceEvidence`);
      for (const pointer of link.candidatePaths) {
        const leaf = candidate ? resolveTextLeaf(candidate, pointer) : null;
        if (!leaf) {
          errors.push(`${path}.candidatePaths must resolve to an existing nonempty candidate text leaf: ${pointer}`);
          continue;
        }
        const parts = leaf.parts;
        if (!allowedCandidatePath(parts)) {
          errors.push(`${path}.candidatePaths is outside the allowed protagonist/source-context fields: ${pointer}`);
          continue;
        }
        if (parts.length === 2 && parts[0] === "protagonist" && parts[1] === "startingIdentity") coverage.identity = true;
        if (parts.length > 2 && parts[0] === "entryContract" && parts[1] === "purpose") coverage.purpose = true;
        if (parts.length === 3 && parts[0] === "entryContract" && parts[1] === "commercialPromise" && parts[2] === "howAdvantage") coverage.means = true;
        if (parts.length > 2 && parts[0] === "openingEpisodes" && /^(?:0|[1-9]\d*)$/u.test(parts[1]!)) coverage.opening = true;
        if (parts.length === 2 && parts[0] === "projectPlan" && parts[1] === "markdown") coverage.plan = true;
      }
    }
    for (const [name, covered] of Object.entries(coverage)) {
      if (!covered) errors.push(`${prefix}.protagonistContext.causalLinks does not cover required candidate ${name}`);
    }
    if ([context.sourceFacts, context.goalAndMeans, context.readablePlan].some((item) => !item.passed)) {
      if (verdict.verdict === "SURVIVE") errors.push(`${prefix} cannot SURVIVE after a failed protagonist context check`);
      if (!object(verdict.entryGate) || verdict.entryGate.passed !== false
        || !Array.isArray(verdict.entryGate.failureReasons) || verdict.entryGate.failureReasons.length === 0
        || !verdict.entryGate.failureReasons.every(nonempty)) {
        errors.push(`${prefix} requires entryGate.passed=false and nonempty failureReasons after a failed protagonist context check`);
      }
    }
    if (!context.sourceFacts.passed || !context.goalAndMeans.passed) {
      if (!object(verdict.sourceChecks) || !object(verdict.sourceChecks.sourceFidelity)
        || verdict.sourceChecks.sourceFidelity.passed !== false) {
        errors.push(`${prefix} requires sourceChecks.sourceFidelity.passed=false after a failed sourceFacts or goalAndMeans check`);
      }
    }
  }
  for (const id of byId.keys()) if (!seen.has(id)) errors.push(`protagonist context review omitted candidate ${id}`);
  return errors;
}

export function protagonistContextReviewGuidance(references: Reference[]): string {
  const errors: string[] = [];
  referenceIndex(references, errors);
  if (errors.length) throw new Error(errors.join("; "));
  const coordinate = { referencePath: "아래 제공된 정확한 path", lineStart: 1, lineEnd: 1, basis: "direct-text 또는 derived-analysis" };
  const facet = { status: "established 또는 not-disclosed 또는 not-in-provided-scope 또는 not-applicable", account: "원문에서 확인한 사실 또는 미공개·미확인·비해당의 범위와 이유", evidence: [coordinate] };
  return `## 주인공의 출발과 목적·선택·수단 · ${PROTAGONIST_CONTEXT_POLICY}
작품마다 실제 출발배경·이전경험·현재상황을 원작에서 복원하고, 무엇이 목적·선택·수단을 설명하는지 독립적으로 확인하세요. 다른 작품의 설정을 넣거나 결핍·전생·비극을 기본값으로 삼지 마세요. 유복한 현재형 인물과 과거 미공개는 정상적인 설계입니다. 모든 배경 사실을 모든 행동의 원인으로 억지로 연결하지 않습니다.
sourceFacets에는 원작 사실만 씁니다. established는 확인된 사실, not-disclosed는 인용한 원문이 해당 정보를 밝히지 않는 경우, not-in-provided-scope는 제공 범위로 확인할 수 없는 경우, not-applicable는 이 작품에 그 구분을 적용할 수 없는 경우입니다. 미공개·미확인·비해당도 살펴본 범위를 evidence로 기록하고, 일부 발췌의 부재를 작품 전체의 부재로 단정하지 마세요. 이 상태 자체는 실패 사유가 아닙니다.
경험·학습·기억과 고유 능력을 구분하고, 그 인물이 해당 수단을 실제로 사용할 수 있는 이유를 원문과 비교하세요. 신작에서 승인된 배경·사건 변주는 원작 불일치라는 이유로 탈락시키지 않습니다. 새 설정은 신작 설정으로 설명하며 원작에 있는 사실로 위조하지 않습니다. 후보가 스스로 쓴 보존 확언으로 대조를 대신하지 마세요.
causalLinks는 1~4개입니다. sourceExplanation은 원작의 연결, targetExplanation은 신작의 목적·선택·수단과 변주 이유를 기록합니다. sourceEvidence는 아래 실제 제공된 문서의 1부터 시작하는 물리적 행 좌표이며 referencePath를 그대로 사용합니다. 발췌 파일이면 전체 원고의 행 번호가 아니라 그 발췌 파일의 행 번호입니다. direct-text와 derived-analysis를 구분합니다.
각 연결의 candidatePaths는 후보 객체를 기준으로 한 JSON pointer입니다. 전체 연결을 합쳐 /protagonist/startingIdentity, /entryContract/purpose의 하위 문자열 최소 하나, /entryContract/commercialPromise/howAdvantage, /openingEpisodes의 하위 문자열 최소 하나, /projectPlan/markdown를 모두 대조하세요. 예: /openingEpisodes/0/event. 추가 근거는 /spineRetention/sourceReconstruction 하위, /spineRetention/decisionComparisons의 sourceChoice/sourceGain/targetChoice/targetGain/preservedReason, /spineRetention/referenceDisclosure/selectionReason만 허용합니다. 배열·객체 자체나 회차 번호, 생성자 decision·점수 등 무관한 항목을 가리키지 마세요.
sourceFacts는 원작 사실의 정확성, goalAndMeans는 목적·선택·수단의 연결, readablePlan은 그 연결이 기획 본문과 도입 행동에서도 읽히는지입니다. 각각 passed와 실제 근거를 씁니다. 하나라도 false면 SURVIVE 금지, entryGate.passed=false와 구체적인 failureReasons를 기록하세요. sourceFacts 또는 goalAndMeans가 false면 sourceChecks.sourceFidelity.passed=false로 일치시킵니다. readablePlan만 false인 본문 연결 누락은 원작 사실 왜곡과 구분하며, 그 이유만으로 sourceFidelity까지 false로 바꾸지 않습니다. 과거 미공개 자체나 기존에 가진 돈·대우·우위를 실패로 판정하지 마세요.
기계 검증은 좌표 존재·구조·후보 경로·판정 결속만 확인합니다. 인용의 의미와 인과의 타당성은 당신이 직접 판단해야 합니다. 새 후보를 다시 쓰거나 본문에 검수 문구를 추가하지 않습니다.
각 verdict에 protagonistContext를 아래 정확한 구조로 추가하세요:
${JSON.stringify({ sourceFacets: { background: facet, priorExperience: facet, currentSituation: facet }, causalLinks: [{ sourceExplanation: "원작의 배경·경험·상황이 선택을 설명하는 실제 연결", targetExplanation: "신작의 대응 연결과 승인된 변경", sourceEvidence: [coordinate], candidatePaths: ["/protagonist/startingIdentity", "/entryContract/purpose/seriesWhat", "/entryContract/commercialPromise/howAdvantage", "/openingEpisodes/0/event", "/projectPlan/markdown"] }], sourceFacts: { passed: true, evidence: "원작 사실과 인용 근거의 대조" }, goalAndMeans: { passed: true, evidence: "선택과 수단이 가능한 이유의 대조" }, readablePlan: { passed: true, evidence: "기획 본문과 도입 행동의 정확한 위치" } }, null, 2)}
제공된 참조 목록(원문 내용은 이미 전달된 동일 reference context를 읽으세요):
${JSON.stringify(references.map(({ path, sha256, content }) => ({ path, sha256, lineCount: lineCount(content) })), null, 2)}`;
}

export function renderProtagonistContextReview(value: unknown): string[] {
  const parsed = contextSchema.safeParse(value);
  if (!parsed.success) return [];
  const context = parsed.data;
  const labels = { background: "출발배경", priorExperience: "이전경험", currentSituation: "현재상황" };
  const statuses = { established: "확인됨", "not-disclosed": "원문에 미공개", "not-in-provided-scope": "제공 범위에서 미확인", "not-applicable": "비해당" };
  const evidence = (items: z.infer<typeof evidenceSchema>[]) => items.map((item) => `${item.referencePath}:${item.lineStart}~${item.lineEnd} (${item.basis})`).join(" / ");
  return [
    "### 주인공의 출발과 선택 근거", "",
    ...Object.entries(context.sourceFacets).flatMap(([key, facet]) => [
      `- ${labels[key as keyof typeof labels]} · ${statuses[facet.status]}: ${facet.account}`,
      `  - 확인 범위: ${evidence(facet.evidence)}`,
    ]),
    ...context.causalLinks.flatMap((link, index) => [
      `- 연결 ${index + 1} · 원작: ${link.sourceExplanation}`,
      `  - 신작: ${link.targetExplanation}`,
      `  - 원문 근거: ${evidence(link.sourceEvidence)}`,
      `  - 후보 위치: ${link.candidatePaths.join(", ")}`,
    ]),
    ...([ ["원작 사실", context.sourceFacts], ["목적·선택·수단", context.goalAndMeans], ["기획 본문의 연결", context.readablePlan] ] as const)
      .map(([label, result]) => `- ${label}: ${result.passed ? "통과" : "수정 필요"} — ${result.evidence}`),
  ];
}
