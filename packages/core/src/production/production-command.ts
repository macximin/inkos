import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ActionSourceSchema, RequestedIntentSchema, type ActionSource, type RequestedIntent } from "../interaction/action-envelope.js";
import { hashCanonicalJson } from "./fiction-content-contract.js";
import {
  OwnerDirectionReferenceSchema,
  Sha256HexSchema,
  TaskGuidanceReferenceSchema,
  type OwnerDirectionReference,
  type TaskGuidanceReference,
} from "./direction-context.js";
import { SessionSoulBindingSchema } from "./soul-schema.js";

export const ProductionCommandSourceSchema = z.enum([
  "studio",
  "cli",
  "tui",
  "agent",
  "hq",
  "test",
]);
export type ProductionCommandSource = z.infer<typeof ProductionCommandSourceSchema>;

const SafeAuthorityIdSchema = z.string().trim().min(1).max(240);
const SafeBookIdSchema = z.string().trim().min(1).max(240).superRefine((value, ctx) => {
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "bookId must be one safe path segment" });
  }
});

export const ProductionCommandBindingSchema = z.object({
  bookId: SafeBookIdSchema,
  sessionId: SafeAuthorityIdSchema,
  requestId: SafeAuthorityIdSchema,
  workOrderId: SafeAuthorityIdSchema.optional(),
  soulBinding: SessionSoulBindingSchema.optional(),
}).strict();
export type ProductionCommandBinding = z.infer<typeof ProductionCommandBindingSchema>;

export const ProductionTargetLengthSchema = z.object({
  count: z.number().int().min(1),
  unit: z.enum(["zh-chars", "ko-chars", "words"]),
}).strict();
export type ProductionTargetLength = z.infer<typeof ProductionTargetLengthSchema>;

const LegacyProductionCommandAuthorizationSchema = z.object({
  source: z.literal("confirmed-action"),
  actionSource: ActionSourceSchema,
  requestedIntent: RequestedIntentSchema,
  ownerDirection: OwnerDirectionReferenceSchema,
}).strict();

const ProductionCommandArgsV1Schema = z.object({
  chapterCount: z.literal(1),
  targetLength: ProductionTargetLengthSchema.optional(),
  ownerDirectionTextSha256: Sha256HexSchema,
}).strict();

const ProductionCommandArgsV2Schema = ProductionCommandArgsV1Schema.extend({
  taskGuidance: TaskGuidanceReferenceSchema.optional(),
}).strict();

const ProductionCommandV1UnsignedSchema = z.object({
  schemaVersion: z.literal("production-command/v1"),
  commandId: z.string().uuid(),
  idempotencyKey: SafeAuthorityIdSchema,
  intentDigest: Sha256HexSchema,
  capability: z.literal("write-next-chapter"),
  source: ProductionCommandSourceSchema,
  binding: ProductionCommandBindingSchema,
  authorization: LegacyProductionCommandAuthorizationSchema,
  args: ProductionCommandArgsV1Schema,
  activatedSkills: z.array(SafeAuthorityIdSchema).default([]),
  disabledSkills: z.array(SafeAuthorityIdSchema).optional(),
  issuedAt: z.string().datetime(),
}).strict();

const ProductionAuthorizationBaseSchema = z.object({
  requestedIntent: z.literal("write_next"),
  actionSource: ActionSourceSchema,
  ownerDirection: OwnerDirectionReferenceSchema,
  argsSha256: Sha256HexSchema,
}).strict();

export const ProductionCommandAuthorizationV2Schema = z.discriminatedUnion("kind", [
  ProductionAuthorizationBaseSchema.extend({
    kind: z.literal("confirmed-ui"),
    actionEnvelopeSha256: Sha256HexSchema,
    confirmationReceiptSha256: Sha256HexSchema,
  }).strict(),
  ProductionAuthorizationBaseSchema.extend({
    kind: z.literal("confirmed-cli"),
    typedCommandPreviewSha256: Sha256HexSchema,
    confirmationReceiptSha256: Sha256HexSchema,
  }).strict(),
  ProductionAuthorizationBaseSchema.extend({
    kind: z.literal("confirmed-agent-tool"),
    sessionRequestId: SafeAuthorityIdSchema,
    proposalReceiptSha256: Sha256HexSchema,
    confirmationReceiptSha256: Sha256HexSchema,
    toolArgsSha256: Sha256HexSchema,
  }).strict(),
  ProductionAuthorizationBaseSchema.extend({
    kind: z.literal("authenticated-orchestrator"),
    workOrderId: SafeAuthorityIdSchema,
    workOrderSha256: Sha256HexSchema,
    manifestCapabilitySha256: Sha256HexSchema,
    ownerDecisionReceiptSha256: Sha256HexSchema,
  }).strict(),
]);
export type ProductionCommandAuthorizationV2 = z.infer<typeof ProductionCommandAuthorizationV2Schema>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type ProductionAuthorizationEvidenceV2 = DistributiveOmit<
  ProductionCommandAuthorizationV2,
  "requestedIntent" | "actionSource" | "ownerDirection" | "argsSha256"
