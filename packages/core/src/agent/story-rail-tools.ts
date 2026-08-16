import { Type, type Static } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { StoryRailPlanInputSchema, type StoryRailPlan } from "../arc/rail-schema.js";
import { StoryRailStore, type BindActiveArcResult } from "../arc/rail-store.js";
import { StoryRailReflowStore } from "../arc/reflow-store.js";
import { ArcStore } from "../arc/store.js";
import { StateManager } from "../state/manager.js";
import { assertSafeBookId } from "../utils/book-id.js";

function textResult(text: string): AgentToolResult<undefined>;
function textResult<T>(text: string, details: T): AgentToolResult<T>;
function textResult<T = undefined>(text: string, details?: T): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details: details as T };
}

function resolveStoryRailBookId(
  toolName: string,
  paramsBookId: string | undefined,
  activeBookId: string | null,
): string {
  const resolvedBookId = paramsBookId ?? activeBookId ?? undefined;
  if (!resolvedBookId) {
    throw new Error(`${toolName} requires bookId when there is no active book.`);
  }
  const safeBookId = assertSafeBookId(resolvedBookId, `${toolName}.bookId`);
  if (paramsBookId && activeBookId && safeBookId !== activeBookId) {
    throw new Error(`${toolName}.bookId must match the active book.`);
  }
  return safeBookId;
}

const StableRailIdParam = Type.String({
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$",
  description: "Stable rail id. Once issued, keep it stable and never reuse a retired id.",
});

const RouteOrderParam = Type.Integer({
  minimum: 0,
  description: "Strictly increasing route order. Reorder with this value without renumbering stable ids.",
});

const DraftReadyStatusParam = Type.Union([
  Type.Literal("draft"),
  Type.Literal("ready"),
]);

const StoryAnchorParam = Type.Object({
  id: StableRailIdParam,
  routeOrder: RouteOrderParam,
  title: Type.String({ description: "Short human-facing name for this long-range destination." }),
  detailLevel: Type.Union([Type.Literal("compound"), Type.Literal("sparse")], {
    description: "Use compound only for nearby anchors; distant anchors stay sparse.",
  }),
  state: Type.Union([Type.Literal("planned"), Type.Literal("reached"), Type.Literal("retired")]),
  entryState: Type.String({ description: "Story state on entry to this anchor." }),
  trigger: Type.String({ description: "External or internal trigger that starts the anchor conversion." }),
  irreversibleChange: Type.String({ description: "Irreversible status, relationship, market, or world change." }),
  humanAftermath: Type.String({ description: "Human aftermath that remains after the conversion." }),
  readerDebt: Type.String({ description: "Reader promise or debt paid or carried at this anchor." }),
  payoffAxis: Type.String({ description: "Primary payoff or valuation axis." }),
  nextPressure: Type.String({ description: "Pressure that propels the story toward the next anchor." }),
});

const AnchorRailParam = Type.Object({
  status: DraftReadyStatusParam,
  anchors: Type.Array(StoryAnchorParam, {
    minItems: 1,
    description: "Complete ordered A-Rail. A ready plan has 6-12 live anchors; retired tombstones remain present and do not count toward that limit.",
  }),
});

const ArcRouteEntryParam = Type.Object({
  bId: StableRailIdParam,
  routeOrder: RouteOrderParam,
  status: Type.Union([
    Type.Literal("closed"),
    Type.Literal("active"),
    Type.Literal("provisional"),
    Type.Literal("hypothesis"),
    Type.Literal("retired"),
  ]),
  targetAnchorId: StableRailIdParam,
  arcId: Type.Optional(Type.String({
    pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$",
    description: "Optional concrete ArcPacket id bound to this B entry. Do not invent or overwrite a conflicting binding.",
  })),
  actualEpisodeCount: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 3,
    description: "Required historical span only when status is closed; forbidden for active, provisional, hypothesis, or retired entries.",
  })),
  narrativeFunction: Type.String({ description: "Durable narrative function; do not put exact future scenes here." }),
  payoffAxis: Type.String({ description: "Durable payoff axis." }),
  carriedReaderDebt: Type.String({ description: "Reader debt this B carries or pays." }),
  contrastRequirement: Type.String({ description: "How this B must differ from the preceding Arc." }),
});

const ArcRouteRailParam = Type.Object({
  status: DraftReadyStatusParam,
  entries: Type.Array(ArcRouteEntryParam, {
    description: "Complete ordered B-Rail. Existing ids may not be omitted; retire unused entries as tombstones.",
  }),
});

