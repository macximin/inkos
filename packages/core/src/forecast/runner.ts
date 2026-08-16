import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentContext } from "../agents/base.js";
import { assertSafeBookId } from "../utils/book-id.js";
import { NarrativeForecastAgent } from "./agent.js";
import { buildForecastContext, renderForecastContextMarkdown } from "./context-builder.js";
import { renderForecastComparisonMarkdown, renderSelectedBranchPlanMarkdown } from "./render.js";
import {
  FORECAST_DEFAULT_BRANCHES,
  FORECAST_DEFAULT_HORIZON,
  FORECAST_MAX_BRANCHES,
  FORECAST_MAX_HORIZON,
  FORECAST_MIN_BRANCHES,
  FORECAST_MIN_HORIZON,
  type ForecastBranch,
  type NarrativeForecast,
} from "./schema.js";
import { ForecastStore, type ForecastStoreOptions } from "./store.js";
import { ArcStore } from "../arc/store.js";
import { createArcDraftFromForecast } from "../arc/forecast.js";
import { StoryRailStore } from "../arc/rail-store.js";
import { inspectStoryRailRuntimeEligibility } from "../arc/rail-context.js";
import { ActiveArcSchema, type ArcPacket } from "../arc/schema.js";
import type { StoryRailPlan } from "../arc/rail-schema.js";
import { StateManager } from "../state/manager.js";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";

// The three v1 operations from RFC #342: create / get / select. All artifacts
// stay under story/runtime/narrative-forecasts/<forecastId>/ — no operation
// here may write story/state/*.json, story/*.md control docs, or chapters/.

export interface CreateNarrativeForecastOptions {
  readonly projectRoot: string;
  readonly bookId: string;
  readonly divergence: string;
  readonly branchCount?: number;
  readonly horizon?: number;
  readonly runtime: AgentContext;
  readonly determinism?: ForecastStoreOptions;
  readonly onProgress?: (message: string) => void;
}

export interface NarrativeForecastCreateResult {
  readonly forecast: NarrativeForecast;
  readonly forecastJsonPath: string;
  readonly comparisonPath: string;
}

export async function createNarrativeForecast(
  options: CreateNarrativeForecastOptions,
): Promise<NarrativeForecastCreateResult> {
  const bookId = assertSafeBookId(options.bookId, "forecast.bookId");
  const divergence = options.divergence.trim();
  if (!divergence) {
    throw new Error("divergence is required: describe the decision point the forecast should branch on.");
  }
  const branchCount = boundedInteger(
    options.branchCount, FORECAST_DEFAULT_BRANCHES, "branchCount", FORECAST_MIN_BRANCHES, FORECAST_MAX_BRANCHES,
  );
  const horizon = boundedInteger(
    options.horizon, FORECAST_DEFAULT_HORIZON, "horizon", FORECAST_MIN_HORIZON, FORECAST_MAX_HORIZON,
  );
  const bookDir = await resolveBookDir(options.projectRoot, bookId);

  options.onProgress?.("Reading canonical context...");
  const context = await buildForecastContext({ bookDir, bookId });

  options.onProgress?.(`Projecting ${branchCount} candidate branches...`);
  const agent = new NarrativeForecastAgent(options.runtime);
  const modelOutput = await agent.generateBranches({
    contextMarkdown: renderForecastContextMarkdown(context),
    divergence,
    branchCount,
    horizon,
    baseChapter: context.baseChapter,
    language: context.language,
  });

  const store = new ForecastStore(bookDir, options.determinism);
  const forecast: NarrativeForecast = {
    version: 1,
    forecastId: await store.allocateForecastId(),
    bookId,
    createdAt: store.now().toISOString(),
    language: context.language,
    divergence,
    horizon,
    baseChapter: context.baseChapter,
    contextFingerprint: context.contextFingerprint,
    status: "active",
    branches: modelOutput.branches.map((branch, index) => ({
      branchId: `branch-${index + 1}`,
      ...branch,
    })),
  };

  options.onProgress?.("Writing forecast artifacts...");
  const paths = await store.save(forecast, renderForecastComparisonMarkdown(forecast));
  return { forecast, ...paths };
}

