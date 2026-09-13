import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertBookAdvisoryWritePaths } from "../utils/book-advisory-files.js";
import { recordSceneDecision } from "../planning/scene-decision.js";
import { createDraftDiscoveryPacket, hashDraftDiscoveryPlan, recordDraftDiscoveryPacket } from "../planning/draft-discovery.js";
import { recordRevisionExperience, recordRevisionOutcome } from "../planning/revision-experience.js";
import { installReadyFixture } from "./fixtures/draft-discovery-fixture.js";

let root: string, bookDir: string, outside: string;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "book-advisory-output-"));
  bookDir = join(root, "book"); outside = join(root, "outside");
  await mkdir(bookDir); await mkdir(outside);
  await writeFile(join(bookDir, "book.json"), JSON.stringify({ id: "book-a", title: "저녁", targetChapters: 17,
    genre: "other", platform: "other", status: "active", language: "ko",
    createdAt: "2026-09-12T00:00:00Z", updatedAt: "2026-09-12T00:00:00Z" }));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("Book-local advisory output paths", () => {
  it.each(["", "../outside/result.json", "/tmp/result.json", "story/../result.json", "story/./result.json", "story//result.json", "story/", "story\\result.json", "story/\0result.json"])("rejects non-normalized output %j before creating anything", async (path) => {
    await expect(assertBookAdvisoryWritePaths(bookDir, [path])).rejects.toThrow("Book-relative");
    expect(await readdir(bookDir)).toEqual(["book.json"]);
  });
  it("allows a missing tail without creating it", async () => {
    await expect(assertBookAdvisoryWritePaths(bookDir, ["story/runtime/example/result.json"])).resolves.toBeUndefined();
    expect(await readdir(bookDir)).toEqual(["book.json"]);
  });
  it("resolves the Book root and permits existing links that remain inside that Book", async () => {
    await mkdir(join(bookDir, "actual")); await writeFile(join(bookDir, "actual/receipt.json"), "existing");
    await symlink(join(bookDir, "actual"), join(bookDir, "alias"), "dir");
    await symlink(join(bookDir, "actual/receipt.json"), join(bookDir, "receipt.json"));
    const linkedRoot = join(root, "book-alias"); await symlink(bookDir, linkedRoot, "dir");
    await expect(assertBookAdvisoryWritePaths(linkedRoot, ["alias/new.json", "receipt.json"])).resolves.toBeUndefined();
    expect(await readFile(join(bookDir, "actual/receipt.json"), "utf8")).toBe("existing");
  });
  it.each(["parent", "leaf"])("rejects an escaping %s link before writing", async (kind) => {
    await mkdir(join(bookDir, "story"));
    await writeFile(join(outside, "receipt.json"), "outside-original");
    const destination = kind === "parent" ? "story/link/receipt.json" : "story/receipt.json";
    await symlink(kind === "parent" ? outside : join(outside, "receipt.json"), join(bookDir, kind === "parent" ? "story/link" : destination));
    await expect(assertBookAdvisoryWritePaths(bookDir, [destination])).rejects.toThrow("escapes the Book");
    expect(await readFile(join(outside, "receipt.json"), "utf8")).toBe("outside-original");
  });
  it.each(["parent", "leaf"])("rejects a dangling %s link even when its missing target is inside the Book", async (kind) => {
    await mkdir(join(bookDir, "story"));
    const destination = kind === "parent" ? "story/link/receipt.json" : "story/receipt.json";
    await symlink(join(bookDir, "missing"), join(bookDir, kind === "parent" ? "story/link" : destination));
    await expect(assertBookAdvisoryWritePaths(bookDir, [destination])).rejects.toThrow("dangling symlink");
    expect(await readdir(bookDir)).not.toContain("missing");
  });
  it("rejects a file parent or directory destination", async () => {
    await mkdir(join(bookDir, "directory"));
    await expect(assertBookAdvisoryWritePaths(bookDir, ["book.json/receipt.json"])).rejects.toThrow("directory parents");
    await expect(assertBookAdvisoryWritePaths(bookDir, ["directory"])).rejects.toThrow("regular file destination");
  });
});

