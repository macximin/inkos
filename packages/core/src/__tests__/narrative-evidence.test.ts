import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NarrativeEvidenceEntrySchema, type NarrativeEvidenceEntry } from "../models/narrative-evidence.js";
import { buildNarrativeEvidenceArtifact, buildNarrativeEvidenceExtractionRules, parseNarrativeEvidenceOutput,
  readNarrativeEvidenceContext, renderNarrativeEvidenceContext, saveNarrativeEvidence, validateNarrativeEvidence } from "../state/narrative-evidence.js";
import { validateNarrativeEvidenceArtifactPaths } from "../state/narrative-evidence.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inkos-narrative-evidence-")); roots.push(root);
  const bookDir = join(root, "book");
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  const chapter = async (number: number, text: string) => {
    const chapterPath = `chapters/${String(number).padStart(4, "0")}.md`;
    const chapterFileContent = `# ${number}화\n\n${text}\n`;
    await writeFile(join(bookDir, chapterPath), chapterFileContent);
    return { bookId: "book", chapterNumber: number, chapterText: text, chapterPath, chapterFileContent };
  };
  return { root, bookDir, chapter };
}
function reward(threadId: string, stage: "promise" | "acquisition" | "experience" | "next-desire", evidence: string, character = "윤서"): NarrativeEvidenceEntry {
  return { kind: "reward", threadId, character, stage, evidence };
}

