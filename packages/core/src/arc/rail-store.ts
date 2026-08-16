import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BookConfigSchema } from "../models/book.js";
import { ArcIdSchema } from "./schema.js";
import {
  StoryRailPlanInputSchema,
  StoryRailPlanSchema,
  type ArcRouteEntry,
  type StoryRailPlan,
  type StoryRailPlanInput,
} from "./rail-schema.js";
import { StoryRailReflowPendingSchema } from "./reflow-schema.js";

export interface StoryRailStoreOptions {
  readonly now?: () => Date;
}

export type BindActiveArcResult =
  | {
      readonly status: "bound";
      readonly changed: boolean;
      readonly bId: string;
      readonly arcId: string;
      readonly plan: StoryRailPlan;
    }
  | {
      readonly status: "conflict";
      readonly reason: "active_b_already_bound" | "arc_already_bound_elsewhere";
      readonly bId: string;
      readonly existingArcId: string;
      readonly requestedArcId: string;
      readonly plan: StoryRailPlan;
    }
  | {
      readonly status: "missing-plan";
      readonly plan: null;
    }
  | {
      readonly status: "missing-active";
      readonly plan: StoryRailPlan;
    };

/**
 * Book-local optional A/B rail storage.
 *
 * Strict callers use load/save and receive parse errors. Chapter production
 * should use loadOptional so a missing or damaged future plan can never block
 * the established Book -> Chapter path.
 */
export class StoryRailStore {
  constructor(
    private readonly bookDir: string,
    private readonly options: StoryRailStoreOptions = {},
  ) {}

  get railsDir(): string { return join(this.bookDir, "story", "rails"); }
  get planPath(): string { return join(this.railsDir, "plan.json"); }
  now(): Date { return (this.options.now ?? (() => new Date()))(); }

