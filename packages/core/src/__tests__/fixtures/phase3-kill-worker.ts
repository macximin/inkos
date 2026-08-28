import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StateManager } from "../../state/manager.js";
import { writeChapterCommitReceipt } from "../../state/chapter-commit-receipt.js";
import { captureChapterPersistenceFingerprint } from "../../state/chapter-persistence-journal.js";
import { createProductionAttemptIdentity } from "../../production/attempt-identity.js";
import { createDetachedOwnerDirectionLease } from "../../production/detached-payload-store.js";
import { ProductionExecutionContextSchema } from "../../production/execution-context.js";
import {
  beginFictionContentOperation,
  prepareFictionContentInvocation,
  sealFictionContentOperationManifest,
  writeFictionContentInvocationOutcome,
} from "../../production/fiction-content-contract.js";
import { createWriteNextProductionCommand } from "../../production/production-command.js";
import { createProductionRunSnapshot, saveProductionRunSnapshot } from "../../production/run-projection.js";

const [, , projectRoot, bookId] = process.argv;
if (!projectRoot || !bookId) throw new Error("phase3 kill worker requires projectRoot and bookId");
const NOW = new Date("2026-08-28T02:00:00.000Z");
const state = new StateManager(projectRoot);
const release = await state.acquireBookLock(bookId);

try {
  const ownerDirection = await createDetachedOwnerDirectionLease({
    projectRoot,
    receiptId: "phase3-kill-request",
    text: "write the next chapter",
    now: NOW,
  });
  const binding = {
    bookId,
    sessionId: "phase3-kill-session",
    requestId: "phase3-kill-request",
    workOrderId: "phase3-kill-request",
  };
  const command = createWriteNextProductionCommand({
    idempotencyKey: "phase3-kill-request",
    source: "test",
    actionSource: "quick-action",
    binding,
    ownerDirection,
    now: NOW,
  });
  const chapterNumber = await state.getNextChapterNumber(bookId);
  const productionAttempt = createProductionAttemptIdentity();
  const context = ProductionExecutionContextSchema.parse({
    schemaVersion: "production-execution-context/v1",
    commandId: command.commandId,
    commandSha256: command.commandSelfHash,
    productionOperationId: productionAttempt.productionOperationId,
    attemptId: productionAttempt.attemptId,
    intentDigest: command.intentDigest,
    capability: command.capability,
    mode: "observe",
    source: command.source,
    actionSource: command.authorization.actionSource,
    binding: command.binding,
    activatedSkills: command.activatedSkills,
    startedAt: NOW.toISOString(),
  });
  await saveProductionRunSnapshot(state.bookDir(bookId), createProductionRunSnapshot({
    command,
    productionAttempt,
    context,
    executionStatus: "running",
    canonicalBaseline: await captureChapterPersistenceFingerprint(state.bookDir(bookId), chapterNumber),
    now: NOW,
  }));

  const operation = await beginFictionContentOperation({
    projectRoot,
    bookId,
    operationKind: "write-next-chapter",
    chapterNumber,
    requiredStages: ["writer"],
    productionAttempt,
    now: () => NOW,
  });
  const prepared = await prepareFictionContentInvocation({
    projectRoot,
    bookId,
    agentName: "writer",
    stage: "writer",
    model: "test-model",
    operationId: operation.operationId,
    productionAttempt,
    messages: [{ role: "system", content: "write" }],
    now: () => NOW,
  });
  await writeFictionContentInvocationOutcome({
    projectRoot,
    prepared,
    output: "completed",
    now: () => NOW,
  });
  const manifest = await sealFictionContentOperationManifest({
    projectRoot,
    operation,
    now: () => NOW,
  });
  const chapter = {
    number: chapterNumber,
    title: "Killed after commit",
    status: "ready-for-review" as const,
    wordCount: 1000,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    auditIssues: [],
    lengthWarnings: [],
  };
  const bookDir = state.bookDir(bookId);
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await Promise.all([
    writeFile(join(bookDir, "chapters", `${String(chapterNumber).padStart(4, "0")}_Killed.md`), "# Killed after commit\n\nbody\n", "utf8"),
    state.saveChapterIndex(bookId, [chapter]),
    writeFile(join(bookDir, "story", "current_state.md"), "committed state\n", "utf8"),
  ]);
  await writeChapterCommitReceipt({
    bookDir,
    bookId,
    chapterNumber,
    capability: "write-next-chapter",
    productionAttempt,
    operationManifests: [manifest],
    now: () => NOW,
  });
  process.stdout.write("READY\n");
  await new Promise(() => undefined);
} finally {
  await release();
}
