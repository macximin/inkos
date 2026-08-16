import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChapterArcProvenance, ChapterMeta } from "../models/chapter.js";
import { BookConfigSchema } from "../models/book.js";
import { StateManifestSchema, type StateManifest } from "../models/runtime-state.js";
import {
  hashLiveStoryStateProjection,
  verifyChapterTruthReceipt,
} from "../state/chapter-truth-receipt.js";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";
import { ArcStore } from "./store.js";
import { ActiveArcSchema, ArcPacketSchema, type ArcPacket } from "./schema.js";
import {
  ArcRouteEntrySchema,
  StableRailIdSchema,
  StoryRailPlanSchema,
  type ArcRouteEntry,
  type StoryRailPlan,
} from "./rail-schema.js";
import { StoryRailStore } from "./rail-store.js";
import {
  StoryRailReflowApplyInputSchema,
  StoryRailReflowDiscardInputSchema,
  StoryRailReflowDiscardReceiptSchema,
  StoryRailReflowPendingSchema,
  StoryRailReflowReceiptSchema,
  type StoryRailReflowDecision,
  type StoryRailReflowDiscardReceipt,
  type StoryRailReflowPending,
  type StoryRailReflowReceipt,
} from "./reflow-schema.js";

export interface StoryRailReflowStoreOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export type StoryRailReflowNotEligibleReason =
  | "missing-plan"
  | "rail-not-ready"
  | "target-chapters-stale"
  | "missing-active-b"
  | "missing-active-arc-binding"
  | "active-arc-unavailable"
  | "active-arc-mismatch"
  | "already-completed"
  | "endpoint-not-in-arc"
  | "chapter-evidence-missing"
  | "chapter-evidence-ambiguous"
  | "chapter-not-approved"
  | "chapter-provenance-mismatch"
  | "later-chapters-exist"
  | "state-not-fresh";

export type StoryRailReflowPrepareResult =
  | {
      readonly status: "not-eligible";
      readonly reason: StoryRailReflowNotEligibleReason;
      readonly message: string;
    }
  | {
      readonly status: "pending";
      readonly pending: StoryRailReflowPending;
    }
  | {
      readonly status: "already-pending";
      readonly pending: StoryRailReflowPending;
    };

export interface StoryRailReflowApplyResult {
  readonly status: "applied";
  readonly plan: StoryRailPlan;
  readonly receipt: StoryRailReflowReceipt;
}

export interface StoryRailReflowDiscardResult {
  readonly status: "discarded";
  readonly receipt: StoryRailReflowDiscardReceipt;
}

/**
 * Two-phase B close/reflow lifecycle.
 *
 * prepare() is intentionally non-authoritative: it proves that the active Arc
 * reached an owner-approved endpoint and records a pending closeout request,
 * but it does not close the B, complete the Arc, or promote the provisional B.
 * apply() re-proves the approved Chapter evidence, requires explicit decisions,
 * and commits the Rail, Arc, active pointer and immutable receipt as one file
 * transaction. Callers must hold the Book write lock around either mutation.
 */
export class StoryRailReflowStore {
  constructor(
    private readonly bookDir: string,
    private readonly options: StoryRailReflowStoreOptions = {},
  ) {}

  get reflowsDir(): string { return join(this.bookDir, "story", "rails", "reflows"); }
  get pendingPath(): string { return join(this.reflowsDir, "pending.json"); }
  requestPath(pendingId: string): string {
    return join(this.reflowsDir, "requests", `${StableRailIdSchema.parse(pendingId)}.json`);
  }
  receiptPath(bId: string): string {
    return join(this.reflowsDir, "receipts", `${StableRailIdSchema.parse(bId)}.json`);
  }
  discardReceiptPath(pendingId: string): string {
    return join(this.reflowsDir, "discards", `${StableRailIdSchema.parse(pendingId)}.json`);
  }
  now(): Date { return (this.options.now ?? (() => new Date()))(); }

