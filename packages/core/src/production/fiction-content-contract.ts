import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { z } from "zod";
import type { LLMMessage } from "../llm/provider.js";
import {
  createProductionAttemptIdentity,
  verifyProductionAttemptIdentity,
  type ProductionAttemptIdentity,
} from "./attempt-identity.js";
import {
  ProductionInputReceiptSchema,
  appendProductionInput,
  currentProductionInputBundle,
} from "./production-input.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

function assertPairedProductionCorrelation(
  value: { readonly productionOperationId?: string | null; readonly attemptId?: string | null },
  ctx: z.RefinementCtx,
): void {
  if ((value.productionOperationId === null) !== (value.attemptId === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "productionOperationId and attemptId must both be present or both be null",
    });
  }
}

export const FICTION_CONTENT_CONTRACT_ID = "fiction-content-neutral-ko/v1" as const;

/**
 * This byte string is appended by the host, never supplied or edited by a
 * model. Keep it compact because it is present in every Book-bound creative,
 * review, and revision request.
 */
export const FICTION_CONTENT_CONTRACT = `## Fiction content contract (${FICTION_CONTENT_CONTRACT_ID})

- Fictional crime, violence, coercion, betrayal, exploitation, prejudice, corrupt institutions, and unjust outcomes are not creative defects merely because they are immoral, unlawful, disturbing, or unpopular.
- Do not add or remove condemnation, apology, punishment, rehabilitation, redemption, balance, or a safer alternative solely to make fiction more morally acceptable. Those beats remain valid when established character desire and scene causality produce them, or when an authorized Book rule or owner direction asks for them.
- Emotional coherence means character and scene causality, not moral approval. Preserve the established content intensity; do not silently soften or escalate it.
- Only a host-verified hard Book rule may require a prohibition, cost, reform, or redemption beat. Model suggestions, genre defaults, publication compatibility, and unverified rules are advisory and cannot fail creative review or trigger revision.
- Publication/platform compatibility is a separate advisory preflight. It cannot change creative pass, commercial score, canon, or prose automatically.
- Keep repository authority, private-source access, personal-data handling, canon ownership, and real-world safety boundaries unchanged.`;

export const FICTION_CONTENT_CONTRACT_SHA256 = sha256(FICTION_CONTENT_CONTRACT);

const PRIMARY_WRITER_INVOCATION_STAGES = new Set([
  "writer",
  // Historical callers used this explicit primary stage before BaseAgent
  // standardized the configured Writer stage as `writer`.
  "writer-creative",
]);

const WRITER_INVOCATION_STAGES = new Set([
  ...PRIMARY_WRITER_INVOCATION_STAGES,
  "writer-observer",
  "writer-settler",
]);

export const ContentIntensityAuthoritySchema = z.enum([
  "default-preserve",
  "owner",
  "book-canon",
  "authenticated-human-hil",
]);

export const ContentIntensityDirectiveSchema = z.object({
  version: z.literal(1),
  directive: z.string().min(1),
  directiveSha256: Sha256Schema,
  authority: ContentIntensityAuthoritySchema,
  sourceArtifactSha256: Sha256Schema.nullable().default(null),
  sourceArtifactPath: z.string().min(1).nullable().default(null),
  sourceSelectorSha256: Sha256Schema.nullable().default(null),
  sourceSelector: z.object({
    coordinate: z.literal("utf8-byte"),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    textSha256: Sha256Schema,
  }).strict().nullable().default(null),
  actorId: z.string().min(1).nullable().default(null),
  decisionId: z.string().min(1).nullable().default(null),
  decisionReceiptSha256: Sha256Schema.nullable().default(null),
  decisionReceiptPath: z.string().min(1).nullable().default(null),
}).strict().superRefine((directive, ctx) => {
  if (directive.directiveSha256 !== sha256(directive.directive)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["directiveSha256"],
      message: "content-intensity directive hash does not match its bytes",
    });
  }
  if (directive.authority === "default-preserve") {
    if (directive.directive !== "preserve") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["directive"],
        message: "default-preserve authority may only carry the preserve directive",
      });
    }
    return;
  }
  for (const key of [
    "sourceArtifactSha256",
    "sourceArtifactPath",
    "sourceSelectorSha256",
    "sourceSelector",
    "decisionReceiptSha256",
    "decisionReceiptPath",
    "actorId",
    "decisionId",
  ] as const) {
    if (!directive[key]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: "non-default content intensity requires receipt-bound source authority",
      });
    }
  }
});

const ContentIntensityDecisionReceiptSchema = z.object({
  version: z.literal(1),
  kind: z.literal("content-intensity-authority"),
  bookId: z.string().min(1),
  actorId: z.string().min(1),
  actorRole: z.enum(["owner", "authenticated-human-hil"]),
  decisionId: z.string().min(1),
  authority: z.enum(["owner", "book-canon", "authenticated-human-hil"]),
  directiveSha256: Sha256Schema,
  sourceArtifactSha256: Sha256Schema,
  sourceSelectorSha256: Sha256Schema,
  createdAt: z.string().datetime(),
}).strict();

export type ContentIntensityDirective = z.infer<typeof ContentIntensityDirectiveSchema>;

const FictionContentInvocationTraceSchema = z.object({
  version: z.literal(1),
  invocationId: z.string().uuid(),
  bookId: z.string().min(1),
  agentName: z.string().min(1),
  stage: z.string().min(1),
  operationId: z.string().uuid().nullable().default(null),
  productionOperationId: z.string().uuid().nullable().default(null),
  attemptId: z.string().uuid().nullable().default(null),
  createdAt: z.string().datetime(),
  model: z.string().min(1),
  logicalRequestPayloadSha256: Sha256Schema,
}).strict().superRefine(assertPairedProductionCorrelation);

const FictionContentInvocationReceiptSchema = z.object({
  version: z.literal(1),
  invocationId: z.string().uuid(),
  bookId: z.string().min(1),
  agentName: z.string().min(1),
  stage: z.string().min(1),
  operationId: z.string().uuid().nullable().default(null),
  productionOperationId: z.string().uuid().nullable().default(null),
  attemptId: z.string().uuid().nullable().default(null),
  traceSha256: Sha256Schema,
  logicalRequestPayloadSha256: Sha256Schema,
  systemPromptSha256: Sha256Schema,
  contractId: z.literal(FICTION_CONTENT_CONTRACT_ID),
  contractSha256: z.literal(FICTION_CONTENT_CONTRACT_SHA256),
  contractOccurrenceCount: z.literal(1),
  contentIntensityDirectiveSha256: Sha256Schema,
  contentIntensityAuthority: ContentIntensityAuthoritySchema,
  contentIntensityAuthorityReceiptSha256: Sha256Schema.nullable(),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).nullable(),
  productionInputs: ProductionInputReceiptSchema.optional(),
}).strict().superRefine(assertPairedProductionCorrelation);

