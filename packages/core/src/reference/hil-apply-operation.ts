import { randomUUID } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { hashCanonicalJson } from "../production/fiction-content-contract.js";
import {
  ProductionAttemptIdentitySchema,
  type ProductionAttemptIdentity,
} from "../production/attempt-identity.js";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const ReferenceHilDecisionReceiptSchema = z.object({
  schemaVersion: z.literal("reference-hil-decision/v1"),
  decisionId: z.string().uuid(),
  actorId: z.string().min(1),
  actorRole: z.enum(["owner", "reviewer"]),
  interface: z.enum(["studio", "cli", "storyyard"]),
  bookId: z.string().min(1),
  chapterNumber: z.number().int().positive(),
  candidateId: z.string().min(1),
  action: z.literal("approve"),
  currentContentSha256: Sha256Schema,
  candidateContentSha256: Sha256Schema,
  confirmedAt: z.string().datetime(),
  receiptSelfHash: Sha256Schema,
}).strict().superRefine((receipt, ctx) => {
  const { receiptSelfHash: _self, ...unsigned } = receipt;
  if (hashCanonicalJson(unsigned) !== receipt.receiptSelfHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["receiptSelfHash"], message: "decision receipt self hash mismatch" });
  }
});
export type ReferenceHilDecisionReceipt = z.infer<typeof ReferenceHilDecisionReceiptSchema>;

export function createReferenceHilDecisionReceipt(input: {
  readonly actorId: string;
  readonly actorRole?: "owner" | "reviewer";
  readonly interface: "studio" | "cli" | "storyyard";
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly candidateId: string;
  readonly currentContentSha256: string;
  readonly candidateContentSha256: string;
  readonly decisionId?: string;
  readonly now?: () => Date;
}): ReferenceHilDecisionReceipt {
  const unsigned = {
    schemaVersion: "reference-hil-decision/v1" as const,
    decisionId: input.decisionId ?? randomUUID(),
    actorId: input.actorId,
    actorRole: input.actorRole ?? "owner" as const,
    interface: input.interface,
    bookId: input.bookId,
    chapterNumber: input.chapterNumber,
    candidateId: input.candidateId,
    action: "approve" as const,
    currentContentSha256: input.currentContentSha256,
    candidateContentSha256: input.candidateContentSha256,
    confirmedAt: (input.now ?? (() => new Date()))().toISOString(),
  };
  return ReferenceHilDecisionReceiptSchema.parse({
    ...unsigned,
    receiptSelfHash: hashCanonicalJson(unsigned),
  });
}

export const ReferenceHilApplyStateSchema = z.enum([
  "applied-needs-resync",
  "applied-needs-audit",
  "ready",
  "needs-attention",
]);
export type ReferenceHilApplyState = z.infer<typeof ReferenceHilApplyStateSchema>;

export const ReferenceHilApplyTransitionSchema = z.object({
  schemaVersion: z.literal("reference-hil-apply-transition/v1"),
  transitionId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  bookId: z.string().min(1),
  chapterNumber: z.number().int().positive(),
  candidateId: z.string().min(1),
  productionOperationId: z.string().uuid(),
  attemptId: z.string().uuid(),
  decisionId: z.string().uuid(),
  state: ReferenceHilApplyStateSchema,
  phase: z.enum(["apply", "resync", "audit", "complete"]),
  errorSha256: Sha256Schema.nullable(),
  createdAt: z.string().datetime(),
  receiptSelfHash: Sha256Schema,
}).strict().superRefine((transition, ctx) => {
  if ((transition.state === "needs-attention") !== (transition.errorSha256 !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["errorSha256"], message: "needs-attention requires an error hash" });
  }
  const { receiptSelfHash: _self, ...unsigned } = transition;
  if (hashCanonicalJson(unsigned) !== transition.receiptSelfHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["receiptSelfHash"], message: "transition self hash mismatch" });
  }
});
export type ReferenceHilApplyTransition = z.infer<typeof ReferenceHilApplyTransitionSchema>;

export function referenceHilOperationDir(productionOperationId: string): string {
  return join("story", "runtime", "reference-hil", productionOperationId);
}