  async getPending(bookId: string): Promise<StoryRailReflowPending | null> {
    const pending = await readOptionalJson(this.pendingPath, StoryRailReflowPendingSchema);
    if (pending && pending.bookId !== bookId) {
      throw new Error(
        `Pending story rail reflow belongs to book ${JSON.stringify(pending.bookId)}, `
        + `not ${JSON.stringify(bookId)}.`,
      );
    }
    return pending;
  }

  async getReceipt(bookId: string, bId: string): Promise<StoryRailReflowReceipt | null> {
    const receipt = await readOptionalJson(this.receiptPath(bId), StoryRailReflowReceiptSchema);
    if (receipt && receipt.bookId !== bookId) {
      throw new Error(
        `Story rail reflow receipt belongs to book ${JSON.stringify(receipt.bookId)}, `
        + `not ${JSON.stringify(bookId)}.`,
      );
    }
    if (receipt && receipt.closedB.bId !== bId) {
      throw new Error(`Story rail reflow receipt does not belong to B ${JSON.stringify(bId)}.`);
    }
    return receipt;
  }

  async getDiscardReceipt(
    bookId: string,
    pendingId: string,
  ): Promise<StoryRailReflowDiscardReceipt | null> {
    const receipt = await readOptionalJson(
      this.discardReceiptPath(pendingId),
      StoryRailReflowDiscardReceiptSchema,
    );
    if (receipt && (receipt.bookId !== bookId || receipt.pending.pendingId !== pendingId)) {
      throw new Error("Story Rail reflow discard receipt belongs to another Book or pending request.");
    }
    return receipt;
  }

  /**
   * Explicitly abandon an unapplied pending gate without mutating the Rail,
   * Arc, active pointer, or any Chapter. This preserves Book -> Chapter as the
   * escape rail when production intentionally continued past the endpoint.
   * Callers must hold the Book write lock.
   */
  async discard(bookId: string, rawInput: unknown): Promise<StoryRailReflowDiscardResult> {
    const input = StoryRailReflowDiscardInputSchema.parse(rawInput);
    const pending = await this.getPending(bookId);
    if (!pending) throw new Error("No pending Story Rail reflow exists.");
    if (
      pending.pendingId !== input.pendingId
      || pending.expectedPlanUpdatedAt !== input.expectedPlanUpdatedAt
    ) {
      throw new Error("Discard input does not match the current pending Story Rail reflow.");
    }
    if (await pathExists(this.discardReceiptPath(pending.pendingId))) {
      throw new Error(`A discard receipt already exists for pending reflow ${JSON.stringify(pending.pendingId)}.`);
    }
    const receipt = StoryRailReflowDiscardReceiptSchema.parse({
      version: 1,
      receiptId: pending.pendingId,
      bookId,
      discardedAt: this.now().toISOString(),
      reason: input.reason,
      pending,
    });
    await commitAtomicFileSet({
      rootDir: this.bookDir,
      writes: [{
        relativePath: reflowRelativePath("discards", `${pending.pendingId}.json`),
        content: jsonContent(receipt),
      }],
      deletes: [reflowRelativePath("pending.json")],
    });
    return { status: "discarded", receipt };
  }