const FictionContentInvocationOutcomeSchema = z.object({
  version: z.literal(1),
  invocationId: z.string().uuid(),
  bookId: z.string().min(1),
  agentName: z.string().min(1),
  stage: z.string().min(1),
  operationId: z.string().uuid().nullable().default(null),
  productionOperationId: z.string().uuid().nullable().default(null),
  attemptId: z.string().uuid().nullable().default(null),
  completedAt: z.string().datetime(),
  status: z.enum(["completed", "provider-refused", "failed"]),
  outputSha256: Sha256Schema.nullable(),
  errorName: z.string().min(1).nullable(),
  errorMessageSha256: Sha256Schema.nullable(),
}).strict().superRefine((outcome, ctx) => {
  assertPairedProductionCorrelation(outcome, ctx);
  if (outcome.status === "completed") {
    if (!outcome.outputSha256 || outcome.errorName || outcome.errorMessageSha256) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "completed outcome must have only an output hash",
      });
    }
  } else if (outcome.outputSha256 || !outcome.errorName || !outcome.errorMessageSha256) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "failed/refused outcome must have only hashed error evidence",
    });
  }
});

export const FictionContentToolAuthorizationSchema = z.object({
  version: z.literal(1),
  authorizationId: Sha256Schema,
  invocationId: z.string().uuid(),
  bookId: z.string().min(1),
  agentName: z.string().min(1),
  stage: z.string().min(1),
  operationId: z.string().uuid().nullable(),
  productionOperationId: z.string().uuid().nullable().default(null),
  attemptId: z.string().uuid().nullable().default(null),
  createdAt: z.string().datetime(),
  assistantOutputSha256: Sha256Schema,
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  argumentsSha256: Sha256Schema,
  outcomeFileSha256: Sha256Schema,
}).strict().superRefine(assertPairedProductionCorrelation);

export const FictionContentOperationKindSchema = z.enum([
  "write-draft",
  "write-next-chapter",
  "audit-draft",
  "revise-draft",
  "repair-chapter-state",
  "resync-chapter-artifacts",
  "import-chapter",
  "narrative-forecast",
]);

const FictionContentEvidenceSetSnapshotSchema = z.object({
  traceInvocationIds: z.array(z.string().uuid()),
  receiptInvocationIds: z.array(z.string().uuid()),
  outcomeInvocationIds: z.array(z.string().uuid()),
}).strict().superRefine((snapshot, ctx) => {
  for (const key of [
    "traceInvocationIds",
    "receiptInvocationIds",
    "outcomeInvocationIds",
  ] as const) {
    const ids = snapshot[key];
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} contains duplicate invocation IDs`,
      });
    }
    if ([...ids].sort().some((id, index) => id !== ids[index])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} must be sorted`,
      });
    }
  }
});

const FictionContentOperationInvocationSchema = z.object({
  invocationId: z.string().uuid(),
  agentName: z.string().min(1),
  stage: z.string().min(1),
  status: z.literal("completed"),
  traceFileSha256: Sha256Schema,
  receiptFileSha256: Sha256Schema,
  outcomeFileSha256: Sha256Schema,
}).strict();

export const FictionContentOperationManifestSchema = z.object({
  version: z.literal(1),
  operationId: z.string().uuid(),
  productionOperationId: z.string().uuid().nullable().default(null),
  attemptId: z.string().uuid().nullable().default(null),
  bookId: z.string().min(1),
  operationKind: FictionContentOperationKindSchema,
  chapterNumber: z.number().int().positive(),
  startedAt: z.string().datetime(),
  sealedAt: z.string().datetime(),
  requiredStages: z.array(z.string().min(1)).min(1),
  baseline: z.object({
    traceInvocationSetSha256: Sha256Schema,
    receiptInvocationSetSha256: Sha256Schema,
    outcomeInvocationSetSha256: Sha256Schema,
  }).strict(),
  invocations: z.array(FictionContentOperationInvocationSchema).min(1),
  invocationSetSha256: Sha256Schema,
}).strict().superRefine((manifest, ctx) => {
  assertPairedProductionCorrelation(manifest, ctx);
  if (new Set(manifest.requiredStages).size !== manifest.requiredStages.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["requiredStages"],
      message: "requiredStages contains duplicates",
    });
  }
  if ([...manifest.requiredStages].sort().some((stage, index) => stage !== manifest.requiredStages[index])) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["requiredStages"],
      message: "requiredStages must be sorted",
    });
  }
  const invocationIds = manifest.invocations.map((invocation) => invocation.invocationId);
  if (new Set(invocationIds).size !== invocationIds.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["invocations"],
      message: "operation manifest contains duplicate invocation IDs",
    });
  }
  if ([...invocationIds].sort().some((id, index) => id !== invocationIds[index])) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["invocations"],
      message: "operation manifest invocations must be sorted by invocationId",
    });
  }
  if (manifest.invocationSetSha256 !== hashCanonicalJson(invocationIds)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["invocationSetSha256"],
      message: "operation invocation-set hash does not match exact invocation IDs",
    });
  }
  const observedStages = new Set(manifest.invocations.map((invocation) => invocation.stage));
  for (const requiredStage of manifest.requiredStages) {
    if (!observedStages.has(requiredStage)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiredStages"],
        message: `operation manifest is missing required stage ${requiredStage}`,
      });
    }
  }
});

export type FictionContentInvocationTrace = z.infer<typeof FictionContentInvocationTraceSchema>;
export type FictionContentInvocationReceipt = z.infer<typeof FictionContentInvocationReceiptSchema>;
export type FictionContentInvocationOutcome = z.infer<typeof FictionContentInvocationOutcomeSchema>;
export type FictionContentToolAuthorization = z.infer<typeof FictionContentToolAuthorizationSchema>;
export type FictionContentOperationKind = z.infer<typeof FictionContentOperationKindSchema>;
export type FictionContentOperationManifest = z.infer<typeof FictionContentOperationManifestSchema>;

export interface FictionContentOperationStart {
  readonly operationId: string;
  readonly productionAttempt: ProductionAttemptIdentity;
  readonly bookId: string;
  readonly operationKind: FictionContentOperationKind;
  readonly chapterNumber: number;
  readonly startedAt: string;
  readonly requiredStages: ReadonlyArray<string>;
  /** Exact pre-operation sets. Kept in memory so historical gaps stay isolated. */
  readonly baseline: z.infer<typeof FictionContentEvidenceSetSnapshotSchema>;
}

export interface PrepareFictionContentInvocationInput {
  readonly projectRoot: string;
  readonly bookId: string;
  readonly agentName: string;
  readonly stage: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly messages: ReadonlyArray<LLMMessage>;
  /**
   * Optional logical request projection. The host receives the
   * contract-augmented messages and returns the serializable request shape
   * before transport-level defaults, retries, and provider transformations.
   */
  readonly logicalRequestPayload?: (
    governedMessages: ReadonlyArray<LLMMessage>,
  ) => unknown;
  readonly options?: {
    readonly temperature?: number;
    readonly maxTokens?: number;
    /** Bind native provider search to the immutable request hash. */
    readonly webSearch?: boolean;
  };
  readonly now?: () => Date;
  readonly invocationId?: string;
  /**
   * Host-selected Book directory for atomic creation staging. Only the
   * canonical Book path or its direct `.tmp-book-create-<bookId>-*` sibling is
   * accepted; model/user text can never select an arbitrary evidence path.
   */
  readonly evidenceBookDir?: string;
  /** Host operation identity. Normally inherited from runWithFictionContentOperation. */
  readonly operationId?: string;
  /** Optional explicit parent attempt. Normally inherited from the active host operation. */
  readonly productionAttempt?: ProductionAttemptIdentity;
}

