import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ActionSourceSchema, RequestedIntentSchema, type ActionSource, type RequestedIntent } from "../interaction/action-envelope.js";
import { hashCanonicalJson } from "./fiction-content-contract.js";
import { OwnerDirectionReferenceSchema, Sha256HexSchema, type OwnerDirectionReference } from "./direction-context.js";

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
  soulBinding: z.object({
    soulId: SafeAuthorityIdSchema,
    bindingSha256: Sha256HexSchema,
  }).strict().optional(),
}).strict();
export type ProductionCommandBinding = z.infer<typeof ProductionCommandBindingSchema>;

export const ProductionTargetLengthSchema = z.object({
  count: z.number().int().min(1),
  unit: z.enum(["zh-chars", "ko-chars", "words"]),
}).strict();
export type ProductionTargetLength = z.infer<typeof ProductionTargetLengthSchema>;

const ProductionCommandAuthorizationSchema = z.object({
  source: z.literal("confirmed-action"),
  actionSource: ActionSourceSchema,
  requestedIntent: RequestedIntentSchema,
  ownerDirection: OwnerDirectionReferenceSchema,
}).strict();

const ProductionCommandArgsSchema = z.object({
  chapterCount: z.literal(1),
  targetLength: ProductionTargetLengthSchema.optional(),
  ownerDirectionTextSha256: Sha256HexSchema,
}).strict();

const ProductionCommandUnsignedSchema = z.object({
  schemaVersion: z.literal("production-command/v1"),
  commandId: z.string().uuid(),
  idempotencyKey: SafeAuthorityIdSchema,
  intentDigest: Sha256HexSchema,
  capability: z.literal("write-next-chapter"),
  source: ProductionCommandSourceSchema,
  binding: ProductionCommandBindingSchema,
  authorization: ProductionCommandAuthorizationSchema,
  args: ProductionCommandArgsSchema,
  activatedSkills: z.array(SafeAuthorityIdSchema).default([]),
  issuedAt: z.string().datetime(),
}).strict();

export const ProductionCommandSchema = ProductionCommandUnsignedSchema.extend({
  commandSelfHash: Sha256HexSchema,
}).strict().superRefine((command, ctx) => {
  if (!isProductionCommandActionAuthorized(command.authorization)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authorization"],
      message: "write-next production requires a typed confirmed action; free text is proposal-only",
    });
  }
  if (command.authorization.ownerDirection.textSha256 !== command.args.ownerDirectionTextSha256) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["args", "ownerDirectionTextSha256"],
      message: "owner direction hash does not match the decision receipt",
    });
  }
  if (new Set(command.activatedSkills).size !== command.activatedSkills.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["activatedSkills"], message: "activatedSkills must be unique" });
  }
  if ([...command.activatedSkills].sort().some((skill, index) => skill !== command.activatedSkills[index])) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["activatedSkills"], message: "activatedSkills must be sorted" });
  }
  if (command.activatedSkills.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["activatedSkills"],
      message: "production Skill activation is unavailable before the Phase-4 binding receipt",
    });
  }
  if (productionIntentDigest(command) !== command.intentDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["intentDigest"], message: "intent digest mismatch" });
  }
  const { commandSelfHash: _self, ...unsigned } = command;
  if (hashCanonicalJson(unsigned) !== command.commandSelfHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["commandSelfHash"], message: "command self hash mismatch" });
  }
});
export type ProductionCommand = z.infer<typeof ProductionCommandSchema>;

export function isProductionCommandActionAuthorized(input: {
  readonly actionSource: ActionSource;
  readonly requestedIntent: RequestedIntent;
}): boolean {
  return input.requestedIntent === "write_next"
    && (input.actionSource === "button" || input.actionSource === "slash" || input.actionSource === "quick-action");
}

export function productionIntentDigest(input: Pick<
  ProductionCommand,
  "capability" | "source" | "binding" | "authorization" | "args" | "activatedSkills"
>): string {
  const { workOrderId: _workOrderId, ...stableBinding } = input.binding;
  return hashCanonicalJson({
    capability: input.capability,
    source: input.source,
    binding: stableBinding,
    authorization: {
      source: input.authorization.source,
      actionSource: input.authorization.actionSource,
      requestedIntent: input.authorization.requestedIntent,
      ownerDirectionTextSha256: input.authorization.ownerDirection.textSha256,
    },
    args: input.args,
    activatedSkills: [...input.activatedSkills],
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
    issuedAt: (input.now ?? new Date()).toISOString(),
  };
  const intentDigest = productionIntentDigest(unsignedWithoutIntent);
  const unsigned = ProductionCommandUnsignedSchema.parse({ ...unsignedWithoutIntent, intentDigest });
  return ProductionCommandSchema.parse({
    ...unsigned,
    commandSelfHash: hashCanonicalJson(unsigned),
  });
}

/** Reparse serialized command bytes immediately before an authorized execution. */
export function parsePersistedProductionCommand(value: unknown): ProductionCommand {
  return ProductionCommandSchema.parse(value);
}
