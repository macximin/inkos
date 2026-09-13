import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CreativeBriefSourcesSchema, type CreativeBriefSources } from "../models/creative-brief.js";
import { readBookCreativeBrief, recordBookCreativeBrief, renderBookCreativeBrief, resolveBookCreativeBrief, verifyBookCreativeBriefSources } from "../planning/creative-brief.js";

const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inkos-creative-brief-"));
  roots.push(root);
  const bookDir = join(root, "book");
  await mkdir(join(bookDir, "story"), { recursive: true });
  const put = async (path: string, content: string | Buffer) => writeFile(join(bookDir, path), content);
  const manifest = async (value: unknown) => put("story/creative_brief.sources.json", JSON.stringify(value));
  return { root, bookDir, put, manifest };
}

describe("Book creative brief projection", () => {
  it("preserves explicit promises, desires, preferences and counterpreferences as original UTF-8 quotes", async () => {
    const f = await fixture();
    const original = "\uFEFF# 작가 의도\r\n\r\n## 독자 약속\r\n- 힘으로 얻은 자유를 생활에서 누리는 순간.\r\n## 사적 욕망\r\n- 내 시간을 남에게 빼앗기지 않는다.\r\n## 선호\r\n- 상대도 자기 몫을 지키려고 버틴다.\r\n## 피할 것\r\n- 돈의 크기만 읽는 보고서.\r\n## 보존할 것\r\n- 손해를 감수하는 이유를 생각하는 내면.\r\n";
    await f.put("story/author_intent.md", original);
    const context = await resolveBookCreativeBrief({ bookDir: f.bookDir, bookId: "book", chapterNumber: 7 });
    expect(context.projection.entries.map((entry) => entry.category)).toEqual([
      "reader-promise", "personal-desire", "preference", "avoid", "preserve",
    ]);
    for (const entry of context.projection.entries) {
      const raw = Buffer.from(original).subarray(entry.start, entry.end);
      expect(raw.toString("utf8")).toBe(entry.quote);
      expect(hash(raw)).toBe(entry.quoteSha256);
      expect(entry.sourceSha256).toBe(hash(original));
      expect(entry.authority).toBe("advisory");
    }
    expect(context.receipt.autoEnforcement).toBe(false);
    expect(context.receipt.modelCalls).toBe(0);
    expect(context.receipt.humanReviewRequired).toBe(false);
    expect(context.projection.unknownCategories).toContain("voice");
  });

  it("does not invent missing fields or turn placeholders, examples and reference analysis into intent", async () => {
    const f = await fixture();
    await f.put("story/author_intent.md", [
      "---", "reader-promise: invented yaml", "---", "# 작가 의도",
      "(이 작품의 장기 창작 방향을 적으세요.)", "## 선호", "미정",
      "```md", "선호: 코드 예제", "```", "<!-- private example -->", "> 참고작 인용",
      "## 참고작 분석", "선호: 남의 취향", "## 참고 작품", "선호: 다른 작품의 취향", "## References", "Preference: another work",
      "## 창작 방향", "- 위험을 선택한 이유를 남긴다.",
    ].join("\n"));
    await f.put("story/current_focus.md", "# 현재 집중점\n\n## 우선 전개\n\n(앞으로 1-3화에서 가장 먼저 진행할 내용을 적으세요.)\n");
    await f.put("story/brief.md", "# 작품 브리프\n직원 수는 열 명이다.\n## 독자 약속\n없음\n");
    const context = await resolveBookCreativeBrief({ bookDir: f.bookDir, bookId: "book" });
    expect(context.projection.entries.map((entry) => entry.quote)).toEqual(["- 위험을 선택한 이유를 남긴다."]);
    expect(context.projection.unknownCategories).toContain("reader-promise");
    expect(context.rendered).not.toContain("남의 취향");
    expect(context.rendered).not.toContain("다른 작품의 취향");
    expect(context.rendered).not.toContain("another work");
    expect(context.rendered).not.toContain("코드 예제");
    expect(context.rendered).not.toContain("직원 수");
  });

  it("reads nested labels and keeps explicit disagreement without silently choosing an owner rule", async () => {
    const f = await fixture();
    await f.put("story/author_intent.md", "# 작가 의도\n## 선호\n### 호흡\n- 빠른 대화를 좋아한다.\n## 목소리\n**보존할 것**: 느린 내면 독백.\n");
    await f.put("story/current_focus.md", "# Current Focus\n- Pause the negotiation this chapter.\nAvoid: a new opponent.\n");
    await f.put("story/book_rules.md", "---\nprohibitions:\n  - 자동 도덕 심사\n---\n");
    const projection = await readBookCreativeBrief({ bookDir: f.bookDir, bookId: "book", chapterNumber: 8 });
    expect(projection.entries.map((entry) => entry.category)).toEqual(["preference", "preserve", "current-focus", "avoid"]);
    const rendered = renderBookCreativeBrief(projection, { language: "en", maxCharacters: 10000 }).rendered;
    expect(rendered).toContain("빠른 대화");
    expect(rendered).toContain("느린 내면");
    expect(rendered).not.toContain("자동 도덕 심사");
    expect(rendered).toContain("Existing verified Book rules remain separate");
  });

  it("admits source-bound preference evidence but keeps reference analysis distinct", async () => {
    const f = await fixture();
    const text = "읽은 본문: 거래가 끝났다.\n선호: 돈보다 거절권을 얻은 뒤의 생활을 보고 싶다.\n";
    await f.put("story/reviewed-preference.md", text);
    const quote = "선호: 돈보다 거절권을 얻은 뒤의 생활을 보고 싶다.";
    const start = Buffer.byteLength(text.slice(0, text.indexOf(quote)));
    const source = { id: "review-one", path: "story/reviewed-preference.md", sha256: hash(text),
      kind: "preference-evidence" as const,
      reviewedText: [{ path: "story/reviewed-preference.md", sha256: hash(text), start: 0, end: Buffer.byteLength("읽은 본문: 거래가 끝났다."), quoteSha256: hash("읽은 본문: 거래가 끝났다.") }],
      selections: [{ category: "preference" as const, start, end: start + Buffer.byteLength(quote), quoteSha256: hash(quote) }] };
    await f.manifest({ schemaVersion: "book-creative-brief-sources/v1", bookId: "book", sources: [source] });
    const context = await resolveBookCreativeBrief({ bookDir: f.bookDir, bookId: "book" });
    expect(context.projection.entries[0]?.quote).toBe(quote);
    expect(context.rendered).toContain("[preference-evidence; advisory]");
    expect(context.rendered).toContain("Reviewed text (context only)");
    expect(context.projection.entries[0]?.reviewedText?.[0]?.quote).toBe("읽은 본문: 거래가 끝났다.");
    await f.manifest({ schemaVersion: "book-creative-brief-sources/v1", bookId: "book", sources: [{ ...source, kind: "reference-analysis" }] });
    const reference = await resolveBookCreativeBrief({ bookDir: f.bookDir, bookId: "book" });
    expect(reference.projection.entries[0]?.sourceKind).toBe("reference-analysis");
    expect(reference.projection.unknownCategories).toContain("preference");
    expect(reference.receipt.autoEnforcement).toBe(false);
  });

  it("rejects stale, split-character and incorrect selectors without partially admitting a source", async () => {
    const f = await fixture();
    const text = "선호: 누릴 자유\n";
    await f.put("story/evidence.md", text);
    const base = { schemaVersion: "book-creative-brief-sources/v1", bookId: "book", sources: [{
      id: "evidence", path: "story/evidence.md", sha256: hash(text), kind: "preference-evidence",
      reviewedText: [{ path: "story/evidence.md", sha256: hash(text), start: 0, end: Buffer.byteLength(text), quoteSha256: hash(text) }],
      selections: [{ category: "preference", start: 0, end: Buffer.byteLength(text), quoteSha256: hash(text) }],
    }] };
    for (const broken of [
      { ...base.sources[0], sha256: "0".repeat(64) },
      { ...base.sources[0], selections: [...base.sources[0]!.selections, { category: "avoid", start: 1, end: 3, quoteSha256: hash("x") }] },
      { ...base.sources[0], selections: [{ category: "avoid", start: 0, end: 900, quoteSha256: hash(text) }] },
    ]) {
      await f.manifest({ ...base, sources: [broken] });
      const context = await resolveBookCreativeBrief({ bookDir: f.bookDir, bookId: "book" });
      expect(context.projection.entries).toEqual([]);
      expect(context.projection.sources.find((source) => source.id === "evidence")?.status).not.toBe("current");
    }
  });

  it("respects pinned chapter scopes instead of recycling an old current-focus document", async () => {
    const f = await fixture();
    const text = "# 현재 집중점\n- 이 장면은 협상 직전까지만 쓴다.\n";
    await f.put("story/current_focus.md", text);
    await f.manifest({ schemaVersion: "book-creative-brief-sources/v1", bookId: "book", sources: [],
      documentScopes: [{ path: "story/current_focus.md", sha256: hash(text), scope: { fromChapter: 4, throughChapter: 6 } }] });
    expect((await readBookCreativeBrief({ bookDir: f.bookDir, bookId: "book", chapterNumber: 5 })).entries).toHaveLength(1);
    const late = await readBookCreativeBrief({ bookDir: f.bookDir, bookId: "book", chapterNumber: 7 });
    expect(late.entries).toEqual([]);
    expect(late.sources.find((source) => source.path.endsWith("current_focus.md"))?.status).toBe("out-of-scope");
    expect((await readBookCreativeBrief({ bookDir: f.bookDir, bookId: "book" })).sources.find((source) => source.path.endsWith("current_focus.md"))?.status).toBe("scope-unresolved");
    await f.put("story/current_focus.md", text + "- 다음 범위\n");
    const stale = await readBookCreativeBrief({ bookDir: f.bookDir, bookId: "book", chapterNumber: 5 });
    expect(stale.entries).toEqual([]);
    expect(stale.sources.find((source) => source.path.endsWith("current_focus.md"))?.status).toBe("stale");
  });

  it("does not reuse a preference when its reviewed manuscript changes or disappears", async () => {
    const f = await fixture();
    const comment = "보존할 것: 양보의 대가를 실제로 치르는 장면.";
    const manuscript = "그는 항구를 넘겨받는 대신 자기 이름을 지웠다.";
    await f.put("story/opinion.md", comment);
    await f.put("story/reviewed.md", manuscript);
    await f.manifest({ schemaVersion: "book-creative-brief-sources/v1", bookId: "book", sources: [{
      id: "liked-scene", path: "story/opinion.md", sha256: hash(comment), kind: "preference-evidence",
      selections: [{ category: "preserve", start: 0, end: Buffer.byteLength(comment), quoteSha256: hash(comment) }],
      reviewedText: [{ path: "story/reviewed.md", sha256: hash(manuscript), start: 0, end: Buffer.byteLength(manuscript), quoteSha256: hash(manuscript) }],
    }] });
    const first = await resolveBookCreativeBrief({ bookDir: f.bookDir, bookId: "book" });
    expect(first.projection.entries).toHaveLength(1);
    await f.put("story/reviewed.md", "같은 제목으로 바뀐 다른 본문");
    expect((await verifyBookCreativeBriefSources(f.bookDir, first.receipt)).changedSourceIds).toContain("liked-scene#reviewed-0");
    const changed = await resolveBookCreativeBrief({ bookDir: f.bookDir, bookId: "book" });
    expect(changed.projection.entries).toEqual([]);
    expect(changed.rendered).toBe("");
    await rm(join(f.bookDir, "story/reviewed.md"));
    const missing = await resolveBookCreativeBrief({ bookDir: f.bookDir, bookId: "book" });
    expect(missing.projection.entries).toEqual([]);
    expect(missing.projection.sources.find((source) => source.id === "liked-scene#reviewed-0")?.status).toBe("missing");
  });

  it("detects edited, newly created and removed sources while keeping projection identity stable across comparisons", async () => {
    const f = await fixture();
    await f.put("story/author_intent.md", "선호: 사적인 욕망\n");
    const first = await resolveBookCreativeBrief({ bookDir: f.bookDir, bookId: "book" });
    expect(await verifyBookCreativeBriefSources(f.bookDir, first.receipt)).toEqual({ current: true, changedSourceIds: [] });
    await expect(verifyBookCreativeBriefSources(f.bookDir, { ...first.receipt, sources: [] })).rejects.toThrow("source receipt");
    const unchanged = await resolveBookCreativeBrief({ bookDir: f.bookDir, bookId: "book", previousReceipt: first.receipt });
    expect(unchanged.projection.projectionSha256).toBe(first.projection.projectionSha256);
    expect(unchanged.projection.sources.every((source) => source.change === "unchanged")).toBe(true);
    await f.put("story/author_intent.md", "선호: 누리는 생활\n");
    await f.put("story/current_focus.md", "보존할 것: 망설임 뒤의 결단\n");
    expect((await verifyBookCreativeBriefSources(f.bookDir, first.receipt)).changedSourceIds).toEqual(["story/author_intent.md", "story/current_focus.md"]);
    const changed = await resolveBookCreativeBrief({ bookDir: f.bookDir, bookId: "book", previousReceipt: first.receipt });
    expect(changed.projection.projectionSha256).not.toBe(first.projection.projectionSha256);
    expect(changed.rendered).not.toContain("사적인 욕망");
    await rm(join(f.bookDir, "story/author_intent.md"));
    expect((await verifyBookCreativeBriefSources(f.bookDir, changed.receipt)).current).toBe(false);
  });

  it("fails closed for a malformed or wrong-Book binding and rejects escaping symlinks", async () => {
    const f = await fixture();
    await f.put("story/author_intent.md", "선호: 정당한 현재 방향\n");
    await f.manifest({ schemaVersion: "book-creative-brief-sources/v1", bookId: "another-book", sources: [] });
    expect((await readBookCreativeBrief({ bookDir: f.bookDir, bookId: "book" })).entries).toEqual([]);
    await f.put("story/creative_brief.sources.json", "private preference is not JSON");
    const invalid = await resolveBookCreativeBrief({ bookDir: f.bookDir, bookId: "book" });
    expect(invalid.projection.sources[0]?.status).toBe("invalid");
    expect(JSON.stringify(invalid)).not.toContain("private preference");
    await rm(join(f.bookDir, "story/creative_brief.sources.json"));
    await f.put("story/brief.md", "reader promise: normal\n");
    await rm(join(f.bookDir, "story/brief.md"));
    await writeFile(join(f.root, "outside.md"), "Reader Promise: private outside content");
    await symlink(join(f.root, "outside.md"), join(f.bookDir, "story/brief.md"));
    const outside = await resolveBookCreativeBrief({ bookDir: f.bookDir, bookId: "book" });
    expect(outside.projection.sources.find((source) => source.path.endsWith("brief.md"))?.status).toBe("invalid");
    expect(outside.rendered).not.toContain("outside content");
  });

  it("retains complete quotes and no partial instruction when character or token budgets are exhausted", async () => {
    const f = await fixture();
    await f.put("story/author_intent.md", "보존할 것: 위험을 선택하기 직전의 망설임.\n피할 것: 무조건 감탄하는 주변 인물.\n");
    const projection = await readBookCreativeBrief({ bookDir: f.bookDir, bookId: "book" });
    for (const options of [{ maxCharacters: 0 }, { maxCharacters: 100 }, { maxInputTokens: 5 }]) {
      const result = renderBookCreativeBrief(projection, options);
      expect(result.rendered).toBe("");
      expect(result.receipt.selectedEntryIds).toEqual([]);
      expect(result.receipt.omittedEntryIds).toHaveLength(2);
    }
    const full = renderBookCreativeBrief(projection);
    expect(full.receipt.renderedSha256).toBe(hash(full.rendered));
    expect(full.receipt.selectedEntryIds).toHaveLength(2);
    expect(() => renderBookCreativeBrief(projection, { maxInputTokens: -1 })).toThrow("budget");
  });

  it("performs no write, creates no Book state and leaves unrelated hard-rule bytes intact", async () => {
    const f = await fixture();
    const text = "독자 약속: 상대의 양보를 얻어내는 과정.\n";
    await f.put("story/brief.md", text);
    await f.put("story/book_rules.md", "raw diagnostic rule");
    const before = await readdir(join(f.bookDir, "story"));
    const context = await resolveBookCreativeBrief({ bookDir: f.bookDir, bookId: "book", chapterNumber: 1 });
    await verifyBookCreativeBriefSources(f.bookDir, context.receipt);
    expect(await readdir(join(f.bookDir, "story"))).toEqual(before);
    expect(await readFile(join(f.bookDir, "story/brief.md"), "utf8")).toBe(text);
    expect(await readFile(join(f.bookDir, "story/book_rules.md"), "utf8")).toBe("raw diagnostic rule");
    expect(await readdir(f.bookDir)).toEqual(["story"]);
  });

  it("keeps explicit facets reachable when a long generic author note precedes them", async () => {
    const f = await fixture();
    await f.put("story/author_intent.md", "# 작가 의도\n" + Array.from({ length: 20 }, (_, index) => `- 배경의 일반 방향 ${index}.`).join("\n"));
    await f.put("story/brief.md", "독자 약속: 비싼 시간을 자기 뜻대로 쓰는 장면.\n");
    await f.put("story/current_focus.md", "이번 집중점: 동료가 거절하는 사정을 보여 준다.\n");
    const context = await resolveBookCreativeBrief({ bookDir: f.bookDir, bookId: "book", maxCharacters: 1500 });
    expect(context.rendered).toContain("비싼 시간을");
    expect(context.rendered).toContain("동료가 거절");
    expect(context.receipt.omittedEntryIds.length).toBeGreaterThan(0);
    expect(context.receipt.characters).toBeLessThanOrEqual(1500);
  });

  it("rejects ambiguous binding identities, paths and chapter scopes at the boundary", () => {
    const base: CreativeBriefSources = { schemaVersion: "book-creative-brief-sources/v1", bookId: "book", documentScopes: [], sources: [] };
    expect(CreativeBriefSourcesSchema.safeParse({ ...base, documentScopes: [{ path: "story/current_focus.md", sha256: "0".repeat(64), scope: { fromChapter: 5, throughChapter: 2 } }] }).success).toBe(false);
    expect(CreativeBriefSourcesSchema.safeParse({ ...base, sources: [{ id: "source-manifest", path: "../private", sha256: "0".repeat(64), kind: "preference-evidence", selections: [] }] }).success).toBe(false);
  });

  it("accepts existing safe Korean Book IDs while leaving source identifiers ASCII", async () => {
    const f = await fixture(), bookId = "한국작가-거절할자유";
    await f.put("story/brief.md", "독자 약속: 얻은 자유를 쓰는 장면.\n");
    const manifest = { schemaVersion: "book-creative-brief-sources/v1", bookId, sources: [] };
    expect(CreativeBriefSourcesSchema.safeParse(manifest).success).toBe(true);
    await f.manifest(manifest);
    const context = await resolveBookCreativeBrief({ bookDir: f.bookDir, bookId, chapterNumber: 2 });
    expect(context.receipt.bookId).toBe(bookId);
    expect(context.rendered).toContain("얻은 자유를 쓰는 장면");
    expect(CreativeBriefSourcesSchema.safeParse({ ...manifest, sources: [{ id: "한글출처", path: "story/reference.md",
      sha256: "0".repeat(64), kind: "reference-analysis", selections: [{ category: "preference", start: 0, end: 1, quoteSha256: "0".repeat(64) }] }] }).success).toBe(false);
  });

  it("returns an empty optional projection for an unsafe Book ID without reading or creating files", async () => {
    const f = await fixture();
    const context = await resolveBookCreativeBrief({ bookDir: join(f.root, "not-created"), bookId: "../unsafe", chapterNumber: 1 });
    expect(context.rendered).toBe("");
    expect(context.projection.omitted).toEqual([{ sourceId: "book", reason: "invalid-book-id" }]);
    expect(await recordBookCreativeBrief(join(f.root, "not-created"), 1, "planning", context)).toBeUndefined();
    expect(await readdir(f.root)).toEqual(["book"]);
  });

  it("refuses an escaping creative-brief output symlink before creating a receipt", async () => {
    const f = await fixture();
    await f.put("story/brief.md", "독자 약속: 얻은 자유를 쓰는 장면.\n");
    const context = await resolveBookCreativeBrief({ bookDir: f.bookDir, bookId: "한국작가", chapterNumber: 1 });
    await mkdir(join(f.bookDir, "story/runtime"));
    const outside = join(f.root, "outside");
    await mkdir(outside);
    await symlink(outside, join(f.bookDir, "story/runtime/creative-brief"));
    await expect(recordBookCreativeBrief(f.bookDir, 1, "planning", context)).rejects.toThrow(/escape/u);
    expect(await readdir(outside)).toEqual([]);
  });
});