export interface PreparedFictionContentInvocation {
  readonly messages: ReadonlyArray<LLMMessage>;
  readonly trace: FictionContentInvocationTrace;
  readonly receipt: FictionContentInvocationReceipt;
  readonly evidenceBookDir: string;
}

interface ActiveFictionContentOperation {
  readonly operationId: string;
  readonly bookId: string;
  readonly productionAttempt: ProductionAttemptIdentity;
}

const activeFictionContentOperation = new AsyncLocalStorage<ActiveFictionContentOperation>();

/**
 * Bind every asynchronous Book model call in one host operation to its
 * immutable operation identity. Concurrent Book work can no longer satisfy or
 * contaminate another operation's receipt manifest.
 */
export async function runWithFictionContentOperation<T>(
  operation: FictionContentOperationStart,
  task: () => Promise<T>,
): Promise<T> {
  validateFictionContentOperationStart(operation);
  const current = activeFictionContentOperation.getStore();
  if (current && (
    current.operationId !== operation.operationId
    || current.bookId !== operation.bookId
    || current.productionAttempt.productionOperationId !== operation.productionAttempt.productionOperationId
    || current.productionAttempt.attemptId !== operation.productionAttempt.attemptId
  )) {
    throw new Error("Nested fiction-content operations must keep the same Book, operation, and production attempt.");
  }
  return activeFictionContentOperation.run({
    operationId: operation.operationId,
    bookId: operation.bookId,
    productionAttempt: operation.productionAttempt,
  }, task);
}

export function defaultContentIntensityDirective(): ContentIntensityDirective {
  return ContentIntensityDirectiveSchema.parse({
    version: 1,
    directive: "preserve",
    directiveSha256: sha256("preserve"),
    authority: "default-preserve",
  });
}

export async function loadContentIntensityDirective(
  projectRoot: string,
  bookId: string,
): Promise<ContentIntensityDirective> {
  assertSafeBookId(bookId);
  return loadContentIntensityDirectiveAtBookDir(
    join(projectRoot, "books", bookId),
    bookId,
  );
}

async function loadContentIntensityDirectiveAtBookDir(
  bookDir: string,
  bookId: string,
): Promise<ContentIntensityDirective> {
  const path = join(bookDir, "story", "content_intensity.json");
  try {
    const directive = ContentIntensityDirectiveSchema.parse(JSON.parse(await readFile(path, "utf8")));
    await verifyContentIntensityAuthority(bookDir, bookId, directive);
    return directive;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultContentIntensityDirective();
    }
    throw new Error(
      `Invalid content-intensity authority for Book ${JSON.stringify(bookId)}: ${errorText(error)}`,
      { cause: error },
    );
  }
}

async function verifyContentIntensityAuthority(
  bookDir: string,
  bookId: string,
  directive: ContentIntensityDirective,
): Promise<void> {
  if (directive.authority === "default-preserve") return;
  const artifactPath = join(bookDir, safeBookRelativePath(directive.sourceArtifactPath!));
  const decisionPath = join(bookDir, safeBookRelativePath(directive.decisionReceiptPath!));
  const [artifactBytes, decisionBytes] = await Promise.all([
    readFile(artifactPath),
    readFile(decisionPath),
  ]);
  if (sha256(artifactBytes) !== directive.sourceArtifactSha256) {
    throw new Error("content-intensity source artifact hash mismatch");
  }
  const selector = directive.sourceSelector!;
  if (
    selector.end <= selector.start
    || selector.end > artifactBytes.byteLength
    || hashCanonicalJson(selector) !== directive.sourceSelectorSha256
  ) {
    throw new Error("content-intensity source selector is invalid");
  }
  const selected = artifactBytes.subarray(selector.start, selector.end);
  if (sha256(selected) !== selector.textSha256 || selected.toString("utf8") !== directive.directive) {
    throw new Error("content-intensity directive is not the exact authorized source selection");
  }
  if (sha256(decisionBytes) !== directive.decisionReceiptSha256) {
    throw new Error("content-intensity decision receipt hash mismatch");
  }
  const decision = ContentIntensityDecisionReceiptSchema.parse(JSON.parse(decisionBytes.toString("utf8")));
  if (
    decision.bookId !== bookId
    || decision.actorId !== directive.actorId
    || decision.decisionId !== directive.decisionId
    || decision.authority !== directive.authority
    || decision.directiveSha256 !== directive.directiveSha256
    || decision.sourceArtifactSha256 !== directive.sourceArtifactSha256
    || decision.sourceSelectorSha256 !== directive.sourceSelectorSha256
    || (decision.actorRole === "owner" && directive.authority === "authenticated-human-hil")
    || (decision.actorRole === "authenticated-human-hil" && directive.authority !== "authenticated-human-hil")
  ) {
    throw new Error("content-intensity decision receipt does not authorize this directive");
  }
}