  async prepare(
    bookId: string,
    chapters: ReadonlyArray<ChapterMeta>,
    options: { readonly endpointChapterNumber?: number } = {},
  ): Promise<StoryRailReflowPrepareResult> {
    const railStore = new StoryRailStore(this.bookDir);
    const plan = await railStore.load();
    if (!plan) return notEligible("missing-plan", "No Story Rail plan exists.");
    if (plan.bookId !== bookId) {
      throw new Error(
        `Story rail plan belongs to book ${JSON.stringify(plan.bookId)}, not ${JSON.stringify(bookId)}.`,
      );
    }
    if (plan.anchorRail.status !== "ready" || plan.arcRouteRail.status !== "ready") {
      return notEligible("rail-not-ready", "The A/B Rail is not ready for production closeout.");
    }
    const liveBook = BookConfigSchema.parse(JSON.parse(await readFile(
      join(this.bookDir, "book.json"),
      "utf8",
    )));
    if (liveBook.id !== bookId) {
      throw new Error(
        `Book config belongs to book ${JSON.stringify(liveBook.id)}, not ${JSON.stringify(bookId)}.`,
      );
    }
    if (plan.routeCapacity.targetChaptersSnapshot !== liveBook.targetChapters) {
      return notEligible(
        "target-chapters-stale",
        `Story Rail capacity targets ${plan.routeCapacity.targetChaptersSnapshot} chapters, but the Book now `
        + `targets ${liveBook.targetChapters}. Replace/reflow the plan before production closeout.`,
      );
    }

    const activeB = plan.arcRouteRail.entries.find((entry) => entry.status === "active");
    if (!activeB) return notEligible("missing-active-b", "The ready B-Rail has no active B.");
    if (!activeB.arcId) {
      return notEligible("missing-active-arc-binding", "The active B is not bound to an ArcPacket.");
    }

    const arcStore = new ArcStore(this.bookDir);
    let arc: ArcPacket;
    let activeArc: ArcPacket | null;
    try {
      [arc, activeArc] = await Promise.all([
        arcStore.load(activeB.arcId),
        arcStore.getActive(),
      ]);
    } catch (error) {
      return notEligible("active-arc-unavailable", `The active Arc cannot be verified: ${errorText(error)}`);
    }
    if (arc.bookId !== bookId || activeArc?.id !== arc.id || activeArc.bookId !== bookId) {
      return notEligible(
        "active-arc-mismatch",
        "The runtime active Arc, active B binding, and Book do not identify the same Arc.",
      );
    }
    if (arc.status === "completed") {
      return notEligible("already-completed", `Arc ${JSON.stringify(arc.id)} is already completed.`);
    }

    const endpoint = options.endpointChapterNumber ?? arc.chapterNumbers.at(-1)!;
    const endpointIndex = arc.chapterNumbers.indexOf(endpoint);
    if (endpointIndex < 0) {
      return notEligible(
        "endpoint-not-in-arc",
        `Chapter ${endpoint} is not an endpoint candidate in Arc ${JSON.stringify(arc.id)}.`,
      );
    }
    if (chapters.some((chapter) => chapter.number > endpoint)) {
      return notEligible(
        "later-chapters-exist",
        `Chapter evidence already extends beyond the proposed Arc endpoint ${endpoint}.`,
      );
    }

    const evidenceNumbers = arc.chapterNumbers.slice(0, endpointIndex + 1);
    const evidence: StoryRailReflowPending["approvedChapters"] = [];
    for (const chapterNumber of evidenceNumbers) {
      const matchingChapters = chapters.filter((candidate) => candidate.number === chapterNumber);
      if (matchingChapters.length === 0) {
        return notEligible(
          "chapter-evidence-missing",
          `Chapter ${chapterNumber} is missing from the durable chapter index.`,
        );
      }
      if (matchingChapters.length !== 1) {
        return notEligible(
          "chapter-evidence-ambiguous",
          `Chapter ${chapterNumber} appears ${matchingChapters.length} times in the durable chapter index.`,
        );
      }
      const chapter = matchingChapters[0]!;
      if (chapter.status !== "approved" && chapter.status !== "published") {
        return notEligible(
          "chapter-not-approved",
          `Chapter ${chapterNumber} is ${chapter.status}; every Arc chapter through the endpoint must be approved or published.`,
        );
      }
      const railPlanUpdatedAt = chapter.arcProvenance?.storyRail?.planUpdatedAt;
      if (
        !railPlanUpdatedAt
        || !matchesActiveStoryRailChapterEvidence(chapter.arcProvenance, chapterNumber, bookId, arc, activeB, railPlanUpdatedAt)
      ) {
        return notEligible(
          "chapter-provenance-mismatch",
          `Chapter ${chapterNumber} does not carry the exact active Arc/B-Rail provenance being closed.`,
        );
      }
      let truthReceipt: Awaited<ReturnType<typeof verifyChapterTruthReceipt>>;
      try {
        truthReceipt = await verifyChapterTruthReceipt(this.bookDir, bookId, chapter);
      } catch (error) {
        return notEligible(
          "state-not-fresh",
          `Chapter ${chapterNumber} has no current truth-settlement receipt: ${errorText(error)}`,
        );
      }
      evidence.push({
        number: chapter.number,
        status: chapter.status,
        updatedAt: chapter.updatedAt,
        arcUpdatedAt: chapter.arcProvenance!.arcUpdatedAt,
        railPlanUpdatedAt,
        chapterContentSha256: truthReceipt.receipt.chapterContentSha256,
        stateSnapshotSha256: truthReceipt.receipt.stateSnapshot.sha256,
        truthReceiptSha256: truthReceipt.receiptSha256,
      });
    }

    let manifest: StateManifest;
    try {
      manifest = StateManifestSchema.parse(JSON.parse(await readFile(
        join(this.bookDir, "story", "state", "manifest.json"),
        "utf8",
      )));
    } catch (error) {
      return notEligible("state-not-fresh", `The runtime state manifest cannot prove the Arc endpoint: ${errorText(error)}`);
    }
    if (manifest.lastAppliedChapter !== endpoint) {
      return notEligible(
        "state-not-fresh",
        `Runtime state is through chapter ${manifest.lastAppliedChapter}, not the exact Arc endpoint ${endpoint}.`,
      );
    }
    let stateProjectionSha256: string;
    try {
      stateProjectionSha256 = await hashLiveStoryStateProjection(this.bookDir);
    } catch (error) {
      return notEligible("state-not-fresh", `The live state projection cannot be attested: ${errorText(error)}`);
    }
    const endpointEvidence = evidence.at(-1)!;
    if (endpointEvidence.stateSnapshotSha256 !== stateProjectionSha256) {
      return notEligible(
        "state-not-fresh",
        "The live narrative state does not match the settled endpoint Chapter snapshot.",
      );
    }

    const existingPending = await this.getPending(bookId);
    if (existingPending && samePreparedEvidence(
      existingPending,
      plan,
      activeB,
      arc,
      endpoint,
      evidence,
      manifest,
      stateProjectionSha256,
    )) {
      return { status: "already-pending", pending: existingPending };
    }

    // A Chapter revision/rejection can make a pending gate impossible to
    // apply. Once fresh approved evidence exists, supersede that stale pointer
    // while preserving its immutable request file for audit.
    const pendingId = await this.allocatePendingId();
    const pending = StoryRailReflowPendingSchema.parse({
      version: 1,
      pendingId,
      ...(existingPending ? { supersedesPendingId: existingPending.pendingId } : {}),
      status: "pending",
      bookId,
      createdAt: this.now().toISOString(),
      expectedPlanUpdatedAt: plan.updatedAt,
      activeB: {
        bId: activeB.bId,
        routeOrder: activeB.routeOrder,
        targetAnchorId: activeB.targetAnchorId,
        arcId: arc.id,
      },
      arc: {
        id: arc.id,
        updatedAt: arc.updatedAt,
        chapterNumbers: arc.chapterNumbers,
        plannedEpisodeCount: arc.episodeCount,
      },
      endpointChapterNumber: endpoint,
      actualEpisodeCount: evidenceNumbers.length,
      approvedChapters: evidence,
      stateEvidence: {
        lastAppliedChapter: manifest.lastAppliedChapter,
        projectionVersion: manifest.projectionVersion,
        stateProjectionSha256,
      },
    });

    const content = jsonContent(pending);
    await commitAtomicFileSet({
      rootDir: this.bookDir,
      writes: [
        { relativePath: reflowRelativePath("pending.json"), content },
        { relativePath: reflowRelativePath("requests", `${pending.pendingId}.json`), content },
      ],
    });
    return { status: "pending", pending };
  }