export interface GetNarrativeForecastOptions {
  readonly projectRoot: string;
  readonly bookId: string;
  readonly forecastId: string;
}

export interface NarrativeForecastGetResult {
  readonly forecast: NarrativeForecast;
  readonly stale: boolean;
  readonly forecastJsonPath: string;
  readonly comparisonPath: string;
}

export async function getNarrativeForecast(
  options: GetNarrativeForecastOptions,
): Promise<NarrativeForecastGetResult> {
  const bookId = assertSafeBookId(options.bookId, "forecast.bookId");
  const bookDir = await resolveBookDir(options.projectRoot, bookId);
  const store = new ForecastStore(bookDir);

  let forecast = await store.load(options.forecastId);
  const stale = await isForecastStale(bookDir, bookId, forecast);
  if (stale && forecast.status === "active") {
    // Persist the stale marker so later readers see it without recomputing.
    forecast = await store.markStale(forecast);
  }

  return {
    forecast,
    stale,
    forecastJsonPath: store.forecastJsonPath(forecast.forecastId),
    comparisonPath: store.comparisonPath(forecast.forecastId),
  };
}

export interface SelectNarrativeBranchOptions {
  readonly projectRoot: string;
  readonly bookId: string;
  readonly forecastId: string;
  readonly branchId: string;
  readonly determinism?: ForecastStoreOptions;
}

export interface NarrativeForecastSelectResult {
  readonly forecast: NarrativeForecast;
  readonly branch: ForecastBranch;
  readonly stale: boolean;
  readonly planPath: string;
  /** Fresh selections become an author-editable, active 1–3 chapter Arc. */
  readonly arc?: ArcPacket;
  /** False when a draft was saved but a ready active B protects another Arc. */
  readonly arcActivated: boolean;
  /** Optional active B slot bound without changing B-Rail order or status. */
  readonly railBinding?: { readonly bId: string; readonly changed: boolean };
  /** Explains an optional Rail binding warning or why Arc activation was withheld. */
  readonly railWarning?: string;
}

/**
 * Select one branch: writes a reviewable plan and, when still fresh, an active
 * editable Arc draft. Neither operation changes canonical prose, outline, or
 * runtime state; the Arc is an author-controlled planning packet.
 */
