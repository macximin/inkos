import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sourceFactRepairHash as hash, sourceFactRepairJson as json, type SourceFactRepairIndex, type SourceFactRepairRequest } from "@actalk/inkos-core";
import { preparePitchFactRepair, runPitchFactRepair, applyPitchFactRepair, createPitchFactRepairCommand } from "../commands/pitch-fact-repair.js";

const mocks = vi.hoisted(() => ({ projectRoot: "", runAgentSession: vi.fn() }));
vi.mock("@actalk/inkos-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actalk/inkos-core")>();
  return { ...actual, PipelineRunner: class {}, runAgentSession: mocks.runAgentSession };
});
vi.mock("../utils.js", () => ({
  findProjectRoot: () => mocks.projectRoot,
  loadConfig: vi.fn(async () => ({ language: "ko", llm: { provider: "codex-cli", model: "gpt-6-astra" } })),
  createClient: vi.fn(() => ({ _piModel: { id: "gpt-6-astra", provider: "codex-cli", codexReasoningEffort: "high" }, _apiKey: "test" })),
  buildPipelineConfig: vi.fn(() => ({})),
}));

type Obj = Record<string, any>;
const fixturePacket = JSON.parse(readFileSync(new URL("../../../core/src/__tests__/fixtures/source-first-pitch-review-v3.json", import.meta.url), "utf8")) as Obj;
const writeJson = (path: string, value: unknown) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