  private async allocatePendingId(): Promise<string> {
    const base = StableRailIdSchema.parse(
      this.options.idFactory?.() ?? `reflow-${randomUUID()}`,
    );
    if (!await pathExists(this.requestPath(base))) return base;
    for (let counter = 2; counter < 10_000; counter += 1) {
      const suffix = `-${counter}`;
      const candidate = StableRailIdSchema.parse(`${base.slice(0, 80 - suffix.length)}${suffix}`);
      if (!await pathExists(this.requestPath(candidate))) return candidate;
    }
    throw new Error(`Could not allocate a unique pending reflow id from ${JSON.stringify(base)}.`);
  }

  async apply(
    bookId: string,
    chapters: ReadonlyArray<ChapterMeta>,
    rawInput: unknown,
  ): Promise<StoryRailReflowApplyResult> {
    const input = StoryRailReflowApplyInputSchema.parse(rawInput);
    const pending = await this.getPending(bookId);
    if (!pending) throw new Error("No pending Story Rail reflow exists.");
    if (pending.pendingId !== input.pendingId) {
      throw new Error(
        `Pending reflow id is ${JSON.stringify(pending.pendingId)}, not ${JSON.stringify(input.pendingId)}.`,
      );
    }
    if (
      input.expectedPlanUpdatedAt !== pending.expectedPlanUpdatedAt
      || input.closeout.stateThroughChapter !== pending.endpointChapterNumber
      || input.closeout.anchorImpact.anchorId !== pending.activeB.targetAnchorId
    ) {
      throw new Error("Reflow input does not match the pending plan, state endpoint, or target Anchor.");
    }

    const railStore = new StoryRailStore(this.bookDir);
    const plan = await railStore.load();
    if (!plan || plan.bookId !== bookId || plan.updatedAt !== pending.expectedPlanUpdatedAt) {
      throw new Error("Story Rail plan changed after the pending reflow was prepared.");
    }
    const activeB = plan.arcRouteRail.entries.find((entry) => entry.status === "active");
    if (
      !activeB
      || activeB.bId !== pending.activeB.bId
      || activeB.arcId !== pending.arc.id
      || activeB.routeOrder !== pending.activeB.routeOrder
      || activeB.targetAnchorId !== pending.activeB.targetAnchorId
    ) {
      throw new Error("The active B no longer matches the pending closeout.");
    }

    const [manifest, stateProjectionSha256] = await Promise.all([
      readFile(join(this.bookDir, "story", "state", "manifest.json"), "utf8")
        .then((raw) => StateManifestSchema.parse(JSON.parse(raw))),
      hashLiveStoryStateProjection(this.bookDir),
    ]);
    if (
      manifest.lastAppliedChapter !== pending.stateEvidence.lastAppliedChapter
      || manifest.projectionVersion !== pending.stateEvidence.projectionVersion
      || stateProjectionSha256 !== pending.stateEvidence.stateProjectionSha256
    ) {
      throw new Error("Runtime state changed after the pending reflow was prepared.");
    }

    const arcStore = new ArcStore(this.bookDir);
    const [arc, activeArcPointer] = await Promise.all([
      arcStore.load(pending.arc.id),
      readActiveArcPointer(arcStore.activePath),
    ]);
    if (
      arc.bookId !== bookId
      || arc.updatedAt !== pending.arc.updatedAt
      || arc.status === "completed"
      || activeArcPointer.arcId !== arc.id
    ) {
      throw new Error("The active Arc changed after the pending reflow was prepared.");
    }
    await assertPendingChapterEvidence(this.bookDir, chapters, pending, bookId, arc, activeB);

    const futureEntries = plan.arcRouteRail.entries.filter(
      (entry) => entry.routeOrder > activeB.routeOrder && entry.status !== "retired",
    );
    const decisionById = validateCompleteDecisionSet(futureEntries, input.decisions);
    const currentProvisional = futureEntries.find((entry) => entry.status === "provisional");
    if (
      currentProvisional
      && currentProvisional.bId !== input.nextActiveBId
      && decisionById.get(currentProvisional.bId)?.action !== "retire"
    ) {
      throw new Error(
        `Current provisional B ${JSON.stringify(currentProvisional.bId)} must be selected explicitly as the next active B `
        + "or explicitly retired; it cannot be silently demoted to a hypothesis.",
      );
    }
    const existingIds = new Set(plan.arcRouteRail.entries.map((entry) => entry.bId));
    for (const entry of input.newEntries) {
      if (existingIds.has(entry.bId)) {
        throw new Error(`New reflow entry reuses issued B id ${JSON.stringify(entry.bId)}.`);
      }
      existingIds.add(entry.bId);
    }

    const transformedFuture = futureEntries.map((entry) => applyDecision(entry, decisionById.get(entry.bId)!));
    const newEntries = input.newEntries.map((entry) => ArcRouteEntrySchema.parse(entry));
    const candidateFuture = [...transformedFuture, ...newEntries];
    const selectable = new Map(
      candidateFuture
        .filter((entry) => entry.status !== "retired")
        .map((entry) => [entry.bId, entry] as const),
    );
    if (!selectable.has(input.nextActiveBId)) {
      throw new Error(`Explicit next active B ${JSON.stringify(input.nextActiveBId)} is unavailable or retired.`);
    }
    if (input.nextProvisionalBId && !selectable.has(input.nextProvisionalBId)) {
      throw new Error(
        `Explicit next provisional B ${JSON.stringify(input.nextProvisionalBId)} is unavailable or retired.`,
      );
    }

    // Concrete future Arc beats were produced against the pre-close state.
    // Keep the durable B direction, but invalidate every future binding so the
    // newly active B receives a fresh Arc from the settled endpoint state.
    const invalidatedFutureArcBindings = candidateFuture.flatMap((entry) =>
      entry.arcId ? [{ bId: entry.bId, arcId: entry.arcId }] : []
    );
    const invalidatedBindingIds = new Set(
      invalidatedFutureArcBindings.map((binding) => binding.bId),
    );
    const nextStatuses = candidateFuture.map<ArcRouteEntry>((entry) => {
      const { arcId: _invalidatedArcId, ...durableEntry } = entry;
      if (entry.status === "retired") return durableEntry;
      if (entry.bId === input.nextActiveBId) return { ...durableEntry, status: "active" };
      if (entry.bId === input.nextProvisionalBId) return { ...durableEntry, status: "provisional" };
      return { ...durableEntry, status: "hypothesis" };
    });
    const futureIds = new Set(futureEntries.map((entry) => entry.bId));
    const preservedPrefix = plan.arcRouteRail.entries
      .filter((entry) => !futureIds.has(entry.bId))
      .map<ArcRouteEntry>((entry) => entry.bId === activeB.bId
        ? { ...entry, status: "closed", actualEpisodeCount: pending.actualEpisodeCount }
        : entry);
    const appliedAt = this.now().toISOString();
    const updatedPlan = StoryRailPlanSchema.parse({
      ...plan,
      arcRouteRail: {
        ...plan.arcRouteRail,
        status: "ready",
        entries: [...preservedPrefix, ...nextStatuses]
          .sort((left, right) => left.routeOrder - right.routeOrder),
      },
      updatedAt: appliedAt,
    });
    const validatedPlan = await railStore.validateForSave(updatedPlan, {
      allowPendingTransitionId: pending.pendingId,
      allowArcBindingRemovalForBIds: invalidatedBindingIds,
    });

    const completedArc = ArcPacketSchema.parse({
      ...arc,
      status: "completed",
      episodeCount: pending.actualEpisodeCount,
      chapterNumbers: arc.chapterNumbers.slice(0, pending.actualEpisodeCount),
      episodeBeats: arc.episodeBeats.slice(0, pending.actualEpisodeCount),
      updatedAt: appliedAt,
    });
    const receipt = StoryRailReflowReceiptSchema.parse({
      version: 1,
      receiptId: pending.pendingId,
      pendingId: pending.pendingId,
      bookId,
      appliedAt,
      planUpdatedAtBefore: plan.updatedAt,
      planUpdatedAtAfter: validatedPlan.updatedAt,
      closedB: {
        bId: activeB.bId,
        arcId: arc.id,
        endpointChapterNumber: pending.endpointChapterNumber,
        actualEpisodeCount: pending.actualEpisodeCount,
      },
      evidence: {
        pendingCreatedAt: pending.createdAt,
        expectedPlanUpdatedAt: pending.expectedPlanUpdatedAt,
        activeB: pending.activeB,
        arc: pending.arc,
        approvedChapters: pending.approvedChapters,
        stateEvidence: pending.stateEvidence,
      },
      closeout: input.closeout,
      decisions: input.decisions,
      newEntryIds: newEntries.map((entry) => entry.bId),
      invalidatedFutureArcBindings,
      nextActiveBId: input.nextActiveBId,
      ...(input.nextProvisionalBId ? { nextProvisionalBId: input.nextProvisionalBId } : {}),
    });
    if (await pathExists(this.receiptPath(activeB.bId))) {
      throw new Error(`A reflow receipt already exists for closed B ${JSON.stringify(activeB.bId)}.`);
    }

    const writes = [
      { relativePath: join("story", "rails", "plan.json"), content: jsonContent(validatedPlan) },
      { relativePath: join("story", "arcs", `${arc.id}.json`), content: jsonContent(completedArc) },
      {
        relativePath: reflowRelativePath("receipts", `${activeB.bId}.json`),
        content: jsonContent(receipt),
      },
    ];
    await commitAtomicFileSet({
      rootDir: this.bookDir,
      writes,
      deletes: [
        reflowRelativePath("pending.json"),
        join("story", "arcs", "active.json"),
      ],
    });

    return { status: "applied", plan: validatedPlan, receipt };
  }
}

