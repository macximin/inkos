import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { Command } from "commander";
import {
  webnovelPlanGuidance,
  renderEntryPlan,
  FireflyHumanPremiseCandidateSchema,
  FireflyHumanPremiseDecisionSchema,
  FireflyHumanPremiseReviewPacketV4Schema,
  FireflyHumanPremiseReviewSchema,
  FireflyHumanPremiseSlateSchema,
  FireflyCommercialExpansionCandidateSchema,
  FireflyCommercialExpansionSlateSchema,
  FireflyPitchRuntimeReceiptSchema,
  FireflyPitchSourceBindingSchema,
  PipelineRunner,
  buildFireflyHumanPremiseReviewPacketV4,
  hashPitchReviewCanonicalJson,
  loadBuiltinSkillResource,
  runAgentSession,
  FIREFLY_PRODUCTION_MODEL,
  type FireflyCommercialExpansionCandidate,
  type FireflyHumanPremiseDecision,
  type FireflyHumanPremiseCandidate,
  type FireflyHumanPremiseReview,
  type FireflyHumanPremiseSlate,
  type FireflyPitchRuntimeReceipt,
  type FireflyPitchSourceBinding,
} from "@actalk/inkos-core";
import { buildPipelineConfig, createClient, findProjectRoot, loadConfig } from "../utils.js";
import type { PitchCommandHooks } from "./pitch.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const SAFE_PACK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;
const SOUL_ID = "male-modern-fantasy-ko";
const SOUL_VERSION = "v1";
const GENERATOR_SKILL_ID = "inkos-human-premise-pitch";
const REVIEW_SKILL_ID = "inkos-human-premise-review";
const EXPANSION_SKILL_ID = "inkos-commercial-webnovel-pitch";
const REQUIRED_MODEL = FIREFLY_PRODUCTION_MODEL;
const REQUIRED_REASONING = "high";

type JsonObject = Record<string, unknown>;
type StoryEntry = {
  sequence: number;
  arcId: string;
  sourceLineRange: { start: number; end: number };
  sourceCharacterRange: { start: number; end: number };
  rawProseSha256: string;
  functions?: unknown;
  title?: unknown;
};
type StyleEntry = {
  id: string;
  sequence: number;
  arcId: string;
  rawProseSha256: string;
  prose: string;
};
type ReferenceIdentity = { workSlug: string; workTitle: string };

export function validateHumanPremiseReviewResponse(value: JsonObject, binding: Pick<
  FireflyHumanPremiseReview, "slateId" | "sourceSlateSha256" | "reviewerRuntimeReceipt" | "reviewedAt"
>) {
  return FireflyHumanPremiseReviewSchema.safeParse({
    ...value,
    schemaVersion: "firefly_human_premise_review/v1",
    reviewKind: "independent-human-grounding",
    ...binding,
    humanDecision: "pending",
  });
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parsePositiveIntegers(values: readonly string[]): number[] {
  const parsed = values.map(Number);
  if (parsed.length === 0 || parsed.some((value) => !Number.isInteger(value) || value < 1)) {
    throw new Error("source sequences must be positive integers");
  }
  if (new Set(parsed).size !== parsed.length) throw new Error("source sequences must be unique");
  return parsed;
}

function parseJsonObject(text: string, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as JsonObject;
}

function extractJsonObject(text: string): JsonObject {
  const trimmed = text.trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "")
    : trimmed;
  try {
    return parseJsonObject(unfenced, "agent response");
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("agent response contains no JSON object");
    return parseJsonObject(unfenced.slice(start, end + 1), "agent response");
  }
}

function parseJsonLines<T>(text: string, label: string): T[] {
  return text.split(/\r?\n/u).filter((line) => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line) as T;
    } catch {
      throw new Error(`${label} line ${index + 1} is not valid JSON`);
    }
  });
}

async function pathDigest(path: string): Promise<{ bytes: Buffer; sha256: string }> {
  const bytes = await readFile(path);
  return { bytes, sha256: sha256(bytes) };
}

function referenceIdentityFromPack(pack: JsonObject): ReferenceIdentity {
  const source = pack.source;
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("reference pack is missing source identity");
  }
  const sourceObject = source as JsonObject;
  const rawWorkSlug = sourceObject.workSlug;
  const rawWorkTitle = sourceObject.workTitle;
  const workSlug = typeof rawWorkSlug === "string" ? rawWorkSlug.trim() : "";
  const workTitle = typeof rawWorkTitle === "string" ? rawWorkTitle.trim() : "";
  if (!workSlug || !workTitle) throw new Error("reference pack requires a human-readable work title and slug");
  return { workSlug, workTitle };
}

async function loadReferenceIdentity(projectRoot: string, binding: FireflyPitchSourceBinding): Promise<ReferenceIdentity> {
  const packPath = join(projectRoot, ".inkos", "reference-packs", binding.packId, "reference-pack.json");
  const digest = await pathDigest(packPath);
  if (digest.sha256 !== binding.packSha256) throw new Error("reference pack drifted from the source binding");
  const pack = parseJsonObject(digest.bytes.toString("utf8"), "reference pack");
  const source = pack.source as JsonObject | undefined;
  if (pack.id !== binding.packId || source?.sourceSha256 !== binding.sourceSha256) {
    throw new Error("reference pack identity does not match the source binding");
  }
  const identity = referenceIdentityFromPack(pack);
  if (binding.sourceWork && (binding.sourceWork.workSlug !== identity.workSlug || binding.sourceWork.workTitle !== identity.workTitle)) {
    throw new Error("reference work display identity drifted from the source binding");
  }
  return identity;
}

async function loadRuntime(projectRoot: string): Promise<{
  config: Awaited<ReturnType<typeof loadConfig>>;
  client: ReturnType<typeof createClient>;
  receipt: FireflyPitchRuntimeReceipt;
  soulContext: string;
}> {
  const config = await loadConfig({
    requireApiKey: false,
    projectRoot,
    cli: { service: "codex", model: REQUIRED_MODEL },
  });
  const reasoning = config.llm.extra?.codexReasoningEffort;
  if (config.llm.service !== "codex" || config.llm.model !== REQUIRED_MODEL || reasoning !== REQUIRED_REASONING) {
    throw new Error(`Human Premise requires codex/${REQUIRED_MODEL}/${REQUIRED_REASONING}; resolved ${config.llm.service}/${config.llm.model}/${String(reasoning)}`);
  }
  const client = createClient(config);
  const effectiveModel = client._piModel as { provider?: string; id?: string; codexReasoningEffort?: string } | undefined;
  if (effectiveModel?.provider !== "codex-cli" || effectiveModel.id !== REQUIRED_MODEL || effectiveModel.codexReasoningEffort !== REQUIRED_REASONING) {
    throw new Error("Human Premise resolved client does not match its declared Astra/high runtime");
  }
  const soulDir = join(projectRoot, "packages", "core", "souls", SOUL_ID, SOUL_VERSION);
  const manifestPath = join(soulDir, "manifest.json");
  const manifestDigest = await pathDigest(manifestPath);
  const manifest = parseJsonObject(manifestDigest.bytes.toString("utf8"), "Soul manifest");
  if (manifest.soulId !== SOUL_ID || manifest.version !== SOUL_VERSION || manifest.promptPath !== "SOUL.md") {
    throw new Error("Human Premise requires the exact male-modern-fantasy-ko/v1 Soul manifest");
  }
  const promptDigest = await pathDigest(join(soulDir, "SOUL.md"));
  const resourceDigest = await pathDigest(join(soulDir, "resources", "genre.md"));
  const receipt = FireflyPitchRuntimeReceiptSchema.parse({
    schemaVersion: "firefly_pitch_runtime/v1",
    provider: "codex-cli",
    model: REQUIRED_MODEL,
    reasoning: REQUIRED_REASONING,
    soul: {
      mode: "canary-scoped",
      soulId: SOUL_ID,
      version: SOUL_VERSION,
      manifestSha256: manifestDigest.sha256,
      promptSha256: promptDigest.sha256,
      resourceSha256: resourceDigest.sha256,
    },
  });
  return {
    config,
    client,
    receipt,
    soulContext: `${promptDigest.bytes.toString("utf8")}\n\n${resourceDigest.bytes.toString("utf8")}`,
  };
}

