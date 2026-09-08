import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { estimateTextTokens } from "../llm/provider.js";
import {
  CurrentStateStateSchema,
  RuntimeStateDeltaSchema,
  type EntityObservation,
  type StoredEntityObservation,
} from "../models/runtime-state.js";
import { readEntityObservationContext, validateEntityObservations } from "../state/entity-observations.js";
import { applyRuntimeStateDelta, type RuntimeStateSnapshot } from "../state/state-reducer.js";

const chapter = "윤서는 해원기획의 대표를 만났다.\r\n해원은 자신과 회사 이름이 같다고 웃었다.\n";
const organization: EntityObservation = { kind: "organization", name: "해원기획", evidence: "윤서는 해원기획의 대표를 만났다." };
const person: EntityObservation = { kind: "person", name: "윤서", evidence: organization.evidence };
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const stored = (value: EntityObservation, sourceChapter: number): StoredEntityObservation => ({
  ...value, sourceChapter, chapterTextHash: hash(value.evidence),
});
function snapshot(chapterNumber = 0, observations?: StoredEntityObservation[]): RuntimeStateSnapshot {
  return {
    manifest: { schemaVersion: 2, language: "ko", lastAppliedChapter: chapterNumber, projectionVersion: 1, migrationWarnings: [] },
    currentState: { chapter: chapterNumber, facts: [], ...(observations !== undefined ? { entityObservations: observations } : {}) },
    hooks: { hooks: [] },
    chapterSummaries: { rows: [] },
  };
}

describe("chapter-backed entity observations", () => {
  it("records the exact quotation and original text hash without inventing identity or alias facts", () => {
    const result = validateEntityObservations({ chapter: 1, entityObservations: [organization, person] }, chapter);
    expect(result).toEqual([
      { ...organization, sourceChapter: 1, chapterTextHash: hash(chapter) },
      { ...person, sourceChapter: 1, chapterTextHash: hash(chapter) },
    ]);
    expect(result[0]!.chapterTextHash).not.toBe(hash(chapter.replace(/\r\n/g, "\n")));
  });

  it("rejects invented evidence even when the name occurs elsewhere in the chapter", () => {
    expect(() => validateEntityObservations({ chapter: 1, entityObservations: [{ ...organization, evidence: "해원기획은 이미 파산했다." }] }, chapter))
      .toThrow(/exact chapter quotation/);
  });

  it("requires the declared name in its own quotation and requires the source chapter text", () => {
    expect(() => validateEntityObservations({ chapter: 1, entityObservations: [{ ...organization, name: "해원 회장" }] }, chapter))
      .toThrow(/name is absent/);
    expect(() => validateEntityObservations({ chapter: 1, entityObservations: [organization] })).toThrow(/require the chapter text/);
  });

  it("does not treat Unicode-normalized or newline-normalized approximations as exact quotations", () => {
    expect(() => validateEntityObservations({ chapter: 1, entityObservations: [organization] }, chapter.normalize("NFD")))
      .toThrow(/exact chapter quotation/);
    expect(() => validateEntityObservations({ chapter: 1, entityObservations: [{ ...organization, evidence: chapter.replace(/\r\n/g, "\n") }] }, chapter))
      .toThrow(/exact chapter quotation/);
  });

  it("rejects unsupported identity fields and bounded-output overflow", () => {
    const base = { chapter: 1, entityObservations: [organization] };
    expect(() => RuntimeStateDeltaSchema.parse({ ...base, entityObservations: [{ ...organization, aliasOf: "다른 회사" }] })).toThrow();
    expect(() => RuntimeStateDeltaSchema.parse({ ...base, entityObservations: [{ ...organization, name: "가".repeat(121) }] })).toThrow();
    expect(() => RuntimeStateDeltaSchema.parse({ ...base, entityObservations: [{ ...organization, evidence: "가".repeat(1201) }] })).toThrow();
    expect(() => RuntimeStateDeltaSchema.parse({ ...base, entityObservations: Array.from({ length: 129 }, () => organization) })).toThrow();
  });

  it("keeps a person and an organization with the same name as separate observations", () => {
    const text = "해원은 해원이라는 회사를 세웠다.";
    const result = applyRuntimeStateDelta({ snapshot: snapshot(), chapterText: text, delta: RuntimeStateDeltaSchema.parse({
      chapter: 1,
      entityObservations: [
        { kind: "person", name: "해원", evidence: text },
        { kind: "organization", name: "해원", evidence: text },
      ],
    }) });
    expect(result.currentState.entityObservations?.map((entry) => entry.kind)).toEqual(["person", "organization"]);
  });

  it.each([undefined, []])("removes prior observations from a rewritten chapter when its replacement is %j", (replacement) => {
    const old = snapshot(2, [stored(person, 1), stored(organization, 2)]);
    const result = applyRuntimeStateDelta({
      snapshot: old,
      delta: RuntimeStateDeltaSchema.parse({ chapter: 2, entityObservations: replacement }),
      allowReapply: true,
    });
    expect(result.currentState.entityObservations).toEqual([stored(person, 1)]);
    expect(old.currentState.entityObservations).toHaveLength(2);
  });

  it("replaces the current chapter's observation while retaining earlier evidence and unrelated state patches", () => {
    const previous = snapshot(2, [stored(person, 1), stored(organization, 2)]);
    const replacement: EntityObservation = { kind: "organization", name: "새봄출판", evidence: "윤서는 새봄출판과 만났다." };
    const revised = applyRuntimeStateDelta({
      snapshot: previous,
      delta: RuntimeStateDeltaSchema.parse({ chapter: 2, entityObservations: [replacement], currentStatePatch: { currentGoal: "계약을 검토한다." } }),
      chapterText: replacement.evidence,
      allowReapply: true,
    });
    expect(revised.currentState.entityObservations).toEqual([stored(person, 1), stored(replacement, 2)]);
    const continued = applyRuntimeStateDelta({ snapshot: revised, delta: RuntimeStateDeltaSchema.parse({ chapter: 3, currentStatePatch: { currentLocation: "서울" } }) });
    expect(continued.currentState.entityObservations).toEqual(revised.currentState.entityObservations);
    const noPatch = applyRuntimeStateDelta({ snapshot: continued, delta: RuntimeStateDeltaSchema.parse({ chapter: 4 }) });
    expect(noPatch.currentState.entityObservations).toEqual(revised.currentState.entityObservations);
  });

  it("preserves legacy state shapes and rejects future provenance in persisted observations", () => {
    const result = applyRuntimeStateDelta({ snapshot: snapshot(), delta: RuntimeStateDeltaSchema.parse({ chapter: 1 }) });
    expect(result.currentState).toEqual({ chapter: 1, facts: [] });
    expect(CurrentStateStateSchema.parse({ chapter: 0 })).toEqual({ chapter: 0, facts: [] });
    expect(() => CurrentStateStateSchema.parse({ chapter: 1, facts: [], entityObservations: [stored(person, 2)] })).toThrow(/future chapter/);
  });
});