function samePreparedEvidence(
  pending: StoryRailReflowPending,
  plan: StoryRailPlan,
  activeB: ArcRouteEntry,
  arc: ArcPacket,
  endpoint: number,
  chapters: StoryRailReflowPending["approvedChapters"],
  manifest: StateManifest,
  stateProjectionSha256: string,
): boolean {
  return pending.expectedPlanUpdatedAt === plan.updatedAt
    && pending.activeB.bId === activeB.bId
    && pending.activeB.routeOrder === activeB.routeOrder
    && pending.activeB.targetAnchorId === activeB.targetAnchorId
    && pending.activeB.arcId === arc.id
    && pending.arc.id === arc.id
    && pending.arc.updatedAt === arc.updatedAt
    && pending.endpointChapterNumber === endpoint
    && pending.actualEpisodeCount === chapters.length
    && pending.stateEvidence.lastAppliedChapter === manifest.lastAppliedChapter
    && pending.stateEvidence.projectionVersion === manifest.projectionVersion
    && pending.stateEvidence.stateProjectionSha256 === stateProjectionSha256
    && pending.approvedChapters.length === chapters.length
    && pending.approvedChapters.every((expected, index) => {
      const current = chapters[index];
      return Boolean(
        current
        && expected.number === current.number
        && expected.status === current.status
        && expected.updatedAt === current.updatedAt
        && expected.arcUpdatedAt === current.arcUpdatedAt
        && expected.railPlanUpdatedAt === current.railPlanUpdatedAt
        && expected.chapterContentSha256 === current.chapterContentSha256
        && expected.stateSnapshotSha256 === current.stateSnapshotSha256
        && expected.truthReceiptSha256 === current.truthReceiptSha256,
      );
    });
}