export async function prepareFictionContentInvocation(
  input: PrepareFictionContentInvocationInput,
): Promise<PreparedFictionContentInvocation> {
  assertSafeBookId(input.bookId);
  if (input.agentName === "writer" && !WRITER_INVOCATION_STAGES.has(input.stage)) {
    throw new Error(`Invalid host-owned Writer invocation stage: ${input.stage}.`);
  }
  const evidenceBookDir = resolveEvidenceBookDir(
    input.projectRoot,
    input.bookId,
    input.evidenceBookDir,
  );
  const intensity = await loadContentIntensityDirectiveAtBookDir(evidenceBookDir, input.bookId);
  const activeOperation = activeFictionContentOperation.getStore();
  if (activeOperation && activeOperation.bookId !== input.bookId) {
    throw new Error("Fiction-content invocation Book does not match the active host operation.");
  }
  if (
    input.operationId
    && activeOperation
    && input.operationId !== activeOperation.operationId
  ) {
    throw new Error("Fiction-content invocation operation ID does not match the active host operation.");
  }
  if (
    input.productionAttempt
    && activeOperation
    && (
      input.productionAttempt.productionOperationId !== activeOperation.productionAttempt.productionOperationId
      || input.productionAttempt.attemptId !== activeOperation.productionAttempt.attemptId
    )
  ) {
    throw new Error("Fiction-content invocation production attempt does not match the active host operation.");
  }
  const operationId = input.operationId ?? activeOperation?.operationId ?? null;
  if (operationId) z.string().uuid().parse(operationId);
  const productionAttempt = input.productionAttempt
    ? verifyProductionAttemptIdentity(input.productionAttempt)
    : activeOperation?.productionAttempt;
  const productionInput = currentProductionInputBundle();
  if (productionInput) {
    if (productionInput.bookId !== input.bookId) {
      throw new Error("Production input bundle Book does not match the fiction-content invocation.");
    }
    if (!productionAttempt) {
      throw new Error("Production input bundle requires a production attempt identity.");
    }
    if (
      productionInput.productionOperationId !== productionAttempt.productionOperationId
      || productionInput.attemptId !== productionAttempt.attemptId
    ) {
      throw new Error("Production input bundle attempt does not match the fiction-content invocation.");
    }
    if (
      input.agentName === "writer"
      && PRIMARY_WRITER_INVOCATION_STAGES.has(input.stage)
      && productionInput.externalContextText
      && !input.messages.some((message) => message.content.includes(productionInput.externalContextText))
    ) {
      throw new Error("Writer request does not contain the exact receipt-bound external context bytes.");
    }
  }
  const productionMessages = productionInput
    ? appendProductionInput(input.messages, productionInput)
    : input.messages;
  const messages = appendFictionContentContract(productionMessages, intensity);
  const systemPrompt = messages.filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const occurrenceCount = countOccurrences(systemPrompt, FICTION_CONTENT_CONTRACT);
  if (occurrenceCount !== 1) {
    throw new Error(
      `Fiction content contract must occur exactly once for ${input.agentName}; found ${occurrenceCount}.`,
    );
  }
  if (
    productionInput?.promptInjection
    && countOccurrences(systemPrompt, productionInput.promptInjection) !== 1
  ) {
    throw new Error("Production Soul/Skill prompt injection must occur exactly once in the provider request.");
  }

  const logicalRequestPayloadSha256 = hashCanonicalJson(
    input.logicalRequestPayload?.(messages) ?? {
      model: input.model,
      messages,
      options: input.options ?? {},
    },
  );
  const invocationId = input.invocationId ?? randomUUID();
  const trace = FictionContentInvocationTraceSchema.parse({
    version: 1,
    invocationId,
    bookId: input.bookId,
    agentName: input.agentName,
    stage: input.stage,
    operationId,
    productionOperationId: productionAttempt?.productionOperationId ?? null,
    attemptId: productionAttempt?.attemptId ?? null,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    model: input.model,
    logicalRequestPayloadSha256,
  });
  const receipt = FictionContentInvocationReceiptSchema.parse({
    version: 1,
    invocationId,
    bookId: input.bookId,
    agentName: input.agentName,
    stage: input.stage,
    operationId,
    productionOperationId: productionAttempt?.productionOperationId ?? null,
    attemptId: productionAttempt?.attemptId ?? null,
    traceSha256: hashCanonicalJson(trace),
    logicalRequestPayloadSha256,
    systemPromptSha256: sha256(systemPrompt),
    contractId: FICTION_CONTENT_CONTRACT_ID,
    contractSha256: FICTION_CONTENT_CONTRACT_SHA256,
    contractOccurrenceCount: occurrenceCount,
    contentIntensityDirectiveSha256: intensity.directiveSha256,
    contentIntensityAuthority: intensity.authority,
    contentIntensityAuthorityReceiptSha256: intensity.decisionReceiptSha256,
    model: input.model,
    reasoningEffort: input.reasoningEffort ?? null,
    ...(productionInput ? { productionInputs: productionInput.receipt } : {}),
  });

  await writeInvocationPair(evidenceBookDir, trace, receipt);
  return { messages, trace, receipt, evidenceBookDir };
}

export async function writeFictionContentInvocationOutcome(input: {
  readonly projectRoot: string;
  readonly prepared: PreparedFictionContentInvocation;
  readonly output?: string;
  readonly error?: unknown;
  readonly now?: () => Date;
}): Promise<FictionContentInvocationOutcome> {
  const { trace } = input.prepared;
  const hasError = input.error !== undefined;
  if (hasError === (input.output !== undefined)) {
    throw new Error("Fiction-content outcome requires exactly one of output or error.");
  }
  const errorMessage = hasError ? errorText(input.error) : null;
  const status = hasError
    ? isProviderRefusal(input.error) ? "provider-refused" as const : "failed" as const
    : "completed" as const;
  const outcome = FictionContentInvocationOutcomeSchema.parse({
    version: 1,
    invocationId: trace.invocationId,
    bookId: trace.bookId,
    agentName: trace.agentName,
    stage: trace.stage,
    operationId: trace.operationId,
    productionOperationId: trace.productionOperationId,
    attemptId: trace.attemptId,
    completedAt: (input.now ?? (() => new Date()))().toISOString(),
    status,
    outputSha256: hasError ? null : sha256(input.output!),
    errorName: hasError
      ? input.error instanceof Error ? input.error.name : "NonErrorThrow"
      : null,
    errorMessageSha256: errorMessage ? sha256(errorMessage) : null,
  });
  const evidenceBookDir = resolveEvidenceBookDir(
    input.projectRoot,
    trace.bookId,
    input.prepared.evidenceBookDir,
  );
  const outcomeDir = join(receiptRootForBookDir(evidenceBookDir), "outcomes");
  await mkdir(outcomeDir, { recursive: true });
  await writeExclusive(join(outcomeDir, `${trace.invocationId}.json`), outcome);
  return outcome;
}

export async function authorizeFictionContentToolCalls(input: {
  readonly projectRoot: string;
  readonly prepared: PreparedFictionContentInvocation;
  readonly assistantOutput: string;
  readonly toolCalls: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly arguments: unknown;
  }>;
  readonly now?: () => Date;
}): Promise<ReadonlyArray<FictionContentToolAuthorization>> {
  if (input.toolCalls.length === 0) return [];
  const toolCallIds = input.toolCalls.map((toolCall) => toolCall.id);
  if (new Set(toolCallIds).size !== toolCallIds.length) {
    throw new Error("Fiction-content tool authorization rejects duplicate tool-call IDs.");
  }
  const completed = await loadCompletedPreparedEvidence(
    input.projectRoot,
    input.prepared,
    input.assistantOutput,
  );
  const authorizationDir = join(
    receiptRootForBookDir(input.prepared.evidenceBookDir),
    "tool-authorizations",
  );
  await mkdir(authorizationDir, { recursive: true });
  const createdAt = (input.now ?? (() => new Date()))().toISOString();
  const authorizations: FictionContentToolAuthorization[] = [];
  for (const toolCall of input.toolCalls) {
    if (!toolCall.id.trim() || !toolCall.name.trim()) {
      throw new Error("Fiction-content tool authorization requires non-empty tool-call ID and name.");
    }
    const unsigned = {
      version: 1 as const,
      invocationId: completed.trace.invocationId,
      bookId: completed.trace.bookId,
      agentName: completed.trace.agentName,
      stage: completed.trace.stage,
      operationId: completed.trace.operationId,
      productionOperationId: completed.trace.productionOperationId,
      attemptId: completed.trace.attemptId,
      createdAt,
      assistantOutputSha256: sha256(input.assistantOutput),
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      argumentsSha256: hashCanonicalJson(toolCall.arguments),
      outcomeFileSha256: completed.outcomeFileSha256,
    };
    const authorization = FictionContentToolAuthorizationSchema.parse({
      ...unsigned,
      authorizationId: hashCanonicalJson(unsigned),
    });
    await writeExclusive(
      toolAuthorizationPath(authorizationDir, authorization),
      authorization,
    );
    authorizations.push(authorization);
  }
  return authorizations;
}