describe("source-first factual repair CLI", () => {
  let root: string;
  let slate: Obj;
  let preparedDir: string;
  let sourcePath: string;
  let slatePath: string;
  let indexPath: string;
  let index: SourceFactRepairIndex;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-fact-repair-")); mocks.projectRoot = root;
    preparedDir = join(root, "prepared"); sourcePath = join(root, "original.txt"); slatePath = join(root, "original-slate.json"); indexPath = join(root, "index.json");
    const raw = Buffer.from("회사를 먼저 설립한다.\n20억 달러의 수익을 얻는다.\n직원은 총 25명이 된다.\n이후 100억 달러의 수익을 얻는다.\n");
    await writeFile(sourcePath, raw);
    const pack = { kind: "reference-transformation-pack", id: "synthetic-ownership-fixture", source: { workSlug: "synthetic-ownership-fixture", workTitle: "계약 검증용 합성 원작", sourceSha256: hash(raw), chapterCount: 4 } };
    const packPath = join(root, "pack.json"); await writeJson(packPath, pack); const packBytes = await readFile(packPath);
    const candidates = ["p01", "p02"].map((candidateId) => {
      const { id: _id, sha256: _sha, independentReview: _review, ...candidate } = structuredClone(fixturePacket.candidates[0]);
      candidate.spineRetention.primaryReference = { packId: pack.id, packSha256: hash(packBytes), sourceSha256: hash(raw) };
      return { ...candidate, candidateId, primaryReference: "합성 원작의 회사와 자금 성장 순서", preservedSkeleton: ["자기 회사 소유", "자기 판단으로 투자", "수익을 자기 몫으로 확보"], surfaceVariation: "인명과 회사 이름은 합성 작품으로 변주한다.", linkedCausalAdjustments: ["개인 돈을 법인에 넣고 원작과 같은 순서로 투자한다."], supportingReferenceRoutes: [],
        firstReward: "회사 설립 후 100억 달러를 번 뒤 직원 25명을 채용한다.",
        longRunRisk: "합성 fixture이며 회사 설립 후 20억 달러, 직원 25명, 100억 달러 순서를 반복한다.",
        commercialScore: { promise: 18, earlyPayoff: 18, repeatEngine: 18, railConversion: 18, longRunSupply: 18, total: 90 }, decision: "pending" };
    });
    const instruction = "인물 이름을 바꾸되 원작의 자기 자산과 사건 순서를 유지한다.";
    slate = { schemaVersion: 2, planningMode: "source-first", sourceFirstReference: { packPath, packId: pack.id, packSha256: hash(packBytes), ...pack.source }, slateId: "original", canonStatus: "non-canonical", reviewStatus: "reviewed", candidateCount: 2, genre: "modern-fantasy-ko", targetChapters: 751, instruction, instructionSha256: hash(instruction), referenceInputs: [
      { path: sourcePath, sha256: hash(raw), bytes: raw.length }, { path: packPath, sha256: hash(packBytes), bytes: packBytes.length },
    ], generatedAt: "2026-09-05T00:00:00.000Z", candidates,
      review: { stale: "old-review" }, humanDecision: { candidateId: "p02" }, promotion: { stale: true }, runtimeReceipt: { model: "gpt-5.6-sol" }, recoveryProvenance: { old: "retained only by source SHA" },
    };
    await writeJson(slatePath, slate);
    const before = "100억 달러를 번 뒤 직원 25명을 채용한다";
    const occurrences: SourceFactRepairIndex["facts"][number]["occurrences"] = candidates.flatMap((candidate) => {
      const start = candidate.firstReward.indexOf(before);
      return [{ occurrenceId: `${candidate.candidateId}-wrong`, candidateId: candidate.candidateId, pointer: "/firstReward", fieldSha256: hash(candidate.firstReward),
        startByte: Buffer.byteLength(candidate.firstReward.slice(0, start)), endByte: Buffer.byteLength(candidate.firstReward.slice(0, start + before.length)), before,
        context: { startByte: 0, endByte: Buffer.byteLength(candidate.firstReward) }, role: "preserved-target" as const },
      { occurrenceId: `${candidate.candidateId}-correct`, candidateId: candidate.candidateId, pointer: "/longRunRisk", fieldSha256: hash(candidate.longRunRisk), startByte: 0, endByte: Buffer.byteLength(candidate.longRunRisk), before: candidate.longRunRisk,
        context: { startByte: 0, endByte: Buffer.byteLength(candidate.longRunRisk) }, role: "source-claim" as const }];
    });
    index = { schemaVersion: "source-fact-repair-index/v1", sourceSlateSha256: hash(await readFile(slatePath)), sourceSha256: hash(raw), coverage: "declared-occurrences-only", coverageNote: "합성 시험의 지정된 네 출현부만 확인한다.", anchors: [{ anchorId: "timeline", startLine: 1, endLine: 4, sha256: hash(raw) }], facts: [{ factId: "company-profit-staff", diagnosis: "회사 → 20억 → 25명 → 100억의 순서다.", anchorIds: ["timeline"], occurrences }] };
    await writeJson(indexPath, index);
    mocks.runAgentSession.mockReset();
    mocks.runAgentSession.mockImplementation(async (config: Obj) => {
      const request = JSON.parse(await readFile(join(preparedDir, "request.json"), "utf8")) as SourceFactRepairRequest;
      const result = { schemaVersion: "source-fact-repair-result/v1", requestSha256: hash(json(request)), decisions: request.index.facts.flatMap((fact) => fact.occurrences.map((occurrence) => ({ occurrenceId: occurrence.occurrenceId,
        action: occurrence.occurrenceId.endsWith("wrong") ? "replace" : "keep",
        ...(occurrence.occurrenceId.endsWith("wrong") ? { after: "20억 달러를 번 뒤 직원 25명을 채용하고 이후 100억 달러를 번다" } : {}), anchorIds: fact.anchorIds, reason: "원문 1~4행의 사건 순서를 해당 출현부와 대조했다." }))) };
      const responseText = JSON.stringify(result);
      const assistant = { role: "assistant", model: "gpt-6-astra", provider: "codex-cli", content: [{ type: "text", text: responseText }], stopReason: "stop" };
      await mkdir(join(root, ".inkos", "sessions"), { recursive: true });
      await writeFile(join(root, ".inkos", "sessions", `${config.sessionId}.jsonl`), `${JSON.stringify({ role: "assistant", message: assistant })}\n`);
      return { responseText, messages: [assistant] };
    });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const prepare = () => preparePitchFactRepair({ projectRoot: root, slatePath, sourcePath, indexPath, outputDir: preparedDir });
  const run = () => runPitchFactRepair({ projectRoot: root, preparedDir });
  const apply = (targetId = "repaired") => applyPitchFactRepair({ projectRoot: root, preparedDir, targetId });

  it("provides executable prepare/run/apply commands", () => {
    const command = createPitchFactRepairCommand();
    expect(command.name()).toBe("pitch-fact-repair");
    expect(command.commands.map((child) => child.name())).toEqual(["prepare", "run", "apply"]);
  });

  it("runs one fresh no-tool session and publishes a pending fork with all original evidence intact", async () => {
    const oldSha = hash(await readFile(slatePath));
    const prep = await prepare();
    expect(prep.bytes.prompt).toBeLessThan(prep.bytes.originalCandidates);
    const execution = await run();
    expect(mocks.runAgentSession).toHaveBeenCalledTimes(1);
    const sessionConfig = mocks.runAgentSession.mock.calls[0]![0];
    expect(sessionConfig.toolPolicy).toBe("none");
    expect(sessionConfig.modelInvocation).toEqual({ stage: "pitch-fact-repair", attempt: 1 });
    expect(sessionConfig.bookId).toBeNull();
    expect(sessionConfig.sessionKind).toBe("pitch-review");
    const output = await apply();
    const saved = JSON.parse(await readFile(join(output.targetDir, "slate.json"), "utf8"));
    expect(saved.reviewStatus).toBe("pending");
    expect(saved.canonStatus).toBe("non-canonical");
    expect(saved.candidates[0].firstReward).toContain("20억 달러를 번 뒤 직원 25명을 채용하고 이후 100억 달러");
    expect(saved.candidates[1].longRunRisk).toBe(slate.candidates[1].longRunRisk);
    for (const key of ["review", "humanDecision", "promotion", "runtimeReceipt", "recoveryProvenance"]) expect(saved[key]).toBeUndefined();
    expect(saved.sourceFactRepair.sourceSlateSha256).toBe(oldSha);
    expect(hash(await readFile(slatePath))).toBe(oldSha);
    expect(execution.declaredOccurrences).toBe(4);
    expect(output.semanticFidelity).toBe("unverified");
    expect(output.independentFullSourceReviewRequired).toBe(true);
    await expect(access(join(output.targetDir, "survival-review"))).rejects.toThrow();
    await expect(apply()).rejects.toThrow(/EEXIST/);
    await expect(run()).rejects.toThrow(/EEXIST/);
    await expect(prepare()).rejects.toThrow(/EEXIST/);
  });

  it.each(["reference", "original", "slate"])("rejects stale %s before any model call", async (target) => {
    await prepare();
    const path = target === "reference" ? slate.sourceFirstReference.packPath : target === "original" ? sourcePath : slatePath;
    await writeFile(path, `${await readFile(path, "utf8")} `);
    await expect(run()).rejects.toThrow(/Stale|stale/);
    expect(mocks.runAgentSession).not.toHaveBeenCalled();
  });

  it.each([
    ["current policy", "protagonist-context/v1"],
    ["unknown policy", "protagonist-context/future"],
    ["legacy policy absence", undefined],
  ])("preserves %s when publishing a repair fork", async (_label, policy) => {
    if (policy !== undefined) slate.protagonistContextPolicy = policy;
    await writeJson(slatePath, slate);
    index.sourceSlateSha256 = hash(await readFile(slatePath));
    await writeJson(indexPath, index);
    await prepare();
    await run();
    const output = await apply();
    const saved = JSON.parse(await readFile(join(output.targetDir, "slate.json"), "utf8"));
    expect(saved.protagonistContextPolicy).toBe(policy);
    expect(Object.prototype.hasOwnProperty.call(saved, "protagonistContextPolicy")).toBe(policy !== undefined);
    expect(saved.reviewStatus).toBe("pending");
  });

  it("rejects a missing keep occurrence and records failure without making a slate", async () => {
    await prepare();
    const normal = mocks.runAgentSession.getMockImplementation()!;
    mocks.runAgentSession.mockImplementationOnce(async (...args: unknown[]) => {
      const response = await normal(...args); const data = JSON.parse(response.responseText); data.decisions.pop();
      response.responseText = JSON.stringify(data); response.messages[0].content[0].text = response.responseText;
      return response;
    });
    await expect(run()).rejects.toThrow(/Every declared occurrence/);
    expect(JSON.parse(await readFile(join(preparedDir, "run", "failure.json"), "utf8")).stage).toBe("pitch-fact-repair");
    await expect(access(join(preparedDir, "run", "receipt.json"))).rejects.toThrow();
    await expect(apply()).rejects.toThrow();
  });

  it("rejects a pack-only review bundle even when --source supplies the immutable original", async () => {
    slate.referenceInputs = slate.referenceInputs.slice(1);
    await writeJson(slatePath, slate);
    index.sourceSlateSha256 = hash(await readFile(slatePath)); await writeJson(indexPath, index);
    await expect(prepare()).rejects.toThrow(/missing the exact original source anchor/);
    expect(mocks.runAgentSession).not.toHaveBeenCalled();
  });

  it("accepts the existing bounded original-excerpt bundle instead of requiring the entire novel", async () => {
    const raw = await readFile(sourcePath);
    const excerptPath = join(root, "curated-source-excerpts.txt");
    const excerpt = `Original source SHA-256: ${hash(raw)}\n<source_chapter>\n${raw.toString()}\n</source_chapter>\n`;
    await writeFile(excerptPath, excerpt);
    slate.referenceInputs[0] = { path: excerptPath, sha256: hash(excerpt), bytes: Buffer.byteLength(excerpt) };
    await writeJson(slatePath, slate);
    index.sourceSlateSha256 = hash(await readFile(slatePath)); await writeJson(indexPath, index);
    await expect(prepare()).resolves.toHaveProperty("independentFullSourceReviewRequired", true);
  });

  it.each(["result", "response", "transcript", "reference"])("rejects drift in saved %s before apply", async (target) => {
    await prepare(); const receipt = await run();
    if (target === "result") {
      const path = join(preparedDir, "run", "result.json"); const data = JSON.parse(await readFile(path, "utf8")); data.decisions[0].after = "수정한 다른 문구"; await writeJson(path, data);
    } else {
      const path = target === "response" ? join(preparedDir, "run", "response.txt") : target === "reference" ? slate.sourceFirstReference.packPath : receipt.transcript.path;
      await writeFile(path, `${await readFile(path, "utf8")} `);
    }
    await expect(apply()).rejects.toThrow();
    await expect(access(join(root, ".inkos", "pitch-slates", "repaired"))).rejects.toThrow();
  });

  it("refuses the original ID and unsafe target IDs", async () => {
    await prepare(); await run();
    await expect(apply("original")).rejects.toThrow(/different slate/);
    await expect(apply("../outside")).rejects.toThrow(/Unsafe/);
  });
});