async function assertPendingChapterEvidence(
  bookDir: string,
  chapters: ReadonlyArray<ChapterMeta>,
  pending: StoryRailReflowPending,
  bookId: string,
  arc: ArcPacket,
  activeB: ArcRouteEntry,
): Promise<void> {
  if (chapters.some((chapter) => chapter.number > pending.endpointChapterNumber)) {
    throw new Error("Chapter evidence advanced after the pending reflow was prepared.");
  }
  if (
    pending.approvedChapters.length !== pending.actualEpisodeCount
    || pending.approvedChapters.at(-1)?.number !== pending.endpointChapterNumber
  ) {
    throw new Error("Pending reflow chapter evidence is internally inconsistent.");
  }

  for (const expected of pending.approvedChapters) {
    const matches = chapters.filter((chapter) => chapter.number === expected.number);
    const chapter = matches[0];
    if (
      matches.length !== 1
      || !chapter
      || chapter.status !== expected.status
      || (chapter.status !== "approved" && chapter.status !== "published")
      || chapter.updatedAt !== expected.updatedAt
      || chapter.arcProvenance?.arcUpdatedAt !== expected.arcUpdatedAt
      || !matchesActiveStoryRailChapterEvidence(
        chapter.arcProvenance,
        chapter.number,
        bookId,
        arc,
        activeB,
        expected.railPlanUpdatedAt,
      )
    ) {
      throw new Error(
        `Chapter ${expected.number} approval or provenance changed after the pending reflow was prepared.`,
      );
    }
    let verified: Awaited<ReturnType<typeof verifyChapterTruthReceipt>>;
    try {
      verified = await verifyChapterTruthReceipt(bookDir, bookId, chapter);
    } catch (error) {
      throw new Error(
        `Chapter ${expected.number} truth settlement changed after the pending reflow was prepared: ${errorText(error)}`,
      );
    }
    if (
      verified.receiptSha256 !== expected.truthReceiptSha256
      || verified.receipt.chapterContentSha256 !== expected.chapterContentSha256
      || verified.receipt.stateSnapshot.sha256 !== expected.stateSnapshotSha256
    ) {
      throw new Error(
        `Chapter ${expected.number} truth settlement changed after the pending reflow was prepared.`,
      );
    }
  }
}

