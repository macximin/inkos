import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  assertNarrativeArcAllocationApproval,
  inspectNarrativeArcAllocation,
  loadNarrativeArcAllocationStore,
} from "../arc/allocation-store.js";
import { StoryRailStore } from "../arc/rail-store.js";
import { ArcStore } from "../arc/store.js";
import {
  inspectGoldRouteReceipt,
  loadGoldRouteReceiptStore,
  type GoldArtifactFreshness,
} from "../references/gold-route-receipt.js";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";
import { assertSafeBookId } from "../utils/book-id.js";
import { safeNonSymlinkChildPath } from "../utils/path-safety.js";
import {
  BookProductionBaselineInputSchema,
  BookProductionBaselineSchema,
  BookProductionBaselineStoreSchema,
  type BookProductionBaseline,
  type BookProductionBaselineInput,
  type BookProductionBaselineStore,
} from "./baseline-schema.js";

export const BOOK_PRODUCTION_BASELINE_STORE_PATH = "story/production/baselines.json";
export const BOOK_PRODUCTION_PITCH_PATH = "project_pitch.md";
export const BOOK_PRODUCTION_RULES_PATH = "story/book_rules.md";

export interface BookProductionBaselineDeps {
  readonly repositoryRoots: Readonly<Record<string, string>>;
  readonly now?: () => Date;
}

export type BookProductionBaselineFreshness = GoldArtifactFreshness | "pending";

export interface BookProductionPitchInspection {
  readonly status: GoldArtifactFreshness;
  readonly reason?: "pitch-missing" | "pitch-changed";
  readonly actualSha256?: string;
}

export interface BookProductionBookRulesInspection {
  readonly status: GoldArtifactFreshness;
  readonly reason?: "book-rules-missing" | "book-rules-changed";
  readonly actualSha256?: string;
}

export interface BookProductionStoryRailInspection {
  readonly status: GoldArtifactFreshness;
  readonly reason?: "story-rail-missing" | "story-rail-changed" | "story-rail-not-ready";
  readonly actualSha256?: string;
}

export interface BookProductionNarrativeArcInspection {
  readonly narrativeArcId: string;
  readonly allocationId: string;
  readonly status: GoldArtifactFreshness;
  readonly reason?:
    | "allocation-missing"
    | "allocation-changed"
    | "allocation-reapproved"
    | "allocation-evidence-stale"
    | "allocation-evidence-missing";
}

export interface BookProductionArcPacketInspection {
  readonly arcPacketId: string;
  readonly status: GoldArtifactFreshness;
  readonly reason?: "arc-packet-missing" | "arc-packet-changed" | "arc-packet-not-production-ready";
  readonly actualSha256?: string;
}

export interface BookProductionGoldRouteInspection {
  readonly receiptId: string;
  readonly status: GoldArtifactFreshness;
  readonly reason?: "gold-route-missing" | "gold-route-reapproved" | "gold-evidence-stale" | "gold-evidence-missing";
}

export interface BookProductionBaselineInspection {
  readonly baselineId: string;
  readonly reviewStatus: "missing" | "draft" | "approved";
  readonly status: BookProductionBaselineFreshness;
  readonly evidenceStatus: GoldArtifactFreshness;
  readonly pitch?: BookProductionPitchInspection;
  readonly bookRules?: BookProductionBookRulesInspection;
  readonly storyRail?: BookProductionStoryRailInspection;
  readonly narrativeArcs: ReadonlyArray<BookProductionNarrativeArcInspection>;
  readonly arcPackets: ReadonlyArray<BookProductionArcPacketInspection>;
  readonly goldRoutes: ReadonlyArray<BookProductionGoldRouteInspection>;
}