export async function verifyFictionContentToolAuthorization(input: {
  readonly projectRoot: string;
  readonly prepared: PreparedFictionContentInvocation;
  readonly authorization: FictionContentToolAuthorization;
  readonly assistantOutput: string;
  readonly toolCall: {
    readonly id: string;
    readonly name: string;
    readonly arguments: unknown;
  };
}): Promise<FictionContentToolAuthorization> {
  const authorization = FictionContentToolAuthorizationSchema.parse(input.authorization);
  const completed = await loadCompletedPreparedEvidence(
    input.projectRoot,
    input.prepared,
    input.assistantOutput,
  );
  const authorizationDir = join(
    receiptRootForBookDir(input.prepared.evidenceBookDir),
    "tool-authorizations",
  );
  const stored = FictionContentToolAuthorizationSchema.parse(JSON.parse(await readFile(
    toolAuthorizationPath(authorizationDir, authorization),
    "utf8",
  )));
  const { authorizationId: _storedId, ...storedUnsigned } = stored;
  if (
    hashCanonicalJson(stored) !== hashCanonicalJson(authorization)
    || stored.authorizationId !== hashCanonicalJson(storedUnsigned)
    || stored.invocationId !== completed.trace.invocationId
    || stored.bookId !== completed.trace.bookId
    || stored.agentName !== completed.trace.agentName
    || stored.stage !== completed.trace.stage
    || stored.operationId !== completed.trace.operationId
    || stored.productionOperationId !== completed.trace.productionOperationId
    || stored.attemptId !== completed.trace.attemptId
    || stored.assistantOutputSha256 !== sha256(input.assistantOutput)
    || stored.toolCallId !== input.toolCall.id
    || stored.toolName !== input.toolCall.name
    || stored.argumentsSha256 !== hashCanonicalJson(input.toolCall.arguments)
    || stored.outcomeFileSha256 !== completed.outcomeFileSha256
  ) {
    throw new Error("Fiction-content tool authorization does not match the completed model call.");
  }
  return stored;
}

export interface FictionContentReceiptAudit {
  readonly traceInvocationIds: ReadonlyArray<string>;
  readonly receiptInvocationIds: ReadonlyArray<string>;
  readonly outcomeInvocationIds: ReadonlyArray<string>;
  readonly participatingInvocationSetSha256: string;
  readonly receiptInvocationSetSha256: string;
  readonly receiptSetEqualityPassed: boolean;
  readonly outcomeSetEqualityPassed: boolean;
  readonly invocations: ReadonlyArray<{
    readonly invocationId: string;
    readonly agentName: string;
    readonly stage: string;
    readonly status: "completed" | "provider-refused" | "failed" | "missing-outcome";
  }>;
}

export interface ProductionModelCallReadback {
  readonly invocationId: string;
  readonly agentName: string;
  readonly stage: string;
  readonly model: string;
  readonly reasoningEffort: string | null;
  readonly status: "completed" | "provider-refused" | "failed";
  readonly receiptPath: string;
  readonly receiptSha256: string;
  readonly outcomePath: string;
  readonly outcomeSha256: string;
}

interface FictionContentEvidenceEntry<T> {
  readonly value: T;
  readonly fileSha256: string;
}

interface FictionContentEvidenceLedger {
  readonly traces: ReadonlyMap<string, FictionContentEvidenceEntry<FictionContentInvocationTrace>>;
  readonly receipts: ReadonlyMap<string, FictionContentEvidenceEntry<FictionContentInvocationReceipt>>;
  readonly outcomes: ReadonlyMap<string, FictionContentEvidenceEntry<FictionContentInvocationOutcome>>;
}

/**
 * Capture the exact evidence sets at the start of one locked Book operation.
 * Historical failed or partial invocations are deliberately retained only in
 * this baseline; they cannot satisfy, or poison, the new operation delta.
 */
export async function beginFictionContentOperation(input: {
  readonly projectRoot: string;
  readonly bookId: string;
  readonly operationKind: FictionContentOperationKind;
  readonly chapterNumber: number;
  readonly requiredStages: ReadonlyArray<string>;
  readonly productionAttempt?: ProductionAttemptIdentity;
  readonly now?: () => Date;
}): Promise<FictionContentOperationStart> {
  assertSafeBookId(input.bookId);
  const operationKind = FictionContentOperationKindSchema.parse(input.operationKind);
  if (!Number.isInteger(input.chapterNumber) || input.chapterNumber < 1) {
    throw new Error(`Fiction-content operation chapterNumber must be positive; received ${input.chapterNumber}.`);
  }
  const requiredStages = [...input.requiredStages].map((stage) => stage.trim()).sort();
  if (requiredStages.length === 0 || requiredStages.some((stage) => !stage)) {
    throw new Error("Fiction-content operation requires at least one non-empty stage.");
  }
  if (new Set(requiredStages).size !== requiredStages.length) {
    throw new Error("Fiction-content operation required stages must be unique.");
  }
  const ledger = await loadFictionContentEvidenceLedger(input.projectRoot, input.bookId);
  const baseline = FictionContentEvidenceSetSnapshotSchema.parse({
    traceInvocationIds: sortedIds(ledger.traces),
    receiptInvocationIds: sortedIds(ledger.receipts),
    outcomeInvocationIds: sortedIds(ledger.outcomes),
  });
  return {
    operationId: randomUUID(),
    productionAttempt: input.productionAttempt
      ? verifyProductionAttemptIdentity(input.productionAttempt)
      : createProductionAttemptIdentity(),
    bookId: input.bookId,
    operationKind,
    chapterNumber: input.chapterNumber,
    startedAt: (input.now ?? (() => new Date()))().toISOString(),
    requiredStages,
    baseline,
  };
}

/** Validate only evidence created after this operation's exact baseline. */
export async function verifyFictionContentOperationEvidence(
  projectRoot: string,
  operation: FictionContentOperationStart,
): Promise<ReadonlyArray<z.infer<typeof FictionContentOperationInvocationSchema>>> {
  const ledger = await loadFictionContentEvidenceLedger(projectRoot, operation.bookId);
  return collectFictionContentOperationInvocations(operation, ledger);
}

/**
 * Seal one immutable operation manifest before any Chapter or truth file is
 * promoted. The manifest records the exact invocation IDs and raw evidence
 * file hashes, not merely a count or a global ledger checksum.
 */