function notEligible(
  reason: StoryRailReflowNotEligibleReason,
  message: string,
): StoryRailReflowPrepareResult {
  return { status: "not-eligible", reason, message };
}

/**
 * Match the durable Arc + active-B identity stored on a Chapter. Compatible
 * edits to future hypotheses or Anchor detail must not invalidate closeout,
 * while a pending receipt may still pin the original plan timestamp.
 */
export function matchesActiveStoryRailChapterEvidence(
  provenance: ChapterArcProvenance | undefined,
  chapterNumber: number,
  bookId: string,
  arc: ArcPacket,
  activeB: ArcRouteEntry,
  evidencePlanUpdatedAt: string,
): boolean {
  const rail = provenance?.storyRail;
  return Boolean(
    provenance
    && rail
    && provenance.chapterNumber === chapterNumber
    && provenance.bookId === bookId
    && provenance.arcId === arc.id
    && provenance.arcUpdatedAt === arc.updatedAt
    && rail.planUpdatedAt === evidencePlanUpdatedAt
    && rail.anchor.id === activeB.targetAnchorId
    && rail.activeB.bId === activeB.bId
    && rail.activeB.routeOrder === activeB.routeOrder
    && rail.activeB.status === "active"
    && rail.activeB.targetAnchorId === activeB.targetAnchorId
    && rail.activeB.narrativeFunction === activeB.narrativeFunction
    && rail.activeB.payoffAxis === activeB.payoffAxis
    && rail.activeB.carriedReaderDebt === activeB.carriedReaderDebt
    && rail.activeB.contrastRequirement === activeB.contrastRequirement,
  );
}

