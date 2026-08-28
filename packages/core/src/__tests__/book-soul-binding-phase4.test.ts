import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateManager } from "../state/manager.js";
import {
  BookSoulStore,
  bindBookSoul,
  loadActiveBookSoulSessionBinding,
} from "../production/book-soul-binding.js";
import { createAndPersistBookSession } from "../interaction/book-session-store.js";
import {
  createProductionInputReceipt,
  currentProductionInputBundle,
  runWithProductionInputBundle,
  sha256Bytes,
} from "../production/production-input.js";
import { createProductionAttemptIdentity } from "../production/attempt-identity.js";
import { prepareFictionContentInvocation } from "../production/fiction-content-contract.js";

const roots: string[] = [];
const NOW = new Date("2026-08-28T03:00:00.000Z");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; bookId: string; bookDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "inkos-phase4-soul-"));
  roots.push(root);
  const bookId = "phase4-soul-book";
  const state = new StateManager(root);
  await state.saveBookConfig(bookId, {
    id: bookId,
    title: "Phase 4 Soul",
    platform: "other",
    genre: "urban-fantasy",
    status: "active",
    targetChapters: 100,
    chapterWordCount: 1800,
    language: "ko",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });
  return { root, bookId, bookDir: state.bookDir(bookId) };
}