export async function saveBookProductionBaselineDraft(
  projectRoot: string,
  bookIdInput: string,
  inputValue: BookProductionBaselineInput,
  deps: BookProductionBaselineDeps,
): Promise<BookProductionBaseline> {
  const bookId = assertSafeBookId(bookIdInput);
  const bookDir = join(projectRoot, "books", bookId);
  await assertBookExists(bookDir, bookId);
  const input = BookProductionBaselineInputSchema.parse(inputValue);
  const current = await loadBookProductionBaselineStore(projectRoot, bookId);
  const existing = current.baselines.find((baseline) => baseline.baselineId === input.baselineId);
  if (existing?.review.status === "approved") {
    throw new Error(`Approved production baseline ${JSON.stringify(input.baselineId)} cannot be replaced.`);
  }

  const [pitch, bookRules, railPlan, allocationStore, goldStore] = await Promise.all([
    snapshotPitch(bookDir),
    snapshotBookRules(bookDir),
    new StoryRailStore(bookDir).load(),
    loadNarrativeArcAllocationStore(projectRoot, bookId),
    loadGoldRouteReceiptStore(projectRoot, bookId),
  ]);
  if (!railPlan) throw new Error("Book production baseline requires a Story Rail plan.");
  if (railPlan.bookId !== bookId) throw new Error(`Story Rail plan belongs to another Book: ${railPlan.bookId}`);
  if (railPlan.anchorRail.status !== "ready" || railPlan.arcRouteRail.status !== "ready") {
    throw new Error("Book production baseline requires ready A-Rail and B-Rail plans.");
  }

  const allocations = input.narrativeArcAllocationIds.map((allocationId) => {
    const allocation = allocationStore.allocations.find((entry) => entry.allocationId === allocationId);
    if (!allocation) throw new Error(`NarrativeArc allocation ${JSON.stringify(allocationId)} not found.`);
    return assertNarrativeArcAllocationApproval(allocation);
  });

  for (const allocation of allocations) {
    const inspection = await inspectNarrativeArcAllocation(
      projectRoot,
      bookId,
      allocation.allocationId,
      deps.repositoryRoots,
    );
    if (inspection.status !== "current") {
      throw new Error(
        `Book production baseline requires current NarrativeArc allocation ${allocation.allocationId}; `
        + `found ${inspection.status}.`,
      );
    }
  }

  const arcStore = new ArcStore(bookDir);
  const arcPacketIds = unique(allocations.flatMap((allocation) => (
    allocation.packetAssignments.map((assignment) => assignment.arcPacketId)
  )));
  const arcPackets = await Promise.all(arcPacketIds.map(async (arcPacketId) => {
    const arc = await arcStore.load(arcPacketId);
    if (arc.status === "draft") {
      throw new Error(`Book production baseline cannot include draft ArcPacket ${JSON.stringify(arc.id)}.`);
    }
    return {
      arcPacketId: arc.id,
      status: arc.status,
      updatedAt: arc.updatedAt,
      chapterNumbers: arc.chapterNumbers,
      sha256: hashCanonicalJson(arc),
    };
  }));

  const goldRouteIds = unique(allocations.flatMap((allocation) => (
    allocation.sourceGoldRoutes.map((route) => route.receiptId)
  )));
  const goldRoutes = goldRouteIds.map((receiptId) => {
    const receipt = goldStore.receipts.find((entry) => entry.receiptId === receiptId);
    if (!receipt) throw new Error(`Gold route receipt ${JSON.stringify(receiptId)} not found.`);
    return {
      receiptId,
      approvedReceiptSha256: receipt.approval.approvedReceiptSha256,
    };
  });

  const now = (deps.now?.() ?? new Date()).toISOString();
  const baseline = BookProductionBaselineSchema.parse({
    version: 1,
    baselineId: input.baselineId,
    bookId,
    pitch,
    bookRules,
    storyRail: {
      path: "story/rails/plan.json",
      updatedAt: railPlan.updatedAt,
      sha256: hashCanonicalJson(railPlan),
    },
    narrativeArcs: allocations.map((allocation) => {
      if (allocation.review.status !== "approved") throw new Error("Approved allocation normalization failed.");
      return {
        narrativeArcId: allocation.narrativeArcId,
        allocationId: allocation.allocationId,
        approvedAllocationSha256: allocation.review.approvedAllocationSha256,
      };
    }),
    arcPackets,
    goldRoutes,
    review: { status: "draft" },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  await writeBaselineStore(bookDir, current, baseline);
  return baseline;
}

export async function approveBookProductionBaseline(
  projectRoot: string,
  bookIdInput: string,
  baselineId: string,
  approvedBy: string,
  deps: BookProductionBaselineDeps,
): Promise<BookProductionBaseline> {
  const bookId = assertSafeBookId(bookIdInput);
  const bookDir = join(projectRoot, "books", bookId);
  const current = await loadBookProductionBaselineStore(projectRoot, bookId);
  const baseline = current.baselines.find((entry) => entry.baselineId === baselineId);
  if (!baseline) throw new Error(`Book production baseline ${JSON.stringify(baselineId)} not found.`);
  if (baseline.review.status !== "draft") {
    throw new Error(`Book production baseline ${JSON.stringify(baselineId)} is already approved.`);
  }
  const evidence = await inspectBookProductionBaselineEvidence(
    projectRoot,
    bookId,
    baseline,
    deps.repositoryRoots,
  );
  if (evidence.status !== "current") {
    throw new Error(`Cannot approve production baseline ${baselineId}: evidence is ${evidence.status}.`);
  }

  const now = (deps.now?.() ?? new Date()).toISOString();
  const normalized = BookProductionBaselineSchema.parse({
    ...baseline,
    updatedAt: now,
    review: {
      status: "approved",
      approvedBy,
      approvedAt: now,
      approvedBaselineSha256: "0".repeat(64),
    },
  });
  if (normalized.review.status !== "approved") throw new Error("Approved baseline normalization failed.");
  const { approvedBaselineSha256: _placeholder, ...review } = normalized.review;
  const unsigned = { ...normalized, review };
  const approved = BookProductionBaselineSchema.parse({
    ...unsigned,
    review: {
      ...review,
      approvedBaselineSha256: hashCanonicalJson(unsigned),
    },
  });
  await writeBaselineStore(bookDir, current, approved);
  return approved;
}

export async function loadBookProductionBaselineStore(
  projectRoot: string,
  bookIdInput: string,
): Promise<BookProductionBaselineStore> {
  const bookId = assertSafeBookId(bookIdInput);
  const bookDir = join(projectRoot, "books", bookId);
  await assertBookExists(bookDir, bookId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(bookDir, BOOK_PRODUCTION_BASELINE_STORE_PATH), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { version: 1, bookId, baselines: [] };
    }
    throw error;
  }
  const store = BookProductionBaselineStoreSchema.parse(parsed);
  if (store.bookId !== bookId) {
    throw new Error(`Book production baseline store belongs to another Book: ${store.bookId}`);
  }
  for (const baseline of store.baselines) {
    if (baseline.review.status === "approved") assertBookProductionBaselineApproval(baseline);
  }
  return store;
}

export function assertBookProductionBaselineApproval(
  baselineInput: BookProductionBaseline,
): BookProductionBaseline {
  const baseline = BookProductionBaselineSchema.parse(baselineInput);
  if (baseline.review.status !== "approved") {
    throw new Error(`Book production baseline is not approved: ${baseline.baselineId}`);
  }
  const { approvedBaselineSha256, ...review } = baseline.review;
  const expected = hashCanonicalJson({ ...baseline, review });
  if (approvedBaselineSha256 !== expected) {
    throw new Error(`Book production baseline approval hash mismatch: ${baseline.baselineId}`);
  }
  return baseline;
}

export async function inspectBookProductionBaseline(
  projectRoot: string,
  bookIdInput: string,
  baselineId: string,
  repositoryRoots: Readonly<Record<string, string>>,
): Promise<BookProductionBaselineInspection> {
  const bookId = assertSafeBookId(bookIdInput);
  const store = await loadBookProductionBaselineStore(projectRoot, bookId);
  const baseline = store.baselines.find((entry) => entry.baselineId === baselineId);
  if (!baseline) {
    return {
      baselineId,
      reviewStatus: "missing",
      status: "missing",
      evidenceStatus: "missing",
      narrativeArcs: [],
      arcPackets: [],
      goldRoutes: [],
    };
  }
  const evidence = await inspectBookProductionBaselineEvidence(
    projectRoot,
    bookId,
    baseline,
    repositoryRoots,
  );
  return {
    baselineId,
    reviewStatus: baseline.review.status,
    ...evidence,
    status: baseline.review.status === "draft" ? "pending" : evidence.status,
    evidenceStatus: evidence.status,
  };
}

async function inspectBookProductionBaselineEvidence(
  projectRoot: string,
  bookId: string,
  baseline: BookProductionBaseline,
  repositoryRoots: Readonly<Record<string, string>>,
): Promise<{
  readonly status: GoldArtifactFreshness;
  readonly pitch: BookProductionPitchInspection;
  readonly bookRules: BookProductionBookRulesInspection;
  readonly storyRail: BookProductionStoryRailInspection;
  readonly narrativeArcs: ReadonlyArray<BookProductionNarrativeArcInspection>;
  readonly arcPackets: ReadonlyArray<BookProductionArcPacketInspection>;
  readonly goldRoutes: ReadonlyArray<BookProductionGoldRouteInspection>;
}> {
  const bookDir = join(projectRoot, "books", bookId);
  const pitch = await inspectPitch(bookDir, baseline.pitch.sha256);
  const bookRules = await inspectBookRules(bookDir, baseline.bookRules.sha256);
  const storyRail = await inspectStoryRail(bookDir, baseline.storyRail);

  let allocationStore;
  try {
    allocationStore = await loadNarrativeArcAllocationStore(projectRoot, bookId);
  } catch {
    allocationStore = null;
  }
  const narrativeArcs = await Promise.all(baseline.narrativeArcs.map(async (snapshot) => {
    const allocation = allocationStore?.allocations.find((entry) => entry.allocationId === snapshot.allocationId);
    if (!allocation) {
      return {
        narrativeArcId: snapshot.narrativeArcId,
        allocationId: snapshot.allocationId,
        status: allocationStore ? "missing" as const : "stale" as const,
        reason: allocationStore ? "allocation-missing" as const : "allocation-changed" as const,
      };
    }
    if (allocation.review.status !== "approved") {
      return {
        narrativeArcId: snapshot.narrativeArcId,
        allocationId: snapshot.allocationId,
        status: "stale" as const,
        reason: "allocation-changed" as const,
      };
    }
    if (
      allocation.narrativeArcId !== snapshot.narrativeArcId
      || allocation.review.approvedAllocationSha256 !== snapshot.approvedAllocationSha256
    ) {
      return {
        narrativeArcId: snapshot.narrativeArcId,
        allocationId: snapshot.allocationId,
        status: "stale" as const,
        reason: "allocation-reapproved" as const,
      };
    }
    try {
      const inspected = await inspectNarrativeArcAllocation(
        projectRoot,
        bookId,
        snapshot.allocationId,
        repositoryRoots,
      );
      if (inspected.status === "stale") {
        return {
          narrativeArcId: snapshot.narrativeArcId,
          allocationId: snapshot.allocationId,
          status: "stale" as const,
          reason: "allocation-evidence-stale" as const,
        };
      }
      if (inspected.status === "missing") {
        return {
          narrativeArcId: snapshot.narrativeArcId,
          allocationId: snapshot.allocationId,
          status: "missing" as const,
          reason: "allocation-evidence-missing" as const,
        };
      }
      return {
        narrativeArcId: snapshot.narrativeArcId,
        allocationId: snapshot.allocationId,
        status: "current" as const,
      };
    } catch {
      return {
        narrativeArcId: snapshot.narrativeArcId,
        allocationId: snapshot.allocationId,
        status: "stale" as const,
        reason: "allocation-changed" as const,
      };
    }
  }));

  const arcStore = new ArcStore(bookDir);
  const arcPackets = await Promise.all(baseline.arcPackets.map(async (snapshot) => {
    let arc;
    try {
      arc = await arcStore.load(snapshot.arcPacketId);
    } catch (error) {
      const missing = String(error).includes("not found");
      return {
        arcPacketId: snapshot.arcPacketId,
        status: missing ? "missing" as const : "stale" as const,
        reason: missing ? "arc-packet-missing" as const : "arc-packet-changed" as const,
      };
    }
    const actualSha256 = hashCanonicalJson(arc);
    if (arc.status === "draft") {
      return {
        arcPacketId: snapshot.arcPacketId,
        status: "stale" as const,
        reason: "arc-packet-not-production-ready" as const,
        actualSha256,
      };
    }
    if (
      arc.bookId !== bookId
      || arc.status !== snapshot.status
      || arc.updatedAt !== snapshot.updatedAt
      || JSON.stringify(arc.chapterNumbers) !== JSON.stringify(snapshot.chapterNumbers)
      || actualSha256 !== snapshot.sha256
    ) {
      return {
        arcPacketId: snapshot.arcPacketId,
        status: "stale" as const,
        reason: "arc-packet-changed" as const,
        actualSha256,
      };
    }
    return { arcPacketId: snapshot.arcPacketId, status: "current" as const, actualSha256 };
  }));

  let goldStore;
  try {
    goldStore = await loadGoldRouteReceiptStore(projectRoot, bookId);
  } catch {
    goldStore = null;
  }
  const goldRoutes = await Promise.all(baseline.goldRoutes.map(async (snapshot) => {
    const receipt = goldStore?.receipts.find((entry) => entry.receiptId === snapshot.receiptId);
    if (!receipt) {
      return {
        receiptId: snapshot.receiptId,
        status: goldStore ? "missing" as const : "stale" as const,
        reason: goldStore ? "gold-route-missing" as const : "gold-route-reapproved" as const,
      };
    }
    if (receipt.approval.approvedReceiptSha256 !== snapshot.approvedReceiptSha256) {
      return {
        receiptId: snapshot.receiptId,
        status: "stale" as const,
        reason: "gold-route-reapproved" as const,
      };
    }
    const inspected = await inspectGoldRouteReceipt(receipt, repositoryRoots);
    if (inspected.status === "stale") {
      return {
        receiptId: snapshot.receiptId,
        status: "stale" as const,
        reason: "gold-evidence-stale" as const,
      };
    }
    if (inspected.status === "missing") {
      return {
        receiptId: snapshot.receiptId,
        status: "missing" as const,
        reason: "gold-evidence-missing" as const,
      };
    }
    return { receiptId: snapshot.receiptId, status: "current" as const };
  }));

  const statuses = [
    pitch.status,
    bookRules.status,
    storyRail.status,
    ...narrativeArcs.map((entry) => entry.status),
    ...arcPackets.map((entry) => entry.status),
    ...goldRoutes.map((entry) => entry.status),
  ];
  const status: GoldArtifactFreshness = statuses.includes("stale")
    ? "stale"
    : statuses.includes("missing")
      ? "missing"
      : "current";
  return { status, pitch, bookRules, storyRail, narrativeArcs, arcPackets, goldRoutes };
}

async function snapshotPitch(bookDir: string): Promise<{ path: "project_pitch.md"; sha256: string }> {
  const path = await safeNonSymlinkChildPath(bookDir, BOOK_PRODUCTION_PITCH_PATH);
  let content: Buffer;
  try {
    content = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      throw new Error("Book production baseline requires project_pitch.md.");
    }
    throw error;
  }
  if (content.toString("utf8").trim().length === 0) {
    throw new Error("Book production baseline requires a non-empty project_pitch.md.");
  }
  return { path: "project_pitch.md", sha256: sha256(content) };
}