async function readInstruction(args: readonly string[], explicit: unknown, readInput?: () => Promise<string>): Promise<string> {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const inline = args.join(" ").trim();
  if (inline) return inline;
  if (readInput) {
    const injected = (await readInput()).trim();
    if (injected) return injected;
  }
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const piped = Buffer.concat(chunks).toString("utf8").trim();
    if (piped) return piped;
  }
  throw new Error("Human Premise instruction is required");
}

async function loadSourceBinding(params: {
  projectRoot: string;
  packId: string;
  receiptPath: string;
  sourceSequences: readonly number[];
  styleExampleIds: readonly string[];
  structures: readonly string[];
}): Promise<{ binding: FireflyPitchSourceBinding; context: string }> {
  const packDir = join(params.projectRoot, ".inkos", "reference-packs", params.packId);
  const packPath = join(packDir, "reference-pack.json");
  const storyPath = join(packDir, "story-index.jsonl");
  const stylePath = join(packDir, "style-examples.jsonl");
  const [packDigest, storyDigest, styleDigest, receiptDigest] = await Promise.all([
    pathDigest(packPath), pathDigest(storyPath), pathDigest(stylePath), pathDigest(resolve(params.projectRoot, params.receiptPath)),
  ]);
  const pack = parseJsonObject(packDigest.bytes.toString("utf8"), "reference pack");
  const receipt = parseJsonObject(receiptDigest.bytes.toString("utf8"), "source receipt");
  const source = pack.source as JsonObject | undefined;
  const privateInputs = pack.privateInputs as JsonObject | undefined;
  if (pack.id !== params.packId || receipt.packId !== params.packId
    || receipt.packSha256 !== packDigest.sha256
    || source?.sourceSha256 !== receipt.sourceSha256
    || privateInputs?.storyIndexSha256 !== storyDigest.sha256
    || privateInputs?.styleExamplesSha256 !== styleDigest.sha256
    || receipt.storyIndexSha256 !== storyDigest.sha256
    || receipt.styleExamplesSha256 !== styleDigest.sha256) {
    throw new Error("reference pack, source receipt, story index, or style examples hash binding mismatch");
  }
  if (typeof receipt.packSha256 !== "string" || typeof receipt.sourceSha256 !== "string") {
    throw new Error("source receipt is missing pack/source SHA-256");
  }
  const sourceWork = referenceIdentityFromPack(pack);
  const storyEntries = parseJsonLines<StoryEntry>(storyDigest.bytes.toString("utf8"), "story index");
  const styleEntries = parseJsonLines<StyleEntry>(styleDigest.bytes.toString("utf8"), "style examples");
  const selectedStory = params.sourceSequences.map((sequence) => {
    const item = storyEntries.find((entry) => entry.sequence === sequence);
    if (!item) throw new Error(`story index has no sequence ${sequence}`);
    return item;
  });
  const selectedStyle = params.styleExampleIds.map((id) => {
    const item = styleEntries.find((entry) => entry.id === id);
    if (!item) throw new Error(`style examples have no id ${id}`);
    return item;
  });
  const roleMap = new Map<string, string>();
  for (const item of params.structures) {
    const separator = item.indexOf("=");
    const role = separator > 0 ? item.slice(0, separator) : "";
    const path = separator > 0 ? item.slice(separator + 1) : "";
    if (!new Set(["project-bible", "chapter-map", "arc-atlas"]).has(role) || !path || roleMap.has(role)) {
      throw new Error("structure inputs must be unique role=path values for project-bible, chapter-map, and arc-atlas");
    }
    roleMap.set(role, path);
  }
  if (roleMap.size !== 3) throw new Error("all three structure inputs are required");
  const structureInputs = await Promise.all([...roleMap].map(async ([role, path]) => {
    const absolutePath = resolve(params.projectRoot, path);
    const digest = await pathDigest(absolutePath);
    return {
      role: role as "project-bible" | "chapter-map" | "arc-atlas",
      path: relative(params.projectRoot, absolutePath).split("\\").join("/"),
      sha256: digest.sha256,
      excerpt: digest.bytes.toString("utf8").slice(0, 24_000),
    };
  }));
  const binding = FireflyPitchSourceBindingSchema.parse({
    schemaVersion: "firefly_pitch_source_binding/v1",
    packId: params.packId,
    packSha256: receipt.packSha256,
    sourceSha256: receipt.sourceSha256,
    sourceWork,
    storyIndex: {
      path: relative(params.projectRoot, storyPath).split("\\").join("/"),
      sha256: storyDigest.sha256,
      selected: selectedStory.map(({ sequence, arcId, sourceLineRange, sourceCharacterRange, rawProseSha256 }) => ({ sequence, arcId, sourceLineRange, sourceCharacterRange, rawProseSha256 })),
    },
    styleExamples: {
      path: relative(params.projectRoot, stylePath).split("\\").join("/"),
      sha256: styleDigest.sha256,
      selected: selectedStyle.map(({ id, sequence, arcId, rawProseSha256 }) => ({ id, sequence, arcId, rawProseSha256 })),
    },
    structureInputs: structureInputs.map(({ role, path, sha256: digest }) => ({ role, path, sha256: digest })),
  });
  const context = [
    `<source_receipt>\n${JSON.stringify(receipt, null, 2)}\n</source_receipt>`,
    `<selected_story_beats>\n${JSON.stringify(selectedStory, null, 2)}\n</selected_story_beats>`,
    `<selected_style_examples>\n${JSON.stringify(selectedStyle, null, 2)}\n</selected_style_examples>`,
    ...structureInputs.map((item) => `<structure role="${item.role}" sha256="${item.sha256}">\n${item.excerpt}\n</structure>`),
  ].join("\n\n");
  return { binding, context };
}

async function loadBoundReviewEvidence(projectRoot: string, binding: FireflyPitchSourceBinding): Promise<string> {
  const storyPath = resolve(projectRoot, binding.storyIndex.path);
  const stylePath = resolve(projectRoot, binding.styleExamples.path);
  const [storyDigest, styleDigest] = await Promise.all([pathDigest(storyPath), pathDigest(stylePath)]);
  if (storyDigest.sha256 !== binding.storyIndex.sha256 || styleDigest.sha256 !== binding.styleExamples.sha256) {
    throw new Error("review source evidence drifted from the Human Premise slate binding");
  }
  const storyEntries = parseJsonLines<StoryEntry>(storyDigest.bytes.toString("utf8"), "review story index");
  const styleEntries = parseJsonLines<StyleEntry>(styleDigest.bytes.toString("utf8"), "review style examples");
  const selectedStory = binding.storyIndex.selected.map((bound) => {
    const item = storyEntries.find((entry) => entry.sequence === bound.sequence);
    if (!item || item.arcId !== bound.arcId || item.rawProseSha256 !== bound.rawProseSha256
      || JSON.stringify(item.sourceLineRange) !== JSON.stringify(bound.sourceLineRange)
      || JSON.stringify(item.sourceCharacterRange) !== JSON.stringify(bound.sourceCharacterRange)) {
      throw new Error(`review story beat ${bound.sequence} no longer matches its binding`);
    }
    return item;
  });
  const selectedStyle = binding.styleExamples.selected.map((bound) => {
    const item = styleEntries.find((entry) => entry.id === bound.id);
    if (!item || item.sequence !== bound.sequence || item.arcId !== bound.arcId || item.rawProseSha256 !== bound.rawProseSha256
      || sha256(item.prose) !== bound.rawProseSha256) {
      throw new Error(`review style example ${bound.id} no longer matches its binding`);
    }
    return item;
  });
  const structures = await Promise.all(binding.structureInputs.map(async (bound) => {
    const digest = await pathDigest(resolve(projectRoot, bound.path));
    if (digest.sha256 !== bound.sha256) throw new Error(`review structure input ${bound.role} drifted from its binding`);
    return { ...bound, excerpt: digest.bytes.toString("utf8").slice(0, 24_000) };
  }));
  return [
    `<selected_story_beats>\n${JSON.stringify(selectedStory, null, 2)}\n</selected_story_beats>`,
    `<selected_style_examples>\n${JSON.stringify(selectedStyle, null, 2)}\n</selected_style_examples>`,
    ...structures.map((item) => `<structure role="${item.role}" sha256="${item.sha256}">\n${item.excerpt}\n</structure>`),
  ].join("\n\n");
}