const StoryRailGetParams = Type.Object({
  bookId: Type.Optional(Type.String({
    description: "Book id. Defaults to the active book and must match it when both are present.",
  })),
});

type StoryRailGetParamsType = Static<typeof StoryRailGetParams>;

const StoryRailReplaceParams = Type.Object({
  bookId: Type.Optional(Type.String({
    description: "Book id. Defaults to the active book and must match it when both are present.",
  })),
  anchorRail: AnchorRailParam,
  arcRouteRail: ArcRouteRailParam,
});

type StoryRailReplaceParamsType = Static<typeof StoryRailReplaceParams>;

const StoryRailDurableRevisionParam = Type.Object({
  routeOrder: RouteOrderParam,
  targetAnchorId: StableRailIdParam,
  narrativeFunction: Type.String({ minLength: 1 }),
  payoffAxis: Type.String({ minLength: 1 }),
  carriedReaderDebt: Type.String({ minLength: 1 }),
  contrastRequirement: Type.String({ minLength: 1 }),
});

const StoryRailReflowDecisionParam = Type.Union([
  Type.Object({
    bId: StableRailIdParam,
    action: Type.Literal("keep"),
  }),
  Type.Object({
    bId: StableRailIdParam,
    action: Type.Literal("revise"),
    revision: StoryRailDurableRevisionParam,
  }),
  Type.Object({
    bId: StableRailIdParam,
    action: Type.Literal("retire"),
    reason: Type.String({ minLength: 1 }),
  }),
]);

const StoryRailReflowApplyParams = Type.Object({
  bookId: Type.Optional(Type.String({
    description: "Book id. Defaults to the active book and must match it when both are present.",
  })),
  pendingId: StableRailIdParam,
  expectedPlanUpdatedAt: Type.String({ description: "Exact plan timestamp from get_story_rails pending reflow." }),
  closeout: Type.Object({
    startState: Type.String({ minLength: 1 }),
    actualOutcome: Type.String({ minLength: 1 }),
    irreversibleSettlement: Type.String({ minLength: 1 }),
    humanRemainder: Type.String({ minLength: 1 }),
    readerDebt: Type.Object({
      paid: Type.Array(Type.String({ minLength: 1 })),
      carried: Type.Array(Type.String({ minLength: 1 })),
      retired: Type.Array(Type.String({ minLength: 1 })),
      emerged: Type.Array(Type.String({ minLength: 1 })),
    }),
    emergence: Type.Array(Type.String({ minLength: 1 })),
    anchorImpact: Type.Object({
      anchorId: StableRailIdParam,
      decision: Type.Literal("keep", {
        description: "This apply operation never mutates A-Rail. Revise A-Rail separately, then prepare again.",
      }),
      reason: Type.String({ minLength: 1 }),
    }),
    stateThroughChapter: Type.Integer({ minimum: 1 }),
  }),
  nextActiveBId: StableRailIdParam,
  nextProvisionalBId: Type.Optional(StableRailIdParam),
  decisions: Type.Array(StoryRailReflowDecisionParam, {
    description: "Exactly one explicit keep/revise/retire decision for every existing future live B.",
  }),
  newEntries: Type.Optional(Type.Array(ArcRouteEntryParam, {
    description: "New, unbound hypothesis entries needed to preserve route capacity after an early close or retirement.",
  })),
});

type StoryRailReflowApplyParamsType = Static<typeof StoryRailReflowApplyParams>;

const StoryRailReflowDiscardParams = Type.Object({
  bookId: Type.Optional(Type.String({
    description: "Book id. Defaults to the active book and must match it when both are present.",
  })),
  pendingId: StableRailIdParam,
  expectedPlanUpdatedAt: Type.String({ description: "Exact plan timestamp from get_story_rails pending reflow." }),
  reason: Type.String({
    minLength: 1,
    description: "Why the unapplied gate is being abandoned, for example direct Book-to-Chapter production continued.",
  }),
});

type StoryRailReflowDiscardParamsType = Static<typeof StoryRailReflowDiscardParams>;