  async load(): Promise<StoryRailPlan | null> {
    try {
      const raw = JSON.parse(await readFile(this.planPath, "utf8"));
      return StoryRailPlanSchema.parse(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
      throw new Error(`Story rail plan cannot be read: ${errorText(error)}`);
    }
  }

  async loadOptional(
    bookId: string,
    onWarning?: (message: string) => void,
  ): Promise<StoryRailPlan | null> {
    try {
      const expectedBookId = parseBookId(bookId);
      const plan = await this.load();
      if (plan && plan.bookId !== expectedBookId) {
        throw new Error(
          `Story rail plan belongs to book ${JSON.stringify(plan.bookId)}, not ${JSON.stringify(expectedBookId)}.`,
        );
      }
      return plan;
    } catch (error) {
      onWarning?.(
        `[rail] Optional story rail plan could not be loaded and was ignored: ${errorText(error)}`,
      );
      return null;
    }
  }

  async save(plan: StoryRailPlan): Promise<StoryRailPlan> {
    const validated = await this.validateForSave(plan);
    await mkdir(this.railsDir, { recursive: true });
    await writeJsonAtomically(this.planPath, validated);
    return validated;
  }

  /**
   * Validate a complete replacement without writing it.
   *
   * Multi-file lifecycle transactions use this preflight before staging the
   * Rail plan together with its Arc and reflow receipt. Keeping the same
   * validation entry point prevents those transactions from bypassing stable
   * ids, tombstones, historical bindings, or the live Book capacity target.
   */
  async validateForSave(
    plan: StoryRailPlan,
    options: {
      readonly allowPendingTransitionId?: string;
      readonly allowArcBindingRemovalForBIds?: ReadonlySet<string>;
    } = {},
  ): Promise<StoryRailPlan> {
    const validated = StoryRailPlanSchema.parse(plan);
    const existing = await this.load();
    if (existing && existing.bookId !== validated.bookId) {
      throw new Error(
        `Refusing to replace story rail plan for book ${JSON.stringify(existing.bookId)} with `
        + `${JSON.stringify(validated.bookId)}.`,
      );
    }
    if (existing) {
      const lifecycleTransitionAuthorized = await assertPendingReflowCompatibility(
        this.bookDir,
        existing,
        validated,
        options.allowPendingTransitionId,
      );
      assertNonDestructiveReplacement(
        existing,
        validated,
        {
          allowArcBindingRemovalForBIds: options.allowArcBindingRemovalForBIds,
          allowLifecycleTransition: lifecycleTransitionAuthorized,
        },
      );
    }
    const book = await this.loadBookConfig(validated.bookId);
    if (validated.routeCapacity.targetChaptersSnapshot !== book.targetChapters) {
      throw new Error(
        `Story rail capacity snapshot ${validated.routeCapacity.targetChaptersSnapshot} does not match `
        + `live book targetChapters ${book.targetChapters}. Replace the plan against the current book config.`,
      );
    }
    return validated;
  }

  async replace(bookId: string, input: StoryRailPlanInput): Promise<StoryRailPlan> {
    const expectedBookId = parseBookId(bookId);
    const validatedInput = StoryRailPlanInputSchema.parse(input);
    const existing = await this.load();
    if (existing && existing.bookId !== expectedBookId) {
      throw new Error(
        `Story rail plan belongs to book ${JSON.stringify(existing.bookId)}, not ${JSON.stringify(expectedBookId)}.`,
      );
    }
    const book = await this.loadBookConfig(expectedBookId);
    const now = this.now().toISOString();
    return this.save(StoryRailPlanSchema.parse({
      version: 1,
      bookId: expectedBookId,
      anchorRail: validatedInput.anchorRail,
      arcRouteRail: validatedInput.arcRouteRail,
      routeCapacity: {
        targetChaptersSnapshot: book.targetChapters,
        arcEpisodeCap: 3,
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }));
  }

  async bindActiveArc(bookId: string, arcId: string): Promise<BindActiveArcResult> {
    const prepared = await this.prepareActiveArcBinding(bookId, arcId);
    if (prepared.status !== "bound" || !prepared.changed) return prepared;
    const saved = await this.save(prepared.plan);
    return { ...prepared, plan: saved };
  }

  /**
   * Build and validate an active-B binding without writing it.
   *
   * Forecast selection uses this to commit plan.json and active.json in one
   * recoverable Book-local file-set transaction. Callers that only need to
   * attach an already-active Arc can continue to use bindActiveArc().
   */
  async prepareActiveArcBinding(bookId: string, arcId: string): Promise<BindActiveArcResult> {
    const expectedBookId = parseBookId(bookId);
    const requestedArcId = ArcIdSchema.parse(arcId);
    const plan = await this.load();
    if (!plan) return { status: "missing-plan", plan: null };
    if (plan.bookId !== expectedBookId) {
      throw new Error(
        `Story rail plan belongs to book ${JSON.stringify(plan.bookId)}, not ${JSON.stringify(expectedBookId)}.`,
      );
    }

    const activeIndex = plan.arcRouteRail.entries.findIndex((entry) => entry.status === "active");
    if (activeIndex < 0) return { status: "missing-active", plan };
    const active = plan.arcRouteRail.entries[activeIndex]!;

    if (active.arcId && active.arcId !== requestedArcId) {
      return {
        status: "conflict",
        reason: "active_b_already_bound",
        bId: active.bId,
        existingArcId: active.arcId,
        requestedArcId,
        plan,
      };
    }

    const otherBinding = plan.arcRouteRail.entries.find(
      (entry, index) => index !== activeIndex && entry.arcId === requestedArcId,
    );
    if (otherBinding?.arcId) {
      return {
        status: "conflict",
        reason: "arc_already_bound_elsewhere",
        bId: otherBinding.bId,
        existingArcId: otherBinding.arcId,
        requestedArcId,
        plan,
      };
    }

    if (active.arcId === requestedArcId) {
      return {
        status: "bound",
        changed: false,
        bId: active.bId,
        arcId: requestedArcId,
        plan,
      };
    }

    const entries = plan.arcRouteRail.entries.map<ArcRouteEntry>((entry, index) =>
      index === activeIndex ? { ...entry, arcId: requestedArcId } : entry,
    );
    const updated = StoryRailPlanSchema.parse({
      ...plan,
      arcRouteRail: { ...plan.arcRouteRail, entries },
      updatedAt: this.now().toISOString(),
    });
    const validated = await this.validateForSave(updated);
    return {
      status: "bound",
      changed: true,
      bId: active.bId,
      arcId: requestedArcId,
      plan: validated,
    };
  }

  private async loadBookConfig(expectedBookId: string) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(this.bookDir, "book.json"), "utf8"));
    } catch (error) {
      throw new Error(`Book config cannot be read for story rail capacity: ${errorText(error)}`);
    }
    const book = BookConfigSchema.parse(raw);
    if (book.id !== expectedBookId) {
      throw new Error(
        `Book config belongs to book ${JSON.stringify(book.id)}, not ${JSON.stringify(expectedBookId)}.`,
      );
    }
    return book;
  }
}