>;

const ProductionCommandV2UnsignedSchema = z.object({
  schemaVersion: z.literal("production-command/v2"),
  commandId: z.string().uuid(),
  idempotencyKey: SafeAuthorityIdSchema,
  intentDigest: Sha256HexSchema,
  capability: z.literal("write-next-chapter"),
  source: ProductionCommandSourceSchema,
  binding: ProductionCommandBindingSchema,
  authorization: ProductionCommandAuthorizationV2Schema,
  args: ProductionCommandArgsV2Schema,
  activatedSkills: z.array(SafeAuthorityIdSchema).default([]),
  disabledSkills: z.array(SafeAuthorityIdSchema).optional(),
  issuedAt: z.string().datetime(),
}).strict();

function validateCommonCommand(
  command: z.infer<typeof ProductionCommandV1UnsignedSchema> | z.infer<typeof ProductionCommandV2UnsignedSchema>,
  ctx: z.RefinementCtx,
): void {
  const ownerDirection = command.authorization.ownerDirection;
  if (ownerDirection.textSha256 !== command.args.ownerDirectionTextSha256) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["args", "ownerDirectionTextSha256"],
      message: "owner direction hash does not match the decision receipt",
    });
  }
  if (command.schemaVersion === "production-command/v2") {
    if (command.authorization.argsSha256 !== hashCanonicalJson(command.args)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["authorization", "argsSha256"], message: "authorization args hash mismatch" });
    }
    const expectedKind = command.source === "studio"
      ? "confirmed-ui"
      : command.source === "cli" || command.source === "tui"
        ? "confirmed-cli"
        : command.source === "agent"
          ? "confirmed-agent-tool"
          : command.source === "hq"
            ? "authenticated-orchestrator"
            : command.authorization.kind;
    if (command.authorization.kind !== expectedKind) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["authorization", "kind"], message: `authorization kind must be ${expectedKind} for ${command.source}` });
    }
    if (
      command.authorization.kind === "authenticated-orchestrator"
      && command.binding.workOrderId !== command.authorization.workOrderId
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["binding", "workOrderId"], message: "orchestrator workOrderId does not match the command binding" });
    }
    const taskGuidance = command.args.taskGuidance;
    if (taskGuidance?.source === "hermes-control-action") {
      if (taskGuidance.bookId !== command.binding.bookId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["args", "taskGuidance", "bookId"], message: "Hermes task guidance bookId does not match the command binding" });
      }
      if (!command.binding.workOrderId || taskGuidance.workOrderId !== command.binding.workOrderId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["args", "taskGuidance", "workOrderId"], message: "Hermes task guidance workOrderId does not match the command binding" });
      }
    }
  } else if (!isProductionCommandActionAuthorized(command.authorization)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authorization"],
      message: "write-next production requires a typed confirmed action; free text is proposal-only",
    });
  }
  if (new Set(command.activatedSkills).size !== command.activatedSkills.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["activatedSkills"], message: "activatedSkills must be unique" });
  }
  if ([...command.activatedSkills].sort().some((skill, index) => skill !== command.activatedSkills[index])) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["activatedSkills"], message: "activatedSkills must be sorted" });
  }
  if (command.disabledSkills) {
    if (new Set(command.disabledSkills).size !== command.disabledSkills.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["disabledSkills"], message: "disabledSkills must be unique" });
    }
    if ([...command.disabledSkills].sort().some((skill, index) => skill !== command.disabledSkills![index])) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["disabledSkills"], message: "disabledSkills must be sorted" });
    }
  }
}

export const ProductionCommandV1Schema = ProductionCommandV1UnsignedSchema.extend({
  commandSelfHash: Sha256HexSchema,
}).strict().superRefine((command, ctx) => {
  validateCommonCommand(command, ctx);
  if (productionIntentDigest(command) !== command.intentDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["intentDigest"], message: "intent digest mismatch" });
  }
  const { commandSelfHash: _self, ...unsigned } = command;
  if (hashCanonicalJson(unsigned) !== command.commandSelfHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["commandSelfHash"], message: "command self hash mismatch" });
  }
});