async function snapshotBookRules(
  bookDir: string,
): Promise<{ path: "story/book_rules.md"; sha256: string }> {
  const path = await safeNonSymlinkChildPath(bookDir, BOOK_PRODUCTION_RULES_PATH);
  let content: Buffer;
  try {
    content = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      throw new Error("Book production baseline requires story/book_rules.md.");
    }
    throw error;
  }
  if (content.toString("utf8").trim().length === 0) {
    throw new Error("Book production baseline requires a non-empty story/book_rules.md.");
  }
  return { path: "story/book_rules.md", sha256: sha256(content) };
}

async function inspectPitch(bookDir: string, expectedSha256: string): Promise<BookProductionPitchInspection> {
  let content: Buffer;
  try {
    const path = await safeNonSymlinkChildPath(bookDir, BOOK_PRODUCTION_PITCH_PATH);
    content = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { status: "missing", reason: "pitch-missing" };
    }
    throw error;
  }
  const actualSha256 = sha256(content);
  return actualSha256 === expectedSha256
    ? { status: "current", actualSha256 }
    : { status: "stale", reason: "pitch-changed", actualSha256 };
}

async function inspectBookRules(
  bookDir: string,
  expectedSha256: string,
): Promise<BookProductionBookRulesInspection> {
  let content: Buffer;
  try {
    const path = await safeNonSymlinkChildPath(bookDir, BOOK_PRODUCTION_RULES_PATH);
    content = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { status: "missing", reason: "book-rules-missing" };
    }
    throw error;
  }
  const actualSha256 = sha256(content);
  return actualSha256 === expectedSha256
    ? { status: "current", actualSha256 }
    : { status: "stale", reason: "book-rules-changed", actualSha256 };
}

