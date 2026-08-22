import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  inspectNarrativeArcAllocation,
  loadNarrativeArcAllocationStore,
} from "../arc/allocation-store.js";
import { StoryRailStore } from "../arc/rail-store.js";
import { ArcStore } from "../arc/store.js";
import { FutureAdvantageResearchReceiptStoreSchema } from "../models/future-advantage-ledger.js";
import { listBookReferences } from "../references/book-references.js";
import {
  inspectGoldRouteReceipt,
  loadGoldRouteReceiptStore,
  type GoldArtifactFreshness,
} from "../references/gold-route-receipt.js";
import { FUTURE_ADVANTAGE_RESEARCH_RECEIPTS_PATH } from "../state/future-advantage-ledger.js";
import { StateManager } from "../state/manager.js";
import { verifyChapterTruthReceipt } from "../state/chapter-truth-receipt.js";
import { assertSafeBookId } from "../utils/book-id.js";
import { safeNonSymlinkChildPath } from "../utils/path-safety.js";
import { BOOK_PRODUCTION_PITCH_PATH, BOOK_PRODUCTION_RULES_PATH } from "./baseline-store.js";

export type BookProductionReadinessStatus = GoldArtifactFreshness | "pending";

export interface BookProductionLiveFileStatus {
  readonly path: "project_pitch.md" | "story/book_rules.md";
  readonly status: "current" | "missing";
  readonly sha256?: string;
}

export interface BookProductionReferenceStatus {
  readonly materialId: string;
  readonly status: "unverified" | "missing";
  readonly sha256?: string;
  readonly reason?: string;
}

export interface BookProductionGoldStatus {
  readonly receiptId: string;
  readonly status: GoldArtifactFreshness;
}

export interface BookProductionRailStatus {
  readonly status: BookProductionReadinessStatus;
  readonly sha256?: string;
  readonly reason?: "story-rail-missing" | "story-rail-invalid" | "story-rail-not-ready";
}

export interface BookProductionAllocationStatus {
  readonly allocationId: string;
  readonly narrativeArcId: string;
  readonly status: BookProductionReadinessStatus;
}

export interface BookProductionPacketStatus {
  readonly arcPacketId: string;
  readonly status: BookProductionReadinessStatus;
  readonly sha256?: string;
  readonly reason?: "arc-packet-missing" | "arc-packet-invalid" | "arc-packet-draft";
}

export interface BookProductionChapterTruthStatus {
  readonly status: BookProductionReadinessStatus | "not-applicable";
  readonly chapterNumber?: number;
  readonly chapterStatus?: string;
  readonly receiptSha256?: string;
  readonly reason?: "chapter-not-settled" | "truth-receipt-missing" | "truth-receipt-stale";
}

export interface BookProductionOwnerLockStatus {
  readonly status: "clear" | "active" | "stale";
  readonly heartbeatAt?: string;
}

export interface BookProductionOpenIssue {
  readonly kind: "chapter-audit" | "chapter-length" | "research";
  readonly status: "pending" | "stale";
  readonly message: string;
}

export interface BookProductionReadinessReport {
  readonly version: 1;
  readonly bookId: string;
  readonly inspectedAt: string;
  readonly status: BookProductionReadinessStatus;
  readonly controlFiles: {
    readonly pitch: BookProductionLiveFileStatus;
    readonly bookRules: BookProductionLiveFileStatus;
  };
  readonly references: ReadonlyArray<BookProductionReferenceStatus>;
  readonly goldRoutes: ReadonlyArray<BookProductionGoldStatus>;
  readonly storyRail: BookProductionRailStatus;
  readonly narrativeArcs: ReadonlyArray<BookProductionAllocationStatus>;
  readonly arcPackets: ReadonlyArray<BookProductionPacketStatus>;
  readonly latestChapterTruth: BookProductionChapterTruthStatus;
  readonly ownerLock: BookProductionOwnerLockStatus;
  readonly openIssues: ReadonlyArray<BookProductionOpenIssue>;
}

export interface InspectBookProductionReadinessDeps {
  readonly repositoryRoots: Readonly<Record<string, string>>;
  readonly now?: () => Date;
}