export function createGetStoryRailsTool(
  activeBookId: string | null,
  projectRoot: string,
): AgentTool<typeof StoryRailGetParams> {
  return {
    name: "get_story_rails",
    description:
      "Read the active book's complete optional A-Rail and B-Rail plan from story/rails/plan.json. "
      + "Call this before replace_story_rails so every anchor, B entry, stable id, order, retired tombstone, "
      + "and Arc binding can be copied into the full replacement. Existing ids and bindings cannot be deleted by omission. "
      + "This tool is read-only.",
    label: "Get Story Rails",
    parameters: StoryRailGetParams,
    async execute(
      _toolCallId: string,
      params: StoryRailGetParamsType,
    ): Promise<AgentToolResult<unknown>> {
      const bookId = resolveStoryRailBookId("get_story_rails", params.bookId, activeBookId);
      const store = new StoryRailStore(join(projectRoot, "books", bookId));
      const reflowStore = new StoryRailReflowStore(join(projectRoot, "books", bookId));
      const plan = await store.load();
      if (!plan) {
        return textResult(
          `No A/B Rail plan exists for book ${JSON.stringify(bookId)}. `
          + "A new plan may be created with replace_story_rails using a complete anchorRail and arcRouteRail.",
          { kind: "story_rails", bookId, path: store.planPath, plan: null, pendingReflow: null },
        );
      }

      const pendingReflow = await reflowStore.getPending(bookId);

      const currentTargetChapters = await readCurrentTargetChapters(join(projectRoot, "books", bookId));
      const warnings = currentTargetChapters !== null
        && plan.routeCapacity.targetChaptersSnapshot !== currentTargetChapters
        ? [
            `The Rail capacity snapshot targets ${plan.routeCapacity.targetChaptersSnapshot} chapters, `
            + `but the Book now targets ${currentTargetChapters}. Replace/reflow the complete plan before treating it as ready.`,
          ]
        : [];

      return textResult(
        [
          `Complete A/B Rail plan for book ${JSON.stringify(bookId)}:`,
          JSON.stringify(plan, null, 2),
          ...warnings.map((warning) => `WARNING: ${warning}`),
          ...(pendingReflow
            ? [
                `REFLOW REQUIRED: pending ${JSON.stringify(pendingReflow.pendingId)} closes `
                + `${pendingReflow.activeB.bId}/${pendingReflow.arc.id} through chapter `
                + `${pendingReflow.endpointChapterNumber}. Review every future B explicitly, then use apply_story_rail_reflow.`,
                "If direct Book → Chapter production has intentionally continued past that endpoint, use "
                + "discard_story_rail_reflow explicitly before replacing the protected active B.",
              ]
            : []),
          "replace_story_rails is full replacement: include every existing id; retire items explicitly instead of omitting them.",
        ].join("\n"),
        { kind: "story_rails", bookId, path: store.planPath, plan, pendingReflow, warnings },
      );
    },
  };
}

export function createReplaceStoryRailsTool(
  activeBookId: string | null,
  projectRoot: string,
): AgentTool<typeof StoryRailReplaceParams> {
  return {
    name: "replace_story_rails",
    description:
      "Fully replace the active book's A-Rail and B-Rail plan. Always call get_story_rails first and send the complete "
      + "anchorRail and arcRouteRail, including every stable id, retired tombstone, existing Arc binding, and entry that "
      + "already exists; omission is rejected, and retired/closed history or an existing Arc binding cannot be revived or "
      + "overwritten. This is not a patch. A ready B-Rail must cover the Book target at the 1-3 chapter Arc cap. "
      + "After saving, if a current active Arc exists and "
      + "the active B entry is unbound, InkOS binds it. An existing conflicting binding is preserved and reported as a warning.",
    label: "Replace Story Rails",
    parameters: StoryRailReplaceParams,
    async execute(
      _toolCallId: string,
      params: StoryRailReplaceParamsType,
    ): Promise<AgentToolResult<unknown>> {
      const bookId = resolveStoryRailBookId("replace_story_rails", params.bookId, activeBookId);
      const bookDir = join(projectRoot, "books", bookId);
      const input = StoryRailPlanInputSchema.parse({
        anchorRail: params.anchorRail,
        arcRouteRail: params.arcRouteRail,
      });
      const state = new StateManager(projectRoot);
      // acquireBookLock creates its lock directory, so prove the Book exists
      // first and avoid leaving a ghost directory for an invalid explicit id.
      await state.loadBookConfig(bookId);
      const releaseLock = await state.acquireBookLock(bookId);
      try {
        const store = new StoryRailStore(bookDir);
        const previous = await store.load();
        let plan = await store.replace(bookId, input);
        const warnings: string[] = [];
        let binding: BindingDetails = { status: "not-attempted", reason: "no-active-arc" };

        try {
          const activeArc = await new ArcStore(bookDir).getActive();
          if (activeArc && activeArc.bookId !== bookId) {
            warnings.push(
              `Current active Arc ${JSON.stringify(activeArc.id)} belongs to book ${JSON.stringify(activeArc.bookId)}; `
              + "its id was not bound into this book's B-Rail.",
            );
            binding = { status: "not-attempted", reason: "active-arc-book-mismatch", arcId: activeArc.id };
          } else if (activeArc) {
            const result = await store.bindActiveArc(bookId, activeArc.id);
            plan = result.plan ?? plan;
            binding = summarizeBinding(result);
            const warning = bindingWarning(result);
            if (warning) warnings.push(warning);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`The Rail plan was saved, but current active Arc binding could not be checked: ${message}`);
          binding = { status: "error", reason: message };
        }

        const summary = [
          `${previous ? "Replaced" : "Created"} the complete A/B Rail plan for book ${JSON.stringify(bookId)}.`,
          `Saved ${plan.anchorRail.anchors.length} anchor(s) and ${plan.arcRouteRail.entries.length} B-Rail entry/entries at ${store.planPath}.`,
          bindingText(binding),
          ...warnings.map((warning) => `WARNING: ${warning}`),
        ].filter(Boolean).join("\n");

        return textResult(summary, {
          kind: "story_rails_replaced",
          bookId,
          path: store.planPath,
          plan,
          binding,
          warnings,
        });
      } finally {
        await releaseLock();
      }
    },
  };
}