function candidatePrompt(id: string, instruction: string, prior: readonly FireflyHumanPremiseCandidate[]): string {
  return `비정본 Human Premise 후보 ${id} 하나를 만드세요. 아직 장편 기획서나 원고를 만들지 않습니다.

발주: ${instruction}

이미 생성된 후보: ${prior.length ? prior.map((item) => `${item.candidateId}: ${item.oneLineHumanPromise}`).join("\n") : "없음"}

핵심 판정:
- 회사, 돈, 지분, 권한, 접근권, 계약, 물류, 직함을 모두 지워도 한 인간이 특정 사람에게 바라는 것이 남아야 합니다.
- 그 욕망 때문에 오늘 내리는 첫 선택이 있어야 하며, 감정적으로 무엇을 얻거나 잃는지가 보여야 합니다.
- sourceBeatSequences와 styleExampleIds는 제공된 결속 항목만 정확히 인용하세요.
- 원문의 사건 기능·압박·반전·지급 리듬과 실제 문체 감각을 적극 사용하되, surfaceVariation에 바꾼 표면을 명시하세요.
- Arc, Rail, 장기 권한 사다리, 회차표, 원고는 생성하지 마세요.

JSON 하나만 출력하세요:
{
  "candidateId": "${id}",
  "titleCandidates": ["제목 1", "제목 2"],
  "oneLineHumanPromise": "사람의 욕망과 감정적 지급이 보이는 한 줄",
  "humanPremise": {
    "protagonistAsPerson": "직함 아닌 인간으로서의 현재 모습",
    "privateWant": "특정 사람을 향해 자기 자신을 위해 원하는 것",
    "feltLack": "몸으로 체감한 결핍·모욕·상실",
    "targetPerson": "욕망이 향하는 구체적 사람 또는 관계",
    "whyToday": "오늘 움직이지 않으면 잃는 것",
    "firstChoice": "주인공이 오늘 능동적으로 저지르는 선택",
    "emotionalPayment": "상대의 표정·말·대우 변화로 확인되는 지급",
    "stillHumanWithoutPower": "돈·권한·계약을 지운 뒤에도 남는 독자 욕망"
  },
  "firstScene": {
    "currentSituation": "장소·상대·시한",
    "pressure": "즉시 체감되는 압박",
    "action": "주인공의 행동",
    "witnessedChange": "누가 보고 어떻게 달라지는지"
  },
  "sourceBeatSequences": [1],
  "styleExampleIds": ["실제 결속 ID"],
  "retainedReferenceTraits": ["보존한 사건 기능", "보존한 문체·정서 기능"],
  "surfaceVariation": "바꾼 인물·조직·공간·소품·국소 원인"
}`;
}

function correctionPrompt(id: string, errors: readonly string[]): string {
  return `직전 Human Premise JSON이 실패했습니다. ${id} 전체 JSON만 다시 출력하세요. 오류:\n- ${errors.join("\n- ")}`;
}

