import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { ActionSourceSchema } from "../interaction/action-envelope.js";
import { ProductionAttemptIdentitySchema } from "./attempt-identity.js";
import {
  ProductionCommandBindingSchema,
  ProductionCommandSourceSchema,
} from "./production-command.js";
import { Sha256HexSchema } from "./direction-context.js";
import { ProductionInputReceiptSchema } from "./production-input.js";

export const ProductionExecutionContextSchema = z.object({
  schemaVersion: z.literal("production-execution-context/v1"),
  commandId: z.string().uuid(),
  commandSha256: Sha256HexSchema,
  productionOperationId: ProductionAttemptIdentitySchema.shape.productionOperationId,
  attemptId: ProductionAttemptIdentitySchema.shape.attemptId,
  intentDigest: Sha256HexSchema,
  capability: z.literal("write-next-chapter"),
  mode: z.literal("observe"),
  source: ProductionCommandSourceSchema,
  actionSource: ActionSourceSchema,
  binding: ProductionCommandBindingSchema,
  activatedSkills: z.array(z.string().trim().min(1).max(240)),
  productionInputs: ProductionInputReceiptSchema.optional(),
  startedAt: z.string().datetime(),
}).strict();
export type ProductionExecutionContext = z.infer<typeof ProductionExecutionContextSchema>;

const productionExecutionStorage = new AsyncLocalStorage<ProductionExecutionContext>();

/**
 * Propagate correlation only. Possessing this context never bypasses command,
 * Book binding, decision-receipt, or commit-evidence validation.
 */
export function runWithProductionExecutionContext<T>(
  context: ProductionExecutionContext,
  task: () => T,
): T {
  return productionExecutionStorage.run(ProductionExecutionContextSchema.parse(context), task);
}

export function currentProductionExecutionContext(): ProductionExecutionContext | undefined {
  return productionExecutionStorage.getStore();
}

export function requireProductionExecutionContext(): ProductionExecutionContext {
  const context = currentProductionExecutionContext();
  if (!context) throw new Error("No active ProductionExecutionContext.");
  return context;
}