export function createApplyStoryRailReflowTool(
  activeBookId: string | null,
  projectRoot: string,
): AgentTool<typeof StoryRailReflowApplyParams> {
  return {
    name: "apply_story_rail_reflow",
    description:
      "Apply a prepared B close/reflow as one atomic transaction. Call get_story_rails first and use its exact "
      + "pendingReflow id and expected plan timestamp. This tool requires a closeout, an explicit next active B, "
      + "and exactly one keep/revise/retire decision for every existing future live B; it never silently promotes "
      + "the provisional B. The current provisional must become the explicitly selected next active B or be explicitly "
      + "retired; it is never silently demoted. Add new unbound hypothesis entries when early closure or retirement would reduce route "
      + "capacity. A-Rail is not changed here: revise it separately and prepare a fresh closeout when Anchor direction changes.",
    label: "Apply Story Rail Reflow",
    parameters: StoryRailReflowApplyParams,
    async execute(
      _toolCallId: string,
      params: StoryRailReflowApplyParamsType,
    ): Promise<AgentToolResult<unknown>> {
      const bookId = resolveStoryRailBookId("apply_story_rail_reflow", params.bookId, activeBookId);
      const state = new StateManager(projectRoot);
      await state.loadBookConfig(bookId);
      const releaseLock = await state.acquireBookLock(bookId);
      try {
        const chapters = await state.loadChapterIndex(bookId);
        const result = await new StoryRailReflowStore(join(projectRoot, "books", bookId)).apply(bookId, chapters, {
          pendingId: params.pendingId,
          expectedPlanUpdatedAt: params.expectedPlanUpdatedAt,
          closeout: params.closeout,
          nextActiveBId: params.nextActiveBId,
          ...(params.nextProvisionalBId ? { nextProvisionalBId: params.nextProvisionalBId } : {}),
          decisions: params.decisions,
          newEntries: params.newEntries ?? [],
        });
        return textResult(
          [
            `Applied Story Rail reflow ${JSON.stringify(result.receipt.receiptId)} for book ${JSON.stringify(bookId)}.`,
            `Closed B ${JSON.stringify(result.receipt.closedB.bId)} after ${result.receipt.closedB.actualEpisodeCount} chapter(s).`,
            `New active B: ${JSON.stringify(result.receipt.nextActiveBId)}.`,
            result.receipt.nextProvisionalBId
              ? `New provisional B: ${JSON.stringify(result.receipt.nextProvisionalBId)}.`
              : "No provisional B was selected.",
            result.receipt.nextActiveArcId
              ? `Activated its bound Arc ${JSON.stringify(result.receipt.nextActiveArcId)}.`
              : "The completed Arc pointer was cleared; Book → Chapter remains available until the new active B receives an Arc.",
          ].join("\n"),
          {
            kind: "story_rail_reflow_applied",
            bookId,
            plan: result.plan,
            receipt: result.receipt,
            pendingReflow: null,
          },
        );
      } finally {
        await releaseLock();
      }
    },
  };
}

