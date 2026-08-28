import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FICTION_CONTENT_CONTRACT,
  FICTION_CONTENT_CONTRACT_SHA256,
  FictionContentOperationKindSchema,
  appendFictionContentContract,
  authorizeFictionContentToolCalls,
  beginFictionContentOperation,
  defaultContentIntensityDirective,
  hashCanonicalJson,
  loadContentIntensityDirective,
  prepareFictionContentInvocation,
  sealFictionContentOperationManifest,
  sha256,
  verifyFictionContentInvocationReceipts,
  verifyFictionContentOperationEvidence,
  verifyFictionContentOperationManifest,
  verifyFictionContentToolAuthorization,
  writeFictionContentInvocationOutcome,
} from "../production/fiction-content-contract.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempProject(): Promise<{ root: string; bookId: string }> {
  const root = await mkdtemp(join(tmpdir(), "inkos-fiction-contract-"));
  roots.push(root);
  const bookId = "book-one";
  await mkdir(join(root, "books", bookId, "story"), { recursive: true });
  return { root, bookId };
}

async function recordInvocation(input: {
  root: string;
  bookId: string;
  agentName: string;
  stage: string;
  operationId?: string;
  productionAttempt?: Awaited<ReturnType<typeof beginFictionContentOperation>>["productionAttempt"];
  error?: Error;
}): Promise<string> {
  const prepared = await prepareFictionContentInvocation({
    projectRoot: input.root,
    bookId: input.bookId,
    agentName: input.agentName,
    stage: input.stage,
    operationId: input.operationId,
    productionAttempt: input.productionAttempt,
    model: "test-model",
    messages: [{ role: "system", content: `Test ${input.stage}.` }],
  });
  await writeFictionContentInvocationOutcome({
    projectRoot: input.root,
    prepared,
    ...(input.error ? { error: input.error } : { output: `${input.stage} complete` }),
  });
  return prepared.trace.invocationId;
}