export async function sealFictionContentOperationManifest(input: {
  readonly projectRoot: string;
  readonly operation: FictionContentOperationStart;
  readonly now?: () => Date;
}): Promise<FictionContentOperationManifest> {
  const invocations = await verifyFictionContentOperationEvidence(
    input.projectRoot,
    input.operation,
  );
  const manifest = FictionContentOperationManifestSchema.parse({
    version: 1,
    operationId: input.operation.operationId,
    productionOperationId: input.operation.productionAttempt.productionOperationId,
    attemptId: input.operation.productionAttempt.attemptId,
    bookId: input.operation.bookId,
    operationKind: input.operation.operationKind,
    chapterNumber: input.operation.chapterNumber,
    startedAt: input.operation.startedAt,
    sealedAt: (input.now ?? (() => new Date()))().toISOString(),
    requiredStages: [...input.operation.requiredStages],
    baseline: {
      traceInvocationSetSha256: hashCanonicalJson(input.operation.baseline.traceInvocationIds),
      receiptInvocationSetSha256: hashCanonicalJson(input.operation.baseline.receiptInvocationIds),
      outcomeInvocationSetSha256: hashCanonicalJson(input.operation.baseline.outcomeInvocationIds),
    },
    invocations,
    invocationSetSha256: hashCanonicalJson(invocations.map((invocation) => invocation.invocationId)),
  });
  const operationsDir = join(receiptRoot(input.projectRoot, input.operation.bookId), "operations");
  await mkdir(operationsDir, { recursive: true });
  await writeExclusive(join(operationsDir, `${manifest.operationId}.json`), manifest);
  return manifest;
}

/**
 * Read back and recompute the exact stored manifest immediately before canon
 * persistence. Any missing, added, refused, failed, or mutated current-call
 * evidence fails closed.
 */
export async function verifyFictionContentOperationManifest(input: {
  readonly projectRoot: string;
  readonly operation: FictionContentOperationStart;
  readonly expectedManifest: FictionContentOperationManifest;
}): Promise<FictionContentOperationManifest> {
  const manifestPath = join(
    receiptRoot(input.projectRoot, input.operation.bookId),
    "operations",
    `${input.operation.operationId}.json`,
  );
  const stored = FictionContentOperationManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  if (hashCanonicalJson(stored) !== hashCanonicalJson(input.expectedManifest)) {
    throw new Error("Stored fiction-content operation manifest does not match the sealed host manifest.");
  }
  if (
    stored.operationId !== input.operation.operationId
    || stored.productionOperationId !== input.operation.productionAttempt.productionOperationId
    || stored.attemptId !== input.operation.productionAttempt.attemptId
    || stored.bookId !== input.operation.bookId
    || stored.operationKind !== input.operation.operationKind
    || stored.chapterNumber !== input.operation.chapterNumber
    || stored.startedAt !== input.operation.startedAt
    || hashCanonicalJson(stored.requiredStages) !== hashCanonicalJson(input.operation.requiredStages)
    || stored.baseline.traceInvocationSetSha256 !== hashCanonicalJson(input.operation.baseline.traceInvocationIds)
    || stored.baseline.receiptInvocationSetSha256 !== hashCanonicalJson(input.operation.baseline.receiptInvocationIds)
    || stored.baseline.outcomeInvocationSetSha256 !== hashCanonicalJson(input.operation.baseline.outcomeInvocationIds)
  ) {
    throw new Error("Stored fiction-content operation manifest is not bound to the active Book operation.");
  }
  const currentInvocations = await verifyFictionContentOperationEvidence(
    input.projectRoot,
    input.operation,
  );
  if (hashCanonicalJson(currentInvocations) !== hashCanonicalJson(stored.invocations)) {
    throw new Error("Stored fiction-content operation manifest is not the exact current invocation delta.");
  }
  return stored;
}

export async function verifyFictionContentInvocationReceipts(
  projectRoot: string,
  bookId: string,
): Promise<FictionContentReceiptAudit> {
  assertSafeBookId(bookId);
  const ledger = await loadFictionContentEvidenceLedger(projectRoot, bookId);
  const traceInvocationIds = sortedIds(ledger.traces);
  const receiptInvocationIds = sortedIds(ledger.receipts);
  const outcomeInvocationIds = sortedIds(ledger.outcomes);
  const participatingInvocationSetSha256 = hashCanonicalJson(traceInvocationIds);
  const receiptInvocationSetSha256 = hashCanonicalJson(receiptInvocationIds);
  return {
    traceInvocationIds,
    receiptInvocationIds,
    outcomeInvocationIds,
    participatingInvocationSetSha256,
    receiptInvocationSetSha256,
    receiptSetEqualityPassed:
      participatingInvocationSetSha256 === receiptInvocationSetSha256,
    outcomeSetEqualityPassed:
      hashCanonicalJson(traceInvocationIds) === hashCanonicalJson(outcomeInvocationIds),
    invocations: traceInvocationIds.map((invocationId) => {
      const trace = ledger.traces.get(invocationId)!.value;
      return {
        invocationId,
        agentName: trace.agentName,
        stage: trace.stage,
        status: ledger.outcomes.get(invocationId)?.value.status ?? "missing-outcome",
      };
    }),
  };
}

export async function readProductionModelCallReadback(input: {
  readonly projectRoot: string;
  readonly bookId: string;
  readonly productionOperationId: string;
  readonly attemptId: string;
}): Promise<ReadonlyArray<ProductionModelCallReadback>> {
  const ledger = await loadFictionContentEvidenceLedger(input.projectRoot, input.bookId);
  const root = join("story", "runtime", "fiction-content-neutral");
  return [...ledger.receipts.entries()]
    .filter(([, entry]) => (
      entry.value.productionOperationId === input.productionOperationId
      && entry.value.attemptId === input.attemptId
    ))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([invocationId, receiptEntry]) => {
      const trace = ledger.traces.get(invocationId)?.value;
      const outcomeEntry = ledger.outcomes.get(invocationId);
      if (!trace || !outcomeEntry) {
        throw new Error(`Production model call ${invocationId} is missing trace or outcome evidence.`);
      }
      return {
        invocationId,
        agentName: receiptEntry.value.agentName,
        stage: receiptEntry.value.stage,
        model: receiptEntry.value.model,
        reasoningEffort: receiptEntry.value.reasoningEffort,
        status: outcomeEntry.value.status,
        receiptPath: join(root, "receipts", `${invocationId}.json`),
        receiptSha256: receiptEntry.fileSha256,
        outcomePath: join(root, "outcomes", `${invocationId}.json`),
        outcomeSha256: outcomeEntry.fileSha256,
      };
    });
}