async function assertPendingReflowCompatibility(
  bookDir: string,
  existing: StoryRailPlan,
  incoming: StoryRailPlan,
  allowPendingTransitionId?: string,
): Promise<boolean> {
  let pending;
  try {
    pending = StoryRailReflowPendingSchema.parse(JSON.parse(await readFile(
      join(bookDir, "story", "rails", "reflows", "pending.json"),
      "utf8",
    )));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      if (allowPendingTransitionId) {
        throw new Error(
          `Story Rail lifecycle transition ${JSON.stringify(allowPendingTransitionId)} has no matching pending reflow.`,
        );
      }
      return false;
    }
    throw new Error(`Pending Story Rail reflow cannot be verified before replacement: ${errorText(error)}`);
  }
  if (allowPendingTransitionId === pending.pendingId) return true;

  const existingActive = existing.arcRouteRail.entries.find((entry) => entry.status === "active");
  const incomingActive = incoming.arcRouteRail.entries.find((entry) => entry.status === "active");
  if (
    existingActive
    && incomingActive
    && existingActive.bId === pending.activeB.bId
    && existingActive.arcId === pending.arc.id
    && sameActiveEntry(existingActive, incomingActive)
  ) {
    return false;
  }
  throw new Error(
    `Pending Story Rail reflow ${JSON.stringify(pending.pendingId)} protects active B `
    + `${JSON.stringify(pending.activeB.bId)}. Apply the closeout before changing or replacing that active B; `
    + "compatible A-Rail and future-B edits remain allowed.",
  );
}

function sameActiveEntry(left: ArcRouteEntry, right: ArcRouteEntry): boolean {
  return left.bId === right.bId
    && left.routeOrder === right.routeOrder
    && left.status === "active"
    && right.status === "active"
    && left.targetAnchorId === right.targetAnchorId
    && left.arcId === right.arcId
    && left.narrativeFunction === right.narrativeFunction
    && left.payoffAxis === right.payoffAxis
    && left.carriedReaderDebt === right.carriedReaderDebt
    && left.contrastRequirement === right.contrastRequirement;
}

const BookIdSchema = z.string().trim().min(1);