async function inspectStoryRail(
  bookDir: string,
  snapshot: BookProductionBaseline["storyRail"],
): Promise<BookProductionStoryRailInspection> {
  let plan;
  try {
    plan = await new StoryRailStore(bookDir).load();
  } catch {
    return { status: "stale", reason: "story-rail-changed" };
  }
  if (!plan) return { status: "missing", reason: "story-rail-missing" };
  const actualSha256 = hashCanonicalJson(plan);
  if (plan.anchorRail.status !== "ready" || plan.arcRouteRail.status !== "ready") {
    return { status: "stale", reason: "story-rail-not-ready", actualSha256 };
  }
  if (plan.updatedAt !== snapshot.updatedAt || actualSha256 !== snapshot.sha256) {
    return { status: "stale", reason: "story-rail-changed", actualSha256 };
  }
  return { status: "current", actualSha256 };
}

async function writeBaselineStore(
  bookDir: string,
  current: BookProductionBaselineStore,
  baseline: BookProductionBaseline,
): Promise<void> {
  const next = BookProductionBaselineStoreSchema.parse({
    version: 1,
    bookId: current.bookId,
    baselines: [
      ...current.baselines.filter((entry) => entry.baselineId !== baseline.baselineId),
      baseline,
    ],
  });
  await commitAtomicFileSet({
    rootDir: bookDir,
    writes: [{
      relativePath: BOOK_PRODUCTION_BASELINE_STORE_PATH,
      content: `${JSON.stringify(next, null, 2)}\n`,
    }],
  });
}

async function assertBookExists(bookDir: string, bookId: string): Promise<void> {
  try {
    if (!(await stat(bookDir)).isDirectory()) throw new Error(`Book not found: ${bookId}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      throw new Error(`Book not found: ${bookId}`);
    }
    throw error;
  }
}

function unique(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}

function hashCanonicalJson(value: unknown): string {
  return sha256(JSON.stringify(sortJson(value)));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
