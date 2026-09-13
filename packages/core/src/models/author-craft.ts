import { z } from "zod";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/);
export const AuthorCraftStageSchema = z.enum(["planning", "writing", "revision"]);
export type AuthorCraftStage = z.infer<typeof AuthorCraftStageSchema>;

export const AuthorCraftCaseSchema = z.object({
  id: Id,
  title: z.string().min(1).max(160),
  stages: z.array(AuthorCraftStageSchema).min(1).max(3),
  functions: z.array(z.string().min(1).max(64)).min(1).max(12),
  triggers: z.array(z.string().min(1).max(100)).min(1).max(20),
  observation: z.string().min(1).max(1600),
  method: z.string().min(1).max(1600),
  preserve: z.array(z.string().min(1).max(400)).max(8),
  counterexamples: z.array(z.string().min(1).max(400)).min(1).max(8),
  sourceIds: z.array(Id).min(1).max(12),
}).strict();
export type AuthorCraftCase = z.infer<typeof AuthorCraftCaseSchema>;

export const AuthorCraftPackSchema = z.object({
  schemaVersion: z.literal("author-craft-pack/v1"),
  id: Id,
  language: z.enum(["ko", "en", "zh"]),
  authority: z.literal("advisory"),
  sources: z.array(z.object({
    id: Id,
    title: z.string().min(1).max(200),
    reference: z.string().min(1).max(1000),
    sha256: Sha256.optional(),
    readingScope: z.string().min(1).max(1000),
    kind: z.enum(["manuscript-analysis", "author-interview", "craft-reference", "research-summary"]),
  }).strict()).min(1).max(100),
  cases: z.array(AuthorCraftCaseSchema).min(1).max(100),
}).strict().superRefine((pack, ctx) => {
  const sources = new Set(pack.sources.map((source) => source.id));
  if (sources.size !== pack.sources.length) ctx.addIssue({ code: "custom", path: ["sources"], message: "Duplicate source ID" });
  if (new Set(pack.cases.map((entry) => entry.id)).size !== pack.cases.length) ctx.addIssue({ code: "custom", path: ["cases"], message: "Duplicate case ID" });
  pack.cases.forEach((entry, index) => {
    if (entry.sourceIds.some((id) => !sources.has(id))) ctx.addIssue({ code: "custom", path: ["cases", index, "sourceIds"], message: "Unknown source ID" });
    if (new Set(entry.stages).size !== entry.stages.length) ctx.addIssue({ code: "custom", path: ["cases", index, "stages"], message: "Duplicate stage" });
  });
});
export type AuthorCraftPack = z.infer<typeof AuthorCraftPackSchema>;

/** Content-addressed, explicitly selected per Book. No implicit global enable. */
export const AuthorCraftConfigSchema = z.object({
  packSha256: Sha256,
  caseIds: z.array(Id).max(20).optional(),
  maxCases: z.number().int().min(1).max(6).default(3),
  maxCharacters: z.number().int().min(800).max(12000).default(6000),
}).strict().superRefine((config, ctx) => {
  if (config.caseIds && new Set(config.caseIds).size !== config.caseIds.length) ctx.addIssue({ code: "custom", path: ["caseIds"], message: "Duplicate selected case ID" });
});
export type AuthorCraftConfig = z.infer<typeof AuthorCraftConfigSchema>;

export const AuthorCraftPackReceiptSchema = z.object({
  packId: Id,
  packSha256: Sha256,
  language: z.enum(["ko", "en", "zh"]),
  selectionSha256: Sha256,
}).strict();
export type AuthorCraftPackReceipt = z.infer<typeof AuthorCraftPackReceiptSchema>;

export const AuthorCraftContextReceiptSchema = AuthorCraftPackReceiptSchema.extend({
  stage: AuthorCraftStageSchema,
  selectedCaseIds: z.array(Id).max(6),
  sourceIds: z.array(Id).max(100),
  characters: z.number().int().min(0).max(12000),
  renderedSha256: Sha256,
  omittedCaseIds: z.array(Id).max(100),
  querySha256: Sha256,
  estimatedTokens: z.number().int().min(0),
  selectionReasons: z.array(z.object({ caseId: Id, score: z.number().int().min(0), reason: z.enum(["explicit", "query-match"]) }).strict()).max(6),
  tokenBudget: z.number().int().min(0).optional(),
}).strict();
export type AuthorCraftContextReceipt = z.infer<typeof AuthorCraftContextReceiptSchema>;

export interface AuthorCraftContext {
  readonly rendered: string;
  readonly receipt: AuthorCraftContextReceipt;
}