/** Read-only live aggregation. It never approves or modifies Book content. */
export async function inspectBookProductionReadiness(
  projectRoot: string,
  bookIdInput: string,
  deps: InspectBookProductionReadinessDeps,
): Promise<BookProductionReadinessReport> {
  const bookId = assertSafeBookId(bookIdInput);
  const bookDir = join(projectRoot, "books", bookId);
  await assertBookExists(bookDir, bookId);
  const now = deps.now?.() ?? new Date();

  const [pitch, bookRules, references, goldRoutes, storyRail, allocationStore, latestChapterTruth, ownerLock, researchIssues] = await Promise.all([
    inspectLiveFile(bookDir, BOOK_PRODUCTION_PITCH_PATH, "project_pitch.md"),
    inspectLiveFile(bookDir, BOOK_PRODUCTION_RULES_PATH, "story/book_rules.md"),
    inspectReferences(projectRoot, bookId),
    inspectGoldRoutes(projectRoot, bookId, deps.repositoryRoots),
    inspectRail(bookDir),
    loadNarrativeArcAllocationStore(projectRoot, bookId),
    inspectLatestChapterTruth(projectRoot, bookId),
    inspectOwnerLock(bookDir, now),
    inspectResearchIssues(bookDir),
  ]);

  const narrativeArcs = await Promise.all(allocationStore.allocations.map(async (allocation) => {
    try {
      const inspection = await inspectNarrativeArcAllocation(
        projectRoot,
        bookId,
        allocation.allocationId,
        deps.repositoryRoots,
      );
      return {
        allocationId: allocation.allocationId,
        narrativeArcId: allocation.narrativeArcId,
        status: inspection.status,
      };
    } catch {
      return {
        allocationId: allocation.allocationId,
        narrativeArcId: allocation.narrativeArcId,
        status: "stale" as const,
      };
    }
  }));

  const packetIds = unique(allocationStore.allocations.flatMap((allocation) => (
    allocation.packetAssignments.map((assignment) => assignment.arcPacketId)
  )));
  const arcPackets = await inspectPackets(bookDir, packetIds);
  const latestChapterIssues = await inspectLatestChapterIssues(projectRoot, bookId);
  const openIssues = [...latestChapterIssues, ...researchIssues];

  const statuses: BookProductionReadinessStatus[] = [
    pitch.status,
    bookRules.status,
    storyRail.status,
    ...references.map((reference) => reference.status === "missing" ? "missing" as const : "pending" as const),
    ...goldRoutes.map((route) => route.status),
    ...(narrativeArcs.length > 0 ? narrativeArcs.map((arc) => arc.status) : ["pending" as const]),
    ...(arcPackets.length > 0 ? arcPackets.map((packet) => packet.status) : ["pending" as const]),
    ...(latestChapterTruth.status === "not-applicable" ? [] : [latestChapterTruth.status]),
    ...(ownerLock.status === "clear" ? [] : [ownerLock.status === "active" ? "pending" as const : "stale" as const]),
    ...openIssues.map((issue) => issue.status),
  ];
  const status: BookProductionReadinessStatus = statuses.includes("stale")
    ? "stale"
    : statuses.includes("missing")
      ? "missing"
      : statuses.includes("pending")
        ? "pending"
        : "current";

  return {
    version: 1,
    bookId,
    inspectedAt: now.toISOString(),
    status,
    controlFiles: { pitch, bookRules },
    references,
    goldRoutes,
    storyRail,
    narrativeArcs,
    arcPackets,
    latestChapterTruth,
    ownerLock,
    openIssues,
  };
}

