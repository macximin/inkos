import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const RequiredPlanningTextSchema = z.string().trim().min(6).max(2_000);

export const FireflyEntryContractSchema = z.object({
  humanDrive: z.object({
    lackOrHumiliation: RequiredPlanningTextSchema,
    personalDesire: RequiredPlanningTextSchema,
    selfInterest: RequiredPlanningTextSchema,
    emotionalCostLimit: RequiredPlanningTextSchema,
  }).strict(),
  purpose: z.object({
    seriesWhat: RequiredPlanningTextSchema,
    arcWhat: RequiredPlanningTextSchema,
    chapterWant: RequiredPlanningTextSchema,
    whyNow: RequiredPlanningTextSchema,
  }).strict(),
  commercialPromise: z.object({
    currentSituation: RequiredPlanningTextSchema,
    repeatableReaderFantasy: RequiredPlanningTextSchema,
    howAdvantage: RequiredPlanningTextSchema,
    firstPayoff: RequiredPlanningTextSchema,
    payoffWitness: RequiredPlanningTextSchema,
    nextPaymentQuestion: RequiredPlanningTextSchema,
  }).strict(),
}).strict();

export type FireflyEntryContract = z.infer<typeof FireflyEntryContractSchema>;

export const FireflyPlanningAdmissionSchema = z.object({
  schemaVersion: z.literal("firefly_planning_admission/v1"),
  bookId: z.string().min(1),
  status: z.literal("approved"),
  entryContract: FireflyEntryContractSchema,
  entryContractSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  sourceSlateId: z.string().min(1),
  sourceSlateSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  sourceReviewSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  sourceDecisionSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  approvedAt: z.string().datetime(),
}).strict();

export type FireflyPlanningAdmission = z.infer<typeof FireflyPlanningAdmissionSchema>;

export function hashEntryContract(contract: FireflyEntryContract): string {
  return createHash("sha256").update(JSON.stringify(contract)).digest("hex");
}

export async function assertApprovedFireflyPlanningAdmission(input: {
  readonly bookDir: string;
  readonly bookId: string;
}): Promise<FireflyPlanningAdmission> {
  const path = join(input.bookDir, "story", "entry-contract.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error("Firefly planning HIL is required before chapter production: story/entry-contract.json is missing.");
    }
    throw error;
  }
  let admission: FireflyPlanningAdmission;
  try {
    admission = FireflyPlanningAdmissionSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`Firefly planning HIL admission is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (admission.bookId !== input.bookId) {
    throw new Error("Firefly planning HIL admission belongs to a different Book.");
  }
  if (hashEntryContract(admission.entryContract) !== admission.entryContractSha256) {
    throw new Error("Firefly planning HIL admission entry contract hash is invalid.");
  }
  return admission;
}