export async function selectNarrativeBranch(
  options: SelectNarrativeBranchOptions,
): Promise<NarrativeForecastSelectResult> {
  const bookId = assertSafeBookId(options.bookId, "forecast.bookId");
  const bookDir = await resolveBookDir(options.projectRoot, bookId);
  const store = new ForecastStore(bookDir, options.determinism);

  const forecast = await store.load(options.forecastId);
  const branch = forecast.branches.find((candidate) => candidate.branchId === options.branchId);
  if (!branch) {
    throw new Error(
      `Branch "${options.branchId}" not found in forecast "${forecast.forecastId}". `
      + `Available branches: ${forecast.branches.map((candidate) => candidate.branchId).join(", ")}`,
    );
  }

  const state = new StateManager(options.projectRoot);
  const releaseLock = await state.acquireBookLock(bookId);
  try {
    // Canonical context may have changed while the author was reviewing the
    // forecast. Recheck only after obtaining the same Book write lock used by
    // chapter and Rail mutations, then keep the lock through Arc activation.
    const stale = await isForecastStale(bookDir, bookId, forecast);
    const planPath = await store.writeSelectedPlan(
      forecast.forecastId,
      renderSelectedBranchPlanMarkdown({
        forecast,
        branch,
        selectedAt: store.now().toISOString(),
        stale,
      }),
    );

    if (stale) return { forecast, branch, stale, planPath, arcActivated: false };
    const arcStore = new ArcStore(bookDir, options.determinism);
    const arc = await createArcDraftFromForecast({ store: arcStore, forecast, branch });
    const railStore = new StoryRailStore(bookDir, options.determinism);
    const targetChapters = await readBookTargetChapters(bookDir);
    let railBinding: NarrativeForecastSelectResult["railBinding"];
    let preparedRailPlan: StoryRailPlan | undefined;
    let railWarning: string | undefined;
    try {
      const plan = await railStore.load();
      if (plan) {
        if (plan.bookId !== bookId) {
          throw new Error(
            `Story rail plan belongs to book ${JSON.stringify(plan.bookId)}, not ${JSON.stringify(bookId)}.`,
          );
        }
        const eligibility = inspectStoryRailRuntimeEligibility(plan, arc.id, targetChapters);
        if (eligibility.status === "active-b-conflict") {
          return {
            forecast,
            branch,
            stale,
            planPath,
            arc,
            arcActivated: false,
            railWarning: `Ready active B ${eligibility.bId} is already bound to Arc ${eligibility.boundArcId}; `
              + `the new Arc draft ${arc.id} was saved but story/arcs/active.json was not changed.`,
          };
        }
      }

      const binding = await railStore.prepareActiveArcBinding(bookId, arc.id);
      if (binding.status === "bound") {
        railBinding = { bId: binding.bId, changed: binding.changed };
        if (binding.changed) preparedRailPlan = binding.plan;
      } else if (binding.status === "missing-active") {
        railWarning = "A/B Rail plan has no active B; the Arc was activated without a Rail binding.";
      } else if (binding.status === "conflict") {
        return {
          forecast,
          branch,
          stale,
          planPath,
          arc,
          arcActivated: false,
          railWarning: binding.reason === "active_b_already_bound"
            ? `Active B ${binding.bId} is already bound to Arc ${binding.existingArcId}; `
              + `the new Arc draft ${arc.id} was saved but story/arcs/active.json was not changed.`
            : `Arc ${binding.requestedArcId} is already bound to B ${binding.bId}; `
              + "the new Arc draft was saved but story/arcs/active.json was not changed.",
        };
      }
    } catch (error) {
      railWarning = `Optional A/B Rail binding failed and was ignored: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (preparedRailPlan) {
      const active = ActiveArcSchema.parse({
        arcId: arc.id,
        updatedAt: arcStore.now().toISOString(),
      });
      await commitAtomicFileSet({
        rootDir: bookDir,
        writes: [
          {
            relativePath: join("story", "rails", "plan.json"),
            content: `${JSON.stringify(preparedRailPlan, null, 2)}\n`,
          },
          {
            relativePath: join("story", "arcs", "active.json"),
            content: `${JSON.stringify(active, null, 2)}\n`,
          },
        ],
      });
    } else {
      await arcStore.setActive(arc.id);
    }
    return {
      forecast,
      branch,
      stale,
      planPath,
      arc,
      arcActivated: true,
      ...(railBinding ? { railBinding } : {}),
      ...(railWarning ? { railWarning } : {}),
    };
  } finally {
    await releaseLock();
  }
}

async function isForecastStale(
  bookDir: string,
  bookId: string,
  forecast: NarrativeForecast,
): Promise<boolean> {
  if (forecast.status === "stale") return true;
  const context = await buildForecastContext({ bookDir, bookId });
  return context.contextFingerprint !== forecast.contextFingerprint;
}

async function resolveBookDir(projectRoot: string, bookId: string): Promise<string> {
  const bookDir = join(projectRoot, "books", bookId);
  try {
    await access(join(bookDir, "book.json"));
  } catch {
    throw new Error(`Book "${bookId}" not found under ${join(projectRoot, "books")}.`);
  }
  return bookDir;
}

async function readBookTargetChapters(bookDir: string): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(join(bookDir, "book.json"), "utf8")) as {
      readonly targetChapters?: unknown;
    };
    return Number.isInteger(parsed.targetChapters) && Number(parsed.targetChapters) >= 1
      ? Number(parsed.targetChapters)
      : 200;
  } catch {
    return 200;
  }
}

function boundedInteger(value: number | undefined, fallback: number, name: string, min: number, max: number): number {
  const parsed = value ?? fallback;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}
