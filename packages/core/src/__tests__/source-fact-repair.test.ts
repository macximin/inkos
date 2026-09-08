import { describe, expect, it } from "vitest";
import {
  buildSourceFactRepairRequest, applySourceFactRepairResult, validateSourceFactRepairResult,
  sourceFactRepairHash as hash, sourceFactRepairJson as json,
  type SourceFactRepairIndex, type SourceFactRepairResult,
} from "../planning/source-fact-repair.js";

function fixture() {
  const sourceBytes = Buffer.from("회사를 먼저 만든다.\n20억 수익 뒤 직원 25명.\n그 다음 100억 수익.\n");
  const before = "100억 뒤 25명";
  const field = `원작은 ${before}. 같은 잘못된 설명: ${before}.`;
  const slate = { schemaVersion: 2, planningMode: "source-first", slateId: "before", canonStatus: "non-canonical", candidateCount: 2,
    instruction: "인물 이름의 변주를 유지한다.", instructionSha256: hash("인물 이름의 변주를 유지한다."),
    sourceFirstReference: { sourceSha256: hash(sourceBytes) }, referenceInputs: [{ path: "source.txt", sha256: hash(sourceBytes), bytes: sourceBytes.length }],
    candidates: [{ candidateId: "p01", firstReward: field, surfaceVariation: "이름은 김하준으로 바꾼다." }, { candidateId: "p02", firstReward: "회사 → 20억 → 25명 → 100억." }],
  };
  const slateBytes = Buffer.from(JSON.stringify(slate));
  const offsets = [field.indexOf(before), field.lastIndexOf(before)];
  const index: SourceFactRepairIndex = { schemaVersion: "source-fact-repair-index/v1", sourceSlateSha256: hash(slateBytes), sourceSha256: hash(sourceBytes), coverage: "declared-occurrences-only", coverageNote: "테스트에 지정한 두 중복 출현부와 한 올바른 출현부만 확인한다.",
    anchors: [{ anchorId: "sequence", startLine: 1, endLine: 3, sha256: hash(sourceBytes) }],
    facts: [{ factId: "timeline", diagnosis: "회사를 먼저 세우고 20억 이후 25명이 된 뒤 100억을 얻는다.", anchorIds: ["sequence"], occurrences: [
      ...offsets.map((start, i) => ({ occurrenceId: `p01-${i}`, candidateId: "p01", pointer: "/firstReward", fieldSha256: hash(field),
        startByte: Buffer.byteLength(field.slice(0, start)), endByte: Buffer.byteLength(field.slice(0, start + before.length)), before,
        context: { startByte: 0, endByte: Buffer.byteLength(field) }, role: "source-claim" as const })),
      { occurrenceId: "p02-correct", candidateId: "p02", pointer: "/firstReward", fieldSha256: hash(slate.candidates[1]!.firstReward), startByte: 0,
        endByte: Buffer.byteLength(slate.candidates[1]!.firstReward), before: slate.candidates[1]!.firstReward,
        context: { startByte: 0, endByte: Buffer.byteLength(slate.candidates[1]!.firstReward) }, role: "preserved-target" },
    ] }],
  };
  const request = buildSourceFactRepairRequest({ slateBytes, sourceBytes, index });
  const result: SourceFactRepairResult = { schemaVersion: "source-fact-repair-result/v1", requestSha256: hash(json(request)), decisions: [
    ...offsets.map((_, i) => ({ occurrenceId: `p01-${i}`, action: "replace" as const, after: "20억 뒤 25명, 이후 100억", anchorIds: ["sequence"], reason: "원문 1~3행은 회사와 20억, 인원 증가, 100억의 순서다." })),
    { occurrenceId: "p02-correct", action: "keep", anchorIds: ["sequence"], reason: "이미 원문 1~3행의 순서다." },
  ] };
  return { slate, slateBytes, sourceBytes, index, request, result };
}

