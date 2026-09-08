import { describe, expect, it } from "vitest";
import {
  applyBoundedJsonRepair, buildBoundedJsonRepairRequest, createBoundedJsonRepairPatch, hashBoundedJson,
  type BoundedJsonRepairIssue, type BoundedJsonRepairRule,
} from "../planning/bounded-json-repair.js";

const rules: BoundedJsonRepairRule[] = [
  { kind: "integer", path: ["score", "a"], min: 0, max: 20 },
  { kind: "integer", path: ["score", "b"], min: 0, max: 20 },
  { kind: "sum", path: ["score", "total"], componentPaths: [["score", "a"], ["score", "b"]], min: 0, max: 40 },
];
const issues: BoundedJsonRepairIssue[] = [
  { path: ["score", "a"], code: "invalid_integer", message: "a must be an integer" },
  { path: ["score", "total"], code: "invalid_sum", message: "total must be the component sum" },
];
function fixture() {
  const original = { candidateId: "p01", source: { sourceSha256: "source-hash", sequence: 3 }, prose: "나는 내 회사를 소유한다.", score: { a: "19", b: 18, total: 99 }, rows: [{ id: "a" }, { id: "b" }] };
  const request = buildBoundedJsonRepairRequest({ original, issues, rules, protectedPaths: [["candidateId"], ["source"], ["prose"], ["rows"]] });
  const patch = createBoundedJsonRepairPatch(request);
  const validate = (value: unknown) => {
    const score = (value as { score: Record<string, unknown> }).score;
    return typeof score.a === "number" && typeof score.b === "number" && score.total === score.a + score.b ? [] : ["invalid score"];
  };
  return { original, request, patch, validate };
}