export function validateHumanPremiseCandidate(
  raw: JsonObject,
  expectedId: string,
  binding: FireflyPitchSourceBinding,
): { candidate?: FireflyHumanPremiseCandidate; errors: string[] } {
  const unsigned: JsonObject = { ...raw, candidateId: expectedId };
  delete unsigned.sha256;
  const parsed = FireflyHumanPremiseCandidateSchema.safeParse({
    ...unsigned,
    sha256: hashPitchReviewCanonicalJson(unsigned),
  });
  if (!parsed.success) return { errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
  if (raw.candidateId !== expectedId) return { errors: [`candidateId must be ${expectedId}`] };
  const sequences = new Set(binding.storyIndex.selected.map((item) => item.sequence));
  const styles = new Set(binding.styleExamples.selected.map((item) => item.id));
  const errors: string[] = [];
  if (parsed.data.sourceBeatSequences.some((sequence) => !sequences.has(sequence))) errors.push("candidate cites an unbound source beat");
  if (parsed.data.styleExampleIds.some((id) => !styles.has(id))) errors.push("candidate cites an unbound style example");
  const mechanical = /(권한|접근권|결재권|물류권|계약권|통제권|승인권)/gu;
  const privateWantWithoutMechanics = parsed.data.humanPremise.privateWant.replace(mechanical, "").replace(/\s/gu, "");
  if (privateWantWithoutMechanics.length < 8) errors.push("privateWant collapses into mechanical authority objects");
  return errors.length ? { errors } : { candidate: parsed.data, errors: [] };
}

function reviewPrompt(slate: FireflyHumanPremiseSlate, evidenceContext: string): string {
  const candidates = slate.candidates.map(({ sha256: _sha, ...candidate }) => candidate);
  return `다음 Human Premise 후보를 독립 심사하세요. 생성자 점수는 없으며 복원하지 마세요.

각 gate를 실제로 판정하십시오. 돈·권한·접근권·계약·물류·직함을 지웠을 때 privateWant가 무너지면 nonMechanical=false입니다. 도덕성이나 원작과의 거리는 감점하지 않습니다. 하나라도 false면 SURVIVE 금지, SURVIVE는 최대 하나입니다.

<source_binding>\n${JSON.stringify(slate.sourceBinding, null, 2)}\n</source_binding>
${evidenceContext}
<candidates>\n${JSON.stringify(candidates, null, 2)}\n</candidates>

JSON 하나만 출력하세요:
{
  "winnerCandidateId": "p01 또는 null",
  "ranking": ["모든 후보 ID를 정확히 한 번"],
  "verdicts": [{
    "candidateId": "p01",
    "verdict": "SURVIVE | HOLD | KILL",
    "gates": {"humanDesire": true, "sourceGrounded": true, "sceneableToday": true, "nonMechanical": true, "voiceGrounded": true},
    "decisiveStrength": "강점",
    "decisiveRisk": "위험",
    "requiredRepair": "최소 수정"
  }],
  "comparisonReason": "비교 결론",
  "humanDecision": "pending"
}`;
}

function renderPremiseMarkdown(slate: FireflyHumanPremiseSlate): string {
  return [
    `# Human Premise Slate · ${slate.slateId}`,
    "",
    `- Canon: ${slate.canonStatus}`,
    `- Runtime: ${slate.runtimeReceipt.model}/${slate.runtimeReceipt.reasoning}`,
    `- Soul: ${slate.runtimeReceipt.soul.soulId}/${slate.runtimeReceipt.soul.version} (${slate.runtimeReceipt.soul.mode})`,
    `- Source pack: ${slate.sourceBinding.packId} · ${slate.sourceBinding.sourceSha256}`,
    "",
    ...slate.candidates.flatMap((candidate) => [
      `## ${candidate.candidateId} · ${candidate.titleCandidates[0]}`,
      "",
      candidate.oneLineHumanPromise,
      "",
      `- 사람: ${candidate.humanPremise.protagonistAsPerson}`,
      `- 사적 욕망: ${candidate.humanPremise.privateWant}`,
      `- 결핍: ${candidate.humanPremise.feltLack}`,
      `- 대상: ${candidate.humanPremise.targetPerson}`,
      `- 왜 오늘: ${candidate.humanPremise.whyToday}`,
      `- 첫 선택: ${candidate.humanPremise.firstChoice}`,
      `- 감정 지급: ${candidate.humanPremise.emotionalPayment}`,
      `- 권력 제거 후: ${candidate.humanPremise.stillHumanWithoutPower}`,
      "",
    ]),
  ].join("\n");
}

function premisePaths(root: string, slateId: string) {
  const dir = join(root, ".inkos", "human-premise-slates", slateId);
  return {
    dir,
    slate: join(dir, "slate.json"),
    review: join(dir, "independent-review", "review.json"),
    decisionDir: join(dir, "human-decision"),
    decision: join(dir, "human-decision", "decision.json"),
  };
}

async function persistNewDirectory(target: string, files: ReadonlyArray<readonly [string, string]>): Promise<void> {
  try {
    await access(target);
    throw new Error(`immutable artifact already exists: ${relative(findProjectRoot(), target)}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("immutable artifact already exists")) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(temporary, { recursive: true });
  try {
    for (const [path, content] of files) {
      const output = join(temporary, path);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, content, "utf8");
    }
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function loadSlate(root: string, slateId: string): Promise<{ slate: FireflyHumanPremiseSlate; bytes: Buffer }> {
  const bytes = await readFile(premisePaths(root, slateId).slate);
  return { slate: FireflyHumanPremiseSlateSchema.parse(JSON.parse(bytes.toString("utf8"))), bytes };
}

async function loadReviewedPremise(root: string, slateId: string): Promise<{
  slate: FireflyHumanPremiseSlate;
  slateBytes: Buffer;
  review: FireflyHumanPremiseReview;
  reviewBytes: Buffer;
}> {
  const loaded = await loadSlate(root, slateId);
  const reviewBytes = await readFile(premisePaths(root, slateId).review);
  const review = FireflyHumanPremiseReviewSchema.parse(JSON.parse(reviewBytes.toString("utf8")));
  if (review.slateId !== slateId || review.sourceSlateSha256 !== sha256(loaded.bytes)) {
    throw new Error("Human Premise review does not match the current slate");
  }
  return { slate: loaded.slate, slateBytes: loaded.bytes, review, reviewBytes };
}

function renderPremiseDecision(decision: FireflyHumanPremiseDecision, candidate: FireflyHumanPremiseCandidate): string {
  return [
    `# Human Premise 인간 판정 · ${decision.slateId}`,
    "",
    `- 판정: ${decision.decision}`,
    `- 후보: ${decision.candidateId} · ${candidate.titleCandidates[0]}`,
    `- 후보 SHA-256: ${decision.candidateSha256}`,
    `- 결정 시각: ${decision.decidedAt}`,
    `- 효과: ${decision.canonEffect}`,
    `- 원고 권한: ${decision.manuscriptAuthorized}`,
    `- 메모: ${decision.comment || "없음"}`,
    "",
    decision.decision === "select"
      ? "이 선택은 원문 골격 결속 상업 확장만 허용하며 Book 생성이나 원고 집필을 허용하지 않습니다."
      : "이 판정은 상업 확장을 허용하지 않습니다.",
    "",
  ].join("\n");
}

export function expansionPrompt(params: {
  candidate: FireflyHumanPremiseCandidate;
  sourceBinding: FireflyPitchSourceBinding;
  referenceIdentity: ReferenceIdentity;
  instruction: string;
}): string {
  const [firstBeat, secondBeat] = params.sourceBinding.storyIndex.selected;
  if (!firstBeat || !secondBeat) {
    throw new Error("commercial expansion requires at least two selected source beats");
  }
  const sourceBeatList = params.sourceBinding.storyIndex.selected
    .map((item) => `${item.sequence}:${item.arcId}`)
    .join(", ");
  return `선택된 Human Premise를 바꾸지 말고, 주축 원문의 상업 엔진을 적극 재사용해 전체 피치 하나로 확장하세요.

추가 지시:
${params.instruction}

${webnovelPlanGuidance("pitch")}

이 확장 실행에서는 아래 원문 골격 결속 조건과 선택된 humanPremise를 유지합니다. 일반 양식의 선택 사항과 이 카나리에서 이미 선택한 보상을 구별합니다.

불변 Human Premise:
${JSON.stringify(params.candidate, null, 2)}

강제 조건:
- humanPremise 객체는 위 후보와 글자 하나까지 동일하게 복사합니다.
- 주축 참고작은 ${params.referenceIdentity.workTitle} (${params.referenceIdentity.workSlug})입니다. referenceDisclosure의 작품명과 slug를 정확히 복사합니다.
- referenceDisclosure에 이 작품을 어떤 기능으로 참고했는지, 왜 선택했는지, 무엇을 보존하고 무엇을 표면 변주했는지 구체적으로 씁니다.
- 독창성이나 원작과의 거리를 목표로 하지 않습니다. 인명·조직·소품·장소·국소 원인만 필요한 만큼 바꿉니다.
- 업종, 반복 동사, 성장 사다리, 사건 순서, 보상 문법, 관계 전환, 훅 진행은 주축 원문에서 보존합니다.
- 1~4화 각각에 source beat를 연결하고 최소 두 개의 서로 다른 beat를 사용합니다. 허용 좌표: ${sourceBeatList}
- 첫 지급은 물질 지급과 감정 지급을 모두 포함하고, 목격자의 대우 변화가 있어야 합니다.
- 아직 Book이나 원고를 만들지 않습니다.

JSON 객체 하나만 출력하세요. 아래 키를 전부 채워야 합니다.
{
  "candidateId": "p01",
  "titleCandidates": ["제목 1", "제목 2"],
  "oneLinePromise": "사람 욕망과 반복 상업 엔진이 함께 보이는 약속",
  "primaryReference": "결속 주축 참고작과 보존 이유",
  "preservedSkeleton": ["업종", "반복 동사", "성장 사다리", "보상 문법"],
  "surfaceVariation": "표면에서 바꾼 것",
  "linkedCausalAdjustments": ["표면 변화 때문에 함께 바뀐 인과"],
  "humanPremise": ${JSON.stringify(params.candidate.humanPremise)},
  "spineRetention": {
    "schemaVersion": "firefly_spine_retention/v1",
    "primaryReference": {"packId": "${params.sourceBinding.packId}", "packSha256": "${params.sourceBinding.packSha256}", "sourceSha256": "${params.sourceBinding.sourceSha256}"},
    "referenceDisclosure": {"workSlug": ${JSON.stringify(params.referenceIdentity.workSlug)}, "workTitle": ${JSON.stringify(params.referenceIdentity.workTitle)}, "usageRoles": ["commercial-engine", "opening-event", "relationship", "payoff", "style"], "selectionReason": "이 작품을 주축으로 고른 상업적 이유", "preservedElements": ["업종", "반복 동사", "성장 사다리", "보상 문법"], "transformedElements": ["인명·조직·소품 등 실제 표면 변경"]},
    "preservedEngine": {"industry": "보존 업종", "repeatedVerb": "반복 동사", "progressionLadder": "성장 사다리", "rewardGrammar": "보상 문법"},
    "openingEpisodeMappings": [
      {"episode": 1, "sourceBeatSequence": ${firstBeat.sequence}, "sourceArcId": ${JSON.stringify(firstBeat.arcId)}, "retainedFunction": "보존 기능", "transformedEvent": "1화 event와 동일"},
      {"episode": 2, "sourceBeatSequence": ${secondBeat.sequence}, "sourceArcId": ${JSON.stringify(secondBeat.arcId)}, "retainedFunction": "보존 기능", "transformedEvent": "2화 event와 동일"},
      {"episode": 3, "sourceBeatSequence": ${firstBeat.sequence}, "sourceArcId": ${JSON.stringify(firstBeat.arcId)}, "retainedFunction": "보존 기능", "transformedEvent": "3화 event와 동일"},
      {"episode": 4, "sourceBeatSequence": ${secondBeat.sequence}, "sourceArcId": ${JSON.stringify(secondBeat.arcId)}, "retainedFunction": "보존 기능", "transformedEvent": "4화 event와 동일"}
    ],
    "relationshipConversion": {"sourceFunction": "원문 관계 전환 기능", "transformedExpression": "신작의 관계 전환"},
    "hookProgression": [{"sourceArcId": "결속 arcId", "retainedFunction": "보존 훅 기능", "transformedHook": "신작 훅"}, {"sourceArcId": "결속 arcId", "retainedFunction": "보존 훅 기능", "transformedHook": "신작 훅"}],
    "surfaceChanges": [{"layer": "people", "change": "표면 변경", "causalAdjustment": "필요한 인과 조정"}],
    "payoffPair": {"material": "돈·소유·자리 지급", "emotional": "관계·대우 지급", "witness": "목격자와 행동 변화"}
  },
  "protagonist": {"startingIdentity": "출발 신분", "repeatedVerb": "spineRetention과 같은 반복 동사", "firstAsset": "첫 자산"},
  "entryContract": {
    "humanDrive": {"lackOrHumiliation": "결핍", "personalDesire": "사적 욕망", "selfInterest": "사익", "emotionalCostLimit": "정서 비용 상한"},
    "purpose": {"seriesWhat": "장기 목표", "arcWhat": "첫 Arc 목표", "chapterWant": "1화 목표", "whyNow": "오늘인 이유"},
    "commercialPromise": {"currentSituation": "첫 상황", "repeatableReaderFantasy": "반복 판타지", "howAdvantage": "우위 작동", "firstPayoff": "물질+감정 지급", "payoffWitness": "목격자 변화", "nextPaymentQuestion": "다음 결제 질문"}
  },
  "openingEpisodes": [{"episode": 1, "event": "행동", "visiblePayoff": "지급"}, {"episode": 2, "event": "행동", "visiblePayoff": "지급"}, {"episode": 3, "event": "행동", "visiblePayoff": "지급"}, {"episode": 4, "event": "행동", "visiblePayoff": "지급"}],
  "firstReward": "물질+관계 첫 보상",
  "railA": ["물질 단계1", "단계2", "단계3"],
  "railB": ["관계 단계1", "단계2", "단계3"],
  "arcLadder": [{"arc": 1, "externalMove": "승부", "visibleReward": "보상", "relationshipConversion": "관계 변화"}, {"arc": 2, "externalMove": "승부", "visibleReward": "보상", "relationshipConversion": "관계 변화"}, {"arc": 3, "externalMove": "승부", "visibleReward": "보상", "relationshipConversion": "관계 변화"}, {"arc": 4, "externalMove": "승부", "visibleReward": "보상", "relationshipConversion": "관계 변화"}, {"arc": 5, "externalMove": "승부", "visibleReward": "보상", "relationshipConversion": "관계 변화"}, {"arc": 6, "externalMove": "승부", "visibleReward": "보상", "relationshipConversion": "관계 변화"}],
  "supportingReferenceRoutes": [{"reference": "현재는 주축 팩 내부 사건 은행", "role": "사건·보상 기능", "targetArc": "Arc 1"}],
  "longRunRisk": "장편 공급 위험",
  "commercialScore": {"promise": 0, "earlyPayoff": 0, "repeatEngine": 0, "railConversion": 0, "longRunSupply": 0, "total": 0},
  "decision": "pending"
}`;
}

export function validateExpansionCandidate(
  raw: JsonObject,
  selected: FireflyHumanPremiseCandidate,
  referenceIdentity: ReferenceIdentity,
): { candidate?: FireflyCommercialExpansionCandidate; errors: string[] } {
  const parsed = FireflyCommercialExpansionCandidateSchema.safeParse(raw);
  if (!parsed.success) {
    return { errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
  }
  const errors: string[] = [];
  const disclosure = parsed.data.spineRetention.referenceDisclosure;
  if (disclosure.workSlug !== referenceIdentity.workSlug || disclosure.workTitle !== referenceIdentity.workTitle) {
    errors.push("referenceDisclosure must use the exact source work title and slug from the bound reference pack");
  }
  if (JSON.stringify(parsed.data.humanPremise) !== JSON.stringify(selected.humanPremise)) {
    errors.push("humanPremise must remain byte-equivalent JSON to the selected premise");
  }
  if (parsed.data.protagonist.repeatedVerb !== parsed.data.spineRetention.preservedEngine.repeatedVerb) {
    errors.push("protagonist.repeatedVerb must equal spineRetention.preservedEngine.repeatedVerb");
  }
  parsed.data.openingEpisodes.forEach((episode, index) => {
    if (episode.event !== parsed.data.spineRetention.openingEpisodeMappings[index]?.transformedEvent) {
      errors.push(`openingEpisodes[${index}].event must equal its spine mapping transformedEvent`);
    }
  });
  return errors.length ? { errors } : { candidate: parsed.data, errors: [] };
}

function renderExpansionMarkdown(slate: ReturnType<typeof FireflyCommercialExpansionSlateSchema.parse>): string {
  const candidate = slate.candidates[0];
  return [
    `# 원문 골격 결속 상업 피치 · ${slate.slateId}`,
    "",
    `- Human Premise: ${slate.sourcePremiseBinding.premiseSlateId}/${slate.sourcePremiseBinding.premiseCandidateId}`,
    `- Source pack: ${slate.sourceBinding.packId}`,
    `- 주축 참고작: ${candidate.spineRetention.referenceDisclosure.workTitle} (${candidate.spineRetention.referenceDisclosure.workSlug})`,
    `- 참고 역할: ${candidate.spineRetention.referenceDisclosure.usageRoles.join(" / ")}`,
    `- 선정 이유: ${candidate.spineRetention.referenceDisclosure.selectionReason}`,
    `- 제목: ${candidate.titleCandidates.join(" / ")}`,
    `- 약속: ${candidate.oneLinePromise}`,
    "",
    renderEntryPlan(candidate.entryContract, candidate.protagonist.startingIdentity),
    "",
    `- 보존 업종: ${candidate.spineRetention.preservedEngine.industry}`,
    `- 반복 동사: ${candidate.spineRetention.preservedEngine.repeatedVerb}`,
    `- 성장 사다리: ${candidate.spineRetention.preservedEngine.progressionLadder}`,
    `- 보상 문법: ${candidate.spineRetention.preservedEngine.rewardGrammar}`,
    `- 물질 지급: ${candidate.spineRetention.payoffPair.material}`,
    `- 감정 지급: ${candidate.spineRetention.payoffPair.emotional}`,
    `- 목격자: ${candidate.spineRetention.payoffPair.witness}`,
    "",
    "## 1~4화 원문 기능 매핑",
    "",
    ...candidate.spineRetention.openingEpisodeMappings.map((item) => `- ${item.episode}화 ← ${item.sourceBeatSequence}/${item.sourceArcId}: ${item.retainedFunction} → ${item.transformedEvent}`),
    "",
    "다음 단계: 독립 기획 심사 후 Storyyard 기획 HIL. 아직 Book과 원고는 생성되지 않았습니다.",
    "",
  ].join("\n");
}

export function registerHumanPremiseCommands(command: Command, hooks: PitchCommandHooks = {}): void {
  command.command("premise-slate")
    .description("Generate source-bound Human Premise candidates before commercial planning")
    .argument("[instruction...]", "Human-centered commercial direction")
    .requiredOption("--id <slateId>")
    .requiredOption("--count <n>")
    .requiredOption("--pack-id <packId>")
    .requiredOption("--source-receipt <path>")
    .requiredOption("--source-sequence <numbers...>")
    .requiredOption("--style-example <ids...>")
    .requiredOption("--structure <bindings...>", "role=path for project-bible, chapter-map, arc-atlas")
    .option("--instruction <text>")
    .option("--session <sessionId>")
    .option("--json")
    .action(async (instructionArgs: readonly string[], opts) => {
      try {
        const root = findProjectRoot();
        const slateId = String(opts.id ?? "").trim();
        const packId = String(opts.packId ?? "").trim();
        const count = Number(opts.count);
        if (!SAFE_ID.test(slateId) || !SAFE_PACK_ID.test(packId)) throw new Error("slate and pack IDs must be safe path segments");
        if (!Number.isInteger(count) || count < 1 || count > 6) throw new Error("premise candidate count must be 1-6");
        const instruction = await readInstruction(instructionArgs, opts.instruction, hooks.readInput);
        const source = await loadSourceBinding({
          projectRoot: root,
          packId,
          receiptPath: String(opts.sourceReceipt),
          sourceSequences: parsePositiveIntegers((opts.sourceSequence as string[]).map(String)),
          styleExampleIds: (opts.styleExample as string[]).map(String),
          structures: (opts.structure as string[]).map(String),
        });
        const runtime = await loadRuntime(root);
        const pipeline = new PipelineRunner(buildPipelineConfig(runtime.config, root, { quiet: Boolean(opts.json) }));
        const candidates: FireflyHumanPremiseCandidate[] = [];
        for (let index = 1; index <= count; index += 1) {
          const id = `p${String(index).padStart(2, "0")}`;
          const sessionConfig = {
            sessionId: `${String(opts.session ?? `premise-${slateId}`)}-${id}`,
            bookId: null,
            sessionKind: "pitch-slate" as const,
            actionSource: "slash" as const,
            language: "ko",
            pipeline,
            projectRoot: root,
            model: runtime.client._piModel ?? { provider: runtime.config.llm.provider, modelId: runtime.config.llm.model },
            apiKey: runtime.client._apiKey,
            requestedSkills: [GENERATOR_SKILL_ID],
            suppressProductionTools: true,
            backgroundTaskContext: `<canary_soul>\n${runtime.soulContext}\n</canary_soul>\n\n${source.context}`,
          };
          let response = await runAgentSession(sessionConfig, candidatePrompt(id, instruction, candidates));
          let checked = validateHumanPremiseCandidate(extractJsonObject(response.responseText), id, source.binding);
          if (checked.errors.length) {
            response = await runAgentSession(sessionConfig, correctionPrompt(id, checked.errors));
            checked = validateHumanPremiseCandidate(extractJsonObject(response.responseText), id, source.binding);
          }
          if (!checked.candidate) throw new Error(`${id} failed Human Premise contract: ${checked.errors.join("; ")}`);
          candidates.push(checked.candidate);
        }
        const slate = FireflyHumanPremiseSlateSchema.parse({
          schemaVersion: "firefly_human_premise_slate/v1",
          slateId,
          canonStatus: "non-canonical",
          reviewStatus: "pending",
          genre: "modern-fantasy-ko",
          instruction,
          instructionSha256: sha256(instruction),
          sourceBinding: source.binding,
          runtimeReceipt: runtime.receipt,
          generatedAt: (hooks.now?.() ?? new Date()).toISOString(),
          candidates,
        });
        const paths = premisePaths(root, slateId);
        await persistNewDirectory(paths.dir, [
          ["slate.json", `${JSON.stringify(slate, null, 2)}\n`],
          ["review.md", `${renderPremiseMarkdown(slate)}\n`],
        ]);
        process.stdout.write(`${JSON.stringify({
          slateId,
          stage: "human-premise",
          candidateCount: candidates.length,
          canonStatus: "non-canonical",
          model: runtime.receipt.model,
          reasoning: runtime.receipt.reasoning,
          sourceBinding: source.binding,
          nextStep: `inkos pitch premise-review --id ${slateId}`,
          artifacts: await Promise.all(["slate.json", "review.md"].map(async (file) => ({
            repo: "inkos",
            path: relative(root, join(paths.dir, file)).split("\\").join("/"),
            sha256: sha256(await readFile(join(paths.dir, file))),
            role: file === "slate.json" ? "human-premise-slate-data" : "human-premise-slate-readable",
          }))),
        }, null, 2)}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (opts.json) process.stdout.write(`${JSON.stringify({ error: message })}\n`);
        else process.stderr.write(`Human Premise slate failed: ${message}\n`);
        process.exitCode = 1;
      }
    });

  command.command("premise-review")
    .description("Run an independent semantic Human Premise review")
    .requiredOption("--id <slateId>")
    .option("--session <sessionId>")
    .option("--json")
    .action(async (opts) => {
      try {
        const root = findProjectRoot();
        const slateId = String(opts.id ?? "").trim();
        if (!SAFE_ID.test(slateId)) throw new Error("slate id must be safe");
        const loaded = await loadSlate(root, slateId);
        const evidenceContext = await loadBoundReviewEvidence(root, loaded.slate.sourceBinding);
        const runtime = await loadRuntime(root);
        if (loaded.slate.runtimeReceipt.model !== runtime.receipt.model) {
          throw new Error("Human Premise review requires the generation model; legacy Sol slates remain read-only under the new Astra runtime");
        }
        const pipeline = new PipelineRunner(buildPipelineConfig(runtime.config, root, { quiet: Boolean(opts.json) }));
        const sessionConfig = {
          sessionId: String(opts.session ?? `premise-review-${slateId}`),
          bookId: null,
          sessionKind: "pitch-review" as const,
          actionSource: "slash" as const,
          language: "ko",
          pipeline,
          projectRoot: root,
          model: runtime.client._piModel ?? { provider: runtime.config.llm.provider, modelId: runtime.config.llm.model },
          apiKey: runtime.client._apiKey,
          requestedSkills: [REVIEW_SKILL_ID],
          suppressProductionTools: true,
          backgroundTaskContext: `<canary_soul>\n${runtime.soulContext}\n</canary_soul>`,
        };
        let response = await runAgentSession(sessionConfig, reviewPrompt(loaded.slate, evidenceContext));
        const base = extractJsonObject(response.responseText);
        const buildReview = (value: JsonObject) => validateHumanPremiseReviewResponse(value, {
          slateId,
          sourceSlateSha256: sha256(loaded.bytes),
          reviewerRuntimeReceipt: runtime.receipt,
          reviewedAt: (hooks.now?.() ?? new Date()).toISOString(),
        });
        let parsed = buildReview(base);
        if (!parsed.success) {
          response = await runAgentSession(sessionConfig, `직전 심사 JSON을 전체 다시 출력하세요. 오류:\n${parsed.error.issues.map((issue) => `- ${issue.path.join(".")}: ${issue.message}`).join("\n")}`);
          parsed = buildReview(extractJsonObject(response.responseText));
        }
        if (!parsed.success) throw new Error(`Human Premise review failed: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
        const review = parsed.data;
        const expected = new Set(loaded.slate.candidates.map((candidate) => candidate.candidateId));
        if (review.verdicts.some((item) => !expected.has(item.candidateId)) || review.verdicts.length !== expected.size) {
          throw new Error("review candidates do not exactly match the source slate");
        }
        const target = dirname(premisePaths(root, slateId).review);
        const readable = [
          `# Independent Human Premise Review · ${slateId}`,
          "",
          `- Winner: ${review.winnerCandidateId ?? "none"}`,
          `- Human decision: ${review.humanDecision}`,
          `- Runtime: ${review.reviewerRuntimeReceipt.model}/${review.reviewerRuntimeReceipt.reasoning}`,
          "",
          ...review.verdicts.map((item) => `- ${item.candidateId}: ${item.verdict} · ${Object.entries(item.gates).filter(([, pass]) => !pass).map(([gate]) => gate).join(", ") || "all gates pass"}`),
          "",
          review.comparisonReason,
          "",
        ].join("\n");
        await persistNewDirectory(target, [["review.json", `${JSON.stringify(review, null, 2)}\n`], ["review.md", readable]]);
        process.stdout.write(`${JSON.stringify({
          slateId,
          reviewStatus: "complete",
          humanDecision: "pending",
          winnerCandidateId: review.winnerCandidateId,
          nextStep: `inkos pitch premise-export-storyyard --id ${slateId}`,
          artifacts: await Promise.all(["review.json", "review.md"].map(async (file) => ({
            repo: "inkos",
            path: relative(root, join(target, file)).split("\\").join("/"),
            sha256: sha256(await readFile(join(target, file))),
            role: file === "review.json" ? "human-premise-review-data" : "human-premise-review-readable",
          }))),
        }, null, 2)}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (opts.json) process.stdout.write(`${JSON.stringify({ error: message })}\n`);
        else process.stderr.write(`Human Premise review failed: ${message}\n`);
        process.exitCode = 1;
      }
    });

  command.command("premise-decision")
    .description("Record one immutable human decision for a reviewed Human Premise slate")
    .requiredOption("--id <slateId>")
    .requiredOption("--candidate <candidateId>")
    .requiredOption("--decision <select|hold|reject>")
    .option("--comment <text>")
    .option("--json")
    .action(async (opts) => {
      try {
        const root = findProjectRoot();
        const slateId = String(opts.id ?? "").trim();
        const candidateId = String(opts.candidate ?? "").trim();
        const choice = String(opts.decision ?? "").trim().toLowerCase();
        const comment = String(opts.comment ?? "").trim();
        if (!SAFE_ID.test(slateId) || !/^p\d{2}$/u.test(candidateId)) throw new Error("slate or candidate ID is invalid");
        if (!new Set(["select", "hold", "reject"]).has(choice)) throw new Error("decision must be select, hold, or reject");
        if (comment.length > 2_000) throw new Error("decision comment must be 2,000 characters or fewer");
        const loaded = await loadReviewedPremise(root, slateId);
        const candidate = loaded.slate.candidates.find((item) => item.candidateId === candidateId);
        if (!candidate) throw new Error(`candidate does not belong to Human Premise slate: ${candidateId}`);
        const decidedAt = (hooks.now?.() ?? new Date()).toISOString();
        const decisionId = `hpd-${sha256(`${slateId}:${candidateId}:${candidate.sha256}:${choice}:${decidedAt}:${comment}`).slice(0, 24)}`;
        const decision = FireflyHumanPremiseDecisionSchema.parse({
          schemaVersion: "firefly_human_premise_decision/v1",
          decisionId,
          slateId,
          candidateId,
          candidateSha256: candidate.sha256,
          decision: choice,
          comment,
          decidedAt,
          sourceSlateSha256: sha256(loaded.slateBytes),
          sourceReviewSha256: sha256(loaded.reviewBytes),
          canonEffect: choice === "select" ? "commercial-expansion-authorized" : "none",
          manuscriptAuthorized: false,
        });
        const paths = premisePaths(root, slateId);
        await persistNewDirectory(paths.decisionDir, [
          ["decision.json", `${JSON.stringify(decision, null, 2)}\n`],
          ["decision.md", renderPremiseDecision(decision, candidate)],
        ]);
        const artifacts = await Promise.all([
          ["decision.json", "human-premise-decision-data"],
          ["decision.md", "human-premise-decision-readable"],
        ].map(async ([file, role]) => ({
          repo: "inkos",
          path: relative(root, join(paths.decisionDir, file)).split("\\").join("/"),
          sha256: sha256(await readFile(join(paths.decisionDir, file))),
          role,
        })));
        process.stdout.write(`${JSON.stringify({
          slateId,
          candidateId,
          humanDecision: choice,
          decisionId,
          canonEffect: decision.canonEffect,
          commercialExpansionAuthorized: choice === "select",
          manuscriptAuthorized: false,
          nextStep: choice === "select" ? `inkos pitch premise-expand --id ${slateId} --out-id <pitch-slate-id>` : null,
          artifacts,
        }, null, 2)}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (opts.json) process.stdout.write(`${JSON.stringify({ error: message })}\n`);
        else process.stderr.write(`Human Premise decision failed: ${message}\n`);
        process.exitCode = 1;
      }
    });

  command.command("premise-expand")
    .description("Expand one selected Human Premise into a source-spine-bound commercial pitch slate")
    .requiredOption("--id <slateId>")
    .requiredOption("--out-id <pitchSlateId>")
    .option("--target-chapters <n>", "Long-form chapter target", "200")
    .option("--instruction <text>")
    .option("--session <sessionId>")
    .option("--json")
    .action(async (opts) => {
      try {
        const root = findProjectRoot();
        const slateId = String(opts.id ?? "").trim();
        const outId = String(opts.outId ?? "").trim();
        const targetChapters = Number(opts.targetChapters);
        const sessionId = String(opts.session ?? `premise-expand-${slateId}`).trim();
        if (!SAFE_ID.test(slateId) || !SAFE_ID.test(outId) || !SAFE_ID.test(sessionId)) throw new Error("slate, output, or session ID is invalid");
        if (!Number.isInteger(targetChapters) || targetChapters < 20 || targetChapters > 2_000) throw new Error("target chapters must be 20-2000");
        const loaded = await loadReviewedPremise(root, slateId);
        const decisionBytes = await readFile(premisePaths(root, slateId).decision);
        const decision = FireflyHumanPremiseDecisionSchema.parse(JSON.parse(decisionBytes.toString("utf8")));
        if (decision.slateId !== slateId || decision.sourceSlateSha256 !== sha256(loaded.slateBytes)
          || decision.sourceReviewSha256 !== sha256(loaded.reviewBytes) || decision.decision !== "select") {
          throw new Error("a current select decision is required for commercial expansion");
        }
        const selected = loaded.slate.candidates.find((candidate) => candidate.candidateId === decision.candidateId);
        if (!selected || selected.sha256 !== decision.candidateSha256) throw new Error("selected Human Premise no longer matches its decision");
        const instruction = String(opts.instruction ?? loaded.slate.instruction).trim();
        if (!instruction) throw new Error("commercial expansion instruction is required");
        const [evidence, vitalityRubric, runtime, referenceIdentity] = await Promise.all([
          loadBoundReviewEvidence(root, loaded.slate.sourceBinding),
          loadBuiltinSkillResource(EXPANSION_SKILL_ID, "references/pitch-vitality-rubric.md"),
          loadRuntime(root),
          loadReferenceIdentity(root, loaded.slate.sourceBinding),
        ]);
        const pipeline = new PipelineRunner(buildPipelineConfig(runtime.config, root, { quiet: Boolean(opts.json) }));
        const sessionConfig = {
          sessionId,
          bookId: null,
          sessionKind: "pitch-slate" as const,
          actionSource: "slash" as const,
          language: "ko",
          pipeline,
          projectRoot: root,
          model: runtime.client._piModel ?? { provider: runtime.config.llm.provider, modelId: runtime.config.llm.model },
          apiKey: runtime.client._apiKey,
          requestedSkills: [EXPANSION_SKILL_ID],
          suppressProductionTools: true,
          backgroundTaskContext: `<canary_soul>\n${runtime.soulContext}\n</canary_soul>\n\n${evidence}\n\n<pitch_vitality_rubric>\n${vitalityRubric}\n</pitch_vitality_rubric>`,
        };
        const prompt = expansionPrompt({ candidate: selected, sourceBinding: loaded.slate.sourceBinding, referenceIdentity, instruction });
        let response = await runAgentSession(sessionConfig, prompt);
        let checked = validateExpansionCandidate(extractJsonObject(response.responseText), selected, referenceIdentity);
        if (!checked.candidate) {
          response = await runAgentSession(sessionConfig, `직전 JSON을 전체 다시 출력하세요. 오류:\n- ${checked.errors.join("\n- ")}\n\n${prompt}`);
          checked = validateExpansionCandidate(extractJsonObject(response.responseText), selected, referenceIdentity);
        }
        if (!checked.candidate) throw new Error(`commercial expansion failed after one repair: ${checked.errors.join("; ")}`);
        const sourcePremiseBinding = {
          premiseSlateId: slateId,
          premiseCandidateId: selected.candidateId,
          premiseCandidateSha256: selected.sha256,
          premiseDecisionId: decision.decisionId,
          premiseDecisionSha256: sha256(decisionBytes),
          sourcePremiseSlateSha256: sha256(loaded.slateBytes),
          sourcePremiseReviewSha256: sha256(loaded.reviewBytes),
        };
        const expansion = FireflyCommercialExpansionSlateSchema.parse({
          schemaVersion: 2,
          slateId: outId,
          canonStatus: "non-canonical",
          reviewStatus: "pending",
          candidateCount: 1,
          genre: "modern-fantasy-ko",
          targetChapters,
          instruction,
          instructionSha256: sha256(instruction),
          sourcePremiseBinding,
          sourceBinding: loaded.slate.sourceBinding,
          runtimeReceipt: runtime.receipt,
          generatedAt: (hooks.now?.() ?? new Date()).toISOString(),
          candidates: [checked.candidate],
        });
        const target = join(root, ".inkos", "pitch-slates", outId);
        await persistNewDirectory(target, [
          ["slate.json", `${JSON.stringify(expansion, null, 2)}\n`],
          ["review.md", renderExpansionMarkdown(expansion)],
        ]);
        const artifacts = await Promise.all([
          ["slate.json", "pitch-slate-data"],
          ["review.md", "pitch-slate-review"],
        ].map(async ([file, role]) => ({
          repo: "inkos",
          path: relative(root, join(target, file)).split("\\").join("/"),
          sha256: sha256(await readFile(join(target, file))),
          role,
        })));
        process.stdout.write(`${JSON.stringify({
          sourcePremiseSlateId: slateId,
          slateId: outId,
          candidateCount: 1,
          canonStatus: "non-canonical",
          reviewStatus: "pending",
          sourcePackId: loaded.slate.sourceBinding.packId,
          retainedSourceBeatCount: new Set(checked.candidate.spineRetention.openingEpisodeMappings.map((item) => item.sourceBeatSequence)).size,
          materialAndEmotionalPayoff: true,
          bookCreated: false,
          manuscriptCreated: false,
          nextStep: `inkos pitch review --id ${outId}`,
          artifacts,
        }, null, 2)}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (opts.json) process.stdout.write(`${JSON.stringify({ error: message })}\n`);
        else process.stderr.write(`Human Premise commercial expansion failed: ${message}\n`);
        process.exitCode = 1;
      }
    });

  command.command("premise-export-storyyard")
    .description("Export reviewed Human Premise candidates to Storyyard HIL")
    .requiredOption("--id <slateId>")
    .option("--out <path>")
    .option("--json")
    .action(async (opts) => {
      try {
        const root = findProjectRoot();
        const slateId = String(opts.id ?? "").trim();
        if (!SAFE_ID.test(slateId)) throw new Error("slate id must be safe");
        const loaded = await loadSlate(root, slateId);
        const reviewPath = premisePaths(root, slateId).review;
        const reviewBytes = await readFile(reviewPath);
        const review = FireflyHumanPremiseReviewSchema.parse(JSON.parse(reviewBytes.toString("utf8")));
        if (review.sourceSlateSha256 !== sha256(loaded.bytes)) throw new Error("Human Premise review is stale");
        const candidates = loaded.slate.candidates.map(({ candidateId, ...candidate }) => {
          const independentReview = review.verdicts.find((item) => item.candidateId === candidateId);
          if (!independentReview) throw new Error(`review missing ${candidateId}`);
          return { id: candidateId, ...candidate, independentReview };
        });
        const packet = buildFireflyHumanPremiseReviewPacketV4({
          generatedAt: (hooks.now?.() ?? new Date()).toISOString(),
          purpose: "human-premise",
          source: { system: "inkos", slateId, sourceRevision: sha256(`${sha256(loaded.bytes)}:${sha256(reviewBytes)}`) },
          work: { id: slateId, title: `Human Premise HIL · ${slateId}`, genre: "modern-fantasy-ko", status: "non-canonical" },
          artifact: { id: slateId, kind: "human-premise-slate", title: `Human Premise HIL · ${slateId}`, status: "human-decision-pending" },
          sourceBinding: loaded.slate.sourceBinding,
          runtimeReceipt: loaded.slate.runtimeReceipt,
          reviewerRuntimeReceipt: review.reviewerRuntimeReceipt,
          candidates,
          recommendation: review.winnerCandidateId ? { candidateId: review.winnerCandidateId, reason: review.comparisonReason } : null,
          actions: ["select", "hold", "reject"],
          authority: { canon: "inkos", decisionSurface: "storyyard", decisionEffect: "human-premise-selection", commercialExpansion: false, bookCreation: false, manuscriptApply: false, reverseSync: false },
        });
        const relativeOutput = String(opts.out ?? `.inkos/exports/storyyard/human-premise-slates/${slateId}/packet.json`);
        const outputPath = resolve(root, relativeOutput);
        if (!(outputPath === root || outputPath.startsWith(`${root}/`))) throw new Error("Storyyard output must remain inside InkOS");
        await mkdir(dirname(outputPath), { recursive: true });
        const content = `${JSON.stringify(packet, null, 2)}\n`;
        try {
          await writeFile(outputPath, content, { encoding: "utf8", flag: "wx" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const existing = FireflyHumanPremiseReviewPacketV4Schema.parse(JSON.parse(await readFile(outputPath, "utf8")));
          if (existing.source.sourceRevision !== packet.source.sourceRevision) throw new Error("stale immutable Human Premise packet already exists");
        }
        process.stdout.write(`${JSON.stringify({ slateId, packetId: packet.packetId, packetSha256: packet.packetSha256, humanDecision: "pending", commercialExpansionAuthorized: false, bookCreated: false, manuscriptAuthorized: false, path: relative(root, outputPath).split("\\").join("/"), artifacts: [{ repo: "inkos", path: relative(root, outputPath).split("\\").join("/"), sha256: sha256(await readFile(outputPath)), role: "human-premise-storyyard-packet" }] }, null, 2)}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (opts.json) process.stdout.write(`${JSON.stringify({ error: message })}\n`);
        else process.stderr.write(`Human Premise Storyyard export failed: ${message}\n`);
        process.exitCode = 1;
      }
    });
}