export const ProductionCommandV2Schema = ProductionCommandV2UnsignedSchema.extend({
  commandSelfHash: Sha256HexSchema,
}).strict().superRefine((command, ctx) => {
  validateCommonCommand(command, ctx);
  if (
    productionIntentDigest(command) !== command.intentDigest
    && legacyProductionIntentDigest(command) !== command.intentDigest
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["intentDigest"], message: "intent digest mismatch" });
  }
  const { commandSelfHash: _self, ...unsigned } = command;
  if (hashCanonicalJson(unsigned) !== command.commandSelfHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["commandSelfHash"], message: "command self hash mismatch" });
  }
});

export const ProductionCommandSchema = z.union([ProductionCommandV1Schema, ProductionCommandV2Schema]);
export type ProductionCommandV1 = z.infer<typeof ProductionCommandV1Schema>;
export type ProductionCommandV2 = z.infer<typeof ProductionCommandV2Schema>;
export type ProductionCommand = z.infer<typeof ProductionCommandSchema>;

export function isProductionCommandActionAuthorized(input: {
  readonly actionSource: ActionSource;
  readonly requestedIntent: RequestedIntent;
}): boolean {
  return input.requestedIntent === "write_next"
    && (input.actionSource === "button" || input.actionSource === "slash" || input.actionSource === "quick-action");
}

type ProductionIntentInput = Pick<
  ProductionCommand,
  "schemaVersion" | "capability" | "source" | "binding" | "authorization" | "args" | "activatedSkills" | "disabledSkills"
>;

/** Pre-stability V2 digest retained only so already-persisted commands remain readable. */
function legacyProductionIntentDigest(input: ProductionIntentInput): string {
  const { workOrderId: _workOrderId, ...stableBinding } = input.binding;
  const authorization = "source" in input.authorization
    ? {
        source: input.authorization.source,
        actionSource: input.authorization.actionSource,
        requestedIntent: input.authorization.requestedIntent,
        ownerDirectionTextSha256: input.authorization.ownerDirection.textSha256,
      }
    : input.authorization;
  return hashCanonicalJson({
    capability: input.capability,
    source: input.source,
    binding: stableBinding,
    authorization,
    args: input.args,
    activatedSkills: [...input.activatedSkills],
    ...(input.disabledSkills ? { disabledSkills: [...input.disabledSkills] } : {}),
  });
}

/**
 * Semantic idempotency digest. V2 deliberately excludes the random detached
 * payload lease transport while retaining the owner receipt and exact text
 * hash. Command self-hashes still bind every lease byte; only retry identity is
 * transport-independent.
 */
export function productionIntentDigest(input: ProductionIntentInput): string {
  if (input.schemaVersion === "production-command/v1") {
    return legacyProductionIntentDigest(input);
  }
  const { workOrderId: _workOrderId, ...stableBinding } = input.binding;
  const { ownerDirection, ...authorizationEvidence } = input.authorization;
  return hashCanonicalJson({
    capability: input.capability,
    source: input.source,
    binding: stableBinding,
    authorization: {
      ...authorizationEvidence,
      ownerDirection: {
        source: ownerDirection.source,
        receiptId: ownerDirection.receiptId,
        textSha256: ownerDirection.textSha256,
      },
    },
    args: input.args,
    activatedSkills: [...input.activatedSkills],
    ...(input.disabledSkills ? { disabledSkills: [...input.disabledSkills] } : {}),
  });
}

