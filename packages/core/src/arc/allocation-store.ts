import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  NarrativeArcAllocationInputSchema,
  NarrativeArcAllocationSchema,
  NarrativeArcAllocationStoreSchema,
  type NarrativeArcAllocation,
  type NarrativeArcAllocationInput,
  type NarrativeArcAllocationStore,
} from "./allocation-schema.js";
import { ArcStore } from "./store.js";
import { StoryRailStore } from "./rail-store.js";
import {
  inspectGoldRouteReceipt,
  loadGoldRouteReceiptStore,
  type GoldArtifactFreshness,
  type GoldRouteReceipt,
} from "../references/gold-route-receipt.js";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";
import { assertSafeBookId } from "../utils/book-id.js";

export const NARRATIVE_ARC_ALLOCATION_STORE_PATH = "story/narrative_arcs/allocations.json";

export interface NarrativeArcAllocationDeps {
  readonly now?: () => Date;
}

export interface ApproveNarrativeArcAllocationDeps extends NarrativeArcAllocationDeps {
  readonly repositoryRoots: Readonly<Record<string, string>>;
}

export type NarrativeArcAllocationFreshness = GoldArtifactFreshness | "pending";

export interface NarrativeArcPacketEvidenceInspection {
  readonly arcPacketId: string;
  readonly bRailEntryId: string;
  readonly status: GoldArtifactFreshness;
  readonly reason?:
    | "arc-packet-missing"
    | "arc-packet-changed"
    | "story-rail-missing"
    | "b-rail-entry-missing"
    | "b-rail-entry-changed";
}

export interface NarrativeArcGoldRouteInspection {
  readonly receiptId: string;
  readonly status: GoldArtifactFreshness;
  readonly reason?: "gold-route-missing" | "gold-route-reapproved" | "gold-evidence-stale" | "gold-evidence-missing";
}

export interface NarrativeArcAllocationInspection {
  readonly allocationId: string;
  readonly reviewStatus: "draft" | "approved";
  readonly status: NarrativeArcAllocationFreshness;
  readonly evidenceStatus: GoldArtifactFreshness;
  readonly packetEvidence: ReadonlyArray<NarrativeArcPacketEvidenceInspection>;
  readonly goldRouteEvidence: ReadonlyArray<NarrativeArcGoldRouteInspection>;
}