async function inspectLiveFile(
  bookDir: string,
  requestedPath: string,
  path: BookProductionLiveFileStatus["path"],
): Promise<BookProductionLiveFileStatus> {
  try {
    const resolved = await safeNonSymlinkChildPath(bookDir, requestedPath);
    return { path, status: "current", sha256: sha256(await readFile(resolved)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { path, status: "missing" };
    throw error;
  }
}

async function inspectReferences(
  projectRoot: string,
  bookId: string,
): Promise<BookProductionReferenceStatus[]> {
  const list = await listBookReferences(projectRoot, bookId);
  return Promise.all(list.references.map(async (reference) => {
    if (!reference.available || !reference.asset) {
      return {
        materialId: reference.materialId,
        status: "missing" as const,
        ...(reference.error ? { reason: reference.error } : {}),
      };
    }
    try {
      const path = await safeNonSymlinkChildPath(projectRoot, reference.asset.markdownPath);
      return {
        materialId: reference.materialId,
        status: "unverified" as const,
        sha256: sha256(await readFile(path)),
        reason: "Legacy reference bindings have no approved material hash.",
      };
    } catch (error) {
      return {
        materialId: reference.materialId,
        status: "missing" as const,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}

async function inspectGoldRoutes(
  projectRoot: string,
  bookId: string,
  repositoryRoots: Readonly<Record<string, string>>,
): Promise<BookProductionGoldStatus[]> {
  const store = await loadGoldRouteReceiptStore(projectRoot, bookId);
  return Promise.all(store.receipts.map(async (receipt) => {
    const inspection = await inspectGoldRouteReceipt(receipt, repositoryRoots);
    return { receiptId: receipt.receiptId, status: inspection.status };
  }));
}

async function inspectRail(bookDir: string): Promise<BookProductionRailStatus> {
  try {
    const plan = await new StoryRailStore(bookDir).load();
    if (!plan) return { status: "missing", reason: "story-rail-missing" };
    const sha = hashCanonicalJson(plan);
    if (plan.anchorRail.status !== "ready" || plan.arcRouteRail.status !== "ready") {
      return { status: "pending", sha256: sha, reason: "story-rail-not-ready" };
    }
    return { status: "current", sha256: sha };
  } catch {
    return { status: "stale", reason: "story-rail-invalid" };
  }
}

async function inspectPackets(bookDir: string, ids: ReadonlyArray<string>): Promise<BookProductionPacketStatus[]> {
  const store = new ArcStore(bookDir);
  return Promise.all(ids.map(async (arcPacketId) => {
    try {
      const arc = await store.load(arcPacketId);
      const sha = hashCanonicalJson(arc);
      return arc.status === "draft"
        ? { arcPacketId, status: "pending" as const, sha256: sha, reason: "arc-packet-draft" as const }
        : { arcPacketId, status: "current" as const, sha256: sha };
    } catch (error) {
      const missing = String(error).includes("not found");
      return {
        arcPacketId,
        status: missing ? "missing" as const : "stale" as const,
        reason: missing ? "arc-packet-missing" as const : "arc-packet-invalid" as const,
      };
    }
  }));
}

async function inspectLatestChapterTruth(
  projectRoot: string,
  bookId: string,
): Promise<BookProductionChapterTruthStatus> {
  const state = new StateManager(projectRoot);
  const chapters = await state.loadChapterIndex(bookId);
  const latest = [...chapters].sort((left, right) => right.number - left.number)[0];
  if (!latest) return { status: "not-applicable" };
  if (latest.status !== "approved" && latest.status !== "published") {
    return {
      status: "pending",
      chapterNumber: latest.number,
      chapterStatus: latest.status,
      reason: "chapter-not-settled",
    };
  }
  try {
    const verified = await verifyChapterTruthReceipt(state.bookDir(bookId), bookId, latest);
    return {
      status: "current",
      chapterNumber: latest.number,
      chapterStatus: latest.status,
      receiptSha256: verified.receiptSha256,
    };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
    return {
      status: missing ? "missing" : "stale",
      chapterNumber: latest.number,
      chapterStatus: latest.status,
      reason: missing ? "truth-receipt-missing" : "truth-receipt-stale",
    };
  }
}

async function inspectLatestChapterIssues(
  projectRoot: string,
  bookId: string,
): Promise<BookProductionOpenIssue[]> {
  const chapters = await new StateManager(projectRoot).loadChapterIndex(bookId);
  const latest = [...chapters].sort((left, right) => right.number - left.number)[0];
  if (!latest) return [];
  return [
    ...latest.auditIssues.map((message) => ({ kind: "chapter-audit" as const, status: "pending" as const, message })),
    ...latest.lengthWarnings.map((message) => ({ kind: "chapter-length" as const, status: "pending" as const, message })),
  ];
}

async function inspectOwnerLock(bookDir: string, now: Date): Promise<BookProductionOwnerLockStatus> {
  const path = join(bookDir, ".write.lock");
  try {
    const [raw, fileStat] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    let heartbeatAt = fileStat.mtimeMs;
    try {
      const parsed = JSON.parse(raw) as { heartbeatAt?: unknown };
      if (typeof parsed.heartbeatAt === "number" && Number.isFinite(parsed.heartbeatAt)) heartbeatAt = parsed.heartbeatAt;
    } catch {
      // A malformed old lock is still reported rather than repaired by this read-only inspection.
    }
    const stale = now.getTime() - heartbeatAt > 3 * 60_000;
    return { status: stale ? "stale" : "active", heartbeatAt: new Date(heartbeatAt).toISOString() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { status: "clear" };
    throw error;
  }
}

async function inspectResearchIssues(bookDir: string): Promise<BookProductionOpenIssue[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(bookDir, FUTURE_ADVANTAGE_RESEARCH_RECEIPTS_PATH), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return [];
    return [{ kind: "research", status: "stale", message: "Research receipt store cannot be read." }];
  }
  const result = FutureAdvantageResearchReceiptStoreSchema.safeParse(parsed);
  if (!result.success) {
    return [{ kind: "research", status: "stale", message: "Research receipt store is invalid." }];
  }
  return result.data.receipts.flatMap((receipt) => {
    if (receipt.status === "verified" || receipt.status === "not-applicable") return [];
    const status = receipt.status === "conflict" ? "stale" as const : "pending" as const;
    return [{
      kind: "research" as const,
      status,
      message: `Chapter ${receipt.chapterNumber} move ${receipt.moveId}: ${receipt.status}`,
    }];
  });
}

async function assertBookExists(bookDir: string, bookId: string): Promise<void> {
  try {
    if (!(await stat(bookDir)).isDirectory()) throw new Error(`Book not found: ${bookId}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw new Error(`Book not found: ${bookId}`);
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
