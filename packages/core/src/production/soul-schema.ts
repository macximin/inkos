import { isAbsolute, normalize, sep } from "node:path";
import { z } from "zod";
import { Sha256HexSchema } from "./direction-context.js";

const SafeIdentitySchema = z.string().trim().min(1).max(240);

export const SoulLifecycleSchema = z.enum(["neutral", "candidate", "promoted"]);
export type SoulLifecycle = z.infer<typeof SoulLifecycleSchema>;

export const SoulResourceRefSchema = z.object({
  path: z.string().trim().min(1).superRefine((value, ctx) => {
    const normalized = normalize(value);
    if (
      isAbsolute(value)
      || normalized !== value
      || normalized === ".."
      || normalized.startsWith(`..${sep}`)
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Soul resource path must stay inside its package" });
    }
  }),
  sha256: Sha256HexSchema,
  sizeBytes: z.number().int().nonnegative(),
}).strict();
export type SoulResourceRef = z.infer<typeof SoulResourceRefSchema>;

export const SoulPackageManifestSchema = z.object({
  schemaVersion: z.literal("soul-package/v1"),
  soulId: SafeIdentitySchema,
  version: SafeIdentitySchema,
  promptPath: SoulResourceRefSchema.shape.path,
  resources: z.array(SoulResourceRefSchema.shape.path).default([]),
}).strict().superRefine((manifest, ctx) => {
  const paths = [manifest.promptPath, ...manifest.resources];
  if (new Set(paths).size !== paths.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["resources"], message: "Soul package paths must be unique" });
  }
  const sorted = [...manifest.resources].sort();
  if (sorted.some((path, index) => path !== manifest.resources[index])) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["resources"], message: "Soul resources must be sorted" });
  }
});
export type SoulPackageManifest = z.infer<typeof SoulPackageManifestSchema>;

export const SoulBindingDecisionReceiptSchema = z.object({
  schemaVersion: z.literal("soul-binding-decision/v1"),
  kind: z.literal("bind-soul"),
  decisionId: SafeIdentitySchema,
  actorId: SafeIdentitySchema,
  actorRole: z.literal("owner"),
  bookId: SafeIdentitySchema,
  soulId: SafeIdentitySchema,
  soulVersion: SafeIdentitySchema,
  status: SoulLifecycleSchema,
  createdAt: z.string().datetime(),
}).strict();
export type SoulBindingDecisionReceipt = z.infer<typeof SoulBindingDecisionReceiptSchema>;

const BookSoulBindingUnsignedSchema = z.object({
  schemaVersion: z.literal("book-soul-binding/v1"),
  bindingVersion: z.number().int().positive(),
  bookId: SafeIdentitySchema,
  soulId: SafeIdentitySchema,
  version: SafeIdentitySchema,
  manifestSha256: Sha256HexSchema,
  resources: z.array(SoulResourceRefSchema),
  sourceRegistryReceiptSha256: Sha256HexSchema,
  installObjectSha256: Sha256HexSchema,
  status: SoulLifecycleSchema,
  boundByDecisionReceipt: SafeIdentitySchema,
  decisionReceiptSha256: Sha256HexSchema,
  previousBindingSha256: Sha256HexSchema.nullable(),
  boundAt: z.string().datetime(),
}).strict();

export const BookSoulBindingSchema = BookSoulBindingUnsignedSchema.extend({
  bindingSha256: Sha256HexSchema,
}).strict();
export type BookSoulBinding = z.infer<typeof BookSoulBindingSchema>;
export type BookSoulBindingUnsigned = z.infer<typeof BookSoulBindingUnsignedSchema>;

const ActiveSoulPointerUnsignedSchema = z.object({
  schemaVersion: z.literal("active-soul-pointer/v1"),
  bookId: SafeIdentitySchema,
  bindingVersion: z.number().int().positive(),
  bindingPath: z.string().regex(/^story\/soul-bindings\/v\d{4,}\.json$/u),
  bindingSha256: Sha256HexSchema,
  updatedAt: z.string().datetime(),
}).strict();

export const ActiveSoulPointerSchema = ActiveSoulPointerUnsignedSchema.extend({
  pointerSha256: Sha256HexSchema,
}).strict();
export type ActiveSoulPointer = z.infer<typeof ActiveSoulPointerSchema>;
export type ActiveSoulPointerUnsigned = z.infer<typeof ActiveSoulPointerUnsignedSchema>;

export const SessionSoulBindingSchema = z.object({
  soulId: SafeIdentitySchema,
  soulVersion: SafeIdentitySchema,
  bindingSha256: Sha256HexSchema,
}).strict();
export type SessionSoulBinding = z.infer<typeof SessionSoulBindingSchema>;