export function createWriteNextProductionCommand(input: {
  readonly idempotencyKey: string;
  readonly source: ProductionCommandSource;
  readonly actionSource: ActionSource;
  readonly binding: ProductionCommandBinding;
  readonly ownerDirection: OwnerDirectionReference;
  readonly targetLength?: ProductionTargetLength;
  readonly activatedSkills?: ReadonlyArray<string>;
  readonly disabledSkills?: ReadonlyArray<string>;
  readonly commandId?: string;
  readonly now?: Date;
}): ProductionCommand {
  if (!isProductionCommandActionAuthorized({ actionSource: input.actionSource, requestedIntent: "write_next" })) {
    throw new Error("write-next production requires button, slash, or quick-action authorization; free text is proposal-only.");
  }
  const unsignedWithoutIntent = {
    schemaVersion: "production-command/v1" as const,
    commandId: input.commandId ?? randomUUID(),
    idempotencyKey: input.idempotencyKey,
    capability: "write-next-chapter" as const,
    source: input.source,
    binding: ProductionCommandBindingSchema.parse(input.binding),
    authorization: {
      source: "confirmed-action" as const,
      actionSource: input.actionSource,
      requestedIntent: "write_next" as const,
      ownerDirection: OwnerDirectionReferenceSchema.parse(input.ownerDirection),
    },
    args: {
      chapterCount: 1 as const,
      ...(input.targetLength ? { targetLength: ProductionTargetLengthSchema.parse(input.targetLength) } : {}),
      ownerDirectionTextSha256: input.ownerDirection.textSha256,
    },
    activatedSkills: [...new Set(input.activatedSkills ?? [])].sort(),
    ...(input.disabledSkills && input.disabledSkills.length > 0
      ? { disabledSkills: [...new Set(input.disabledSkills)].sort() }
      : {}),
    issuedAt: (input.now ?? new Date()).toISOString(),
  };
  const intentDigest = productionIntentDigest(unsignedWithoutIntent);
  const unsigned = ProductionCommandV1UnsignedSchema.parse({ ...unsignedWithoutIntent, intentDigest });
  return ProductionCommandV1Schema.parse({
    ...unsigned,
    commandSelfHash: hashCanonicalJson(unsigned),
  });
}

export function createWriteNextProductionCommandV2(input: {
  readonly idempotencyKey: string;
  readonly source: ProductionCommandSource;
  readonly binding: ProductionCommandBinding;
  readonly ownerDirection: OwnerDirectionReference;
  readonly authorization: ProductionAuthorizationEvidenceV2;
  readonly targetLength?: ProductionTargetLength;
  readonly taskGuidance?: TaskGuidanceReference;
  readonly activatedSkills?: ReadonlyArray<string>;
  readonly disabledSkills?: ReadonlyArray<string>;
  readonly commandId?: string;
  readonly now?: Date;
}): ProductionCommandV2 {
  const args = ProductionCommandArgsV2Schema.parse({
    chapterCount: 1,
    ...(input.targetLength ? { targetLength: ProductionTargetLengthSchema.parse(input.targetLength) } : {}),
    ownerDirectionTextSha256: input.ownerDirection.textSha256,
    ...(input.taskGuidance ? { taskGuidance: TaskGuidanceReferenceSchema.parse(input.taskGuidance) } : {}),
  });
  const authorization = ProductionCommandAuthorizationV2Schema.parse({
    ...input.authorization,
    requestedIntent: "write_next",
    actionSource: input.source === "cli" || input.source === "tui"
      ? "slash"
      : input.source === "studio" || input.source === "agent"
        ? "button"
        : "quick-action",
    ownerDirection: OwnerDirectionReferenceSchema.parse(input.ownerDirection),
    argsSha256: hashCanonicalJson(args),
  });
  const unsignedWithoutIntent = {
    schemaVersion: "production-command/v2" as const,
    commandId: input.commandId ?? randomUUID(),
    idempotencyKey: input.idempotencyKey,
    capability: "write-next-chapter" as const,
    source: input.source,
    binding: ProductionCommandBindingSchema.parse(input.binding),
    authorization,
    args,
    activatedSkills: [...new Set(input.activatedSkills ?? [])].sort(),
    ...(input.disabledSkills && input.disabledSkills.length > 0
      ? { disabledSkills: [...new Set(input.disabledSkills)].sort() }
      : {}),
    issuedAt: (input.now ?? new Date()).toISOString(),
  };
  const intentDigest = productionIntentDigest(unsignedWithoutIntent);
  const unsigned = ProductionCommandV2UnsignedSchema.parse({ ...unsignedWithoutIntent, intentDigest });
  return ProductionCommandV2Schema.parse({ ...unsigned, commandSelfHash: hashCanonicalJson(unsigned) });
}

export function productionCommandActionSource(command: ProductionCommand): ActionSource | ProductionCommandAuthorizationV2["kind"] {
  return command.schemaVersion === "production-command/v1"
    ? command.authorization.actionSource
    : command.authorization.kind;
}

/** Reparse serialized command bytes immediately before an authorized execution. */
export function parsePersistedProductionCommand(value: unknown): ProductionCommand {
  return ProductionCommandSchema.parse(value);
}
