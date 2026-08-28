import { randomUUID } from "node:crypto";
import { z } from "zod";

export const ProductionAttemptIdentitySchema = z.object({
  productionOperationId: z.string().uuid(),
  attemptId: z.string().uuid(),
}).strict();

export type ProductionAttemptIdentity = z.infer<typeof ProductionAttemptIdentitySchema>;

/**
 * Create one host-owned mutation identity after the Book lock is acquired.
 * Model output must never supply either identifier.
 */
export function createProductionAttemptIdentity(
  nextId: () => string = randomUUID,
): ProductionAttemptIdentity {
  return ProductionAttemptIdentitySchema.parse({
    productionOperationId: nextId(),
    attemptId: nextId(),
  });
}

export function verifyProductionAttemptIdentity(
  value: ProductionAttemptIdentity,
): ProductionAttemptIdentity {
  return ProductionAttemptIdentitySchema.parse(value);
}