function validateCompleteDecisionSet(
  entries: ReadonlyArray<ArcRouteEntry>,
  decisions: ReadonlyArray<StoryRailReflowDecision>,
): Map<string, StoryRailReflowDecision> {
  const requiredIds = new Set(entries.map((entry) => entry.bId));
  const byId = new Map(decisions.map((decision) => [decision.bId, decision] as const));
  const missing = [...requiredIds].filter((id) => !byId.has(id));
  const unexpected = [...byId].filter(([id]) => !requiredIds.has(id)).map(([id]) => id);
  if (missing.length > 0 || unexpected.length > 0 || byId.size !== decisions.length) {
    throw new Error(
      "Reflow requires exactly one explicit keep, revise, or retire decision for every existing future B. "
      + `Missing: ${missing.join(", ") || "none"}; unexpected/duplicate: ${unexpected.join(", ") || "none"}.`,
    );
  }
  return byId;
}

function applyDecision(entry: ArcRouteEntry, decision: StoryRailReflowDecision): ArcRouteEntry {
  if (decision.action === "keep") return entry;
  if (decision.action === "retire") return { ...entry, status: "retired" };
  return {
    ...entry,
    ...decision.revision,
  };
}

async function readActiveArcPointer(path: string) {
  return ActiveArcSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function readOptionalJson<T>(
  path: string,
  schema: { readonly parse: (value: unknown) => T },
): Promise<T | null> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return false;
    throw error;
  }
}

function jsonContent(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function reflowRelativePath(...parts: string[]): string {
  return join("story", "rails", "reflows", ...parts);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
