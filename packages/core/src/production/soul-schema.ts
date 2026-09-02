import { isAbsolute, normalize, sep } from "node:path";
import { z } from "zod";
import { GenreProfileReadReceiptSchema } from "../models/genre-profile.js";
import { Sha256HexSchema } from "./direction-context.js";

const SafeIdentitySchema = z.string().trim().min(1).max(240);
const GitCommitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const SafeEvidencePathSchema = z.string().trim().min(1).superRefine((value, ctx) => {
  const normalized = normalize(value);
  if (
    isAbsolute(value)
    || value.includes("\\")
    || normalized !== value
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith(`..${sep}`)
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Soul evidence path must stay inside its repository" });
  }
});

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

export const SoulEvidenceArtifactRefSchema = z.object({
  path: SafeEvidencePathSchema,
  sha256: Sha256HexSchema,
  sizeBytes: z.number().int().positive(),
}).strict();
export type SoulEvidenceArtifactRef = z.infer<typeof SoulEvidenceArtifactRefSchema>;

export const SoulAdoptionEvidenceSchema = z.object({
  schemaVersion: z.literal("soul-adoption-evidence/v1"),
  referenceLab: z.object({
    repo: z.literal("firefly_reference_lab"),
    commit: GitCommitSchema,
    analysisProfile: SoulEvidenceArtifactRefSchema,
    managerQa: SoulEvidenceArtifactRefSchema,
    routingCatalog: SoulEvidenceArtifactRefSchema,
  }).strict(),
  writerGenreProfile: z.object({
    repo: z.literal("inkos"),
    commit: GitCommitSchema,
    receipt: GenreProfileReadReceiptSchema,
  }).strict(),
  executorSoul: z.object({
    repo: z.literal("firefly_studio"),
    commit: GitCommitSchema,
    profileRegistry: SoulEvidenceArtifactRefSchema,
    profileId: SafeIdentitySchema,
    soulSha256: Sha256HexSchema,
    configSha256: Sha256HexSchema,
  }).strict(),
  writerSoulPackage: z.object({
    repo: z.literal("inkos"),
    commit: GitCommitSchema,
    packageManifest: SoulEvidenceArtifactRefSchema,
    files: z.array(SoulEvidenceArtifactRefSchema).min(1),
    packageSha256: Sha256HexSchema,
  }).strict(),
  hqAdoption: z.object({
    repo: z.literal("firefly_studio"),
    commit: GitCommitSchema,
    decision: SoulEvidenceArtifactRefSchema,
    activeRegistry: SoulEvidenceArtifactRefSchema,
  }).strict().nullable(),
}).strict();
export type SoulAdoptionEvidence = z.infer<typeof SoulAdoptionEvidenceSchema>;

const SoulBindingDecisionReceiptBaseSchema = z.object({
  kind: z.literal("bind-soul"),
  decisionId: SafeIdentitySchema,
  actorId: SafeIdentitySchema,
  actorRole: z.literal("owner"),
  bookId: SafeIdentitySchema,
  soulId: SafeIdentitySchema,
  soulVersion: SafeIdentitySchema,
  status: SoulLifecycleSchema,
  createdAt: z.string().datetime(),
});

export const SoulBindingDecisionReceiptV1Schema = SoulBindingDecisionReceiptBaseSchema.extend({
  schemaVersion: z.literal("soul-binding-decision/v1"),
}).strict();

export const SoulBindingDecisionReceiptV2Schema = SoulBindingDecisionReceiptBaseSchema.extend({
  schemaVersion: z.literal("soul-binding-decision/v2"),
  adoptionEvidence: SoulAdoptionEvidenceSchema,
}).strict();

export const SoulBindingDecisionReceiptSchema = z.discriminatedUnion("schemaVersion", [
  SoulBindingDecisionReceiptV1Schema,
  SoulBindingDecisionReceiptV2Schema,
]);
export type SoulBindingDecisionReceipt = z.infer<typeof SoulBindingDecisionReceiptSchema>;

const BookSoulBindingBaseSchema = z.object({
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
});

const BookSoulBindingV1UnsignedSchema = BookSoulBindingBaseSchema.extend({
  schemaVersion: z.literal("book-soul-binding/v1"),
}).strict();

const BookSoulBindingV2UnsignedSchema = BookSoulBindingBaseSchema.extend({
  schemaVersion: z.literal("book-soul-binding/v2"),
  adoptionEvidence: SoulAdoptionEvidenceSchema,
  adoptionEvidenceSha256: Sha256HexSchema,
  executorSoulSha256: Sha256HexSchema,
  writerSoulPackageSha256: Sha256HexSchema,
}).strict();

export const BookSoulBindingV1Schema = BookSoulBindingV1UnsignedSchema.extend({
  bindingSha256: Sha256HexSchema,
}).strict();

export const BookSoulBindingV2Schema = BookSoulBindingV2UnsignedSchema.extend({
  bindingSha256: Sha256HexSchema,
}).strict();

export const BookSoulBindingSchema = z.discriminatedUnion("schemaVersion", [
  BookSoulBindingV1Schema,
  BookSoulBindingV2Schema,
]);
export type BookSoulBinding = z.infer<typeof BookSoulBindingSchema>;
export type BookSoulBindingUnsigned =
  | z.infer<typeof BookSoulBindingV1UnsignedSchema>
  | z.infer<typeof BookSoulBindingV2UnsignedSchema>;

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