describe("entity observation reading context", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });
  async function book(value?: unknown): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "inkos-entity-observations-"));
    roots.push(root);
    if (value !== undefined) {
      await mkdir(join(root, "story", "state"), { recursive: true });
      await writeFile(join(root, "story", "state", "current_state.json"), JSON.stringify(value));
    }
    return root;
  }

  it("does not expose later chapters and prefers requested names before recent unrelated observations", async () => {
    const future: EntityObservation = { kind: "organization", name: "미래회사", evidence: "미래회사가 인수했다." };
    const root = await book(snapshot(3, [stored(person, 1), stored(organization, 2), stored(future, 3)]).currentState);
    const text = await readEntityObservationContext(root, { throughChapter: 2, query: "윤서의 다음 선택" });
    expect(text).toContain("본문에서 확인된 인물·조직 기록");
    expect(text).toContain("현재 상태를 보장하지 않습니다");
    expect(text.indexOf("[인물] 윤서")).toBeLessThan(text.indexOf("[조직] 해원기획"));
    expect(text).not.toContain("미래회사");
    const recent = await readEntityObservationContext(root, { throughChapter: 2 });
    expect(recent.indexOf("[조직] 해원기획")).toBeLessThan(recent.indexOf("[인물] 윤서"));
    expect(await readEntityObservationContext(root, { throughChapter: 0 })).toBe("");
  });

  it("fits its character budget using complete quotations, including skipping an oversized high-priority record", async () => {
    const long: EntityObservation = { kind: "organization", name: "긴회사", evidence: `긴회사 ${"가".repeat(1000)}` };
    const root = await book(snapshot(2, [stored(person, 1), stored(long, 2)]).currentState);
    const text = await readEntityObservationContext(root, { throughChapter: 2, query: "긴회사", maxChars: 300 });
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text).not.toContain("[조직] 긴회사");
    expect(text).toContain(person.evidence);
    expect(await readEntityObservationContext(root, { throughChapter: 2, maxChars: 10 })).toBe("");
    expect(await readEntityObservationContext(root, { throughChapter: 2, maxChars: 0 })).toBe("");
  });

  it("keeps the default 6000 character ceiling on a large history", async () => {
    const entries = Array.from({ length: 30 }, (_, index) => stored({ kind: "person", name: `인물${index}`, evidence: `인물${index} ${"가".repeat(350)}` }, index + 1));
    const root = await book(snapshot(30, entries).currentState);
    const text = await readEntityObservationContext(root, { throughChapter: 30 });
    expect(text.length).toBeLessThanOrEqual(6000);
    expect(text).toContain(entries[29]!.evidence);
    for (const entry of entries) {
      if (text.includes(`[인물] ${entry.name} ·`)) expect(text).toContain(entry.evidence);
    }
  });

  it("honors an additional token ceiling by skipping whole quotations even when the character budget permits them", async () => {
    const long: EntityObservation = { kind: "organization", name: "大公司", evidence: `大公司${"新".repeat(600)}` };
    const root = await book(snapshot(2, [stored(person, 1), stored(long, 2)]).currentState);
    const text = await readEntityObservationContext(root, { throughChapter: 2, query: "大公司", language: "en", maxChars: 6000, maxContextTokens: 180 });
    expect(estimateTextTokens(text)).toBeLessThanOrEqual(180);
    expect(text).toContain(person.evidence);
    expect(text).not.toContain("[Organization] 大公司");
    expect(text).not.toContain("新");
    const unlimited = await readEntityObservationContext(root, { throughChapter: 2, query: "大公司", language: "en", maxChars: 6000 });
    expect(unlimited).toContain(long.evidence);
    expect(estimateTextTokens(unlimited)).toBeGreaterThan(180);
    expect(await readEntityObservationContext(root, { throughChapter: 2, maxContextTokens: 0 })).toBe("");
  });

  it.each([
    ["en", "People and organizations observed in the manuscript", "Chapter 1"],
    ["zh", "正文中出现的人物与组织记录", "第1章"],
  ] as const)("localizes %s guidance while leaving quoted names and evidence intact", async (language, title, chapterLabel) => {
    const root = await book(snapshot(1, [stored(person, 1)]).currentState);
    const text = await readEntityObservationContext(root, { throughChapter: 1, language });
    expect(text).toContain(title);
    expect(text).toContain(chapterLabel);
    expect(text).toContain(person.evidence);
  });

  it("returns empty for missing/legacy files but rejects damaged schemas and invalid cutoffs", async () => {
    expect(await readEntityObservationContext(await book(), { throughChapter: 1 })).toBe("");
    expect(await readEntityObservationContext(await book({ chapter: 2, facts: [] }), { throughChapter: 2 })).toBe("");
    await expect(readEntityObservationContext(await book({ chapter: 2, facts: [], entityObservations: [{ ...stored(person, 1), aliases: ["가명"] }] }), { throughChapter: 2 })).rejects.toThrow();
    await expect(readEntityObservationContext(await book({ chapter: 2, facts: [], entityObservations: [{ ...stored(person, 1), name: "근거에없는인물" }] }), { throughChapter: 2 })).rejects.toThrow(/must quote its name/);
    await expect(readEntityObservationContext(await book(), { throughChapter: -1 })).rejects.toThrow(/throughChapter/);
    await expect(readEntityObservationContext(await book(), { throughChapter: Number.NaN })).rejects.toThrow(/throughChapter/);
    await expect(readEntityObservationContext(await book(), { throughChapter: 0, maxChars: -1 })).rejects.toThrow(/budget/);
    await expect(readEntityObservationContext(await book(), { throughChapter: 0, maxContextTokens: -1 })).rejects.toThrow(/token budget/);
    await expect(readEntityObservationContext(await book(), { throughChapter: 0, maxContextTokens: Number.NaN })).rejects.toThrow(/token budget/);
  });
});
