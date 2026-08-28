import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { LLMMessage } from "../llm/provider.js";
import {
  GenreProfileReadReceiptSchema,
  type GenreProfileReadReceipt,
} from "../models/genre-profile.js";
import { Sha256HexSchema } from "./direction-context.js";
import { SessionSoulBindingSchema } from "./soul-schema.js";

export const ProductionInputFileReceiptSchema = z.object({
  path: z.string().min(1),
  sha256: Sha256HexSchema,
  sizeBytes: z.number().int().nonnegative(),
}).strict();
export type ProductionInputFileReceipt = z.infer<typeof ProductionInputFileReceiptSchema>;

export const ProductionSkillReceiptSchema = z.object({
  id: z.string().trim().min(1).max(240),
  version: z.string().trim().min(1).max(240),
  namespace: z.enum(["trusted-builtin", "owner-overlay"]),
  manifestSha256: Sha256HexSchema,
  resources: z.array(ProductionInputFileReceiptSchema),
  inputSha256: Sha256HexSchema,
}).strict();
export type ProductionSkillReceipt = z.infer<typeof ProductionSkillReceiptSchema>;

export const ProductionSoulInputReceiptSchema = z.object({
  binding: SessionSoulBindingSchema,
  manifestSha256: Sha256HexSchema,
  resources: z.array(ProductionInputFileReceiptSchema),
  sourceRegistryReceiptSha256: Sha256HexSchema,
  inputSha256: Sha256HexSchema,
}).strict();
export type ProductionSoulInputReceipt = z.infer<typeof ProductionSoulInputReceiptSchema>;

const ProductionInputReceiptUnsignedSchema = z.object({
  schemaVersion: z.literal("production-input-receipt/v1"),
  soul: ProductionSoulInputReceiptSchema.nullable(),
  skills: z.array(ProductionSkillReceiptSchema),
  writerGenreProfile: GenreProfileReadReceiptSchema.optional(),
  externalContextSha256: Sha256HexSchema,
  promptInjectionSha256: Sha256HexSchema,
}).strict();

export const ProductionInputReceiptSchema = ProductionInputReceiptUnsignedSchema.extend({
  receiptSha256: Sha256HexSchema,
}).strict().superRefine((receipt, ctx) => {
  const ids = receipt.skills.map((skill) => skill.id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["skills"], message: "production Skill IDs must be unique" });
  }
  if ([...ids].sort().some((id, index) => id !== ids[index])) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["skills"], message: "production Skills must be sorted" });
  }
  const { receiptSha256: _self, ...unsigned } = receipt;
  if (hashCanonical(unsigned) !== receipt.receiptSha256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["receiptSha256"], message: "production input receipt self hash mismatch" });
  }
});
export type ProductionInputReceipt = z.infer<typeof ProductionInputReceiptSchema>;

export interface ProductionInputBundle {
  readonly bookId: string;
  readonly commandId: string;
  readonly productionOperationId: string;
  readonly attemptId: string;
  readonly promptInjection: string;
  readonly externalContextText: string;
  readonly receipt: ProductionInputReceipt;
}

const productionInputStorage = new AsyncLocalStorage<ProductionInputBundle>();

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

export function hashCanonical(value: unknown): string {
  return sha256Bytes(canonical(value));
}

export function createProductionInputReceipt(
  input: z.input<typeof ProductionInputReceiptUnsignedSchema>,
): ProductionInputReceipt {
  const unsigned = ProductionInputReceiptUnsignedSchema.parse(input);
  return ProductionInputReceiptSchema.parse({ ...unsigned, receiptSha256: hashCanonical(unsigned) });
}

export function runWithProductionInputBundle<T>(bundle: ProductionInputBundle, task: () => T): T {
  const parsedReceipt = ProductionInputReceiptSchema.parse(bundle.receipt);
  if (sha256Bytes(bundle.promptInjection) !== parsedReceipt.promptInjectionSha256) {
    throw new Error("Production prompt injection bytes do not match their receipt.");
  }
  if (sha256Bytes(bundle.externalContextText) !== parsedReceipt.externalContextSha256) {
    throw new Error("Production external context bytes do not match their receipt.");
  }
  return productionInputStorage.run({ ...bundle, receipt: parsedReceipt }, task);
}

export function currentProductionInputBundle(): ProductionInputBundle | undefined {
  return productionInputStorage.getStore();
}

/**
 * Bind the profile bytes actually loaded by Writer to the host-resolved
 * production receipt. Legacy non-kernel calls have no production bundle and
 * remain unchanged; every kernel call must carry the profile receipt.
 */
export function assertCurrentProductionGenreProfileReceipt(
  actual: GenreProfileReadReceipt,
): void {
  const bundle = currentProductionInputBundle();
  if (!bundle) return;
  const expected = bundle.receipt.writerGenreProfile;
  if (!expected) {
    throw new Error("Production input receipt is missing the Writer genre profile binding.");
  }
  if (hashCanonical(actual) !== hashCanonical(expected)) {
    throw new Error("Writer genre profile bytes do not match the host-resolved production receipt.");
  }
}

export function appendProductionInput(
  messages: ReadonlyArray<LLMMessage>,
  bundle: ProductionInputBundle,
): ReadonlyArray<LLMMessage> {
  if (!bundle.promptInjection) return messages;
  const firstSystem = messages.findIndex((message) => message.role === "system");
  if (firstSystem < 0) return [{ role: "system", content: bundle.promptInjection }, ...messages];
  return messages.map((message, index) => index === firstSystem
    ? { ...message, content: `${message.content}\n\n${bundle.promptInjection}` }
    : message);
}
