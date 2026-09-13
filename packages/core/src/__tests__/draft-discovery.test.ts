import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDraftDiscoveryReflowInput, createDraftDiscoveryPacket, draftDiscoveryExtractionGuidance, hashDraftDiscoveryPlan,
  loadDraftDiscoveryContext, parseDraftDiscoverySuggestions, projectDraftDiscoveryReflowDecisions,
  recordDraftDiscoveryPacket, renderDraftDiscoveryContext, renderDraftDiscoveryWritableTargets, validateDraftDiscoveryPacket,
  type DraftDiscoveryContext, type DraftDiscoveryCreateInput,
} from "../planning/draft-discovery.js";
import { StoryRailReflowStore } from "../arc/reflow-store.js";
import { StoryRailStore } from "../arc/rail-store.js";
import { ArcStore } from "../arc/store.js";
import { installReadyFixture, makeApplyInput } from "./fixtures/draft-discovery-fixture.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
describe("draft discoveries remain grounded future-plan candidates", () => {
  let bookDir: string, context: DraftDiscoveryContext, text: string, input: DraftDiscoveryCreateInput;
  beforeEach(async () => {
    bookDir = await mkdtemp(join(tmpdir(), "inkos-draft-discovery-"));
    await writeFile(join(bookDir, "book.json"), JSON.stringify({ id: "book-a", title: "Book A", platform: "qidian", genre: "urban", status: "active",
      targetChapters: 17, chapterWordCount: 2200, createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z" }));
    const fixture = await installReadyFixture(bookDir);
    context = { bookId: "book-a", plan: fixture.plan, arcs: [fixture.arc], chapters: fixture.chapters };
    text = await readFile(join(bookDir, "chapters", "0002_Chapter_2.md"), "utf8");
    input = { ...context, sourceChapter: 2, chapterText: text, expectedChapterTextSha256: sha(text), expectedPlanSha256: hashDraftDiscoveryPlan(context.plan),
      suggestions: [{ kind: "new-desire", evidence: "딸과 저녁을 먹겠다는 약속은 양보할 수 없었다.", observation: "지훈은 돈보다 딸과의 저녁을 우선했다.",
        implication: "다음 영입 제안은 보상액 대신 근무 조건을 시험할 수 있다.", futureRevisions: [{ bId: "B002", revision: {
          narrativeFunction: "퇴근 시간을 지키는 약속이 실제로 유지되는지 시험한다.", payoffAxis: "딸과 약속한 식탁에 제시간에 도착한다.",
          carriedReaderDebt: "조건을 지키면서 식당도 버틸 수 있는가?", contrastRequirement: "계약금 협상과 다른 생활상의 만족을 보여준다.",
        } }] }] };
  });
  afterEach(async () => { await rm(bookDir, { recursive: true, force: true }); });

  it("creates a deterministic exact-quote packet with a before/after diff and no canon mutation", async () => {
    const before = JSON.stringify(context), filesBefore = await readdir(bookDir);
    const packet = createDraftDiscoveryPacket(input)!;
    expect(createDraftDiscoveryPacket(input)).toEqual(packet);
    expect(JSON.stringify(context)).toBe(before); expect(await readdir(bookDir)).toEqual(filesBefore);
    expect(packet).toMatchObject({ authority: "advisory-future-plan", sourceChapter: 2, canonApplied: false, modelCallsAdded: 0 });
    const quote = packet.discoveries[0]!;
    expect(text.slice(quote.evidenceStart, quote.evidenceEnd)).toBe(quote.evidence);
    expect(packet.changes[0]).toMatchObject({ bId: "B002", before: { narrativeFunction: "Function 2" }, changedFields: ["narrativeFunction", "payoffAxis", "carriedReaderDebt", "contrastRequirement"] });
    expect(renderDraftDiscoveryContext(packet)).toContain("아직 일어난 사건이나 확정 계획이 아닙니다");
  });
  it("uses UTF-16 positions without silently normalizing the manuscript", () => {
    const chapterText = "🍲\r\n" + text;
    const packet = createDraftDiscoveryPacket({ ...input, chapterText, expectedChapterTextSha256: sha(chapterText) })!;
    const d = packet.discoveries[0]!;
    expect(d.evidenceStart).toBe(chapterText.indexOf(d.evidence));
    expect(chapterText.slice(d.evidenceStart, d.evidenceEnd)).toBe(d.evidence);
  });
  it("rejects stale manuscript or plan including content changes with an unchanged timestamp", () => {
    expect(() => createDraftDiscoveryPacket({ ...input, chapterText: text + "changed" })).toThrow("manuscript-drift");
    const plan = structuredClone(context.plan); plan.arcRouteRail.entries[1]!.payoffAxis = "changed";
    expect(() => createDraftDiscoveryPacket({ ...input, plan })).toThrow("plan-drift");
  });
  it("rejects missing and ambiguous quotes instead of inventing an occurrence", () => {
    const suggestions = structuredClone(input.suggestions) as Array<{ evidence: string }>;
    suggestions[0]!.evidence = "본문에 없는 문장";
    expect(() => createDraftDiscoveryPacket({ ...input, suggestions })).toThrow("quote-not-in-manuscript");
    const chapterText = text + text;
    expect(() => createDraftDiscoveryPacket({ ...input, chapterText, expectedChapterTextSha256: sha(chapterText) })).toThrow("quote-ambiguous");
  });
  it("rejects A/route/status writes and current, closed, retired or unknown B targets", () => {
    for (const bId of ["B001", "A01", "missing"]) {
      const suggestions = structuredClone(input.suggestions) as any[];
      suggestions[0].futureRevisions[0].bId = bId;
      expect(() => createDraftDiscoveryPacket({ ...input, suggestions })).toThrow("protected-or-missing-b");
    }
    for (const forbidden of ["routeOrder", "targetAnchorId", "status", "arcId"]) {
      const suggestions = structuredClone(input.suggestions) as any[];
      suggestions[0].futureRevisions[0].revision[forbidden] = "new";
      expect(() => createDraftDiscoveryPacket({ ...input, suggestions })).toThrow();
    }
    // Historical targets are no longer selectable even in a structurally valid draft plan.
    for (const status of ["retired", "closed"] as const) {
      const plan = structuredClone(context.plan); plan.arcRouteRail.status = "draft"; plan.arcRouteRail.entries[1]!.status = status;
      if (status === "closed") plan.arcRouteRail.entries[1]!.actualEpisodeCount = 2;
      expect(() => createDraftDiscoveryPacket({ ...input, plan, expectedPlanSha256: hashDraftDiscoveryPlan(plan) })).toThrow("protected-or-missing-b");
    }
  });
  it("rejects future B entries already bound to written or completed Arc content", () => {
    for (const completed of [false, true]) {
      const plan = structuredClone(context.plan); plan.arcRouteRail.entries[1]!.arcId = "arc-future";
      const arc = structuredClone(context.arcs[0]!); arc.id = "arc-future";
      if (completed) { arc.status = "completed"; arc.chapterNumbers = [3, 4]; arc.episodeBeats = arc.episodeBeats.map((b, i) => ({ ...b, chapterNumber: i + 3 })); }
      expect(() => createDraftDiscoveryPacket({ ...input, plan, arcs: [...context.arcs, arc], expectedPlanSha256: hashDraftDiscoveryPlan(plan) })).toThrow("protected-or-missing-b");
    }
  });
  it("requires complete bound-Arc and unambiguous Chapter inventory", () => {
    expect(() => createDraftDiscoveryPacket({ ...input, arcs: [] })).toThrow("bound-arc-missing");
    expect(() => createDraftDiscoveryPacket({ ...input, chapters: [...context.chapters, context.chapters[0]!] })).toThrow("duplicate-inventory");
    expect(() => createDraftDiscoveryPacket({ ...input, sourceChapter: 9 })).toThrow("source-chapter-missing");
  });
  it("rejects conflicting proposals and unchanged revisions", () => {
    const suggestions = structuredClone(input.suggestions) as any[];
    suggestions[0].futureRevisions.push(suggestions[0].futureRevisions[0]);
    expect(() => createDraftDiscoveryPacket({ ...input, suggestions })).toThrow("conflicting-b-revisions");
    suggestions[0].futureRevisions = [suggestions[0].futureRevisions[0]];
    const entry = context.plan.arcRouteRail.entries[1]!;
    suggestions[0].futureRevisions[0].revision = { narrativeFunction: entry.narrativeFunction, payoffAxis: entry.payoffAxis, carriedReaderDebt: entry.carriedReaderDebt, contrastRequirement: entry.contrastRequirement };
    expect(() => createDraftDiscoveryPacket({ ...input, suggestions })).toThrow("unchanged-revision");
  });
  it("leaves legacy output and empty optional output entirely file-free", async () => {
    expect(parseDraftDiscoverySuggestions("=== OBSERVATIONS ===\nlegacy").status).toBe("absent");
    expect(parseDraftDiscoverySuggestions("=== DRAFT_DISCOVERIES ===\n[]").suggestions).toEqual([]);
    expect(await recordDraftDiscoveryPacket(bookDir, createDraftDiscoveryPacket({ ...input, suggestions: [] }))).toBeNull();
    await expect(access(join(bookDir, "story", "runtime", "draft-discoveries"))).rejects.toMatchObject({ code: "ENOENT" });
    const loaded = await loadDraftDiscoveryContext(bookDir, context, { readChapterText: async () => { throw new Error("should not be called"); } });
    expect(loaded).toEqual({ rendered: "", packets: [], diagnostics: [] });
  });
  it("parses one optional section, preserves later settlement sections, and reports malformed output without retry", () => {
    const content = `=== DRAFT_DISCOVERIES ===\n${JSON.stringify(input.suggestions)}\n=== UPDATED_STATE ===\nunchanged`;
    expect(parseDraftDiscoverySuggestions(content)).toMatchObject({ status: "valid", suggestions: input.suggestions });
    expect(parseDraftDiscoverySuggestions(content + "\n=== DRAFT_DISCOVERIES ===\n[]").diagnostics).toContain("duplicate-discovery-section");
    expect(parseDraftDiscoverySuggestions("=== DRAFT_DISCOVERIES ===\n{broken").status).toBe("invalid");
    expect(draftDiscoveryExtractionGuidance()).toContain("항목을 채우려고");
    expect(renderDraftDiscoveryWritableTargets(context)).toContain('"bId":"B002"');
    expect(renderDraftDiscoveryWritableTargets(context)).not.toContain('"bId":"B001"');
    expect(renderDraftDiscoveryWritableTargets(context, { maxEntries: 1 })).not.toContain('"bId":"B003"');
    expect(renderDraftDiscoveryWritableTargets(context, { maxCharacters: 20 })).toBe("");
  });
  it("writes immutable idempotent sidecars and reads bounded complete proposals", async () => {
    const packet = createDraftDiscoveryPacket(input)!;
    const file = await recordDraftDiscoveryPacket(bookDir, packet);
    expect(await recordDraftDiscoveryPacket(bookDir, packet)).toBe(file);
    const loaded = await loadDraftDiscoveryContext(bookDir, context, { readChapterText: async () => text });
    expect(loaded.packets).toEqual([packet]); expect(loaded.diagnostics).toEqual([]);
    const small = await loadDraftDiscoveryContext(bookDir, context, { readChapterText: async () => text, maxCharacters: 20 });
    expect(small.rendered).toBe(""); expect(small.diagnostics[0]!.reason).toBe("discovery-context-budget");
    await writeFile(file!, "tampered");
    await expect(recordDraftDiscoveryPacket(bookDir, packet)).rejects.toThrow("sidecar-conflict");
  });
  it("excludes changed manuscript, changed future plan and changed writing inventory with diagnostics", async () => {
    const packet = createDraftDiscoveryPacket(input)!; await recordDraftDiscoveryPacket(bookDir, packet);
    const sourceChanged = await loadDraftDiscoveryContext(bookDir, context, { readChapterText: async () => text + "changed" });
    expect(sourceChanged.packets).toEqual([]); expect(sourceChanged.diagnostics[0]!.reason).toBe("discovery-manuscript-drift");
    const plan = structuredClone(context.plan); plan.arcRouteRail.entries[1]!.narrativeFunction += "changed";
    const planChanged = await loadDraftDiscoveryContext(bookDir, { ...context, plan }, { readChapterText: async () => text });
    expect(planChanged.diagnostics[0]!.reason).toBe("discovery-plan-drift");
    const chapters = [...context.chapters, { ...context.chapters[1]!, number: 3, arcProvenance: undefined }];
    expect(() => validateDraftDiscoveryPacket(packet, { ...context, chapters }, text)).toThrow("inventory-drift");
  });
  it("allows approval lifecycle changes without reclassifying them as plan discoveries", () => {
    const packet = createDraftDiscoveryPacket(input)!;
    const chapters = context.chapters.map(chapter => ({ ...chapter, status: "published" as const, updatedAt: "2026-08-10T00:00:00.000Z" }));
    expect(validateDraftDiscoveryPacket(packet, { ...context, chapters }, text)).toEqual(packet);
  });
  it("rejects packet tampering before persistence or projection", async () => {
    const packet = createDraftDiscoveryPacket(input)!;
    packet.changes[0]!.after.payoffAxis = "changed after binding";
    await expect(recordDraftDiscoveryPacket(bookDir, packet)).rejects.toThrow("packet-hash-mismatch");
    expect(() => projectDraftDiscoveryReflowDecisions(packet, context, text)).toThrow("packet-or-inventory-drift");
  });
  it("connects to the existing real reflow store only through an explicitly constructed apply input", async () => {
    const packet = createDraftDiscoveryPacket(input)!;
    const beforePlan = JSON.stringify(context.plan.anchorRail);
    const beforeChapter = await readFile(join(bookDir, "chapters", "0002_Chapter_2.md"), "utf8");
    const reflow = new StoryRailReflowStore(bookDir, { now: () => new Date("2026-08-09T11:00:00.000Z"), idFactory: () => "draft-discovery-fixture" });
    const prepared = await reflow.prepare("book-a", context.chapters);
    if (prepared.status === "not-eligible") throw new Error(prepared.message);
    const oldInput = makeApplyInput(prepared.pending.pendingId, prepared.pending.expectedPlanUpdatedAt);
    const applyInput = buildDraftDiscoveryReflowInput({ packet, context, chapterText: text, pending: prepared.pending, closeout: oldInput.closeout,
      nextActiveBId: "B002", nextProvisionalBId: "B003" });
    // Projection did not close B, apply a plan, or modify the current manuscript.
    expect((await new StoryRailStore(bookDir).load())!.arcRouteRail.entries[0]!.status).toBe("active");
    expect(applyInput.decisions[0]).toMatchObject({ bId: "B002", action: "revise", revision: { routeOrder: 200, targetAnchorId: "A02" } });
    const applied = await reflow.apply("book-a", context.chapters, applyInput);
    expect(JSON.stringify(applied.plan.anchorRail)).toBe(beforePlan);
    expect(applied.plan.arcRouteRail.entries[1]!.narrativeFunction).toBe(packet.changes[0]!.after.narrativeFunction);
    expect(await readFile(join(bookDir, "chapters", "0002_Chapter_2.md"), "utf8")).toBe(beforeChapter);
    expect((await new ArcStore(bookDir).load("arc-active")).status).toBe("completed");
  });
  it("does not fabricate reflow approval evidence for an unapproved draft discovery", async () => {
    const packet = createDraftDiscoveryPacket(input)!;
    const store = new StoryRailReflowStore(bookDir);
    const prepared = await store.prepare("book-a", context.chapters);
    if (prepared.status === "not-eligible") throw new Error(prepared.message);
    const pending = structuredClone(prepared.pending); pending.approvedChapters[1]!.chapterContentSha256 = "f".repeat(64);
    const old = makeApplyInput(pending.pendingId, pending.expectedPlanUpdatedAt);
    expect(() => buildDraftDiscoveryReflowInput({ packet, context, chapterText: text, pending, closeout: old.closeout, nextActiveBId: "B002" })).toThrow("source-not-attested");
  });
});