async function loadFictionContentEvidenceLedger(
  projectRoot: string,
  bookId: string,
): Promise<FictionContentEvidenceLedger> {
  assertSafeBookId(bookId);
  const root = receiptRoot(projectRoot, bookId);
  const [traceNames, receiptNames, outcomeNames] = await Promise.all([
    readJsonNames(join(root, "traces")),
    readJsonNames(join(root, "receipts")),
    readJsonNames(join(root, "outcomes")),
  ]);
  const [traceEntries, receiptEntries, outcomeEntries] = await Promise.all([
    Promise.all(traceNames.map(async (name) => {
      const raw = await readFile(join(root, "traces", name), "utf8");
      const value = FictionContentInvocationTraceSchema.parse(JSON.parse(raw));
      assertEvidenceFilename(name, value.invocationId, "trace");
      if (value.bookId !== bookId) {
        throw new Error(`Fiction-content trace ${value.invocationId} belongs to another Book.`);
      }
      return [value.invocationId, { value, fileSha256: sha256(raw) }] as const;
    })),
    Promise.all(receiptNames.map(async (name) => {
      const raw = await readFile(join(root, "receipts", name), "utf8");
      const value = FictionContentInvocationReceiptSchema.parse(JSON.parse(raw));
      assertEvidenceFilename(name, value.invocationId, "receipt");
      if (value.bookId !== bookId) {
        throw new Error(`Fiction-content receipt ${value.invocationId} belongs to another Book.`);
      }
      return [value.invocationId, { value, fileSha256: sha256(raw) }] as const;
    })),
    Promise.all(outcomeNames.map(async (name) => {
      const raw = await readFile(join(root, "outcomes", name), "utf8");
      const value = FictionContentInvocationOutcomeSchema.parse(JSON.parse(raw));
      assertEvidenceFilename(name, value.invocationId, "outcome");
      if (value.bookId !== bookId) {
        throw new Error(`Fiction-content outcome ${value.invocationId} belongs to another Book.`);
      }
      return [value.invocationId, { value, fileSha256: sha256(raw) }] as const;
    })),
  ]);
  const traces = new Map(traceEntries);
  const receipts = new Map(receiptEntries);
  const outcomes = new Map(outcomeEntries);
  if (
    traces.size !== traceEntries.length
    || receipts.size !== receiptEntries.length
    || outcomes.size !== outcomeEntries.length
  ) {
    throw new Error("Duplicate fiction-content invocation IDs found in runtime evidence.");
  }

  for (const [invocationId, receiptEntry] of receipts) {
    const trace = traces.get(invocationId)?.value;
    if (!trace) continue;
    const receipt = receiptEntry.value;
    if (
      receipt.traceSha256 !== hashCanonicalJson(trace)
      || receipt.logicalRequestPayloadSha256 !== trace.logicalRequestPayloadSha256
      || receipt.bookId !== trace.bookId
      || receipt.agentName !== trace.agentName
      || receipt.stage !== trace.stage
      || receipt.operationId !== trace.operationId
      || receipt.productionOperationId !== trace.productionOperationId
      || receipt.attemptId !== trace.attemptId
      || receipt.model !== trace.model
    ) {
      throw new Error(`Fiction-content receipt does not match trace ${invocationId}.`);
    }
  }

  for (const [invocationId, outcomeEntry] of outcomes) {
    const trace = traces.get(invocationId)?.value;
    if (!trace) continue;
    const outcome = outcomeEntry.value;
    if (
      outcome.bookId !== trace.bookId
      || outcome.agentName !== trace.agentName
      || outcome.stage !== trace.stage
      || outcome.operationId !== trace.operationId
      || outcome.productionOperationId !== trace.productionOperationId
      || outcome.attemptId !== trace.attemptId
    ) {
      throw new Error(`Fiction-content outcome does not match trace ${invocationId}.`);
    }
  }
  return { traces, receipts, outcomes };
}

function collectFictionContentOperationInvocations(
  operation: FictionContentOperationStart,
  ledger: FictionContentEvidenceLedger,
): ReadonlyArray<z.infer<typeof FictionContentOperationInvocationSchema>> {
  validateFictionContentOperationStart(operation);
  assertBaselineStillPresent("trace", operation.baseline.traceInvocationIds, ledger.traces);
  assertBaselineStillPresent("receipt", operation.baseline.receiptInvocationIds, ledger.receipts);
  assertBaselineStillPresent("outcome", operation.baseline.outcomeInvocationIds, ledger.outcomes);

  const traceIds = sortedOperationIds(ledger.traces, operation.operationId);
  const receiptIds = sortedOperationIds(ledger.receipts, operation.operationId);
  const outcomeIds = sortedOperationIds(ledger.outcomes, operation.operationId);
  if (traceIds.length === 0) {
    throw new Error("Current Book operation has no fiction-content invocation evidence.");
  }
  if (
    hashCanonicalJson(traceIds) !== hashCanonicalJson(receiptIds)
    || hashCanonicalJson(traceIds) !== hashCanonicalJson(outcomeIds)
  ) {
    throw new Error("Current Book operation has a partial or mismatched fiction-content evidence set.");
  }

  const invocations = traceIds.map((invocationId) => {
    const traceEntry = ledger.traces.get(invocationId)!;
    const receiptEntry = ledger.receipts.get(invocationId)!;
    const outcomeEntry = ledger.outcomes.get(invocationId)!;
    if (
      traceEntry.value.productionOperationId !== operation.productionAttempt.productionOperationId
      || traceEntry.value.attemptId !== operation.productionAttempt.attemptId
    ) {
      throw new Error(
        `Current Book operation fiction call ${invocationId} is not correlated to the active production attempt.`,
      );
    }
    if (outcomeEntry.value.status !== "completed") {
      throw new Error(
        `Current Book operation has an incomplete/refused model call ${invocationId} (${outcomeEntry.value.status}).`,
      );
    }
    const productionInput = currentProductionInputBundle();
    if (
      productionInput
      && hashCanonicalJson(receiptEntry.value.productionInputs ?? null) !== hashCanonicalJson(productionInput.receipt)
    ) {
      throw new Error(
        `Current Book operation fiction call ${invocationId} does not contain the exact host-resolved Soul/Skill input receipt.`,
      );
    }
    return FictionContentOperationInvocationSchema.parse({
      invocationId,
      agentName: traceEntry.value.agentName,
      stage: traceEntry.value.stage,
      status: outcomeEntry.value.status,
      traceFileSha256: traceEntry.fileSha256,
      receiptFileSha256: receiptEntry.fileSha256,
      outcomeFileSha256: outcomeEntry.fileSha256,
    });
  });
  const observedStages = new Set(invocations.map((invocation) => invocation.stage));
  const missingStages = operation.requiredStages.filter((stage) => !observedStages.has(stage));
  if (missingStages.length > 0) {
    throw new Error(
      `Current Book operation is missing fiction-content receipts for: ${missingStages.join(", ")}.`,
    );
  }
  return invocations;
}

function validateFictionContentOperationStart(operation: FictionContentOperationStart): void {
  z.string().uuid().parse(operation.operationId);
  verifyProductionAttemptIdentity(operation.productionAttempt);
  assertSafeBookId(operation.bookId);
  FictionContentOperationKindSchema.parse(operation.operationKind);
  if (!Number.isInteger(operation.chapterNumber) || operation.chapterNumber < 1) {
    throw new Error("Invalid fiction-content operation chapter number.");
  }
  z.string().datetime().parse(operation.startedAt);
  FictionContentEvidenceSetSnapshotSchema.parse(operation.baseline);
  if (
    operation.requiredStages.length === 0
    || new Set(operation.requiredStages).size !== operation.requiredStages.length
    || [...operation.requiredStages].sort().some((stage, index) => stage !== operation.requiredStages[index])
    || operation.requiredStages.some((stage) => !stage.trim())
  ) {
    throw new Error("Invalid fiction-content operation required stages.");
  }
}

function assertBaselineStillPresent<T>(
  kind: string,
  baselineIds: ReadonlyArray<string>,
  current: ReadonlyMap<string, T>,
): void {
  const removed = baselineIds.filter((invocationId) => !current.has(invocationId));
  if (removed.length > 0) {
    throw new Error(
      `Historical fiction-content ${kind} evidence was removed during the current Book operation: ${removed.join(", ")}.`,
    );
  }
}