describe("advisory writers enforce the shared output boundary", () => {
  it("does not follow a scene-decision receipt leaf into another directory", async () => {
    const memo = { chapter: 1, goal: "저녁", body: "이전 메모", isGoldenOpening: false, threadRefs: [] };
    await mkdir(join(bookDir, "story/runtime/scene-decisions"), { recursive: true });
    await writeFile(join(outside, "receipt.json"), "outside-original");
    await symlink(join(outside, "receipt.json"), join(bookDir, `story/runtime/scene-decisions/1-${hash(memo.body)}.json`));
    await expect(recordSceneDecision(bookDir, memo)).rejects.toThrow("escapes the Book");
    expect(await readFile(join(outside, "receipt.json"), "utf8")).toBe("outside-original");
  });
  it("rejects an escaping draft-discoveries parent with no outside artifact", async () => {
    const fixture = await installReadyFixture(bookDir);
    const chapterText = await readFile(join(bookDir, "chapters/0002_Chapter_2.md"), "utf8");
    const packet = createDraftDiscoveryPacket({ bookId: "book-a", ...fixture, arcs: [fixture.arc], sourceChapter: 2, chapterText,
      expectedChapterTextSha256: hash(chapterText), expectedPlanSha256: hashDraftDiscoveryPlan(fixture.plan),
      suggestions: [{ kind: "new-desire", evidence: "딸과 저녁을 먹겠다는 약속은 양보할 수 없었다.", observation: "저녁 약속을 선택했다.", implication: "시간을 지킬 조건이 필요하다.",
        futureRevisions: [{ bId: "B002", revision: { narrativeFunction: "퇴근 협상", payoffAxis: "함께 식사", carriedReaderDebt: "시간을 지킬까", contrastRequirement: "수입과 시간" } }] }] });
    await mkdir(join(bookDir, "story/runtime"), { recursive: true });
    await symlink(outside, join(bookDir, "story/runtime/draft-discoveries"), "dir");
    await expect(recordDraftDiscoveryPacket(bookDir, packet)).rejects.toThrow("escapes the Book");
    expect(await readdir(outside)).toEqual([]);
  });
  it("rejects an escaping revision blob parent before creating reference text", async () => {
    await mkdir(join(bookDir, "story/runtime"), { recursive: true });
    await symlink(outside, join(bookDir, "story/runtime/revision-experiences"), "dir");
    await expect(recordRevisionExperience(bookDir, { bookId: "book-a", chapterNumber: 1, beforeContent: "전", output: { revisedContent: "후", fixedIssues: [] }, issues: [] })).rejects.toThrow("escapes the Book");
    expect(await readdir(outside)).toEqual([]);
  });
  it("rejects a dangling revision outcome parent while preserving the original record", async () => {
    const experience = await recordRevisionExperience(bookDir, { bookId: "book-a", chapterNumber: 1, beforeContent: "전", output: { revisedContent: "후", fixedIssues: [] }, issues: [] });
    const original = await readFile(experience.path, "utf8");
    await symlink(join(outside, "missing"), join(bookDir, "story/runtime/revision-experiences/outcomes"));
    await expect(recordRevisionOutcome(bookDir, { bookId: "book-a", chapterNumber: 1, experienceId: experience.record.experienceId, cycleId: "fixture",
      selectedContent: "후", snapshots: [{ content: "전", auditResult: { passed: false }, lengthInRange: true }, { content: "후", auditResult: { passed: true }, lengthInRange: true }] })).rejects.toThrow("dangling symlink");
    expect(await readFile(experience.path, "utf8")).toBe(original);
    expect(await readdir(outside)).toEqual([]);
  });
});