describe("fiction content contract", () => {
  it("recognizes every chapter-persisting operation kind", () => {
    expect([
      "write-draft",
      "write-next-chapter",
      "audit-draft",
      "revise-draft",
      "repair-chapter-state",
      "resync-chapter-artifacts",
      "import-chapter",
    ].map((kind) => FictionContentOperationKindSchema.parse(kind))).toEqual([
      "write-draft",
      "write-next-chapter",
      "audit-draft",
      "revise-draft",
      "repair-chapter-state",
      "resync-chapter-artifacts",
      "import-chapter",
    ]);
  });

  it("appends the host contract exactly once with the default preserve directive", () => {
    const messages = appendFictionContentContract([
      { role: "system", content: "Write a chapter." },
      { role: "user", content: "Continue." },
    ], defaultContentIntensityDirective());

    expect(messages[0]!.content).toContain(FICTION_CONTENT_CONTRACT);
    expect(messages[0]!.content.match(/fiction-content-neutral-ko\/v1/g)).toHaveLength(1);
    expect(messages[0]!.content).toContain("Directive: preserve");
    expect(messages[0]!.content).toContain("Authority: default-preserve");
  });

  it("writes SHA-bound trace and receipt pairs and verifies invocation-set equality", async () => {
    const { root, bookId } = await tempProject();
    const invocationId = "e403fc2c-1570-4423-8d97-043d2d225614";
    const prepared = await prepareFictionContentInvocation({
      projectRoot: root,
      bookId,
      agentName: "writer",
      stage: "writer",
      model: "test-model",
      messages: [
        { role: "system", content: "Write the scene." },
        { role: "user", content: "The criminal succeeds this chapter." },
      ],
      options: { temperature: 0.7 },
      invocationId,
      now: () => new Date("2026-08-27T00:00:00.000Z"),
    });

    expect(prepared.receipt.contractSha256).toBe(FICTION_CONTENT_CONTRACT_SHA256);
    expect(prepared.receipt.contractOccurrenceCount).toBe(1);
    expect(prepared.receipt.contentIntensityAuthority).toBe("default-preserve");
    await writeFictionContentInvocationOutcome({
      projectRoot: root,
      prepared,
      output: "The criminal succeeds without an added moral lesson.",
      now: () => new Date("2026-08-27T00:00:01.000Z"),
    });
    const audit = await verifyFictionContentInvocationReceipts(root, bookId);
    expect(audit.traceInvocationIds).toEqual([invocationId]);
    expect(audit.receiptInvocationIds).toEqual([invocationId]);
    expect(audit.outcomeInvocationIds).toEqual([invocationId]);
    expect(audit.receiptSetEqualityPassed).toBe(true);
    expect(audit.outcomeSetEqualityPassed).toBe(true);
  });

  it("keeps atomic Book-creation evidence inside a host-validated staging Book", async () => {
    const { root, bookId } = await tempProject();
    const stagingBookDir = join(root, "books", `.tmp-book-create-${bookId}-fixture`);
    const prepared = await prepareFictionContentInvocation({
      projectRoot: root,
      bookId,
      agentName: "architect",
      stage: "architect",
      model: "test-model",
      messages: [{ role: "system", content: "Create the foundation." }],
      evidenceBookDir: stagingBookDir,
    });
    await writeFictionContentInvocationOutcome({
      projectRoot: root,
      prepared,
      output: "foundation complete",
    });

    const canonicalAudit = await verifyFictionContentInvocationReceipts(root, bookId);
    expect(canonicalAudit.traceInvocationIds).toEqual([]);
    await expect(readFile(join(
      stagingBookDir,
      "story",
      "runtime",
      "fiction-content-neutral",
      "outcomes",
      `${prepared.trace.invocationId}.json`,
    ), "utf8")).resolves.toContain('"status": "completed"');

    await expect(prepareFictionContentInvocation({
      projectRoot: root,
      bookId,
      agentName: "architect",
      stage: "architect",
      model: "test-model",
      messages: [{ role: "system", content: "Invalid location." }],
      evidenceBookDir: join(root, "outside-book"),
    })).rejects.toThrow(/invalid host evidence Book directory/i);
  });

  it("rejects a non-default intensity directive without receipt-bound authority", async () => {
    const { root, bookId } = await tempProject();
    await writeFile(join(root, "books", bookId, "story", "content_intensity.json"), JSON.stringify({
      version: 1,
      directive: "soften graphic violence",
      directiveSha256: sha256("soften graphic violence"),
      authority: "owner",
      sourceArtifactSha256: null,
      sourceSelectorSha256: null,
      actorId: "owner-one",
      decisionId: "decision-one",
      decisionReceiptSha256: null,
    }), "utf8");

    await expect(prepareFictionContentInvocation({
      projectRoot: root,
      bookId,
      agentName: "writer",
      stage: "writer",
      model: "test-model",
      messages: [{ role: "user", content: "Continue." }],
    })).rejects.toThrow("Invalid content-intensity authority");
  });

  it("accepts only an exact source selector plus a matching host decision receipt", async () => {
    const { root, bookId } = await tempProject();
    const bookDir = join(root, "books", bookId);
    const directiveText = "preserve the established graphic intensity";
    const artifactPath = "story/owner-direction.txt";
    const artifactBytes = Buffer.from(directiveText, "utf8");
    await writeFile(join(bookDir, artifactPath), artifactBytes);
    const selector = {
      coordinate: "utf8-byte" as const,
      start: 0,
      end: artifactBytes.byteLength,
      textSha256: sha256(artifactBytes),
    };
    const sourceSelectorSha256 = hashCanonicalJson(selector);
    const decisionPath = "story/review-decisions/intensity-one.json";
    await mkdir(join(bookDir, "story", "review-decisions"), { recursive: true });
    const decisionRaw = `${JSON.stringify({
      version: 1,
      kind: "content-intensity-authority",
      bookId,
      actorId: "owner-one",
      actorRole: "owner",
      decisionId: "intensity-one",
      authority: "owner",
      directiveSha256: sha256(directiveText),
      sourceArtifactSha256: sha256(artifactBytes),
      sourceSelectorSha256,
      createdAt: "2026-08-27T00:00:00.000Z",
    }, null, 2)}\n`;
    await writeFile(join(bookDir, decisionPath), decisionRaw, "utf8");
    await writeFile(join(bookDir, "story", "content_intensity.json"), JSON.stringify({
      version: 1,
      directive: directiveText,
      directiveSha256: sha256(directiveText),
      authority: "owner",
      sourceArtifactSha256: sha256(artifactBytes),
      sourceArtifactPath: artifactPath,
      sourceSelectorSha256,
      sourceSelector: selector,
      actorId: "owner-one",
      decisionId: "intensity-one",
      decisionReceiptSha256: sha256(decisionRaw),
      decisionReceiptPath: decisionPath,
    }), "utf8");

    await expect(loadContentIntensityDirective(root, bookId)).resolves.toMatchObject({
      directive: directiveText,
      authority: "owner",
    });

    await writeFile(join(bookDir, artifactPath), `${directiveText}!`, "utf8");
    await expect(loadContentIntensityDirective(root, bookId))
      .rejects.toThrow("Invalid content-intensity authority");
  });

  it("fails set equality when a crash leaves only the participating trace", async () => {
    const { root, bookId } = await tempProject();
    const invocationId = "5a0c066f-38da-437c-b97e-d0ebfba75b6a";
    await prepareFictionContentInvocation({
      projectRoot: root,
      bookId,
      agentName: "auditor",
      stage: "auditor",
      model: "test-model",
      messages: [{ role: "system", content: "Audit." }],
      invocationId,
    });
    const receiptPath = join(
      root,
      "books",
      bookId,
      "story",
      "runtime",
      "fiction-content-neutral",
      "receipts",
      `${invocationId}.json`,
    );
    const receiptRaw = await readFile(receiptPath, "utf8");
    await rm(receiptPath);

    const audit = await verifyFictionContentInvocationReceipts(root, bookId);
    expect(receiptRaw).toContain(invocationId);
    expect(audit.traceInvocationIds).toEqual([invocationId]);
    expect(audit.receiptInvocationIds).toEqual([]);
    expect(audit.receiptSetEqualityPassed).toBe(false);
    expect(audit.outcomeSetEqualityPassed).toBe(false);
  });

  it("records provider refusal as refusal evidence without inventing replacement output", async () => {
    const { root, bookId } = await tempProject();
    const invocationId = "aa6ce852-1ce4-46d1-aa65-53a12f82d5ab";
    const prepared = await prepareFictionContentInvocation({
      projectRoot: root,
      bookId,
      agentName: "writer",
      stage: "writer",
      model: "test-model",
      messages: [{ role: "system", content: "Write." }],
      invocationId,
    });

    const outcome = await writeFictionContentInvocationOutcome({
      projectRoot: root,
      prepared,
      error: new Error("request refused by provider content policy"),
    });

    expect(outcome.status).toBe("provider-refused");
    expect(outcome.outputSha256).toBeNull();
    expect(outcome.errorMessageSha256).toMatch(/^[a-f0-9]{64}$/);
    const audit = await verifyFictionContentInvocationReceipts(root, bookId);
    expect(audit.outcomeSetEqualityPassed).toBe(true);
  });

  it("isolates a successful operation from historical failed and missing evidence", async () => {
    const { root, bookId } = await tempProject();
    await recordInvocation({
      root,
      bookId,
      agentName: "old-writer",
      stage: "writer",
      error: new Error("historical provider transport failure"),
    });
    const historicalPartial = await prepareFictionContentInvocation({
      projectRoot: root,
      bookId,
      agentName: "old-auditor",
      stage: "auditor",
      model: "test-model",
      messages: [{ role: "system", content: "Historical partial call." }],
    });
    await rm(join(
      root,
      "books",
      bookId,
      "story",
      "runtime",
      "fiction-content-neutral",
      "receipts",
      `${historicalPartial.trace.invocationId}.json`,
    ));
    const operation = await beginFictionContentOperation({
      projectRoot: root,
      bookId,
      operationKind: "write-draft",
      chapterNumber: 4,
      requiredStages: ["writer"],
    });

    const currentId = await recordInvocation({
      root,
      bookId,
      agentName: "writer",
      stage: "writer",
      operationId: operation.operationId,
      productionAttempt: operation.productionAttempt,
    });
    const invocations = await verifyFictionContentOperationEvidence(root, operation);
    expect(invocations.map((invocation) => invocation.invocationId)).toEqual([currentId]);

    const manifest = await sealFictionContentOperationManifest({ projectRoot: root, operation });
    await expect(verifyFictionContentOperationManifest({
      projectRoot: root,
      operation,
      expectedManifest: manifest,
    })).resolves.toEqual(manifest);
    expect(manifest).toMatchObject({
      operationId: operation.operationId,
      productionOperationId: operation.productionAttempt.productionOperationId,
      attemptId: operation.productionAttempt.attemptId,
      bookId,
      operationKind: "write-draft",
      chapterNumber: 4,
      requiredStages: ["writer"],
      invocations: [{ invocationId: currentId, stage: "writer", status: "completed" }],
    });
  });

  it("does not let a stale historical stage satisfy the current operation", async () => {
    const { root, bookId } = await tempProject();
    await recordInvocation({ root, bookId, agentName: "old-auditor", stage: "auditor" });
    const operation = await beginFictionContentOperation({
      projectRoot: root,
      bookId,
      operationKind: "write-next-chapter",
      chapterNumber: 2,
      requiredStages: ["writer", "auditor"],
    });
    await recordInvocation({
      root,
      bookId,
      agentName: "writer",
      stage: "writer",
      operationId: operation.operationId,
      productionAttempt: operation.productionAttempt,
    });

    await expect(verifyFictionContentOperationEvidence(root, operation))
      .rejects.toThrow(/missing fiction-content receipts for: auditor/i);
  });

  it("fails closed for an empty current operation delta", async () => {
    const { root, bookId } = await tempProject();
    const operation = await beginFictionContentOperation({
      projectRoot: root,
      bookId,
      operationKind: "write-draft",
      chapterNumber: 1,
      requiredStages: ["writer"],
    });

    await expect(verifyFictionContentOperationEvidence(root, operation))
      .rejects.toThrow(/no fiction-content invocation evidence/i);
  });

  it("fails closed for a partial current evidence set", async () => {
    const { root, bookId } = await tempProject();
    const operation = await beginFictionContentOperation({
      projectRoot: root,
      bookId,
      operationKind: "write-draft",
      chapterNumber: 1,
      requiredStages: ["writer"],
    });
    await prepareFictionContentInvocation({
      projectRoot: root,
      bookId,
      agentName: "writer",
      stage: "writer",
      model: "test-model",
      operationId: operation.operationId,
      productionAttempt: operation.productionAttempt,
      messages: [{ role: "system", content: "Partial current call." }],
    });

    await expect(verifyFictionContentOperationEvidence(root, operation))
      .rejects.toThrow(/partial or mismatched/i);
  });

  it("fails closed for a current provider refusal", async () => {
    const { root, bookId } = await tempProject();
    const operation = await beginFictionContentOperation({
      projectRoot: root,
      bookId,
      operationKind: "write-draft",
      chapterNumber: 1,
      requiredStages: ["writer"],
    });
    await recordInvocation({
      root,
      bookId,
      agentName: "writer",
      stage: "writer",
      operationId: operation.operationId,
      productionAttempt: operation.productionAttempt,
      error: new Error("request refused by provider content policy"),
    });

    await expect(verifyFictionContentOperationEvidence(root, operation))
      .rejects.toThrow(/provider-refused/i);
  });

  it("rejects an operation manifest that becomes a stale subset before persistence", async () => {
    const { root, bookId } = await tempProject();
    const operation = await beginFictionContentOperation({
      projectRoot: root,
      bookId,
      operationKind: "write-draft",
      chapterNumber: 1,
      requiredStages: ["writer"],
    });
    await recordInvocation({
      root,
      bookId,
      agentName: "writer",
      stage: "writer",
      operationId: operation.operationId,
      productionAttempt: operation.productionAttempt,
    });
    const manifest = await sealFictionContentOperationManifest({ projectRoot: root, operation });
    await recordInvocation({
      root,
      bookId,
      agentName: "late-validator",
      stage: "auditor",
      operationId: operation.operationId,
      productionAttempt: operation.productionAttempt,
    });

    await expect(verifyFictionContentOperationManifest({
      projectRoot: root,
      operation,
      expectedManifest: manifest,
    })).rejects.toThrow(/not the exact current invocation delta/i);
  });

  it("isolates interleaved operations by host operation ID", async () => {
    const { root, bookId } = await tempProject();
    const first = await beginFictionContentOperation({
      projectRoot: root,
      bookId,
      operationKind: "write-draft",
      chapterNumber: 1,
      requiredStages: ["writer"],
    });
    const second = await beginFictionContentOperation({
      projectRoot: root,
      bookId,
      operationKind: "write-draft",
      chapterNumber: 2,
      requiredStages: ["writer"],
    });
    const firstId = await recordInvocation({
      root,
      bookId,
      agentName: "writer-one",
      stage: "writer",
      operationId: first.operationId,
      productionAttempt: first.productionAttempt,
    });
    await recordInvocation({
      root,
      bookId,
      agentName: "unrelated-session",
      stage: "agent-session:book",
    });
    const secondId = await recordInvocation({
      root,
      bookId,
      agentName: "writer-two",
      stage: "writer",
      operationId: second.operationId,
      productionAttempt: second.productionAttempt,
    });

    await expect(verifyFictionContentOperationEvidence(root, first))
      .resolves.toMatchObject([{ invocationId: firstId }]);
    await expect(verifyFictionContentOperationEvidence(root, second))
      .resolves.toMatchObject([{ invocationId: secondId }]);
  });

  it("authorizes a Book mutation only after the exact completed model output", async () => {
    const { root, bookId } = await tempProject();
    const prepared = await prepareFictionContentInvocation({
      projectRoot: root,
      bookId,
      agentName: "book-agent-session",
      stage: "agent-session:book",
      model: "test-model",
      messages: [{ role: "system", content: "Edit only when asked." }],
    });
    const assistantOutput = JSON.stringify({
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "call-1",
        name: "write_truth_file",
        arguments: { fileName: "current_focus.md", content: "keep the betrayal" },
      }],
    });
    await writeFictionContentInvocationOutcome({
      projectRoot: root,
      prepared,
      output: assistantOutput,
    });
    const [authorization] = await authorizeFictionContentToolCalls({
      projectRoot: root,
      prepared,
      assistantOutput,
      toolCalls: [{
        id: "call-1",
        name: "write_truth_file",
        arguments: { fileName: "current_focus.md", content: "keep the betrayal" },
      }],
    });

    await expect(verifyFictionContentToolAuthorization({
      projectRoot: root,
      prepared,
      authorization: authorization!,
      assistantOutput,
      toolCall: {
        id: "call-1",
        name: "write_truth_file",
        arguments: { fileName: "current_focus.md", content: "keep the betrayal" },
      },
    })).resolves.toEqual(authorization);
    await expect(verifyFictionContentToolAuthorization({
      projectRoot: root,
      prepared,
      authorization: authorization!,
      assistantOutput,
      toolCall: {
        id: "call-1",
        name: "write_truth_file",
        arguments: { fileName: "current_focus.md", content: "soften the betrayal" },
      },
    })).rejects.toThrow(/does not match/i);
  });
});
