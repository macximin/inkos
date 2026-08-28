import { createHash } from "node:crypto";
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

export const ResolvedOwnerDirectionSchema = OwnerDirectionReferenceSchema.extend({
  text: z.string().min(1),
}).strict();
export type ResolvedOwnerDirection = z.infer<typeof ResolvedOwnerDirectionSchema>;

export const ResolvedModelMediatedTaskGuidanceSchema = ModelMediatedTaskGuidanceReferenceSchema.extend({
  text: z.string().min(1),
}).strict();
export type ResolvedModelMediatedTaskGuidance = z.infer<typeof ResolvedModelMediatedTaskGuidanceSchema>;

export const ResolvedProductionDirectionContextSchema = z.object({
  ownerDirection: ResolvedOwnerDirectionSchema.optional(),
  taskGuidance: ResolvedModelMediatedTaskGuidanceSchema.optional(),
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
    throw new Error("Model-mediated task guidance bytes do not match its transcript reference.");
  }
  return parsed;
}