export function createDiscardStoryRailReflowTool(
  activeBookId: string | null,
  projectRoot: string,
): AgentTool<typeof StoryRailReflowDiscardParams> {
  return {
    name: "discard_story_rail_reflow",
    description:
      "Explicitly discard an unapplied Story Rail reflow gate when direct Book-to-Chapter production continued or the "
      + "closeout is intentionally abandoned. Call get_story_rails first and copy its exact pending id and plan timestamp. "
      + "This writes an immutable discard receipt and removes only the pending pointer; it does not change Chapters, A/B Rails, "
      + "the active Arc, or any Arc binding.",
    label: "Discard Story Rail Reflow",
    parameters: StoryRailReflowDiscardParams,
    async execute(
      _toolCallId: string,
      params: StoryRailReflowDiscardParamsType,
    ): Promise<AgentToolResult<unknown>> {
      const bookId = resolveStoryRailBookId("discard_story_rail_reflow", params.bookId, activeBookId);
      const state = new StateManager(projectRoot);
      await state.loadBookConfig(bookId);
      const releaseLock = await state.acquireBookLock(bookId);
      try {
        const result = await new StoryRailReflowStore(join(projectRoot, "books", bookId)).discard(bookId, {
          pendingId: params.pendingId,
          expectedPlanUpdatedAt: params.expectedPlanUpdatedAt,
          reason: params.reason,
        });
        const plan = await new StoryRailStore(join(projectRoot, "books", bookId)).load();
        return textResult(
          `Discarded pending Story Rail reflow ${JSON.stringify(result.receipt.pending.pendingId)} for book `
          + `${JSON.stringify(bookId)}. The immutable discard receipt was preserved; Book → Chapter, the Rail, and Arc truth were unchanged.`,
          {
            kind: "story_rail_reflow_discarded",
            bookId,
            plan,
            receipt: result.receipt,
            pendingReflow: null,
          },
        );
      } finally {
        await releaseLock();
      }
    },
  };
}

type BindingDetails =
  | { readonly status: "not-attempted"; readonly reason: "no-active-arc" }
  | { readonly status: "not-attempted"; readonly reason: "active-arc-book-mismatch"; readonly arcId: string }
  | { readonly status: "bound"; readonly changed: boolean; readonly bId: string; readonly arcId: string }
  | {
      readonly status: "conflict";
      readonly reason: "active_b_already_bound" | "arc_already_bound_elsewhere";
      readonly bId: string;
      readonly existingArcId: string;
      readonly requestedArcId: string;
    }
  | { readonly status: "missing-active" }
  | { readonly status: "missing-plan" }
  | { readonly status: "error"; readonly reason: string };

function summarizeBinding(result: BindActiveArcResult): BindingDetails {
  if (result.status === "bound") {
    return {
      status: "bound",
      changed: result.changed,
      bId: result.bId,
      arcId: result.arcId,
    };
  }
  if (result.status === "conflict") {
    return {
      status: "conflict",
      reason: result.reason,
      bId: result.bId,
      existingArcId: result.existingArcId,
      requestedArcId: result.requestedArcId,
    };
  }
  return { status: result.status };
}

function bindingWarning(result: BindActiveArcResult): string | null {
  if (result.status === "conflict") {
    if (result.reason === "active_b_already_bound") {
      return `Active B ${JSON.stringify(result.bId)} remains bound to ${JSON.stringify(result.existingArcId)}; `
        + `current active Arc ${JSON.stringify(result.requestedArcId)} was not allowed to overwrite it.`;
    }
    return `Current active Arc ${JSON.stringify(result.requestedArcId)} is already bound to B ${JSON.stringify(result.bId)}; `
      + "the active B entry was left unchanged.";
  }
  if (result.status === "missing-active") {
    return "The saved B-Rail has no active entry, so the current active Arc could not be bound.";
  }
  if (result.status === "missing-plan") {
    return "The saved Rail plan could not be reloaded for active Arc binding.";
  }
  return null;
}

function bindingText(binding: BindingDetails): string {
  if (binding.status === "bound") {
    return binding.changed
      ? `Bound current active Arc ${JSON.stringify(binding.arcId)} to active B ${JSON.stringify(binding.bId)}.`
      : `Current active Arc ${JSON.stringify(binding.arcId)} was already bound to active B ${JSON.stringify(binding.bId)}.`;
  }
  if (binding.status === "not-attempted" && binding.reason === "no-active-arc") {
    return "No current active Arc exists; no B-Rail binding was needed.";
  }
  return "";
}

async function readCurrentTargetChapters(bookDir: string): Promise<number | null> {
  try {
    const parsed = JSON.parse(await readFile(join(bookDir, "book.json"), "utf-8")) as {
      readonly targetChapters?: unknown;
    };
    return Number.isInteger(parsed.targetChapters) && Number(parsed.targetChapters) >= 1
      ? Number(parsed.targetChapters)
      : null;
  } catch {
    return null;
  }
}