function sortedIds<T>(map: ReadonlyMap<string, T>): string[] {
  return [...map.keys()].sort();
}

function sortedOperationIds<T extends { readonly operationId: string | null }>(
  map: ReadonlyMap<string, FictionContentEvidenceEntry<T>>,
  operationId: string,
): string[] {
  return [...map.entries()]
    .filter(([, entry]) => entry.value.operationId === operationId)
    .map(([invocationId]) => invocationId)
    .sort();
}

function assertEvidenceFilename(name: string, invocationId: string, kind: string): void {
  if (name !== `${invocationId}.json`) {
    throw new Error(`Fiction-content ${kind} filename does not match invocation ID ${invocationId}.`);
  }
}

export function appendFictionContentContract(
  messages: ReadonlyArray<LLMMessage>,
  intensity: ContentIntensityDirective,
): ReadonlyArray<LLMMessage> {
  const intensityBlock = `## Content intensity\nDirective: ${intensity.directive}\nAuthority: ${intensity.authority}`;
  const firstSystem = messages.findIndex((message) => message.role === "system");
  if (firstSystem < 0) {
    return [
      { role: "system", content: `${FICTION_CONTENT_CONTRACT}\n\n${intensityBlock}` },
      ...messages,
    ];
  }
  return messages.map((message, index) => index === firstSystem
    ? { ...message, content: `${message.content}\n\n${FICTION_CONTENT_CONTRACT}\n\n${intensityBlock}` }
    : message);
}

async function loadCompletedPreparedEvidence(
  projectRoot: string,
  prepared: PreparedFictionContentInvocation,
  assistantOutput: string,
): Promise<{
  readonly trace: FictionContentInvocationTrace;
  readonly outcomeFileSha256: string;
}> {
  const evidenceBookDir = resolveEvidenceBookDir(
    projectRoot,
    prepared.trace.bookId,
    prepared.evidenceBookDir,
  );
  const root = receiptRootForBookDir(evidenceBookDir);
  const invocationId = prepared.trace.invocationId;
  const [traceRaw, receiptRaw, outcomeRaw] = await Promise.all([
    readFile(join(root, "traces", `${invocationId}.json`), "utf8"),
    readFile(join(root, "receipts", `${invocationId}.json`), "utf8"),
    readFile(join(root, "outcomes", `${invocationId}.json`), "utf8"),
  ]);
  const trace = FictionContentInvocationTraceSchema.parse(JSON.parse(traceRaw));
  const receipt = FictionContentInvocationReceiptSchema.parse(JSON.parse(receiptRaw));
  const outcome = FictionContentInvocationOutcomeSchema.parse(JSON.parse(outcomeRaw));
  if (
    hashCanonicalJson(trace) !== hashCanonicalJson(prepared.trace)
    || hashCanonicalJson(receipt) !== hashCanonicalJson(prepared.receipt)
    || receipt.traceSha256 !== hashCanonicalJson(trace)
    || receipt.invocationId !== trace.invocationId
    || receipt.bookId !== trace.bookId
    || receipt.agentName !== trace.agentName
    || receipt.stage !== trace.stage
    || receipt.operationId !== trace.operationId
    || receipt.productionOperationId !== trace.productionOperationId
    || receipt.attemptId !== trace.attemptId
    || outcome.invocationId !== trace.invocationId
    || outcome.bookId !== trace.bookId
    || outcome.agentName !== trace.agentName
    || outcome.stage !== trace.stage
    || outcome.operationId !== trace.operationId
    || outcome.productionOperationId !== trace.productionOperationId
    || outcome.attemptId !== trace.attemptId
    || outcome.status !== "completed"
    || outcome.outputSha256 !== sha256(assistantOutput)
  ) {
    throw new Error("Tool mutation requires an exact completed fiction-content invocation.");
  }
  return { trace, outcomeFileSha256: sha256(outcomeRaw) };
}

function toolAuthorizationPath(
  authorizationDir: string,
  authorization: Pick<FictionContentToolAuthorization, "invocationId" | "toolCallId">,
): string {
  return join(
    authorizationDir,
    `${authorization.invocationId}-${sha256(authorization.toolCallId)}.json`,
  );
}

async function writeInvocationPair(
  evidenceBookDir: string,
  trace: FictionContentInvocationTrace,
  receipt: FictionContentInvocationReceipt,
): Promise<void> {
  const root = receiptRootForBookDir(evidenceBookDir);
  const traceDir = join(root, "traces");
  const receiptDir = join(root, "receipts");
  await Promise.all([
    mkdir(traceDir, { recursive: true }),
    mkdir(receiptDir, { recursive: true }),
  ]);
  await writeExclusive(join(traceDir, `${trace.invocationId}.json`), trace);
  // A crash between these two immutable writes is deliberate evidence of an
  // incomplete run; set-equality verification then fails closed.
  await writeExclusive(join(receiptDir, `${receipt.invocationId}.json`), receipt);
}

async function writeExclusive(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJsonNames(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function receiptRoot(projectRoot: string, bookId: string): string {
  assertSafeBookId(bookId);
  return receiptRootForBookDir(join(projectRoot, "books", bookId));
}

function receiptRootForBookDir(bookDir: string): string {
  return join(bookDir, "story", "runtime", "fiction-content-neutral");
}

function resolveEvidenceBookDir(
  projectRoot: string,
  bookId: string,
  override: string | undefined,
): string {
  const booksDir = resolve(projectRoot, "books");
  const canonicalBookDir = resolve(booksDir, bookId);
  if (!override) return canonicalBookDir;
  const candidate = resolve(override);
  if (candidate === canonicalBookDir) return candidate;
  const requiredPrefix = `.tmp-book-create-${bookId}-`;
  if (
    dirname(candidate) !== booksDir
    || !basename(candidate).startsWith(requiredPrefix)
    || basename(candidate).length <= requiredPrefix.length
  ) {
    throw new Error(
      `Invalid host evidence Book directory for ${JSON.stringify(bookId)}: ${JSON.stringify(override)}.`,
    );
  }
  return candidate;
}

function assertSafeBookId(bookId: string): void {
  if (
    !bookId.trim()
    || bookId === "."
    || bookId === ".."
    || bookId.includes("/")
    || bookId.includes("\\")
    || bookId.includes("\0")
  ) {
    throw new Error(`Unsafe Book id for fiction-content evidence: ${JSON.stringify(bookId)}`);
  }
}

function safeBookRelativePath(relativePath: string): string {
  const normalized = normalize(relativePath);
  if (
    !relativePath.trim()
    || isAbsolute(relativePath)
    || normalized === ".."
    || normalized.startsWith(`..${sep}`)
  ) {
    throw new Error(`Content-intensity evidence path must stay inside the Book: ${relativePath}`);
  }
  return normalized;
}

function isProviderRefusal(error: unknown): boolean {
  const text = errorText(error);
  return /(?:refus(?:al|ed)|content\s*policy|safety\s*(?:policy|filter)|moderation|blocked\s*by\s*provider)/i.test(text);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashCanonicalJson(value: unknown): string {
  return sha256(JSON.stringify(sortJson(value)));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)]));
  }
  return value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