function parseBookId(bookId: string): string {
  return BookIdSchema.parse(bookId);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Rails use stable identities and tombstones. Full replacement may revise
 * future strategy, but it may not erase issued ids, resurrect retired items,
 * reopen closed B entries, or detach/rebind an Arc that already has history.
 * This guard lives under public save() so every write path receives it.
 */
function assertNonDestructiveReplacement(
  existing: StoryRailPlan,
  incoming: StoryRailPlan,
  options: {
    readonly allowArcBindingRemovalForBIds?: ReadonlySet<string>;
    readonly allowLifecycleTransition?: boolean;
  } = {},
): void {
  const allowArcBindingRemovalForBIds = options.allowArcBindingRemovalForBIds ?? new Set<string>();
  const lifecycleEditableDraft = existing.arcRouteRail.status === "draft"
    && existing.arcRouteRail.entries.every(
      (entry) => !entry.arcId && entry.status !== "closed",
    );
  const incomingAnchors = new Map(
    incoming.anchorRail.anchors.map((anchor) => [anchor.id, anchor] as const),
  );
  for (const anchor of existing.anchorRail.anchors) {
    const replacement = incomingAnchors.get(anchor.id);
    if (!replacement) {
      throw new Error(
        `Existing Anchor ${JSON.stringify(anchor.id)} cannot be omitted; `
        + "retain it as a tombstone with state \"retired\".",
      );
    }
    if (anchor.state === "retired" && replacement.state !== "retired") {
      throw new Error(`Retired Anchor ${JSON.stringify(anchor.id)} cannot be restored or reused.`);
    }
  }

  const incomingEntries = new Map(
    incoming.arcRouteRail.entries.map((entry) => [entry.bId, entry] as const),
  );
  const existingEntryIds = new Set(existing.arcRouteRail.entries.map((entry) => entry.bId));
  for (const entry of existing.arcRouteRail.entries) {
    const replacement = incomingEntries.get(entry.bId);
    if (!replacement) {
      throw new Error(
        `Existing B-Rail id ${JSON.stringify(entry.bId)} cannot be omitted; retain it with status "retired".`,
      );
    }
    if (entry.status === "retired" && replacement.status !== "retired") {
      throw new Error(`Retired B-Rail id ${JSON.stringify(entry.bId)} cannot be restored or reused.`);
    }
    if (entry.status === "closed" && replacement.status !== "closed") {
      throw new Error(`Closed B-Rail id ${JSON.stringify(entry.bId)} cannot move back to a future status.`);
    }
    if (entry.status === "closed" && !sameClosedEntry(entry, replacement)) {
      throw new Error(
        `Closed B-Rail id ${JSON.stringify(entry.bId)} is historical and cannot be changed; `
        + "issue a new B id for future strategy.",
      );
    }
    const allowedReflowInvalidation = entry.status !== "closed"
      && replacement.arcId === undefined
      && allowArcBindingRemovalForBIds.has(entry.bId);
    if (entry.arcId && replacement.arcId !== entry.arcId && !allowedReflowInvalidation) {
      throw new Error(
        `Existing Arc binding for B ${JSON.stringify(entry.bId)} cannot be changed or removed: `
        + `${JSON.stringify(entry.arcId)}.`,
      );
    }
    if (
      !options.allowLifecycleTransition
      && entry.status === "active"
      && entry.arcId
      && !sameActiveEntry(entry, replacement)
    ) {
      throw new Error(
        `Active B ${JSON.stringify(entry.bId)} is bound to Arc ${JSON.stringify(entry.arcId)} and its durable `
        + "route contract cannot be edited through a normal Rail replacement. Close it through explicit reflow apply.",
      );
    }
    if (
      !options.allowLifecycleTransition
      && !lifecycleEditableDraft
      && entry.status !== "closed"
      && entry.status !== "retired"
      && replacement.status !== entry.status
    ) {
      throw new Error(
        `B-Rail lifecycle status for ${JSON.stringify(entry.bId)} cannot change from `
        + `${JSON.stringify(entry.status)} to ${JSON.stringify(replacement.status)} through a normal Rail replacement. `
        + "Use the explicit reflow apply lifecycle with its matching pending request.",
      );
    }
  }

  if (!options.allowLifecycleTransition) {
    for (const entry of incoming.arcRouteRail.entries) {
      if (existingEntryIds.has(entry.bId)) continue;
      const buildingInitialRoute = lifecycleEditableDraft
        && (entry.status === "active" || entry.status === "provisional" || entry.status === "hypothesis");
      if (!buildingInitialRoute && entry.status !== "hypothesis") {
        throw new Error(
          `New B-Rail id ${JSON.stringify(entry.bId)} must begin as a hypothesis through a normal Rail replacement. `
          + "Closed, active, provisional, or retired lifecycle states require initial plan creation or explicit reflow apply.",
        );
      }
    }
  }
}

function sameClosedEntry(left: ArcRouteEntry, right: ArcRouteEntry): boolean {
  return left.bId === right.bId
    && left.routeOrder === right.routeOrder
    && left.status === right.status
    && left.targetAnchorId === right.targetAnchorId
    && left.arcId === right.arcId
    && left.actualEpisodeCount === right.actualEpisodeCount
    && left.narrativeFunction === right.narrativeFunction
    && left.payoffAxis === right.payoffAxis
    && left.carriedReaderDebt === right.carriedReaderDebt
    && left.contrastRequirement === right.contrastRequirement;
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