describe("bounded deterministic JSON repair", () => {
  it("converts exact integers and derives the sum while preserving every content field and the original", () => {
    const state = fixture();
    const before = JSON.stringify(state.original);
    const result = applyBoundedJsonRepair(state);
    expect(result).toEqual({ ...state.original, score: { a: 19, b: 18, total: 37 } });
    expect(JSON.stringify(state.original)).toBe(before);
    expect(state.request.allowedChanges).toEqual([
      { path: ["score", "a"], before: { exists: true, value: "19" }, after: 19 },
      { path: ["score", "total"], before: { exists: true, value: 99 }, after: 37 },
    ]);
  });

  it("binds a missing derived total explicitly without filling missing components", () => {
    const state = fixture();
    const original = { score: { a: "19", b: 18 } };
    const request = buildBoundedJsonRepairRequest({ original, issues, rules });
    expect(request.allowedChanges.at(-1)?.before).toEqual({ exists: false });
    expect(applyBoundedJsonRepair({ original, request, patch: createBoundedJsonRepairPatch(request), validate: state.validate })).toEqual({ score: { a: 19, b: 18, total: 37 } });
    expect(() => buildBoundedJsonRepairRequest({ original: { score: { a: "19" } }, issues, rules })).toThrow("missing integer");
  });

  it.each(["19.0", "019", "1.9e1", "19점", " 19 ", "+19", "-0", "21", "9007199254740992", null, true])("does not guess the meaning of component %j", (a) => {
    expect(() => buildBoundedJsonRepairRequest({ original: { score: { a, b: 18, total: 37 } }, issues, rules })).toThrow("preserves the value");
  });

  it("refuses missing evidence, unlocated or excessive issues", () => {
    for (const invalidIssues of [
      [{ path: ["source", "personalGoal"], code: "missing", message: "source evidence missing" }],
      [{ path: [], code: "syntax", message: "unlocated syntax error" }],
      Array.from({ length: 33 }, () => issues[0]!),
    ]) expect(() => buildBoundedJsonRepairRequest({ original: fixture().original, issues: invalidIssues, rules })).toThrow();
  });

  it("refuses protected paths even when a numeric value has a possible conversion", () => {
    const original = { source: { sequence: "3" } };
    expect(() => buildBoundedJsonRepairRequest({ original, issues: [{ path: ["source", "sequence"], code: "type", message: "integer" }], rules: [{ kind: "integer", path: ["source", "sequence"], min: 1, max: 10 }], protectedPaths: [["source"]] })).toThrow("protected path");
  });

  it("rejects stale original, changed before value, forged replacements, added source operations and duplicate operations", () => {
    const state = fixture();
    expect(() => applyBoundedJsonRepair({ ...state, original: { ...state.original, candidateId: "p02" } })).toThrow("original SHA");
    const changes = state.patch.changes;
    for (const forged of [
      [{ ...changes[0]!, before: { exists: false as const } }, changes[1]!],
      [{ ...changes[0]!, after: 20 }, changes[1]!],
      [...changes, { path: ["source", "sequence"], before: { exists: true as const, value: 3 }, after: 4 }],
      [...changes, changes[0]!],
      changes.slice(0, 1),
    ]) expect(() => applyBoundedJsonRepair({ ...state, patch: { ...state.patch, changes: forged } })).toThrow("bound allowed paths");
    expect(() => applyBoundedJsonRepair({ ...state, patch: { ...state.patch, requestSha256: "stale" } })).toThrow();
  });

  it("recomputes the request rather than trusting claimed before/after values or its SHA", () => {
    const state = fixture();
    expect(() => applyBoundedJsonRepair({ ...state, request: { ...state.request, requestSha256: "stale" } })).toThrow("request SHA");
    const { requestSha256: _sha, ...body } = state.request;
    const forgedBody = { ...body, allowedChanges: [{ ...body.allowedChanges[0]!, after: 20 }, body.allowedChanges[1]!] };
    const forged = { ...forgedBody, requestSha256: hashBoundedJson(forgedBody) };
    expect(() => applyBoundedJsonRepair({ ...state, request: forged, patch: createBoundedJsonRepairPatch(forged) })).toThrow("deterministic values");
  });

  it("fails atomically when the complete contract still rejects the patched candidate", () => {
    const state = fixture();
    const before = JSON.stringify(state.original);
    expect(() => applyBoundedJsonRepair({ ...state, validate: () => ["source binding differs"] })).toThrow("complete contract");
    expect(JSON.stringify(state.original)).toBe(before);
  });

  it("refuses changes introduced by a mutating final validator", () => {
    const state = fixture();
    expect(() => applyBoundedJsonRepair({ ...state, validate: (value) => {
      value.source.sequence = 4;
      return [];
    } })).toThrow("validation mutated");
    expect(state.original.source.sequence).toBe(3);
  });

  it.each([[], ["__proto__", "polluted"], ["constructor"], ["prototype"], ["score", -1]].map((path) => ({ path })))("rejects unsafe path $path", ({ path }) => {
    expect(() => buildBoundedJsonRepairRequest({ original: fixture().original, issues: [{ path, code: "type", message: "invalid" }], rules: [{ kind: "integer", path, min: 0, max: 20 }] })).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([["rows", 0, "id"], ["rows", "0", "id"], ["rows", 8], ["rows", "length"], ["rows"]].map((path) => ({ path })))("never mutates arrays at $path", ({ path }) => {
    expect(() => buildBoundedJsonRepairRequest({ original: { rows: [{ id: "1" }] }, issues: [{ path, code: "type", message: "invalid" }], rules: [{ kind: "integer", path, min: 0, max: 20 }] })).toThrow();
  });

  it("refuses unsafe JSON prototypes, accessors, special own keys, sparse arrays and non-JSON values", () => {
    let accessed = false;
    const accessor = Object.defineProperty({}, "score", { enumerable: true, get() { accessed = true; return 1; } });
    for (const original of [
      Object.create({ score: 1 }), accessor, JSON.parse('{"__proto__":{"polluted":true}}'),
      { score: undefined }, { score: Infinity }, { rows: new Array(2) }, { date: new Date() },
    ]) expect(() => hashBoundedJson(original)).toThrow();
    expect(accessed).toBe(false);
  });

  it("refuses overlapping rules and duplicate sum inputs", () => {
    const state = fixture();
    expect(() => buildBoundedJsonRepairRequest({ original: state.original, issues, rules: [...rules, rules[0]!] })).toThrow("overlapping");
    expect(() => buildBoundedJsonRepairRequest({ original: state.original, issues, rules: [...rules.slice(0, 2), { kind: "sum", path: ["score", "total"], componentPaths: [["score", "a"], ["score", "a"]], min: 0, max: 40 }] })).toThrow("duplicate components");
  });
});