describe("bounded source fact repair", () => {
  it("extracts exact raw lines, deduplicates context and repairs every declared duplicate by UTF-8 position", () => {
    const f = fixture();
    expect(f.request.sourceAnchors[0]!.text).toBe(f.sourceBytes.toString("utf8"));
    expect(f.request.contexts).toHaveLength(2);
    const out = applySourceFactRepairResult(f);
    expect(out.candidates[0]!.firstReward).toBe("원작은 20억 뒤 25명, 이후 100억. 같은 잘못된 설명: 20억 뒤 25명, 이후 100억.");
    expect(out.candidates[1]).toEqual(f.slate.candidates[1]);
    expect(out.changedFields).toHaveLength(1);
    expect(out.semanticFidelity).toBe("unverified");
    expect(out.coverage).toBe("declared-occurrences-only");
    expect(JSON.parse(f.slateBytes.toString())).toEqual(f.slate);
  });

  it.each(["source", "slate", "anchor", "field", "before"])("rejects stale %s data", (kind) => {
    const f = fixture();
    if (kind === "source") f.sourceBytes = Buffer.from("changed");
    if (kind === "slate") f.slateBytes = Buffer.from(`${f.slateBytes.toString()} `);
    if (kind === "anchor") f.index.anchors[0]!.sha256 = "0".repeat(64);
    if (kind === "field") f.index.facts[0]!.occurrences[0]!.fieldSha256 = "0".repeat(64);
    if (kind === "before") f.index.facts[0]!.occurrences[0]!.before = "다른 문구";
    expect(() => buildSourceFactRepairRequest(f)).toThrow(/Stale|stale/);
  });

  it.each(["missing", "duplicate", "unknown", "keep-after", "anchor"])("rejects invalid decision coverage: %s", (kind) => {
    const f = fixture();
    if (kind === "missing") f.result.decisions.pop();
    if (kind === "duplicate") f.result.decisions[1] = f.result.decisions[0]!;
    if (kind === "unknown") f.result.decisions[0]!.occurrenceId = "unlisted";
    if (kind === "keep-after") f.result.decisions[2]!.after = "새 문구";
    if (kind === "anchor") f.result.decisions[0]!.anchorIds = ["unlisted"];
    expect(() => validateSourceFactRepairResult(f.request, f.result)).toThrow();
  });

  it("rejects overlap, split UTF-8 boundaries, context omission, and unsafe structural paths", () => {
    for (const change of [
      (i: SourceFactRepairIndex) => { i.facts[0]!.occurrences[1] = { ...i.facts[0]!.occurrences[0]!, occurrenceId: "different-id" }; },
      (i: SourceFactRepairIndex) => { i.facts[0]!.occurrences[0]!.startByte = 1; },
      (i: SourceFactRepairIndex) => { i.facts[0]!.occurrences[0]!.context.startByte = 100; },
      (i: SourceFactRepairIndex) => { i.facts[0]!.occurrences[0]!.pointer = "/candidateId"; },
      (i: SourceFactRepairIndex) => { i.facts[0]!.occurrences[0]!.pointer = "/__proto__/firstReward"; },
      (i: SourceFactRepairIndex) => { i.facts[0]!.occurrences[0]!.pointer = "/spineRetention/rewards/0/kind"; },
    ]) {
      const f = fixture(); change(f.index);
      expect(() => buildSourceFactRepairRequest(f)).toThrow();
    }
  });

  it("keeps intentional variation bound to existing instruction rather than forcing it back to source", () => {
    const f = fixture();
    const occurrence = f.index.facts[0]!.occurrences[0]!;
    occurrence.role = "intentional-variation";
    expect(() => buildSourceFactRepairRequest(f)).toThrow(/authority/);
    occurrence.variationAuthority = { pointer: "/instruction", sha256: f.slate.instructionSha256 };
    const request = buildSourceFactRepairRequest(f);
    f.result.requestSha256 = hash(json(request));
    expect(() => validateSourceFactRepairResult(request, f.result)).toThrow(/protected/);
    f.result.decisions[0] = { occurrenceId: occurrence.occurrenceId, action: "keep", anchorIds: ["sequence"], reason: "지정된 변주는 사실 정정 권한으로 바꾸지 않는다. 미해결 충돌을 전체 심사에서 확인한다." };
    expect(validateSourceFactRepairResult(request, f.result).decisions[0]!.action).toBe("keep");
    occurrence.variationAuthority.sha256 = "0".repeat(64);
    expect(() => buildSourceFactRepairRequest(f)).toThrow(/authority SHA/);
  });

  it("rejects edited prepared evidence even if response is rehashed", () => {
    const f = fixture();
    f.request.sourceAnchors[0]!.text = "원문을 요약해 바꿔 넣은 자료";
    f.result.requestSha256 = hash(json(f.request));
    expect(() => applySourceFactRepairResult(f)).toThrow(/no longer matches/);
  });

  it("accepts keep-only work without claiming factual truth or producing extra changes", () => {
    const f = fixture();
    f.result.decisions = f.result.decisions.map(({ after: _after, ...decision }) => ({ ...decision, action: "keep" }));
    const applied = applySourceFactRepairResult(f);
    expect(applied.changedFields).toEqual([]);
    expect(applied.candidates).toEqual(f.slate.candidates);
    expect(applied.semanticFidelity).toBe("unverified");
  });
});
