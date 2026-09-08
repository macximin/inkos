import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sourceFactRepairHash as hash, variationHash, PitchVariationCandidateSchema, type PitchVariationRequest } from "@actalk/inkos-core";
import { createPitchVariationCommand, generatePitchVariations, parseVariationResponse, preparePitchVariation, recoverSavedPitchVariationCall, variationCandidatePrompt } from "../commands/pitch-variation.js";
import { variationProjectPlanFixture } from "../../../core/dist/__tests__/fixtures/variation-project-plan-fixture.js";

const writeJson = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + "\n");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function candidate(candidateId = "v01") {
  return PitchVariationCandidateSchema.parse({
    candidateId, title: "회사와 첫 투자", variationIntent: "개입 사건과 회수 순서를 바꾼다", sourceEventIds: ["main-1", "donor-1"],
    synopsis: "자기 회사의 첫 투자를 결정하는 인물이 직접 상대를 만난다. 기존 자금과 인재를 이용하여 자기 이익을 확보한다. ".repeat(8) + "\n다음 선택으로 이어진다.\n남은 자금은 자기 사업에 쓴다.",
    eventComparisons: ["개입", "투자"].map((baselineEvent) => ({ baselineEvent, retainedFunction: { personalGoal: "자기 목적", interventionReason: "개입 이유", advantageUse: "기억", personalGain: "자기 수익", readerPleasure: "선택과 반응", nextGoal: "자기 회사" }, donorEventIds: ["donor-1"], redesignedEvent: "다른 상대를 만난다", prerequisiteChanges: "실행 시점의 차이", downstreamConnection: "다음 투자로 잇는다" })),
    openingEpisodes: [1, 2, 3, 4].map((episode) => ({ episode, goal: "이익", action: "실행", gainOrProgress: "수익", endingPull: "다음 선택" })),
    firstInvestment: { item: "회사", informationEdge: "기억", capitalAndExecution: "기존 자금", sequence: "매수 후 매도", realizedReturn: "20억", nextUse: "자기 사업" },
    chronologyChanges: "실행 순서를 바꾼다", remainingQuestions: "사건의 읽는 맛",
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inkos-variation-recovery-")); roots.push(root);
  const sourcePath = join(root, "source.txt"); const source = "실제 사건의 시작\n선택과 결산\n";
  await writeFile(sourcePath, source);
  await writeJson(join(root, "baseline.json"), { candidateId: "p01", titleCandidates: ["기준안"], projectPlan: variationProjectPlanFixture, oneLinePromise: "자기 수익을 얻는다", protagonist: { startingIdentity: "상속인" }, openingEpisodes: [], firstReward: "자기 이익", railB: [] });
  const event = { workTitle: "합성 원작", sourcePath, sourceSha256: hash(source), startLine: 1, endLine: 2, chapterRange: "1화", actualEvent: "선택과 결산", privateGoal: "자기 이익", interventionReason: "기회", advantageUse: "기억", personalGain: "수익", readerPleasure: "행동과 반응", nextGoal: "사업", prerequisites: "자금", transferUse: "사건", doNotTransfer: "별개 능력" };
  await writeJson(join(root, "events.json"), { events: [{ ...event, eventId: "main-1", role: "main" }, { ...event, eventId: "donor-1", role: "donor" }] });
  await writeJson(join(root, "spec.json"), { slateId: "variation-test", baselinePath: "baseline.json", baselineSlateId: "baseline", eventsPath: "events.json", scope: { episodeStart: 1, episodeEnd: 4, through: "첫 투자 회수" }, instruction: "새 사건을 고른다", directions: ["첫 방향", "둘째 방향"] });
  const directory = join(root, "prepared");
  await preparePitchVariation({ projectRoot: root, specPath: "spec.json", outputDir: directory });
  const request = JSON.parse(await readFile(join(directory, "request.json"), "utf8")) as PitchVariationRequest;
  // Preserve a legacy saved-response recovery fixture with no new plan field.
  delete request.planningGuidanceVersion; delete request.baselineProjectPlan;
  await writeJson(join(directory, "request.json"), request);
  const manifestPath = join(directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")); manifest.requestSha256 = variationHash(request);
  await writeJson(manifestPath, manifest);
  return { root, directory, request };
}

async function savedCall(setup: Awaited<ReturnType<typeof fixture>>, value = candidate()) {
  const { root, directory, request } = setup;
  const sessionId = `pitch-variation-${randomUUID()}`; const callDir = join(directory, "calls", sessionId);
  await mkdir(callDir, { recursive: true }); await mkdir(join(root, ".inkos", "sessions"), { recursive: true });
  const prompt = variationCandidatePrompt(request, Number(value.candidateId.slice(1)) - 1);
  const raw = JSON.stringify(value).replaceAll("\\n", "\n");
  const startedAt = "2026-09-06T00:00:00.000Z"; const completedAt = "2026-09-06T00:01:00.000Z";
  const invocation = { stage: "pitch-variation-generation", candidateId: value.candidateId, sessionId, model: "gpt-6-astra", provider: "codex-cli", reasoning: "high", promptSha256: hash(prompt), promptBytes: Buffer.byteLength(prompt), toolCount: 0, startedAt };
  const requestId = "request-one"; const base = { version: 1, sessionId, timestamp: 1 };
  const transcript = [
    { ...base, seq: 0, type: "session_created", bookId: null, sessionKind: "pitch-slate", title: null, createdAt: 1, updatedAt: 1 },
    { ...base, seq: 1, type: "request_started", requestId, sessionKind: "pitch-slate", input: prompt },
    { ...base, seq: 2, type: "message", requestId, uuid: "user-one", parentUuid: null, role: "user", message: { role: "user", content: prompt } },
    { ...base, seq: 3, type: "message", requestId, uuid: "assistant-one", parentUuid: "user-one", role: "assistant", message: { role: "assistant", model: "gpt-6-astra", provider: "codex-cli", stopReason: "stop", content: [{ type: "text", text: raw }] } },
    { ...base, seq: 4, type: "request_committed", requestId },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
  const transcriptPath = join(root, ".inkos", "sessions", `${sessionId}.jsonl`);
  const receipt = { ...invocation, completedAt, responseSha256: hash(raw), transcriptPath, transcriptSha256: hash(transcript), callDir };
  await writeFile(join(callDir, "prompt.txt"), prompt); await writeFile(join(callDir, "response.txt"), raw); await writeFile(transcriptPath, transcript);
  await writeJson(join(callDir, "invocation.json"), invocation); await writeJson(join(callDir, "receipt.json"), receipt);
  await writeJson(join(callDir, "failure.json"), { ...invocation, failedAt: "2026-09-06T00:01:01.000Z", error: "candidate response was not valid JSON: Bad control character in string literal" });
  return { callDir, raw, transcriptPath, value };
}

describe("lossless variation response parsing", () => {
  it("escapes only literal control characters and proves exact string values, offsets and response hashes", () => {
    const value = { text: '앞 "인용"\\경로\n새 줄\t끝\u0000', number: 20.5 };
    const raw = "\n```json\n" + JSON.stringify(value).replaceAll("\\n", "\n").replaceAll("\\t", "\t").replaceAll("\\u0000", "\u0000") + "\n```\n";
    const parsed = parseVariationResponse(raw);
    expect(parsed.value).toEqual(value);
    const proof = parsed.responseNormalization!;
    expect(proof.changes.map((change) => change.codePoint)).toEqual([10, 9, 0]);
    expect(proof.originalResponseSha256).toBe(hash(raw));
    let escaped = raw;
    for (const change of [...proof.changes].reverse()) {
      expect(change.utf8Offset).toBe(Buffer.byteLength(raw.slice(0, change.utf16Offset)));
      expect(raw.charCodeAt(change.utf16Offset)).toBe(change.codePoint);
      escaped = escaped.slice(0, change.utf16Offset) + change.jsonEscape + escaped.slice(change.utf16Offset + 1);
    }
    expect(proof.escapedResponseSha256).toBe(hash(escaped));
    expect(parseVariationResponse(JSON.stringify(value))).toEqual({ value });
  });

  it.each(['{"text":"줄\n바꿈",}', '{"text":"줄\n바꿈","n":01}', '{"text":"잘못된\\q\n"}', '{"text":"역슬래시\\\n"}', '{\u0000"text":"줄\n"}'])("refuses every non-control-escaping syntax error: %j", (raw) => {
    expect(() => parseVariationResponse(raw)).toThrow();
  });
});

describe("saved variation call recovery", () => {
  it("publishes only schema-normalized saved content, preserves failure and native evidence, and resumes without generation", async () => {
    const setup = await fixture();
    const first = await savedCall(setup); const second = await savedCall(setup, candidate("v02"));
    const protectedPaths = ["prompt.txt", "response.txt", "invocation.json", "receipt.json", "failure.json"].map((name) => join(first.callDir, name)).concat(first.transcriptPath);
    const before = await Promise.all(protectedPaths.map((path) => readFile(path)));
    const result = await recoverSavedPitchVariationCall(setup.root, setup.directory, first.callDir);
    expect(JSON.parse(await readFile(join(setup.directory, "v01.json"), "utf8"))).toEqual(first.value);
    expect(result.recovery.status).toBe("recovered-parse-only");
    expect(result.responseNormalization?.changes).toHaveLength(2);
    expect(result.recovery.originalFailureSha256).toBe(hash(before[4]!));
    expect(await Promise.all(protectedPaths.map((path) => readFile(path)))).toEqual(before);
    await expect(recoverSavedPitchVariationCall(setup.root, setup.directory, first.callDir)).rejects.toThrow(/overwrite/);
    await recoverSavedPitchVariationCall(setup.root, setup.directory, second.callDir);
    expect((await generatePitchVariations(setup.root, setup.directory)).candidateIds).toEqual(["v01", "v02"]);
    const receiptPath = join(setup.directory, "v01-receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")); receipt.responseNormalization.changes[0].utf16Offset++;
    await writeJson(receiptPath, receipt);
    await expect(generatePitchVariations(setup.root, setup.directory)).rejects.toThrow(/normalization evidence/);
    expect(createPitchVariationCommand().commands.map((command) => command.name())).toContain("recover-saved-call");
  });

  it.each(["prompt", "transcript", "response", "failure", "source", "spec"])("refuses altered %s evidence before publishing any candidate", async (target) => {
    const setup = await fixture(); const call = await savedCall(setup);
    const path = target === "transcript" ? call.transcriptPath : target === "source" ? join(setup.root, "source.txt") : target === "spec" ? join(setup.root, "spec.json") : join(call.callDir, target === "failure" ? "failure.json" : `${target}.txt`);
    await writeFile(path, (await readFile(path, "utf8")) + " ");
    // failure bytes are explicitly linked at recovery time; changing semantics,
    // rather than merely its whitespace, must be rejected before that link exists.
    if (target === "failure") {
      const value = JSON.parse(await readFile(path, "utf8")); value.error = "Unrelated model failure"; await writeJson(path, value);
    }
    await expect(recoverSavedPitchVariationCall(setup.root, setup.directory, call.callDir)).rejects.toThrow();
    await expect(readFile(join(setup.directory, "v01.json"))).rejects.toThrow();
  });

  it("does not turn a recovered syntax error into authority for an invented source ID", async () => {
    const setup = await fixture();
    const call = await savedCall(setup, { ...candidate(), sourceEventIds: ["main-1", "donor-1", "invented"] });
    await expect(recoverSavedPitchVariationCall(setup.root, setup.directory, call.callDir)).rejects.toThrow(/invented/);
    await expect(readFile(join(setup.directory, "v01.json"))).rejects.toThrow();
  });
});