describe("Narrative evidence extraction and persistence", () => {
  it("parses an isolated optional marker and never returns raw invalid content or requests a retry", () => {
    expect(parseNarrativeEvidenceOutput("normal settlement")).toEqual({ status: "missing" });
    expect(parseNarrativeEvidenceOutput('normal\n=== NARRATIVE_EVIDENCE ===\n```json\n[]\n```\n=== NEXT ===\nmore').entries).toEqual([]);
    expect(parseNarrativeEvidenceOutput("=== NARRATIVE_EVIDENCE ===\nprivate invalid text")).toEqual({ status: "invalid", diagnostic: "optional-body-invalid-json" });
    expect(parseNarrativeEvidenceOutput("=== NARRATIVE_EVIDENCE ===\n[]\n=== NARRATIVE_EVIDENCE ===\n[]").status).toBe("invalid");
    expect(parseNarrativeEvidenceOutput("=== NARRATIVE_EVIDENCE ===\n{}").status).toBe("invalid");
  });

  it("validates each whole optional entry and keeps valid observations beside malformed or invented ones", () => {
    const text = "윤서는 금고의 비밀번호를 아직 몰랐다.\n금고의 비밀번호는 4812였다.";
    const result = validateNarrativeEvidence({ chapterNumber: 3, chapterText: text, entries: [
      { kind: "reader-disclosure", informationId: "safe-code", evidence: "금고의 비밀번호는 4812였다." },
      { kind: "character-awareness", informationId: "safe-code", character: "윤서", awareness: "unaware", evidence: "윤서는 금고의 비밀번호를 아직 몰랐다." },
      { kind: "reader-disclosure", informationId: "fake", evidence: "없는 원문" },
      { kind: "character-awareness", informationId: "safe-code", character: "민호", awareness: "aware", evidence: "금고의 비밀번호는 4812였다." },
      { kind: "reward", threadId: "x", character: "윤서", stage: "satisfaction", evidence: text },
      { kind: "reader-disclosure", informationId: "x", evidence: text, allCharactersKnow: true },
    ] });
    expect(result.entries).toHaveLength(2);
    expect(result.diagnostics.map((item) => item.reason)).toEqual(["quote-not-found", "character-not-in-quote", "invalid-entry", "invalid-entry"]);
    for (const entry of result.entries) {
      expect(Buffer.from(text).subarray(entry.quote.start, entry.quote.end).toString()).toBe(entry.entry.evidence);
      expect(entry.quote.sha256).toBe(hash(entry.entry.evidence));
    }
  });

  it("does not choose an arbitrary occurrence when an exact quotation repeats", () => {
    const chapterText = "윤서는 거절했다.\n윤서는 거절했다.";
    const entry = reward("offer", "experience", "윤서는 거절했다.");
    expect(validateNarrativeEvidence({ chapterNumber: 1, chapterText, entries: [entry] }).diagnostics[0]?.reason).toBe("ambiguous-quote");
    const precise = validateNarrativeEvidence({ chapterNumber: 1, chapterText, entries: [{ ...entry, occurrence: 1 }] });
    expect(precise.entries[0]?.quote.start).toBe(Buffer.byteLength("윤서는 거절했다.\n"));
    expect(validateNarrativeEvidence({ chapterNumber: 1, chapterText, entries: [{ ...entry, occurrence: 4 }] }).diagnostics[0]?.reason).toBe("invalid-occurrence");
  });

  it("can constrain reward labels to the host supplied threads without inventing stages", () => {
    const chapterText = "윤서는 열쇠를 받았다.";
    const result = validateNarrativeEvidence({ chapterNumber: 1, chapterText, allowedThreadIds: ["key"], entries: [
      reward("key", "acquisition", chapterText), reward("new-label", "promise", chapterText),
    ] });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.entry).toEqual(reward("key", "acquisition", chapterText));
    expect(result.diagnostics[0]?.reason).toBe("thread-not-admitted");
  });

  it("builds exact serialized chapter artifacts without touching the filesystem", () => {
    const chapterText = "윤서는 창고 열쇠를 손에 쥐었다.";
    const file = "\uFEFF# 4화\r\n\r\n" + chapterText + "\r\n";
    const artifact = buildNarrativeEvidenceArtifact({ bookId: "book", chapterNumber: 4, chapterText,
      chapterPath: "chapters/0004.md", chapterFileContent: file, entries: [reward("warehouse", "acquisition", chapterText)] });
    expect(artifact.record.chapterBodyStart).toBe(Buffer.byteLength("\uFEFF# 4화\r\n\r\n"));
    expect(artifact.record.chapterFileSha256).toBe(hash(file));
    expect(artifact.writes).toHaveLength(2);
    expect(artifact.writes.every((write) => write.relativePath.startsWith("story/runtime/narrative-evidence/"))).toBe(true);
    expect(artifact.record.authority).toBe("advisory");
    expect(() => buildNarrativeEvidenceArtifact({ bookId: "book", chapterNumber: 4, chapterText: "다른 본문",
      chapterPath: "chapters/0004.md", chapterFileContent: file, entries: [] })).toThrow("exact");
  });

  it("saves advisory sidecars idempotently while preserving chapter and canon files", async () => {
    const f = await fixture(), text = "윤서는 열쇠를 받았다.";
    const source = await f.chapter(1, text);
    await mkdir(join(f.bookDir, "story/state"), { recursive: true });
    await writeFile(join(f.bookDir, "story/state/current_state.json"), "canon bytes unchanged");
    const input = { ...source, bookDir: f.bookDir, entries: [reward("key", "acquisition", text)] };
    expect((await saveNarrativeEvidence(input)).status).toBe("saved");
    const existing = await saveNarrativeEvidence(input);
    expect(existing.status).toBe("unchanged");
    await rm(join(f.bookDir, existing.paths[0]!));
    expect((await saveNarrativeEvidence(input)).status).toBe("saved");
    expect(await readFile(join(f.bookDir, source.chapterPath), "utf8")).toBe(source.chapterFileContent);
    expect(await readFile(join(f.bookDir, "story/state/current_state.json"), "utf8")).toBe("canon bytes unchanged");
    const read = await readNarrativeEvidenceContext(f.bookDir, { bookId: "book", throughChapter: 1 });
    expect(read.rendered).toContain(text);
    expect(read.receipt.selectedEntryIds).toHaveLength(1);
    expect(read.receipt.modelCalls).toBe(0);
    expect(read.receipt.humanReviewRequired).toBe(false);
  });

  it("does not duplicate the same located observation through an optional occurrence field", () => {
    const chapterText = "윤서는 열쇠를 받았다.", entry = reward("key", "acquisition", chapterText);
    const result = validateNarrativeEvidence({ chapterNumber: 1, chapterText, entries: [entry, { ...entry, occurrence: 0 }] });
    expect(result.entries).toHaveLength(1);
    expect(result.diagnostics[0]?.reason).toBe("duplicate-entry");
  });

  it("keeps reader disclosure separate from explicit character awareness and another POV", async () => {
    const f = await fixture();
    const first = "금고의 비밀번호는 4812였다.\n윤서는 비밀번호를 몰랐다.\n민호는 비밀번호를 외웠다.";
    await saveNarrativeEvidence({ ...await f.chapter(1, first), bookDir: f.bookDir, entries: [
      { kind: "reader-disclosure", informationId: "safe-code", evidence: "금고의 비밀번호는 4812였다." },
      { kind: "character-awareness", informationId: "safe-code", character: "윤서", awareness: "unaware", evidence: "윤서는 비밀번호를 몰랐다." },
      { kind: "character-awareness", informationId: "safe-code", character: "민호", awareness: "aware", evidence: "민호는 비밀번호를 외웠다." },
    ] });
    const view = await readNarrativeEvidenceContext(f.bookDir, { bookId: "book", throughChapter: 1, povCharacter: "윤서" });
    expect(view.rendered).toContain("reader-only disclosure safe-code");
    expect(view.rendered).toContain("character-awareness safe-code · 윤서");
    expect(view.rendered).toContain("unaware");
    expect(view.rendered).not.toContain("민호는 비밀번호를 외웠다");
    expect(view.receipt.omittedEntryIds).toHaveLength(1);
    expect(view.rendered).toContain("모든 등장인물이 아는 정보가 아니다");
  });

  it("preserves same-thread chronology, acquisition versus experience and next desire without completing other threads", async () => {
    const f = await fixture();
    const events = [
      { number: 1, stage: "promise" as const, text: "윤서는 자기 시간을 되찾기 위해 창고를 갖고 싶었다." },
      { number: 2, stage: "acquisition" as const, text: "윤서는 창고 열쇠를 받았다." },
      { number: 3, stage: "experience" as const, text: "윤서는 퇴근을 재촉하는 전화를 끄고 창고 의자에 발을 올렸다." },
      { number: 4, stage: "next-desire" as const, text: "윤서는 이제 동생도 이곳에서 쉬게 하고 싶었다." },
    ];
    for (const event of events) await saveNarrativeEvidence({ ...await f.chapter(event.number, event.text), bookDir: f.bookDir,
      entries: [reward("warehouse-freedom", event.stage, event.text)] });
    const another = "윤서는 새 자동차 열쇠를 받았다.";
    await saveNarrativeEvidence({ ...await f.chapter(5, another), bookDir: f.bookDir, entries: [reward("car", "acquisition", another)] });
    const context = await readNarrativeEvidenceContext(f.bookDir, { bookId: "book", throughChapter: 5, query: "창고", maxCharacters: 12000 });
    const start = context.rendered.indexOf("reward thread warehouse-freedom");
    const end = context.rendered.indexOf("### reward thread car");
    const sequence = context.rendered.slice(start, end < 0 ? undefined : end);
    expect(sequence.indexOf("· promise")).toBeLessThan(sequence.indexOf("· acquisition"));
    expect(sequence.indexOf("· acquisition")).toBeLessThan(sequence.indexOf("· experience"));
    expect(sequence.indexOf("· experience")).toBeLessThan(sequence.indexOf("· next-desire"));
    const car = context.rendered.slice(end);
    expect(car).toContain("· acquisition");
    expect(car).not.toContain("· promise");
    expect(car).not.toContain("· experience");
  });

  it("never reads future evidence into an earlier chapter and rechecks revised or missing manuscript files", async () => {
    const f = await fixture();
    const old = "윤서는 열쇠가 없다는 사실을 알았다.", later = "윤서는 열쇠를 되찾았다.";
    const one = await f.chapter(1, old), two = await f.chapter(2, later);
    await saveNarrativeEvidence({ ...one, bookDir: f.bookDir, entries: [reward("key", "promise", old)] });
    await saveNarrativeEvidence({ ...two, bookDir: f.bookDir, entries: [reward("key", "acquisition", later)] });
    const earlier = await readNarrativeEvidenceContext(f.bookDir, { bookId: "book", throughChapter: 1 });
    expect(earlier.rendered).toContain(old);
    expect(earlier.rendered).not.toContain(later);
    await writeFile(join(f.bookDir, one.chapterPath), "# 수정본\n윤서는 다른 길로 갔다.\n");
    const changed = await readNarrativeEvidenceContext(f.bookDir, { bookId: "book", throughChapter: 1 });
    expect(changed.rendered).toBe("");
    expect(changed.receipt.excluded[0]?.reason).toBe("manuscript-or-evidence-changed");
    await rm(join(f.bookDir, two.chapterPath));
    const missing = await readNarrativeEvidenceContext(f.bookDir, { bookId: "book", throughChapter: 2 });
    expect(missing.rendered).toBe("");
    expect(missing.receipt.excluded.some((entry) => entry.reason === "manuscript-unavailable")).toBe(true);
  });

  it("replaces a chapter's current advisory set without retaining removed observations and archives prior records", async () => {
    const f = await fixture(), text = "윤서는 열쇠를 받았다.\n윤서는 쉴 곳을 얻었다.";
    const source = await f.chapter(1, text);
    const initial = await saveNarrativeEvidence({ ...source, bookDir: f.bookDir, entries: [reward("key", "acquisition", "윤서는 열쇠를 받았다.")] });
    const replacement = await saveNarrativeEvidence({ ...source, bookDir: f.bookDir, entries: [] });
    expect(replacement.record.recordSha256).not.toBe(initial.record.recordSha256);
    const current = await readNarrativeEvidenceContext(f.bookDir, { bookId: "book", throughChapter: 1 });
    expect(current.rendered).toBe("");
    expect(await readdir(join(f.bookDir, "story/runtime/narrative-evidence/records"))).toHaveLength(2);
  });

  it("rejects forged record quotations even after a caller recomputes the record self-hash", async () => {
    const f = await fixture(), text = "윤서는 열쇠를 받았다.";
    const saved = await saveNarrativeEvidence({ ...await f.chapter(1, text), bookDir: f.bookDir, entries: [reward("key", "acquisition", text)] });
    const forged = structuredClone(saved.record);
    forged.entries[0]!.entry.evidence = "윤서는 백만 원을 받았다.";
    const { recordSha256: _old, ...body } = forged;
    forged.recordSha256 = hash(JSON.stringify(body));
    await writeFile(join(f.bookDir, saved.paths[1]!), JSON.stringify(forged));
    const read = await readNarrativeEvidenceContext(f.bookDir, { bookId: "book", throughChapter: 1 });
    expect(read.rendered).toBe("");
    expect(read.receipt.excluded[0]?.reason).toBe("manuscript-or-evidence-changed");
  });

  it("does not break a quoted chronology group to fill a small input budget", async () => {
    const f = await fixture(), text = "윤서는 열쇠를 받았다.";
    await saveNarrativeEvidence({ ...await f.chapter(1, text), bookDir: f.bookDir, entries: [reward("key", "acquisition", text)] });
    for (const options of [{ maxCharacters: 100 }, { maxInputTokens: 3 }]) {
      const context = await readNarrativeEvidenceContext(f.bookDir, { bookId: "book", throughChapter: 1, ...options });
      expect(context.rendered).toBe("");
      expect(context.receipt.omittedEntryIds).toHaveLength(1);
    }
  });

  it("keeps a long-running thread usable with an explicitly incomplete chronological window", () => {
    const records = Array.from({ length: 12 }, (_, index) => {
      const text = `윤서는 ${index + 1}번째로 자기 시간을 어떻게 쓸지 골랐다. ` + "주변을 둘러본 뒤 결정을 내렸다. ".repeat(8);
      return buildNarrativeEvidenceArtifact({ bookId: "book", chapterNumber: index + 1, chapterText: text,
        chapterPath: `chapters/${index + 1}.md`, chapterFileContent: `# 제목\n${text}`,
        entries: [reward("freedom", index === 0 ? "promise" : index === 11 ? "next-desire" : "experience", text)] }).record;
    });
    const context = renderNarrativeEvidenceContext(records, { bookId: "book", throughChapter: 12, maxCharacters: 1600 });
    expect(context.rendered).toContain("윤서는 12번째로");
    expect(context.rendered).toContain("not a complete chronology");
    expect(context.rendered).not.toContain("· acquisition");
    expect(context.receipt.omittedEntryIds.length).toBeGreaterThan(0);
    expect(context.receipt.characters).toBeLessThanOrEqual(1600);
  });

  it("orders same-chapter events by their quoted location rather than an assumed reward-stage sequence", () => {
    const first = "윤서는 선금을 먼저 받았다.", second = "그 뒤 윤서는 다음 일을 약속했다.";
    const text = `${first}\n${second}`;
    const { record } = buildNarrativeEvidenceArtifact({ bookId: "book", chapterNumber: 1, chapterText: text,
      chapterPath: "chapters/1.md", chapterFileContent: `# 제목\n${text}`,
      entries: [reward("job", "promise", second), reward("job", "acquisition", first)] });
    const context = renderNarrativeEvidenceContext([record], { bookId: "book", throughChapter: 1 });
    expect(context.rendered.indexOf("· acquisition")).toBeLessThan(context.rendered.indexOf("· promise"));
  });

  it("handles absent storage, wrong-Book records and escaping paths without inventing state", async () => {
    const f = await fixture();
    expect((await readNarrativeEvidenceContext(f.bookDir, { bookId: "book", throughChapter: 0 })).rendered).toBe("");
    expect(await readdir(f.bookDir)).toEqual(["chapters"]);
    const text = "윤서는 열쇠를 받았다.", source = await f.chapter(1, text);
    await saveNarrativeEvidence({ ...source, bookDir: f.bookDir, entries: [reward("key", "acquisition", text)] });
    const other = await readNarrativeEvidenceContext(f.bookDir, { bookId: "other", throughChapter: 1 });
    expect(other.rendered).toBe("");
    expect(other.receipt.excluded[0]?.reason).toBe("invalid-record");
    await rm(join(f.bookDir, source.chapterPath));
    await writeFile(join(f.root, "outside.md"), source.chapterFileContent);
    await symlink(join(f.root, "outside.md"), join(f.bookDir, source.chapterPath));
    await expect(saveNarrativeEvidence({ ...source, bookDir: f.bookDir, entries: [] })).rejects.toThrow("escaped");
  });

  it("keeps extraction instructions optional and avoids universal knowledge or satisfaction claims", () => {
    const rules = buildNarrativeEvidenceExtractionRules("ko");
    expect(rules).toContain("=== NARRATIVE_EVIDENCE ===");
    expect(rules).toContain("Reader disclosure is not character awareness");
    expect(rules).toContain("A money amount alone is not experienced satisfaction");
    expect(NarrativeEvidenceEntrySchema.safeParse({ kind: "reader-disclosure", informationId: "one", evidence: "정확한 문장", character: "윤서" }).success).toBe(false);
    expect(validateNarrativeEvidence({ chapterNumber: 1, chapterText: "본문", entries: undefined }).diagnostics).toEqual([{ reason: "optional-missing" }]);
  });

  it("persists and reads existing safe Korean Book IDs while keeping thread IDs ASCII", async () => {
    const f = await fixture(), text = "윤서는 열쇠를 받았다.", bookId = "한국작가-거절할자유";
    const source = await f.chapter(1, text);
    const saved = await saveNarrativeEvidence({ ...source, bookId, bookDir: f.bookDir, entries: [reward("key", "acquisition", text)] });
    expect(saved.record.bookId).toBe(bookId);
    const read = await readNarrativeEvidenceContext(f.bookDir, { bookId, throughChapter: 1 });
    expect(read.rendered).toContain(text);
    expect(read.receipt.bookId).toBe(bookId);
    expect(NarrativeEvidenceEntrySchema.safeParse(reward("한글스레드", "acquisition", text)).success).toBe(false);
    const unsafe = await readNarrativeEvidenceContext(join(f.root, "not-created"), { bookId: "../unsafe", throughChapter: 1 });
    expect(unsafe.rendered).toBe("");
    expect(unsafe.receipt.excluded[0]?.reason).toBe("invalid-book-id");
    expect(await readdir(f.root)).toEqual(["book"]);
  });

  it("preflights transaction artifacts read-only and rejects immutable archive conflicts", async () => {
    const f = await fixture(), text = "윤서는 열쇠를 받았다.", source = await f.chapter(1, text);
    const artifact = buildNarrativeEvidenceArtifact({ ...source, entries: [reward("key", "acquisition", text)] });
    await validateNarrativeEvidenceArtifactPaths(f.bookDir, artifact.writes);
    expect(await readdir(f.bookDir)).toEqual(["chapters"]);
    await saveNarrativeEvidence({ ...source, bookDir: f.bookDir, entries: [reward("key", "acquisition", text)] });
    await validateNarrativeEvidenceArtifactPaths(f.bookDir, artifact.writes);
    await writeFile(join(f.bookDir, artifact.writes[0]!.relativePath), "changed archive");
    await expect(validateNarrativeEvidenceArtifactPaths(f.bookDir, artifact.writes)).rejects.toThrow("immutable record");
    expect(await readFile(join(f.bookDir, artifact.writes[0]!.relativePath), "utf8")).toBe("changed archive");
    await expect(validateNarrativeEvidenceArtifactPaths(f.bookDir, [artifact.writes[0]!, { relativePath: "../outside.json", content: "{}" }])).rejects.toThrow();
  });

  it("rejects existing and dangling escaping parent symlinks before the shared chapter transaction can write", async () => {
    const f = await fixture(), text = "윤서는 열쇠를 받았다.", source = await f.chapter(1, text);
    const artifact = buildNarrativeEvidenceArtifact({ ...source, entries: [reward("key", "acquisition", text)] });
    await mkdir(join(f.bookDir, "story/runtime"), { recursive: true });
    const outside = join(f.root, "outside"), link = join(f.bookDir, "story/runtime/narrative-evidence");
    await mkdir(outside);
    await symlink(outside, link);
    await expect(validateNarrativeEvidenceArtifactPaths(f.bookDir, artifact.writes)).rejects.toThrow(/escape/u);
    expect(await readdir(outside)).toEqual([]);
    await rm(link);
    await symlink(join(outside, "does-not-exist"), link);
    await expect(validateNarrativeEvidenceArtifactPaths(f.bookDir, artifact.writes)).rejects.toThrow(/unresolved|dangling/u);
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects an escaping final-component symlink even when its bytes match the expected current record", async () => {
    const f = await fixture(), text = "윤서는 열쇠를 받았다.", source = await f.chapter(1, text);
    const artifact = buildNarrativeEvidenceArtifact({ ...source, entries: [reward("key", "acquisition", text)] });
    await saveNarrativeEvidence({ ...source, bookDir: f.bookDir, entries: [reward("key", "acquisition", text)] });
    const outside = join(f.root, "outside.json");
    await writeFile(outside, artifact.writes[1]!.content);
    await rm(join(f.bookDir, artifact.writes[1]!.relativePath));
    await symlink(outside, join(f.bookDir, artifact.writes[1]!.relativePath));
    await expect(validateNarrativeEvidenceArtifactPaths(f.bookDir, artifact.writes)).rejects.toThrow(/escape/u);
    expect(await readFile(outside, "utf8")).toBe(artifact.writes[1]!.content);
  });
});
