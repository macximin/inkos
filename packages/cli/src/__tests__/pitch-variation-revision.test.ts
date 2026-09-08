import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceFactRepairHash as hash, variationHash, PitchVariationCandidateSchema, type PitchVariationRequest, type PitchVariationCandidate } from "@actalk/inkos-core";
import { applyVariationRevisionPatch, assertVariationRevisionChanges, generatePitchVariations, preparePitchVariation, readVariationRevisionReviewContext, revisePitchVariation,
  reviewPitchVariations, exportPitchVariations, validateVariationRevisionAllowedPaths, variationRevisionPrompt, variationReviewPrompt } from "../commands/pitch-variation.js";
import { variationProjectPlanFixture } from "../../../core/dist/__tests__/fixtures/variation-project-plan-fixture.js";

const model = vi.hoisted(() => ({ calls: [] as Array<{ stage: string; prompt: string }>, invalidPatch: false }));
vi.mock("../utils.js", async (original) => ({ ...await original<typeof import("../utils.js")>(),
  loadConfig: async () => ({}), createClient: () => ({ _piModel: { id: "gpt-6-astra", provider: "codex-cli", codexReasoningEffort: "high" } }), buildPipelineConfig: () => ({}),
}));
vi.mock("@actalk/inkos-core", async (original) => ({ ...await original<typeof import("@actalk/inkos-core")>(), PipelineRunner: class {},
  runAgentSession: async (options: { sessionId: string; projectRoot: string; sessionKind: string; modelInvocation: { stage: string; candidateId?: string } }, prompt: string) => {
    const { stage, candidateId } = options.modelInvocation;
    model.calls.push({ stage, prompt });
    let value: unknown;
    if (stage === "pitch-variation-generation") value = { ...candidate(candidateId), ...(prompt.includes("## 작품 기획서 · webnovel-bounded-variation/v3") ? { projectPlan: variationProjectPlanFixture } : {}) };
    else if (stage === "pitch-variation-revision") {
      const base = JSON.parse(prompt.split("<base_candidate>\n")[1]!.split("\n</base_candidate>")[0]!) as PitchVariationCandidate;
      value = patch(base, model.invalidPatch ? "/title" : "/openingEpisodes/0/action", "먼저 고용한 직원에게 실행을 지시하고 자기 이익을 얻는다.");
    } else {
      const request = JSON.parse(prompt.split("<bound_request>\n")[1]!.split("\n</bound_request>")[0]!) as PitchVariationRequest;
      const candidates = JSON.parse(prompt.split("<candidates>\n")[1]!.split("\n</candidates>")[0]!) as PitchVariationCandidate[];
      value = { requestSha256: variationHash(request), candidatesSha256: variationHash(candidates), verdicts: candidates.map((item) => ({ candidateId: item.candidateId,
        review: { verdict: "ready", sourceAccuracy: { passed: true, evidence: "원문과 대조" }, selfInterest: { passed: true, evidence: "자기 이익" }, causalCoherence: { passed: true, evidence: "선행 조건" }, variationQuality: { passed: true, evidence: "다른 사건" }, readingPleasure: { assessment: "사건이 읽힌다", evidence: "행동과 반응" }, requiredRepair: "없음" } })), recommendation: null };
    }
    const raw = JSON.stringify(value);
    const base = { version: 1, sessionId: options.sessionId, timestamp: 1 };
    const requestId = "request-one";
    const transcript = [
      { ...base, seq: 0, type: "session_created", bookId: null, sessionKind: options.sessionKind, title: null, createdAt: 1, updatedAt: 1 },
      { ...base, seq: 1, type: "request_started", requestId, sessionKind: options.sessionKind, input: prompt },
      { ...base, seq: 2, type: "message", requestId, uuid: "user-one", parentUuid: null, role: "user", message: { role: "user", content: prompt } },
      { ...base, seq: 3, type: "message", requestId, uuid: "assistant-one", parentUuid: "user-one", role: "assistant", message: { role: "assistant", model: "gpt-6-astra", provider: "codex-cli", stopReason: "stop", content: [{ type: "text", text: raw }] } },
      { ...base, seq: 4, type: "request_committed", requestId },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n";
    await mkdir(join(options.projectRoot, ".inkos", "sessions"), { recursive: true });
    await writeFile(join(options.projectRoot, ".inkos", "sessions", `${options.sessionId}.jsonl`), transcript);
    return { responseText: raw };
  },
}));

const writeJson = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + "\n");
const roots: string[] = [];
afterEach(async () => { model.calls.length = 0; model.invalidPatch = false; await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function candidate(candidateId = "v01") {
  return PitchVariationCandidateSchema.parse({ candidateId, title: "자기 회사와 첫 투자", variationIntent: "개입과 회수 순서를 바꾼다", sourceEventIds: ["main-1", "donor-1"],
    synopsis: "자기 회사의 첫 투자를 결정하는 인물이 직접 상대를 만난다. 기존 자금과 인재를 이용하여 자기 이익을 확보한다. ".repeat(9),
    eventComparisons: ["개입", "투자"].map((baselineEvent) => ({ baselineEvent, retainedFunction: { personalGoal: "자기 목적", interventionReason: "기회", advantageUse: "기억", personalGain: "자기 수익", readerPleasure: "선택과 반응", nextGoal: "자기 회사" }, donorEventIds: ["donor-1"], redesignedEvent: "상대를 만난다", prerequisiteChanges: "실행 시점", downstreamConnection: "다음 투자" })),
    openingEpisodes: [1, 2, 3, 4].map((episode) => ({ episode, goal: "자기 이익", action: "실행", gainOrProgress: "수익", endingPull: "다음 선택" })),
    firstInvestment: { item: "회사", informationEdge: "기억", capitalAndExecution: "기존 자금", sequence: "매수 후 매도", realizedReturn: "20억", nextUse: "자기 사업" }, chronologyChanges: "실행 순서", remainingQuestions: "읽는 맛" });
}
const patch = (base: PitchVariationCandidate, path = "/openingEpisodes/0/action", after = "인재를 먼저 확보하고 실행한다") => ({ candidateId: base.candidateId, baseCandidateSha256: variationHash(base), changes: [{ path, after }] });

async function fixture(legacy: boolean | "v1" = false) {
  const root = await mkdtemp(join(tmpdir(), "inkos-variation-revision-")); roots.push(root);
  const source = "실제 사건의 시작\n선택과 결산\n"; const sourcePath = join(root, "source.txt"); await writeFile(sourcePath, source);
  await writeJson(join(root, "baseline.json"), { candidateId: "p01", titleCandidates: ["기준안"], projectPlan: variationProjectPlanFixture, oneLinePromise: "자기 이익", protagonist: { startingIdentity: "상속인" }, openingEpisodes: [], firstReward: "자기 몫", railB: [] });
  const event = { workTitle: "합성 원작", sourcePath, sourceSha256: hash(source), startLine: 1, endLine: 2, chapterRange: "1화", actualEvent: "선택과 결산", privateGoal: "자기 이익", interventionReason: "기회", advantageUse: "기억", personalGain: "수익", readerPleasure: "행동과 반응", nextGoal: "사업", prerequisites: "자금", transferUse: "사건", doNotTransfer: "별개 능력" };
  await writeJson(join(root, "events.json"), { events: [{ ...event, eventId: "main-1", role: "main" }, { ...event, eventId: "donor-1", role: "donor" }] });
  await writeJson(join(root, "spec.json"), { slateId: "revision-test", baselinePath: "baseline.json", baselineSlateId: "baseline", eventsPath: "events.json", scope: { episodeStart: 1, episodeEnd: 4, through: "첫 투자 회수" }, instruction: "새 사건을 고른다", directions: ["첫 방향", "둘째 방향"] });
  const directory = join(root, "prepared"); const outputDir = join(root, "revised");
  await preparePitchVariation({ projectRoot: root, specPath: "spec.json", outputDir: directory });
  if (legacy) {
    // Reconstruct a pre-guidance request only in this synthetic fixture.
    const requestPath = join(directory, "request.json");
    const request = JSON.parse(await readFile(requestPath, "utf8"));
    if (legacy === "v1") request.planningGuidanceVersion = "webnovel-bounded-variation/v1";
    else delete request.planningGuidanceVersion;
    delete request.baselineProjectPlan;
    await writeJson(requestPath, request);
    const manifestPath = join(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.requestSha256 = variationHash(request);
    await writeJson(manifestPath, manifest);
  }
  await generatePitchVariations(root, directory); await reviewPitchVariations(root, directory);
  const instructionPath = join(root, "instruction.txt"); const allowedPathsPath = join(root, "allowed.json");
  await writeFile(instructionPath, "기존 재미를 유지하며 인재를 먼저 확보하고 실행하게 한다.");
  await writeJson(allowedPathsPath, ["/openingEpisodes/0/action"]);
  return { root, directory, outputDir, params: { projectRoot: root, directory, outputDir, candidateId: "v01", instructionPath, allowedPathsPath } };
}

describe("bounded variation patch", () => {
  it("deterministically applies existing string replacements while preserving all locked values", () => {
    const base = candidate(); const applied = applyVariationRevisionPatch(base, patch(base), ["/openingEpisodes/0/action"]);
    expect(applied.changedPaths).toEqual(["/openingEpisodes/0/action"]);
    expect(applied.candidate.firstInvestment).toEqual(base.firstInvestment);
    expect(applied.candidate.openingEpisodes[0]!.action).toBe("인재를 먼저 확보하고 실행한다");
    expect(base.openingEpisodes[0]!.action).toBe("실행");
    expect(assertVariationRevisionChanges(base, applied.candidate, ["/openingEpisodes/0/action"])).toEqual(applied.changedPaths);
  });
  it.each(["nonallowed", "duplicate", "new-key", "array", "hash", "extra", "trim", "number", "id"])("rejects %s patch changes", (mode) => {
    const base = candidate(); const value: any = patch(base);
    if (mode === "nonallowed") value.changes[0].path = "/title";
    if (mode === "duplicate") value.changes.push(value.changes[0]);
    if (mode === "new-key") value.changes[0].path = "/invented";
    if (mode === "array") value.changes[0].path = "/openingEpisodes";
    if (mode === "hash") value.baseCandidateSha256 = "0".repeat(64);
    if (mode === "extra") value.notes = "extra";
    if (mode === "trim") value.changes[0].after = " 새 행동 ";
    if (mode === "number") value.changes[0].after = 42;
    if (mode === "id") value.candidateId = "v02";
    expect(() => applyVariationRevisionPatch(base, value, ["/openingEpisodes/0/action"])).toThrow();
  });
  it("rejects nonexistent/nonstring pointers and structural edits even with an allowed string", () => {
    const base = candidate();
    for (const path of ["/new", "/openingEpisodes/0/episode", "/openingEpisodes", "/openingEpisodes/00/action", "/foo~2bar"]) expect(() => validateVariationRevisionAllowedPaths(base, [path])).toThrow();
    expect(() => assertVariationRevisionChanges(base, { ...base, openingEpisodes: base.openingEpisodes.slice(1) }, ["/title"])).toThrow();
    expect(() => assertVariationRevisionChanges(base, { ...base, title: "다른 제목" }, ["/synopsis"])).toThrow();
  });
});

describe("native variation revision evidence", () => {
  it.each([false, true, "v1"] as const)("preserves original and carried bytes, patch lineage, and fresh review (legacy=%s)", async (legacy) => {
    const setup = await fixture(legacy);
    const names = ["request.json", "manifest.json", "v01.json", "v01.md", "v01-receipt.json", "v02.json", "v02.md", "v02-receipt.json", "review.json", "review-receipt.json"];
    const before = await Promise.all(names.map((name) => readFile(join(setup.directory, name))));
    const result = await revisePitchVariation(setup.params);
    expect(result.changedPaths).toEqual(["/openingEpisodes/0/action"]);
    expect(await Promise.all(names.map((name) => readFile(join(setup.directory, name))))).toEqual(before);
    for (const name of ["request.json", "manifest.json", "v02.json", "v02.md", "v02-receipt.json"]) expect(await readFile(join(setup.outputDir, name))).toEqual(await readFile(join(setup.directory, name)));
    await expect(readFile(join(setup.outputDir, "review.json"))).rejects.toThrow();
    const context = await readVariationRevisionReviewContext(setup.outputDir);
    expect(context?.instruction).toContain("인재");
    const request = JSON.parse(await readFile(join(setup.directory, "request.json"), "utf8"));
    expect(Object.hasOwn(request, "planningGuidanceVersion")).toBe(legacy !== true);
    const base = JSON.parse(before[2]!.toString());
    expect(model.calls.at(-1)!.prompt).toBe(variationRevisionPrompt(request, base, context!.instruction, context!.allowedPaths));
    expect(model.calls.at(-1)!.prompt).not.toContain("<candidates>");
    expect(variationReviewPrompt(request, [])).not.toContain("bounded_revision_context");
    const callsBeforeResume = model.calls.length;
    await generatePitchVariations(setup.root, setup.outputDir);
    expect(model.calls).toHaveLength(callsBeforeResume);
    await expect(revisePitchVariation(setup.params)).rejects.toThrow(/EEXIST/);
    expect(model.calls).toHaveLength(callsBeforeResume);
    await reviewPitchVariations(setup.root, setup.outputDir);
    expect(model.calls.at(-1)!.prompt).toContain("<bounded_revision_context>");
    expect(model.calls.at(-1)!.prompt).toContain(context!.instruction);
    for (const call of model.calls) {
      expect(call.prompt.includes("## 작품 기획서 · webnovel-bounded-variation/v3")).toBe(legacy === false);
      expect(call.prompt.includes("## 작품 기획서 · webnovel-bounded-variation/v1")).toBe(legacy === "v1");
    }
    if (!legacy) expect(await readFile(join(setup.outputDir, "v01.md"), "utf8")).toBe(variationProjectPlanFixture.markdown);
    expect((await exportPitchVariations(setup.outputDir)).humanDecision).toBe("pending");
  });

  it.each(["instruction", "allowed", "proof", "base-receipt", "carried", "prompt", "remove-proof"])("rejects altered %s revision evidence without another model call", async (target) => {
    const setup = await fixture(); await revisePitchVariation(setup.params);
    const receiptPath = join(setup.outputDir, "v01-receipt.json"); const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    if (target === "instruction") await writeFile(setup.params.instructionPath, "다른 지시");
    if (target === "allowed") await writeJson(join(setup.outputDir, "revision-allowed-paths.json"), ["/title"]);
    if (target === "proof") { receipt.revision.patchSha256 = "0".repeat(64); await writeJson(receiptPath, receipt); }
    if (target === "base-receipt") await writeFile(join(setup.directory, "v01-receipt.json"), (await readFile(join(setup.directory, "v01-receipt.json"), "utf8")) + " ");
    if (target === "carried") await writeFile(join(setup.outputDir, "v02.json"), (await readFile(join(setup.outputDir, "v02.json"), "utf8")) + " ");
    if (target === "prompt") await writeFile(join(receipt.invocation.callDir, "prompt.txt"), "다른 입력");
    if (target === "remove-proof") { delete receipt.revision; await writeJson(receiptPath, receipt); }
    const callCount = model.calls.length;
    await expect(reviewPitchVariations(setup.root, setup.outputDir)).rejects.toThrow();
    expect(model.calls).toHaveLength(callCount);
  });

  it("retains failure evidence and refuses unrestricted generation or a duplicate revision after a disallowed model patch", async () => {
    const setup = await fixture(); model.invalidPatch = true;
    await expect(revisePitchVariation(setup.params)).rejects.toThrow(/nonallowed/);
    const failure = await readFile(join(setup.outputDir, "revision-failure.json"));
    const callCount = model.calls.length;
    await expect(generatePitchVariations(setup.root, setup.outputDir)).rejects.toThrow();
    await expect(revisePitchVariation(setup.params)).rejects.toThrow(/EEXIST/);
    expect(model.calls).toHaveLength(callCount);
    expect(await readFile(join(setup.outputDir, "revision-failure.json"))).toEqual(failure);
  });
});
