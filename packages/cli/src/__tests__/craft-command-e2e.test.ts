import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BookConfigSchema } from "@actalk/inkos-core";

const cliEntry = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");
let project: string;
let source: string;
let networkGuard: string;
let originalBook: string;
beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "inkos-craft-cli-"));
  source = join(project, "reference.json");
  networkGuard = join(project, "no-network.cjs");
  await writeFile(networkGuard, `
    const forbidden = () => { throw new Error('craft command attempted network access'); };
    const localFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url ?? String(input);
      if (url.startsWith('data:')) return localFetch(input, init);
      return forbidden();
    };
    for (const name of ['node:http', 'node:https']) {
      const api = require(name); api.request = forbidden; api.get = forbidden;
    }
  `);
  await writeFile(source, JSON.stringify({
    schemaVersion: "author-craft-pack/v1", id: "cli-fixture", language: "ko", authority: "advisory",
    sources: [{ id: "s1", title: "Local fixture", reference: "fixture.md", readingScope: "test only", kind: "manuscript-analysis" }],
    cases: [{ id: "choice", title: "선택 이유", stages: ["planning", "writing", "revision"], functions: ["causality"], triggers: ["선택"], observation: "선택에 근거가 있다.", method: "바뀐 조건과 선택을 연결한다.", preserve: ["필요한 내면"], counterexamples: ["매번 길게 설명하지 않는다."], sourceIds: ["s1"] }],
  }));
  await mkdir(join(project, "books", "demo", "story"), { recursive: true });
  const book = BookConfigSchema.parse({ id: "demo", title: "테스트", platform: "other", genre: "other", language: "ko", status: "active", createdAt: "2026-09-12T00:00:00Z", updatedAt: "2026-09-12T00:00:00Z", writing: { reviewMode: "manual" } });
  originalBook = JSON.stringify({ ...book, ownerExtension: "preserve" });
  await writeFile(join(project, "books", "demo", "book.json"), originalBook);
  await writeFile(join(project, "books", "demo", "story", "current_state.md"), "기존 원고 상태");
  for (const name of ["story_bible.md", "volume_outline.md", "book_rules.md", "pending_hooks.md"]) {
    await writeFile(join(project, "books", "demo", "story", name), `# ${name}\n`);
  }
  await mkdir(join(project, "books", "demo", "chapters"), { recursive: true });
  await writeFile(join(project, "books", "demo", "chapters", "index.json"), "[]");
});
afterEach(async () => { await rm(project, { recursive: true, force: true }); });

function run(args: string[]) {
  return execFileSync(process.execPath, ["--require", networkGuard, cliEntry, "craft", ...args], {
    cwd: project, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, LANG: "ko_KR.UTF-8", NO_COLOR: "1" },
  });
}
const bookPath = () => join(project, "books", "demo", "book.json");

describe("craft CLI without model or review services", () => {
  it("imports, previews, enables idempotently, and disables while preserving Book data", async () => {
    const imported = JSON.parse(run(["import", source]));
    expect(imported.packSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(bookPath(), "utf8")).toBe(originalBook);
    expect(JSON.parse(run(["status", "demo"]))).toMatchObject({ enabled: false });
    expect(JSON.parse(run(["history", "demo"]))).toMatchObject({ recordCount: 0, invalidRecords: 0 });
    const preview = JSON.parse(run(["preview", "--pack", imported.packSha256, "--query", "선택의 이유", "--json"]));
    expect(preview.receipt.selectedCaseIds).toEqual(["choice"]);
    expect(preview.rendered).toContain("매번 길게 설명하지 않는다.");
    expect(JSON.parse(run(["enable", "demo", "--pack", imported.packSha256])).changed).toBe(true);
    const enabled = await readFile(bookPath(), "utf8");
    expect(JSON.parse(run(["status", "demo"]))).toMatchObject({ enabled: true, selectionMode: "query", eligibleCases: [{ id: "choice" }] });
    expect(await readFile(bookPath(), "utf8")).toBe(enabled);
    expect(JSON.parse(run(["enable", "demo", "--pack", imported.packSha256])).changed).toBe(false);
    expect(await readFile(bookPath(), "utf8")).toBe(enabled);
    expect(JSON.parse(run(["disable", "demo"]))).toMatchObject({ enabled: false, changed: true });
    expect(JSON.parse(await readFile(bookPath(), "utf8"))).toMatchObject({ ownerExtension: "preserve", writing: { reviewMode: "manual" } });
    expect(JSON.parse(await readFile(bookPath(), "utf8")).writing.authorCraft).toBeUndefined();
    expect(await readFile(join(project, "books", "demo", "story", "current_state.md"), "utf8")).toBe("기존 원고 상태");
  }, 45_000);

  it("rejects bad selections and changed pack bytes without changing the Book", async () => {
    const imported = JSON.parse(run(["import", source]));
    expect(() => run(["enable", "demo", "--pack", imported.packSha256, "--case", "missing"])).toThrow(/Unknown author craft case/);
    expect(() => run(["preview", "--pack", imported.packSha256, "--max-cases", "NaN"])).toThrow();
    expect(await readFile(bookPath(), "utf8")).toBe(originalBook);
    const changed = { ...JSON.parse(await readFile(source, "utf8")), id: "changed" };
    await writeFile(join(project, ".inkos", "author-craft-packs", `${imported.packSha256}.json`), JSON.stringify(changed));
    expect(() => run(["enable", "demo", "--pack", imported.packSha256])).toThrow(/SHA-256 mismatch/);
    expect(await readFile(bookPath(), "utf8")).toBe(originalBook);
  }, 45_000);

  it("verifies recorded selections and reports damaged records without exposing source text", async () => {
    const imported = JSON.parse(run(["import", source]));
    const context = JSON.parse(run(["preview", "--pack", imported.packSha256, "--query", "선택의 이유", "--json"]));
    const receiptSha = createHash("sha256").update(JSON.stringify(context.receipt)).digest("hex");
    const folder = join(project, "books", "demo", "story", "runtime", "author-craft");
    await mkdir(folder, { recursive: true });
    const path = join(folder, `2-writing-${receiptSha}.json`);
    await writeFile(path, JSON.stringify({ schemaVersion: "author-craft-context/v1", chapterNumber: 2, ...context }));
    const history = JSON.parse(run(["history", "demo", "--chapter", "2", "--stage", "writing"]));
    expect(history).toMatchObject({ recordCount: 1, invalidRecords: 0, records: [{ valid: true, chapterNumber: 2, receipt: { selectedCaseIds: ["choice"] } }] });
    expect(JSON.stringify(history)).not.toContain(context.rendered);
    expect(JSON.parse(run(["history", "demo", "--stage", "revision"])).recordCount).toBe(0);
    expect(() => run(["history", "demo", "--chapter", "NaN"])).toThrow();
    await writeFile(path, "private manuscript sentence is not JSON");
    let failure: { status?: number; stdout?: string } | undefined;
    try { run(["history", "demo"]); } catch (error) { failure = error as typeof failure; }
    expect(failure?.status).toBe(1);
    const damaged = JSON.parse(String(failure?.stdout));
    expect(damaged).toMatchObject({ recordCount: 1, invalidRecords: 1, records: [{ valid: false, error: "Author craft receipt is not valid UTF-8 JSON" }] });
    expect(failure?.stdout).not.toContain("private manuscript");
    expect(await readFile(bookPath(), "utf8")).toBe(originalBook);
  }, 45_000);
});