async function soulArtifacts(
  root: string,
  bookId: string,
  version: string,
  decisionId: string,
  prompt = "",
  status: "neutral" | "candidate" | "promoted" = "candidate",
): Promise<{ manifestPath: string; registryPath: string; decisionPath: string }> {
  const packageRoot = join(root, "soul-source", version);
  await mkdir(join(packageRoot, "resources"), { recursive: true });
  await writeFile(join(packageRoot, "SOUL.md"), prompt, "utf8");
  await writeFile(join(packageRoot, "resources", "genre.md"), "상업적 보상과 회차 말미 훅을 우선한다.\n", "utf8");
  const manifestPath = join(packageRoot, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: "soul-package/v1",
    soulId: "male-modern-fantasy-ko",
    version,
    promptPath: "SOUL.md",
    resources: ["resources/genre.md"],
  }, null, 2)}\n`, "utf8");
  const registryPath = join(root, `registry-${version}.json`);
  await writeFile(registryPath, `${JSON.stringify({ version: 1, corpus: [], note: "runtime plumbing only" })}\n`, "utf8");
  const decisionPath = join(root, `decision-${decisionId}.json`);
  await writeFile(decisionPath, `${JSON.stringify({
    schemaVersion: "soul-binding-decision/v1",
    kind: "bind-soul",
    decisionId,
    actorId: "owner",
    actorRole: "owner",
    bookId,
    soulId: "male-modern-fantasy-ko",
    soulVersion: version,
    status,
    createdAt: NOW.toISOString(),
  }, null, 2)}\n`, "utf8");
  return { manifestPath, registryPath, decisionPath };
}

describe("Phase 4 BookSoulBinding", () => {
  it("installs a content-addressed candidate, appends history, and forces a new session on rebind", async () => {
    const f = await fixture();
    const firstArtifacts = await soulArtifacts(f.root, f.bookId, "v1", "owner-bind-v1");
    const first = await bindBookSoul({
      projectRoot: f.root,
      bookId: f.bookId,
      manifestPath: firstArtifacts.manifestPath,
      sourceRegistryReceiptPath: firstArtifacts.registryPath,
      decisionReceiptPath: firstArtifacts.decisionPath,
      status: "candidate",
      now: () => NOW,
    });
    expect(first).toMatchObject({
      bindingVersion: 1,
      soulId: "male-modern-fantasy-ko",
      version: "v1",
      status: "candidate",
      previousBindingSha256: null,
    });
    expect(await readFile(join(f.bookDir, "story", "soul-bindings", "v0001.json"), "utf8")).toContain(first.bindingSha256);
    const runtime = await new BookSoulStore(f.root, f.bookDir, f.bookId).resolveActiveInput();
    expect(runtime?.promptInput).toContain("Lifecycle: candidate");
    expect(runtime?.promptInput).toContain("상업적 보상과 회차 말미 훅");

    const oldSession = await createAndPersistBookSession(f.root, f.bookId, "phase4-old-session", "book");
    expect(oldSession.soulBinding?.bindingSha256).toBe(first.bindingSha256);

    await expect(bindBookSoul({
      projectRoot: f.root,
      bookId: f.bookId,
      manifestPath: firstArtifacts.manifestPath,
      sourceRegistryReceiptPath: firstArtifacts.registryPath,
      decisionReceiptPath: firstArtifacts.decisionPath,
      status: "candidate",
      now: () => new Date(NOW.getTime() + 500),
    })).rejects.toThrow(/decision ID is already used/i);
    await expect(readFile(join(f.bookDir, "story", "soul-bindings", "v0002.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    const secondArtifacts = await soulArtifacts(f.root, f.bookId, "v2", "owner-bind-v2", "현대 판타지 재벌물의 욕망과 보상을 선명하게 유지한다.");
    const second = await bindBookSoul({
      projectRoot: f.root,
      bookId: f.bookId,
      manifestPath: secondArtifacts.manifestPath,
      sourceRegistryReceiptPath: secondArtifacts.registryPath,
      decisionReceiptPath: secondArtifacts.decisionPath,
      status: "candidate",
      now: () => new Date(NOW.getTime() + 1000),
    });
    expect(second.bindingVersion).toBe(2);
    expect(second.previousBindingSha256).toBe(first.bindingSha256);
    await expect(createAndPersistBookSession(f.root, f.bookId, oldSession.sessionId, "book"))
      .rejects.toThrow(/soulBinding/i);
    const newSession = await createAndPersistBookSession(f.root, f.bookId, "phase4-new-session", "book");
    expect(newSession.soulBinding).toEqual(await loadActiveBookSoulSessionBinding(f.root, f.bookId));
    expect(newSession.soulBinding?.bindingSha256).toBe(second.bindingSha256);

    const promotedArtifacts = await soulArtifacts(
      f.root,
      f.bookId,
      "v2",
      "owner-promote-v2",
      "현대 판타지 재벌물의 욕망과 보상을 선명하게 유지한다.",
      "promoted",
    );
    const promoted = await bindBookSoul({
      projectRoot: f.root,
      bookId: f.bookId,
      manifestPath: promotedArtifacts.manifestPath,
      sourceRegistryReceiptPath: promotedArtifacts.registryPath,
      decisionReceiptPath: promotedArtifacts.decisionPath,
      status: "promoted",
      now: () => new Date(NOW.getTime() + 2000),
    });
    expect(promoted).toMatchObject({
      bindingVersion: 3,
      status: "promoted",
      previousBindingSha256: second.bindingSha256,
    });
    await rm(join(f.bookDir, "story", "soul-bindings", "current.json"));
    await expect(new BookSoulStore(f.root, f.bookDir, f.bookId).loadActive(false))
      .rejects.toThrow(/history exists without an active pointer/i);
  });

  it("fails before pointer activation for symlinked package input and detects installed byte drift", async () => {
    const f = await fixture();
    const artifacts = await soulArtifacts(f.root, f.bookId, "v1", "owner-bind-v1", "prompt");
    const outside = join(f.root, "outside.md");
    await writeFile(outside, "outside", "utf8");
    await rm(join(artifacts.manifestPath, "..", "resources", "genre.md"));
    await symlink(outside, join(artifacts.manifestPath, "..", "resources", "genre.md"));
    await expect(bindBookSoul({
      projectRoot: f.root,
      bookId: f.bookId,
      manifestPath: artifacts.manifestPath,
      sourceRegistryReceiptPath: artifacts.registryPath,
      decisionReceiptPath: artifacts.decisionPath,
      status: "candidate",
      now: () => NOW,
    })).rejects.toThrow(/symlink/i);
    await expect(readFile(join(f.bookDir, "story", "soul-bindings", "current.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    const clean = await soulArtifacts(f.root, f.bookId, "v2", "owner-bind-clean", "prompt");
    const binding = await bindBookSoul({
      projectRoot: f.root,
      bookId: f.bookId,
      manifestPath: clean.manifestPath,
      sourceRegistryReceiptPath: clean.registryPath,
      decisionReceiptPath: clean.decisionPath,
      status: "candidate",
      now: () => NOW,
    });
    const resource = join(
      f.root,
      ".inkos",
      "production",
      "souls",
      "objects",
      binding.installObjectSha256,
      "resources",
      "SOUL.md",
    );
    await writeFile(resource, "drift", "utf8");
    await expect(new BookSoulStore(f.root, f.bookDir, f.bookId).resolveActiveInput())
      .rejects.toThrow(/hash mismatch/i);
  });

  it("injects exact Soul/Skill bytes into the provider request, records only hashes, and expires after the operation", async () => {
    const f = await fixture();
    await mkdir(join(f.bookDir, "story"), { recursive: true });
    const attempt = createProductionAttemptIdentity();
    const promptInjection = "## Host-bound production Soul\n상업성 우선";
    const externalContextText = "이번 화에서 현금 100억 영수증을 보여 준다.";
    const receipt = createProductionInputReceipt({
      schemaVersion: "production-input-receipt/v1",
      soul: null,
      skills: [],
      externalContextSha256: sha256Bytes(externalContextText),
      promptInjectionSha256: sha256Bytes(promptInjection),
    });
    const prepared = await runWithProductionInputBundle({
      bookId: f.bookId,
      commandId: randomUUID(),
      productionOperationId: attempt.productionOperationId,
      attemptId: attempt.attemptId,
      promptInjection,
      externalContextText,
      receipt,
    }, () => prepareFictionContentInvocation({
      projectRoot: f.root,
      bookId: f.bookId,
      agentName: "writer",
      stage: "writer",
      model: "test-model",
      productionAttempt: attempt,
      messages: [
        { role: "system", content: "write" },
        { role: "user", content: externalContextText },
      ],
      now: () => NOW,
    }));
    expect(prepared.messages[0]?.content).toContain(promptInjection);
    expect(prepared.receipt.productionInputs).toEqual(receipt);
    const persisted = await readFile(join(
      f.bookDir,
      "story",
      "runtime",
      "fiction-content-neutral",
      "receipts",
      `${prepared.receipt.invocationId}.json`,
    ), "utf8");
    expect(persisted).not.toContain("상업성 우선");
    expect(persisted).not.toContain("현금 100억");
    expect(currentProductionInputBundle()).toBeUndefined();

    expect(() => runWithProductionInputBundle({
      bookId: f.bookId,
      commandId: randomUUID(),
      productionOperationId: attempt.productionOperationId,
      attemptId: attempt.attemptId,
      promptInjection: `${promptInjection} tampered`,
      externalContextText,
      receipt,
    }, () => Promise.resolve())).toThrow(/prompt injection bytes/i);
  });
});