export function referenceHilDecisionRelativePath(productionOperationId: string): string {
  return join(referenceHilOperationDir(productionOperationId), "decision.json");
}

export function referenceHilTransitionRelativePath(productionOperationId: string, sequence: number): string {
  return join(referenceHilOperationDir(productionOperationId), `${String(sequence).padStart(3, "0")}-transition.json`);
}

export function buildReferenceHilApplyTransition(input: {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly candidateId: string;
  readonly productionAttempt: ProductionAttemptIdentity;
  readonly decisionId: string;
  readonly sequence: number;
  readonly state: ReferenceHilApplyState;
  readonly phase: "apply" | "resync" | "audit" | "complete";
  readonly error?: unknown;
  readonly transitionId?: string;
  readonly now?: () => Date;
}): ReferenceHilApplyTransition {
  const attempt = ProductionAttemptIdentitySchema.parse(input.productionAttempt);
  const errorSha256 = input.error === undefined
    ? null
    : hashCanonicalJson({ error: input.error instanceof Error ? `${input.error.name}:${input.error.message}` : String(input.error) });
  const unsigned = {
    schemaVersion: "reference-hil-apply-transition/v1" as const,
    transitionId: input.transitionId ?? randomUUID(),
    sequence: input.sequence,
    bookId: input.bookId,
    chapterNumber: input.chapterNumber,
    candidateId: input.candidateId,
    productionOperationId: attempt.productionOperationId,
    attemptId: attempt.attemptId,
    decisionId: input.decisionId,
    state: input.state,
    phase: input.phase,
    errorSha256,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
  };
  return ReferenceHilApplyTransitionSchema.parse({ ...unsigned, receiptSelfHash: hashCanonicalJson(unsigned) });
}

export async function appendReferenceHilApplyTransition(input: {
  readonly bookDir: string;
  readonly transition: ReferenceHilApplyTransition;
}): Promise<void> {
  const transition = ReferenceHilApplyTransitionSchema.parse(input.transition);
  const path = referenceHilTransitionRelativePath(transition.productionOperationId, transition.sequence);
  await access(join(input.bookDir, path)).then(
    () => { throw new Error(`Reference HIL transition already exists: ${path}`); },
    (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; },
  );
  await commitAtomicFileSet({
    rootDir: input.bookDir,
    writes: [{ relativePath: path, content: `${JSON.stringify(transition, null, 2)}\n` }],
  });
}

export async function loadReferenceHilOperation(input: {
  readonly bookDir: string;
  readonly productionOperationId: string;
}): Promise<{
  readonly decision: ReferenceHilDecisionReceipt;
  readonly transitions: ReadonlyArray<ReferenceHilApplyTransition>;
}> {
  const dir = join(input.bookDir, referenceHilOperationDir(input.productionOperationId));
  const decision = ReferenceHilDecisionReceiptSchema.parse(JSON.parse(await readFile(join(dir, "decision.json"), "utf8")));
  const files = await readdir(dir);
  const transitions = await Promise.all(files.filter((name) => name.endsWith("-transition.json")).sort().map(async (name) =>
    ReferenceHilApplyTransitionSchema.parse(JSON.parse(await readFile(join(dir, name), "utf8")))));
  transitions.forEach((transition, sequence) => {
    if (transition.sequence !== sequence) throw new Error("Reference HIL transition history has a sequence gap.");
    if (
      transition.productionOperationId !== input.productionOperationId
      || transition.decisionId !== decision.decisionId
      || transition.bookId !== decision.bookId
      || transition.chapterNumber !== decision.chapterNumber
      || transition.candidateId !== decision.candidateId
      || (sequence > 0 && transition.attemptId !== transitions[0]?.attemptId)
    ) {
      throw new Error("Reference HIL transition history does not match its decision or production attempt.");
    }
  });
  const first = transitions[0];
  if (!first || first.sequence !== 0 || first.state !== "applied-needs-resync" || first.phase !== "apply") {
    throw new Error("Reference HIL transition history is missing its canonical apply transition.");
  }
  return { decision, transitions };
}