export async function saveNarrativeArcAllocationDraft(
  projectRoot: string,
  bookIdInput: string,
  inputValue: NarrativeArcAllocationInput,
  deps: NarrativeArcAllocationDeps = {},
): Promise<NarrativeArcAllocation> {
  const bookId = assertSafeBookId(bookIdInput);
  const bookDir = join(projectRoot, "books", bookId);
  await assertBookExists(bookDir, bookId);
  const input = NarrativeArcAllocationInputSchema.parse(inputValue);
  const current = await loadNarrativeArcAllocationStore(projectRoot, bookId);
  const existing = current.allocations.find((allocation) => allocation.allocationId === input.allocationId);
  const now = (deps.now?.() ?? new Date()).toISOString();
  const [goldStore, railPlan] = await Promise.all([
    loadGoldRouteReceiptStore(projectRoot, bookId),
    new StoryRailStore(bookDir).load(),
  ]);
  if (!railPlan) throw new Error("NarrativeArc allocation requires a Story Rail plan.");
  if (railPlan.bookId !== bookId) {
    throw new Error(`Story Rail plan belongs to another Book: ${railPlan.bookId}`);
  }

  const sourceReceipts = resolveSourceGoldReceipts(
    input.sourceGoldRouteReceiptIds,
    goldStore.receipts,
    input.narrativeArcId,
  );
  assertExactGoldObligationCoverage(sourceReceipts, input.obligations);

  const arcStore = new ArcStore(bookDir);
  const packetAssignments = await Promise.all(input.packetAssignments.map(async (assignment, routeOrder) => {
    const arc = await arcStore.load(assignment.arcPacketId);
    if (arc.bookId !== bookId) {
      throw new Error(`ArcPacket ${JSON.stringify(arc.id)} belongs to another Book: ${arc.bookId}`);
    }
    const bEntry = railPlan.arcRouteRail.entries.find((entry) => entry.bId === assignment.bRailEntryId);
    if (!bEntry) throw new Error(`B-Rail entry ${JSON.stringify(assignment.bRailEntryId)} not found.`);
    if (bEntry.status === "retired") {
      throw new Error(`B-Rail entry ${JSON.stringify(bEntry.bId)} is retired.`);
    }
    if (bEntry.arcId !== arc.id) {
      throw new Error(
        `B-Rail entry ${JSON.stringify(bEntry.bId)} is not bound to ArcPacket ${JSON.stringify(arc.id)}.`,
      );
    }
    return {
      ...assignment,
      routeOrder,
      chapterNumbers: arc.chapterNumbers,
      arcPacketUpdatedAt: arc.updatedAt,
      arcPacketSha256: hashCanonicalJson(arc),
      bRailEntrySha256: hashCanonicalJson(bEntry),
    };
  }));

  for (let index = 1; index < packetAssignments.length; index += 1) {
    const previousB = railPlan.arcRouteRail.entries.find(
      (entry) => entry.bId === packetAssignments[index - 1]!.bRailEntryId,
    )!;
    const currentB = railPlan.arcRouteRail.entries.find(
      (entry) => entry.bId === packetAssignments[index]!.bRailEntryId,
    )!;
    if (currentB.routeOrder <= previousB.routeOrder) {
      throw new Error("NarrativeArc ArcPackets must follow increasing B-Rail route order.");
    }
  }

  const allocation = NarrativeArcAllocationSchema.parse({
    version: 1,
    allocationId: input.allocationId,
    bookId,
    narrativeArcId: input.narrativeArcId,
    title: input.title,
    entryState: input.entryState,
    exitState: input.exitState,
    irreversibleChange: input.irreversibleChange,
    sourceGoldRoutes: sourceReceipts.map((receipt) => ({
      receiptId: receipt.receiptId,
      approvedReceiptSha256: receipt.approval.approvedReceiptSha256,
    })),
    packetAssignments,
    obligations: input.obligations,
    review: { status: "draft" },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  await writeAllocationStore(bookDir, current, allocation);
  return allocation;
}

export async function approveNarrativeArcAllocation(
  projectRoot: string,
  bookIdInput: string,
  allocationId: string,
  approvedBy: string,
  deps: ApproveNarrativeArcAllocationDeps,
): Promise<NarrativeArcAllocation> {
  const bookId = assertSafeBookId(bookIdInput);
  const bookDir = join(projectRoot, "books", bookId);
  const current = await loadNarrativeArcAllocationStore(projectRoot, bookId);
  const allocation = current.allocations.find((entry) => entry.allocationId === allocationId);
  if (!allocation) throw new Error(`NarrativeArc allocation ${JSON.stringify(allocationId)} not found.`);
  if (allocation.review.status !== "draft") {
    throw new Error(`NarrativeArc allocation ${JSON.stringify(allocationId)} is already approved.`);
  }
  const evidence = await inspectNarrativeArcAllocationEvidence(
    projectRoot,
    bookId,
    allocation,
    deps.repositoryRoots,
  );
  if (evidence.status !== "current") {
    throw new Error(
      `Cannot approve NarrativeArc allocation ${allocation.allocationId}: evidence is ${evidence.status}.`,
    );
  }
  const now = (deps.now?.() ?? new Date()).toISOString();
  const normalized = NarrativeArcAllocationSchema.parse({
    ...allocation,
    updatedAt: now,
    review: {
      status: "approved",
      approvedBy,
      approvedAt: now,
      approvedAllocationSha256: "0".repeat(64),
    },
  });
  if (normalized.review.status !== "approved") throw new Error("Approved allocation normalization failed.");
  const { approvedAllocationSha256: _placeholder, ...review } = normalized.review;
  const unsigned = { ...normalized, review };
  const approved = NarrativeArcAllocationSchema.parse({
    ...unsigned,
    review: {
      ...review,
      approvedAllocationSha256: hashCanonicalJson(unsigned),
    },
  });
  await writeAllocationStore(bookDir, current, approved);
  return approved;
}

export async function loadNarrativeArcAllocationStore(
  projectRoot: string,
  bookIdInput: string,
): Promise<NarrativeArcAllocationStore> {
  const bookId = assertSafeBookId(bookIdInput);
  const bookDir = join(projectRoot, "books", bookId);
  await assertBookExists(bookDir, bookId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(bookDir, NARRATIVE_ARC_ALLOCATION_STORE_PATH), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { version: 1, bookId, allocations: [] };
    }
    throw error;
  }
  const store = NarrativeArcAllocationStoreSchema.parse(parsed);
  if (store.bookId !== bookId) {
    throw new Error(`NarrativeArc allocation store belongs to another Book: ${store.bookId}`);
  }
  for (const allocation of store.allocations) {
    if (allocation.review.status === "approved") assertNarrativeArcAllocationApproval(allocation);
  }
  return store;
}

export function assertNarrativeArcAllocationApproval(
  allocationInput: NarrativeArcAllocation,
): NarrativeArcAllocation {
  const allocation = NarrativeArcAllocationSchema.parse(allocationInput);
  if (allocation.review.status !== "approved") {
    throw new Error(`NarrativeArc allocation is not approved: ${allocation.allocationId}`);
  }
  const { approvedAllocationSha256, ...review } = allocation.review;
  const expected = hashCanonicalJson({ ...allocation, review });
  if (approvedAllocationSha256 !== expected) {
    throw new Error(`NarrativeArc allocation approval hash mismatch: ${allocation.allocationId}`);
  }
  return allocation;
}

export async function inspectNarrativeArcAllocation(
  projectRoot: string,
  bookIdInput: string,
  allocationId: string,
  repositoryRoots: Readonly<Record<string, string>>,
): Promise<NarrativeArcAllocationInspection> {
  const bookId = assertSafeBookId(bookIdInput);
  const store = await loadNarrativeArcAllocationStore(projectRoot, bookId);
  const allocation = store.allocations.find((entry) => entry.allocationId === allocationId);
  if (!allocation) throw new Error(`NarrativeArc allocation ${JSON.stringify(allocationId)} not found.`);
  const evidence = await inspectNarrativeArcAllocationEvidence(
    projectRoot,
    bookId,
    allocation,
    repositoryRoots,
  );
  return {
    allocationId,
    reviewStatus: allocation.review.status,
    status: allocation.review.status === "draft" ? "pending" : evidence.status,
    evidenceStatus: evidence.status,
    packetEvidence: evidence.packetEvidence,
    goldRouteEvidence: evidence.goldRouteEvidence,
  };
}

async function inspectNarrativeArcAllocationEvidence(
  projectRoot: string,
  bookId: string,
  allocation: NarrativeArcAllocation,
  repositoryRoots: Readonly<Record<string, string>>,
): Promise<{
  readonly status: GoldArtifactFreshness;
  readonly packetEvidence: ReadonlyArray<NarrativeArcPacketEvidenceInspection>;
  readonly goldRouteEvidence: ReadonlyArray<NarrativeArcGoldRouteInspection>;
}> {
  const bookDir = join(projectRoot, "books", bookId);
  const arcStore = new ArcStore(bookDir);
  const [railPlan, goldStore] = await Promise.all([
    new StoryRailStore(bookDir).load(),
    loadGoldRouteReceiptStore(projectRoot, bookId),
  ]);
  const packetEvidence = await Promise.all(allocation.packetAssignments.map(async (assignment) => {
    let arc;
    try {
      arc = await arcStore.load(assignment.arcPacketId);
    } catch (error) {
      if (String(error).includes("not found")) {
        return {
          arcPacketId: assignment.arcPacketId,
          bRailEntryId: assignment.bRailEntryId,
          status: "missing" as const,
          reason: "arc-packet-missing" as const,
        };
      }
      throw error;
    }
    if (
      arc.bookId !== bookId
      || arc.updatedAt !== assignment.arcPacketUpdatedAt
      || hashCanonicalJson(arc) !== assignment.arcPacketSha256
      || JSON.stringify(arc.chapterNumbers) !== JSON.stringify(assignment.chapterNumbers)
    ) {
      return {
        arcPacketId: assignment.arcPacketId,
        bRailEntryId: assignment.bRailEntryId,
        status: "stale" as const,
        reason: "arc-packet-changed" as const,
      };
    }
    if (!railPlan) {
      return {
        arcPacketId: assignment.arcPacketId,
        bRailEntryId: assignment.bRailEntryId,
        status: "missing" as const,
        reason: "story-rail-missing" as const,
      };
    }
    const bEntry = railPlan.arcRouteRail.entries.find((entry) => entry.bId === assignment.bRailEntryId);
    if (!bEntry) {
      return {
        arcPacketId: assignment.arcPacketId,
        bRailEntryId: assignment.bRailEntryId,
        status: "missing" as const,
        reason: "b-rail-entry-missing" as const,
      };
    }
    if (bEntry.arcId !== arc.id || hashCanonicalJson(bEntry) !== assignment.bRailEntrySha256) {
      return {
        arcPacketId: assignment.arcPacketId,
        bRailEntryId: assignment.bRailEntryId,
        status: "stale" as const,
        reason: "b-rail-entry-changed" as const,
      };
    }
    return {
      arcPacketId: assignment.arcPacketId,
      bRailEntryId: assignment.bRailEntryId,
      status: "current" as const,
    };
  }));

  const goldRouteEvidence = await Promise.all(allocation.sourceGoldRoutes.map(async (snapshot) => {
    const current = goldStore.receipts.find((receipt) => receipt.receiptId === snapshot.receiptId);
    if (!current) {
      return { receiptId: snapshot.receiptId, status: "missing" as const, reason: "gold-route-missing" as const };
    }
    if (current.approval.approvedReceiptSha256 !== snapshot.approvedReceiptSha256) {
      return { receiptId: snapshot.receiptId, status: "stale" as const, reason: "gold-route-reapproved" as const };
    }
    const inspected = await inspectGoldRouteReceipt(current, repositoryRoots);
    if (inspected.status === "stale") {
      return { receiptId: snapshot.receiptId, status: "stale" as const, reason: "gold-evidence-stale" as const };
    }
    if (inspected.status === "missing") {
      return { receiptId: snapshot.receiptId, status: "missing" as const, reason: "gold-evidence-missing" as const };
    }
    return { receiptId: snapshot.receiptId, status: "current" as const };
  }));

  const statuses = [
    ...packetEvidence.map((entry) => entry.status),
    ...goldRouteEvidence.map((entry) => entry.status),
  ];
  const status: GoldArtifactFreshness = statuses.includes("stale")
    ? "stale"
    : statuses.includes("missing")
      ? "missing"
      : "current";
  return { status, packetEvidence, goldRouteEvidence };
}

function resolveSourceGoldReceipts(
  receiptIds: ReadonlyArray<string>,
  receipts: ReadonlyArray<GoldRouteReceipt>,
  narrativeArcId: string,
): GoldRouteReceipt[] {
  return receiptIds.map((receiptId) => {
    const receipt = receipts.find((entry) => entry.receiptId === receiptId);
    if (!receipt) throw new Error(`Gold route receipt ${JSON.stringify(receiptId)} not found.`);
    if (!receipt.targets.some((target) => target.kind === "narrative-arc" && target.id === narrativeArcId)) {
      throw new Error(
        `Gold route receipt ${JSON.stringify(receiptId)} does not target NarrativeArc ${JSON.stringify(narrativeArcId)}.`,
      );
    }
    return receipt;
  });
}

function assertExactGoldObligationCoverage(
  sourceReceipts: ReadonlyArray<GoldRouteReceipt>,
  obligations: NarrativeArcAllocationInput["obligations"],
): void {
  const expected = new Set(sourceReceipts.flatMap((receipt) => receipt.selectedSources.map(
    (source) => `${receipt.receiptId}\0${source.kind}\0${source.id}`,
  )));
  const counts = new Map<string, number>();
  for (const obligation of obligations) {
    const key = `${obligation.sourceReceiptId}\0${obligation.sourceKind}\0${obligation.sourceId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const missing = [...expected].filter((key) => !counts.has(key));
  const unexpected = [...counts].filter(([key, count]) => !expected.has(key) || count !== 1);
  if (missing.length > 0 || unexpected.length > 0 || counts.size !== expected.size) {
    throw new Error(
      "NarrativeArc allocation must account exactly once for every selected source in its Gold route receipts.",
    );
  }
}

async function writeAllocationStore(
  bookDir: string,
  current: NarrativeArcAllocationStore,
  allocation: NarrativeArcAllocation,
): Promise<void> {
  const next = NarrativeArcAllocationStoreSchema.parse({
    version: 1,
    bookId: current.bookId,
    allocations: [
      ...current.allocations.filter((entry) => entry.allocationId !== allocation.allocationId),
      allocation,
    ],
  });
  await commitAtomicFileSet({
    rootDir: bookDir,
    writes: [{
      relativePath: NARRATIVE_ARC_ALLOCATION_STORE_PATH,
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

function hashCanonicalJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex");
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
