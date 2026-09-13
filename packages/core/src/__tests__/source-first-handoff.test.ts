import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySourceFirstHandoff, validateSourceFirstHandoff, initializeSourceFirstHandoffBook, mapDailyPlanningCandidate } from "../planning/source-first-handoff.js";
import { assertApprovedFireflyPlanningAdmission } from "../planning/entry-contract.js";
import { StateManager } from "../state/manager.js";
import { ArcStore } from "../arc/store.js";
import { StoryRailStore } from "../arc/rail-store.js";
import { ReferencePackStore } from "../reference/store.js";
import { fixtureFile, hashBytes, standaloneHandoffFixture } from "./fixtures/source-first-handoff-fixture.js";

describe("source-first planning handoff", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "inkos-source-handoff-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const validate = (fixture: Awaited<ReturnType<typeof standaloneHandoffFixture>>) => validateSourceFirstHandoff({ projectRoot: root, manifestPath: "handoff.json", subject: fixture.subject });

  it("checks without writes and imports exactly the explicit Rail/Arc/source into existing InkOS readers", async () => {
    const fixture = await standaloneHandoffFixture(root);
    const before = await readdir(root);
    const checked = await validate(fixture);
    expect(checked).toMatchObject({ status: "validated-handoff", modelCalls: 0, manuscriptAuthorized: false, semanticMappingReviewPerformed: false });
    expect(await readdir(root)).toEqual(before);
    const bookDir = await fixture.initBook();
    const receipt = await applySourceFirstHandoff({ projectRoot: root, bookDir, book: fixture.book, handoff: checked });
    expect(receipt.status).toBe("planning-seed-imported");
    expect(await new StoryRailStore(bookDir).load()).toEqual(fixture.handoff.mapping.railPlan);
    expect(await new ArcStore(bookDir).getActive()).toEqual(fixture.handoff.mapping.activeArc);
    const reference = await new ReferencePackStore(root, bookDir).buildWriterContext({ book: fixture.book, chapterNumber: 1, arcId: "opening-arc" });
    expect(reference?.storyEntries).toHaveLength(4);
    expect(reference?.rendered).toContain("칭찬만 받지 않고 자기 지분");
    // The production reader accepts the existing approval; the adapter does not create it.
    await writeFile(join(bookDir, "story", "entry-contract.json"), JSON.stringify(checked.authorization.admission));
    expect((await assertApprovedFireflyPlanningAdmission({ bookDir, bookId: fixture.book.id })).sourceDecisionSha256).toBe(fixture.subject.sourceDecisionSha256);
    await expect(readdir(join(bookDir, "chapters"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(applySourceFirstHandoff({ projectRoot: root, bookDir, book: fixture.book, handoff: checked })).rejects.toThrow("refusing to overwrite");
  });

  it("initializes a complete discoverable Book from bound foundation bytes without generating them", async () => {
    const fixture = await standaloneHandoffFixture(root);
    const checked = await validate(fixture);
    await initializeSourceFirstHandoffBook({ projectRoot: root, book: fixture.book, brief: "합성 입력 전달", handoff: checked });
    expect(await new StateManager(root).listBooks()).toEqual([fixture.book.id]);
    const bookDir = join(root, "books", fixture.book.id);
    for (const file of fixture.handoff.mapping.foundationFiles) expect(await readFile(join(bookDir, "story", file.target), "utf8")).toBe(await readFile(join(root, file.file.path), "utf8"));
    expect(await assertApprovedFireflyPlanningAdmission({ bookDir, bookId: fixture.book.id })).toEqual(checked.authorization.admission);
    expect(JSON.parse(await readFile(join(bookDir, "chapters", "index.json"), "utf8"))).toEqual([]);
    await expect(initializeSourceFirstHandoffBook({ projectRoot: root, book: fixture.book, brief: "다른 입력", handoff: checked })).rejects.toThrow("target Book already exists");
  });

  it("detects native selection drift at the last read before initializing a Book", async () => {
    const fixture = await standaloneHandoffFixture(root);
    const checked = await validate(fixture);
    await writeFile(join(root, ".inkos/pitch-slates/handoff-slate/human-decision/decision.json"), "{}");
    await expect(initializeSourceFirstHandoffBook({ projectRoot: root, book: fixture.book, brief: "입력", handoff: checked })).rejects.toThrow("native.decision");
    await expect(readdir(join(root, "books"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rechecks slate invalidation before import and leaves no Book", async () => {
    const fixture = await standaloneHandoffFixture(root);
    const checked = await validate(fixture);
    await mkdir(join(root, "config"));
    await fixtureFile(root, "config/pitch-slate-invalidations.json", { invalidations: [{ slateId: fixture.subject.slateId, sourceSlateSha256: fixture.subject.sourceSlateSha256, reason: "synthetic invalidation" }] });
    await expect(initializeSourceFirstHandoffBook({ projectRoot: root, book: fixture.book, brief: "입력", handoff: checked })).rejects.toThrow("invalidated");
    await expect(readdir(join(root, "books"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses opening-state application to a Book that already contains a manuscript", async () => {
    const fixture = await standaloneHandoffFixture(root);
    const checked = await validate(fixture);
    const bookDir = await fixture.initBook();
    await mkdir(join(bookDir, "chapters"));
    await writeFile(join(bookDir, "chapters", "0001-existing.md"), "이미 있는 원고");
    await expect(applySourceFirstHandoff({ projectRoot: root, bookDir, book: fixture.book, handoff: checked })).rejects.toThrow("with manuscript chapters");
    expect(await readFile(join(bookDir, "chapters", "0001-existing.md"), "utf8")).toBe("이미 있는 원고");
    expect(await readdir(join(bookDir, "story"))).toEqual([]);
  });

  it("requires the complete explicit foundation and never manufactures missing setup", async () => {
    const fixture = await standaloneHandoffFixture(root);
    fixture.handoff.mapping.foundationFiles.pop();
    await fixture.handoff.save();
    await expect(validate(fixture)).rejects.toThrow("foundationFiles");
  });

  it("does not treat a selected candidate as authorization or reuse another Book's approval", async () => {
    const fixture = await standaloneHandoffFixture(root);
    fixture.handoff.authorization.admission.bookId = "other-book";
    await fixture.handoff.save();
    await expect(validate(fixture)).rejects.toThrow("authorization.admission");
    await rm(join(root, "handoff-authorization.json"));
    await expect(validate(fixture)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["sourceSlateSha256", "sourceReviewSha256", "sourceDecisionSha256", "candidateSha256"] as const)("rejects stale %s before Book creation", async (field) => {
    const fixture = await standaloneHandoffFixture(root);
    fixture.subject[field] = hashBytes("changed");
    await expect(validate(fixture)).rejects.toThrow("differs from the current reviewed input");
    await expect(readdir(join(root, "books"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires each explicit target mapping and rejects invented plan spans", async () => {
    const fixture = await standaloneHandoffFixture(root);
    fixture.handoff.mapping.evidence.pop();
    await fixture.handoff.save();
    await expect(validate(fixture)).rejects.toThrow("missing explicit mappings");
    fixture.handoff.mapping.evidence[0].planSpan.sha256 = hashBytes("invented");
    await fixture.handoff.save();
    await expect(validate(fixture)).rejects.toThrow("plan span does not match");
  });

  it("does not reinterpret legacy relationship railB or accept an incomplete ready route", async () => {
    const fixture = await standaloneHandoffFixture(root);
    fixture.handoff.mapping.railPlan.arcRouteRail.entries[0].targetAnchorId = "missing";
    await fixture.handoff.save();
    await expect(validate(fixture)).rejects.toThrow("does not exist");
  });

  it("rejects unbound or ambiguous source-to-Arc conversion", async () => {
    const fixture = await standaloneHandoffFixture(root);
    fixture.handoff.mapping.transformation.sourceSegments[0].sourceChapterIds.push(99);
    await fixture.handoff.save();
    await expect(validate(fixture)).rejects.toThrow("unbound source or target");
    fixture.handoff.mapping.transformation.sourceSegments[0].sourceChapterIds.pop();
    fixture.handoff.mapping.transformation.sourceSegments.push({ ...fixture.handoff.mapping.transformation.sourceSegments[0], id: "duplicate-route" });
    await fixture.handoff.save();
    await expect(validate(fixture)).rejects.toThrow("ambiguous source segments");
  });

  it("revalidates changed source bytes at the write boundary", async () => {
    const fixture = await standaloneHandoffFixture(root);
    const checked = await validate(fixture);
    const bookDir = await fixture.initBook();
    await writeFile(join(root, "source.md"), "changed source");
    await expect(applySourceFirstHandoff({ projectRoot: root, bookDir, book: fixture.book, handoff: checked })).rejects.toThrow("SHA-256 mismatch");
    expect(await readdir(join(bookDir, "story"))).toEqual([]);
  });

  it("rejects a changed authorization even when the manifest hash is refreshed", async () => {
    const fixture = await standaloneHandoffFixture(root);
    const manifest = JSON.parse(await readFile(join(root, "handoff.json"), "utf8"));
    fixture.handoff.authorization.mappingSha256 = hashBytes("another mapping");
    manifest.authorization = await fixtureFile(root, "handoff-authorization.json", fixture.handoff.authorization);
    await fixtureFile(root, "handoff.json", manifest);
    await expect(validate(fixture)).rejects.toThrow("exact mapping bytes");
  });

  it("rejects traversal and symlinks escaping the project evidence root", async () => {
    const fixture = await standaloneHandoffFixture(root);
    fixture.handoff.mapping.files.source.path = "../source.md";
    await fixture.handoff.save();
    await expect(validate(fixture)).rejects.toThrow("without traversal");
    fixture.handoff.mapping.files.source.path = "escape.txt";
    await symlink("/etc/hosts", join(root, "escape.txt"));
    await fixture.handoff.save();
    await expect(validate(fixture)).rejects.toThrow("escapes the project root");
  });
});

describe("daily-plan candidate mapping", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "inkos-daily-handoff-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  async function input() {
    const fixture = await standaloneHandoffFixture(root);
    const markdown = fixture.subject.candidate.projectPlan.markdown + "\n";
    fixture.subject.candidate.projectPlan.markdown = markdown;
    const canary = { schemaVersion: "firefly-planning-canary/v1", id: `fcp-${"a".repeat(24)}`, batchId: "synthetic-daily", state: "complete", markdown,
      inputSha256: hashBytes("synthetic input"), outputSha256: hashBytes(markdown), generatedAt: "2026-09-12T00:00:00.000Z", author: { route: "fixture-route", model: "synthetic-no-model-call" },
      receipt: { inputSha256: hashBytes("synthetic input"), outputSha256: hashBytes(markdown) } };
    const canaryBytes = Buffer.from(JSON.stringify(canary));
    const mapping = { schemaVersion: "firefly_daily_planning_candidate_mapping/v1", canaryId: canary.id, canarySha256: hashBytes(canaryBytes), outputSha256: canary.outputSha256, candidate: fixture.subject.candidate };
    return { canaryBytes, mapping, mappingBytes: Buffer.from(JSON.stringify(mapping)) };
  }
  it("preserves exact plan text, original author, and non-canonical pending state", async () => {
    const fixture = await input();
    const result = mapDailyPlanningCandidate(fixture);
    expect(result.candidate).toEqual(fixture.mapping.candidate);
    expect(result.sourceOrigin).toMatchObject({ system: "v3_ff_foundry", originalAuthor: { route: "fixture-route", model: "synthetic-no-model-call" } });
    expect(result).toMatchObject({ reviewStatus: "pending", canonStatus: "non-canonical", modelCalls: 0, manuscriptAuthorized: false });
    expect((result.candidate.projectPlan as { markdown: string }).markdown.endsWith("\n")).toBe(true);
  });
  it("rejects reworded mappings even when the canary reference remains valid", async () => {
    const fixture = await input();
    fixture.mapping.candidate.projectPlan.markdown += "새 설정";
    await expect(async () => mapDailyPlanningCandidate({ ...fixture, mappingBytes: Buffer.from(JSON.stringify(fixture.mapping)) })).rejects.toThrow("copied exactly");
  });
  it("returns missing structured entry data instead of deriving it from prose", async () => {
    const fixture = await input();
    delete fixture.mapping.candidate.entryContract;
    expect(() => mapDailyPlanningCandidate({ ...fixture, mappingBytes: Buffer.from(JSON.stringify(fixture.mapping)) })).toThrow();
  });
  it("rejects a pending or mutated original canary", async () => {
    const fixture = await input();
    const canary = JSON.parse(fixture.canaryBytes.toString());
    canary.state = "running";
    expect(() => mapDailyPlanningCandidate({ ...fixture, canaryBytes: Buffer.from(JSON.stringify(canary)) })).toThrow("complete");
    canary.state = "complete"; canary.markdown += "다른 결과";
    expect(() => mapDailyPlanningCandidate({ ...fixture, canaryBytes: Buffer.from(JSON.stringify(canary)) })).toThrow("hashes disagree");
  });
});
