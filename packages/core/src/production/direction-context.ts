import { createHash } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";

export const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const DetachedPayloadLeaseSourceRefSchema = z.object({
  kind: z.literal("detached-payload-lease"),
  leaseId: z.string().uuid(),
  payloadSha256: Sha256HexSchema,
  byteLength: z.number().int().min(1),
  expiresAt: z.string().datetime(),
  leaseReceiptSha256: Sha256HexSchema,
}).strict();
export type DetachedPayloadLeaseSourceRef = z.infer<typeof DetachedPayloadLeaseSourceRefSchema>;

export const OwnerDirectionReferenceSchema = z.object({
  source: z.literal("owner-confirmed").default("owner-confirmed"),
  receiptId: z.string().trim().min(1).max(240),
  sourceRef: DetachedPayloadLeaseSourceRefSchema,
  textSha256: Sha256HexSchema,
}).strict();
export type OwnerDirectionReference = z.infer<typeof OwnerDirectionReferenceSchema>;

export const ModelMediatedTaskGuidanceReferenceSchema = z.object({
  source: z.literal("model-mediated"),
  transcriptRef: z.object({
    sessionId: z.string().min(1),
    requestId: z.string().min(1),
    toolCallId: z.string().min(1),
  }).strict(),
  textSha256: Sha256HexSchema,
}).strict();
export type ModelMediatedTaskGuidanceReference = z.infer<typeof ModelMediatedTaskGuidanceReferenceSchema>;

const BookLocalHermesControlPathSchema = z.string().min(1).superRefine((value, ctx) => {
  const normalized = posix.normalize(value);
  if (
    posix.isAbsolute(value)
    || value.includes("\\")
    || normalized !== value
    || normalized === ".."
    || normalized.startsWith("../")
    || !value.startsWith("story/runtime/hermes-control/")
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Hermes control action path must stay in the Book-local Hermes control root" });
  }
});

const SafeHermesControlIdSchema = z.string().trim().min(1).max(240).superRefine((value, ctx) => {
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Hermes control identity must be one safe path segment" });
  }
});

export const HermesControlTaskGuidanceReferenceSchema = z.object({
  source: z.literal("hermes-control-action"),
  bookId: SafeHermesControlIdSchema,
  workOrderId: SafeHermesControlIdSchema,
  actionRef: z.object({
    path: BookLocalHermesControlPathSchema,
    sha256: Sha256HexSchema,
    byteLength: z.number().int().positive(),
  }).strict(),
  textSha256: Sha256HexSchema,
}).strict();
export type HermesControlTaskGuidanceReference = z.infer<typeof HermesControlTaskGuidanceReferenceSchema>;

export const TaskGuidanceReferenceSchema = z.union([
  ModelMediatedTaskGuidanceReferenceSchema,
  HermesControlTaskGuidanceReferenceSchema,
]);
export type TaskGuidanceReference = z.infer<typeof TaskGuidanceReferenceSchema>;

export const ResolvedOwnerDirectionSchema = OwnerDirectionReferenceSchema.extend({
  text: z.string().min(1),
}).strict();
export type ResolvedOwnerDirection = z.infer<typeof ResolvedOwnerDirectionSchema>;

export const ResolvedModelMediatedTaskGuidanceSchema = ModelMediatedTaskGuidanceReferenceSchema.extend({
  text: z.string().min(1),
}).strict();
export type ResolvedModelMediatedTaskGuidance = z.infer<typeof ResolvedModelMediatedTaskGuidanceSchema>;

export const ResolvedHermesControlTaskGuidanceSchema = HermesControlTaskGuidanceReferenceSchema.extend({
  text: z.string().min(1),
}).strict();
export type ResolvedHermesControlTaskGuidance = z.infer<typeof ResolvedHermesControlTaskGuidanceSchema>;

export const ResolvedTaskGuidanceSchema = z.union([
  ResolvedModelMediatedTaskGuidanceSchema,
  ResolvedHermesControlTaskGuidanceSchema,
]);
export type ResolvedTaskGuidance = z.infer<typeof ResolvedTaskGuidanceSchema>;

export const ResolvedProductionDirectionContextSchema = z.object({
  ownerDirection: ResolvedOwnerDirectionSchema.optional(),
  taskGuidance: ResolvedTaskGuidanceSchema.optional(),
}).strict().refine((value) => value.ownerDirection !== undefined || value.taskGuidance !== undefined, {
  message: "Production direction context must contain ownerDirection or taskGuidance",
});
export type ResolvedProductionDirectionContext = z.infer<typeof ResolvedProductionDirectionContextSchema>;

export function directionTextSha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

export function verifyResolvedProductionDirectionContext(
  value: ResolvedProductionDirectionContext,
): ResolvedProductionDirectionContext {
  const parsed = ResolvedProductionDirectionContextSchema.parse(value);
  if (parsed.ownerDirection) {
    const actual = directionTextSha256(parsed.ownerDirection.text);
    if (
      parsed.ownerDirection.textSha256 !== actual
      || parsed.ownerDirection.sourceRef.payloadSha256 !== actual
    ) {
      throw new Error("Owner direction bytes do not match the detached payload reference.");
    }
    if (Buffer.byteLength(parsed.ownerDirection.text, "utf8") !== parsed.ownerDirection.sourceRef.byteLength) {
      throw new Error("Owner direction byte length does not match the detached payload reference.");
    }
  }
  if (
    parsed.taskGuidance
    && parsed.taskGuidance.textSha256 !== directionTextSha256(parsed.taskGuidance.text)
  ) {
    throw new Error("Task guidance bytes do not match their immutable reference.");
  }
  return parsed;
}
