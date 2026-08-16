import {
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  Link2,
  Milestone,
  PencilLine,
  Route,
} from "lucide-react";
import type { ToolExecution } from "../../store/chat/types";
import { tr } from "../../lib/app-language";

type RailReadiness = "draft" | "ready";
type AnchorState = "planned" | "reached" | "retired";
type AnchorDetailLevel = "compound" | "sparse";
type ArcRouteStatus = "closed" | "active" | "provisional" | "hypothesis" | "retired";

export interface StoryRailAnchorPreview {
  readonly id: string;
  readonly routeOrder: number;
  readonly title: string;
  readonly detailLevel: AnchorDetailLevel;
  readonly state: AnchorState;
  readonly entryState: string;
  readonly trigger: string;
  readonly irreversibleChange: string;
  readonly humanAftermath: string;
  readonly readerDebt: string;
  readonly payoffAxis: string;
  readonly nextPressure: string;
}

export interface StoryRailRouteEntryPreview {
  readonly bId: string;
  readonly routeOrder: number;
  readonly status: ArcRouteStatus;
  readonly targetAnchorId: string;
  readonly arcId?: string;
  readonly actualEpisodeCount?: 1 | 2 | 3;
  readonly narrativeFunction: string;
  readonly payoffAxis: string;
  readonly carriedReaderDebt: string;
  readonly contrastRequirement: string;
}

export interface StoryRailPlanPreview {
  readonly version: 1;
  readonly bookId: string;
  readonly anchorRail: {
    readonly status: RailReadiness;
    readonly anchors: readonly StoryRailAnchorPreview[];
  };
  readonly arcRouteRail: {
    readonly status: RailReadiness;
    readonly entries: readonly StoryRailRouteEntryPreview[];
  };
  readonly routeCapacity: {
    readonly targetChaptersSnapshot: number;
    readonly arcEpisodeCap: 3;
  };
}

export interface StoryRailBindingPreview {
  readonly status: "not-attempted" | "bound" | "conflict" | "missing-active" | "missing-plan" | "error";
  readonly reason?: string;
  readonly changed?: boolean;
  readonly bId?: string;
  readonly arcId?: string;
  readonly existingArcId?: string;
  readonly requestedArcId?: string;
}

export interface StoryRailPendingReflowPreview {
  readonly pendingId: string;
  readonly expectedPlanUpdatedAt: string;
  readonly activeB: {
    readonly bId: string;
    readonly arcId: string;
    readonly targetAnchorId: string;
  };
  readonly endpointChapterNumber: number;
  readonly actualEpisodeCount: 1 | 2 | 3;
}

export interface StoryRailsPreviewDetails {
  readonly kind: "story_rails" | "story_rails_replaced" | "story_rail_reflow_applied" | "story_rail_reflow_discarded";
  readonly bookId: string;
  readonly plan: StoryRailPlanPreview | null;
  readonly binding?: StoryRailBindingPreview;
  readonly pendingReflow?: StoryRailPendingReflowPreview;
  readonly warnings: readonly string[];
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(record: Record<string, unknown>, key: string, allowEmpty = true): string | null {
  const value = record[key];
  if (typeof value !== "string") return null;
  if (!allowEmpty && !value.trim()) return null;
  return value;
}

function optionalStringValue(record: Record<string, unknown>, key: string): string | undefined | null {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === "string" && value.trim() ? value : null;
}

function routeOrderValue(record: Record<string, unknown>): number | null {
  const value = record.routeOrder;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseAnchor(value: unknown): StoryRailAnchorPreview | null {
  const record = recordOf(value);
  if (!record) return null;
  const id = stringValue(record, "id", false);
  const routeOrder = routeOrderValue(record);
  const title = stringValue(record, "title");
  const detailLevel = record.detailLevel;
  const state = record.state;
  const entryState = stringValue(record, "entryState");
  const trigger = stringValue(record, "trigger");
  const irreversibleChange = stringValue(record, "irreversibleChange");
  const humanAftermath = stringValue(record, "humanAftermath");
  const readerDebt = stringValue(record, "readerDebt");
  const payoffAxis = stringValue(record, "payoffAxis");
  const nextPressure = stringValue(record, "nextPressure");
  if (
    !id
    || routeOrder === null
    || title === null
    || (detailLevel !== "compound" && detailLevel !== "sparse")
    || (state !== "planned" && state !== "reached" && state !== "retired")
    || entryState === null
    || trigger === null
    || irreversibleChange === null
    || humanAftermath === null
    || readerDebt === null
    || payoffAxis === null
    || nextPressure === null
  ) return null;
  return {
    id,
    routeOrder,
    title,
    detailLevel,
    state,
    entryState,
    trigger,
    irreversibleChange,
    humanAftermath,
    readerDebt,
    payoffAxis,
    nextPressure,
  };
}

function parseRouteEntry(value: unknown): StoryRailRouteEntryPreview | null {
  const record = recordOf(value);
  if (!record) return null;
  const bId = stringValue(record, "bId", false);
  const routeOrder = routeOrderValue(record);
  const status = record.status;
  const targetAnchorId = stringValue(record, "targetAnchorId", false);
  const arcId = optionalStringValue(record, "arcId");
  const actualEpisodeCount = record.actualEpisodeCount;
  const narrativeFunction = stringValue(record, "narrativeFunction");
  const payoffAxis = stringValue(record, "payoffAxis");
  const carriedReaderDebt = stringValue(record, "carriedReaderDebt");
  const contrastRequirement = stringValue(record, "contrastRequirement");
  if (
    !bId
    || routeOrder === null
    || !["closed", "active", "provisional", "hypothesis", "retired"].includes(String(status))
    || !targetAnchorId
    || arcId === null
    || narrativeFunction === null
    || payoffAxis === null
    || carriedReaderDebt === null
    || contrastRequirement === null
  ) return null;
  if (status === "closed") {
    if (actualEpisodeCount !== 1 && actualEpisodeCount !== 2 && actualEpisodeCount !== 3) return null;
  } else if (actualEpisodeCount !== undefined) {
    return null;
  }
  return {
    bId,
    routeOrder,
    status: status as ArcRouteStatus,
    targetAnchorId,
    ...(arcId ? { arcId } : {}),
    ...(status === "closed" ? { actualEpisodeCount: actualEpisodeCount as 1 | 2 | 3 } : {}),
    narrativeFunction,
    payoffAxis,
    carriedReaderDebt,
    contrastRequirement,
  };
}

function hasUniqueValues<T>(items: readonly T[], select: (item: T) => string | number): boolean {
  const values = items.map(select);
  return new Set(values).size === values.length;
}

function parsePlan(value: unknown): StoryRailPlanPreview | null {
  const record = recordOf(value);
  if (!record || record.version !== 1) return null;
  const bookId = stringValue(record, "bookId", false);
  const anchorRail = recordOf(record.anchorRail);
  const arcRouteRail = recordOf(record.arcRouteRail);
  const routeCapacity = recordOf(record.routeCapacity);
  if (!bookId || !anchorRail || !arcRouteRail || !routeCapacity) return null;
  if (anchorRail.status !== "draft" && anchorRail.status !== "ready") return null;
  if (arcRouteRail.status !== "draft" && arcRouteRail.status !== "ready") return null;
  if (!Array.isArray(anchorRail.anchors) || anchorRail.anchors.length < 1) return null;
  if (!Array.isArray(arcRouteRail.entries)) return null;
  const targetChaptersSnapshot = routeCapacity.targetChaptersSnapshot;
  if (
    typeof targetChaptersSnapshot !== "number"
    || !Number.isSafeInteger(targetChaptersSnapshot)
    || targetChaptersSnapshot < 1
    || routeCapacity.arcEpisodeCap !== 3
  ) return null;

  const anchors = anchorRail.anchors.map(parseAnchor);
  const entries = arcRouteRail.entries.map(parseRouteEntry);
  if (anchors.some((anchor) => anchor === null) || entries.some((entry) => entry === null)) return null;
  const safeAnchors = anchors as StoryRailAnchorPreview[];
  const safeEntries = entries as StoryRailRouteEntryPreview[];
  const anchorIds = new Set(safeAnchors.map((anchor) => anchor.id));
  if (
    !hasUniqueValues(safeAnchors, (anchor) => anchor.id)
    || !hasUniqueValues(safeAnchors, (anchor) => anchor.routeOrder)
    || !hasUniqueValues(safeEntries, (entry) => entry.bId)
    || !hasUniqueValues(safeEntries, (entry) => entry.routeOrder)
    || safeEntries.some((entry) => !anchorIds.has(entry.targetAnchorId))
  ) return null;

  return {
    version: 1,
    bookId,
    anchorRail: {
      status: anchorRail.status,
      anchors: [...safeAnchors].sort((left, right) => left.routeOrder - right.routeOrder),
    },
    arcRouteRail: {
      status: arcRouteRail.status,
      entries: [...safeEntries].sort((left, right) => left.routeOrder - right.routeOrder),
    },
    routeCapacity: {
      targetChaptersSnapshot,
      arcEpisodeCap: 3,
    },
  };
}

export function calculateStoryRailRouteCapacity(plan: StoryRailPlanPreview): number {
  return plan.arcRouteRail.entries.reduce((total, entry) => {
    if (entry.status === "closed") return total + (entry.actualEpisodeCount ?? 0);
    if (entry.status === "active" || entry.status === "provisional" || entry.status === "hypothesis") {
      return total + plan.routeCapacity.arcEpisodeCap;
    }
    return total;
  }, 0);
}

function parseBinding(value: unknown): StoryRailBindingPreview | undefined {
  const record = recordOf(value);
  if (!record) return undefined;
  const status = record.status;
  if (!["not-attempted", "bound", "conflict", "missing-active", "missing-plan", "error"].includes(String(status))) {
    return undefined;
  }
  const optionalKeys = ["reason", "bId", "arcId", "existingArcId", "requestedArcId"] as const;
  const fields: Partial<Record<(typeof optionalKeys)[number], string>> = {};
  for (const key of optionalKeys) {
    const parsed = optionalStringValue(record, key);
    if (parsed === null) return undefined;
    if (parsed) fields[key] = parsed;
  }
  if (record.changed !== undefined && typeof record.changed !== "boolean") return undefined;
  return {
    status: status as StoryRailBindingPreview["status"],
    ...fields,
    ...(typeof record.changed === "boolean" ? { changed: record.changed } : {}),
  };
}

function parseWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePendingReflow(value: unknown): StoryRailPendingReflowPreview | undefined {
  const record = recordOf(value);
  if (!record) return undefined;
  const pendingId = stringValue(record, "pendingId", false);
  const expectedPlanUpdatedAt = stringValue(record, "expectedPlanUpdatedAt", false);
  const activeB = recordOf(record.activeB);
  const bId = activeB ? stringValue(activeB, "bId", false) : null;
  const arcId = activeB ? stringValue(activeB, "arcId", false) : null;
  const targetAnchorId = activeB ? stringValue(activeB, "targetAnchorId", false) : null;
  const endpointChapterNumber = record.endpointChapterNumber;
  const actualEpisodeCount = record.actualEpisodeCount;
  if (
    !pendingId
    || !expectedPlanUpdatedAt
    || !bId
    || !arcId
    || !targetAnchorId
    || typeof endpointChapterNumber !== "number"
    || !Number.isSafeInteger(endpointChapterNumber)
    || endpointChapterNumber < 1
    || (actualEpisodeCount !== 1 && actualEpisodeCount !== 2 && actualEpisodeCount !== 3)
  ) return undefined;
  return {
    pendingId,
    expectedPlanUpdatedAt,
    activeB: { bId, arcId, targetAnchorId },
    endpointChapterNumber,
    actualEpisodeCount,
  };
}

export function getStoryRailsPreviewDetails(exec: ToolExecution): StoryRailsPreviewDetails | null {
  if (
    exec.tool !== "get_story_rails"
    && exec.tool !== "replace_story_rails"
    && exec.tool !== "apply_story_rail_reflow"
    && exec.tool !== "discard_story_rail_reflow"
  ) return null;
  const record = recordOf(exec.details);
  if (!record) return null;
  const expectedKind = exec.tool === "get_story_rails"
    ? "story_rails"
    : exec.tool === "replace_story_rails"
      ? "story_rails_replaced"
      : exec.tool === "apply_story_rail_reflow"
        ? "story_rail_reflow_applied"
        : "story_rail_reflow_discarded";
  if (record.kind !== expectedKind) return null;
  const bookId = stringValue(record, "bookId", false);
  if (!bookId || !("plan" in record)) return null;
  const plan = record.plan === null ? null : parsePlan(record.plan);
  if (record.plan !== null && !plan) return null;
  if (plan && plan.bookId !== bookId) return null;
  return {
    kind: expectedKind,
    bookId,
    plan,
    ...(expectedKind === "story_rails_replaced" ? { binding: parseBinding(record.binding) } : {}),
    ...(parsePendingReflow(record.pendingReflow)
      ? { pendingReflow: parsePendingReflow(record.pendingReflow) }
      : {}),
    warnings: parseWarnings(record.warnings),
  };
}

function readinessLabel(status: RailReadiness): string {
  return status === "ready"
    ? tr("可用", "Ready", "사용 가능")
    : tr("草稿", "Draft", "초안");
}

function anchorStateLabel(state: AnchorState): string {
  if (state === "reached") return tr("已抵达", "Reached", "도달함");
  if (state === "retired") return tr("已退役", "Retired", "사용 종료");
  return tr("计划中", "Planned", "계획 중");
}

function routeStatusLabel(status: ArcRouteStatus): string {
  const labels: Record<ArcRouteStatus, readonly [string, string, string]> = {
    closed: ["已完成", "Closed", "완료"],
    active: ["当前", "Active", "현재"],
    provisional: ["暂定", "Provisional", "잠정"],
    hypothesis: ["假设", "Hypothesis", "가설"],
    retired: ["已退役", "Retired", "사용 종료"],
  };
  const value = labels[status];
  return tr(value[0], value[1], value[2]);
}

function stateClasses(state: AnchorState | ArcRouteStatus): string {
  if (state === "active" || state === "reached") {
    return "border-emerald-500/25 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300";
  }
  if (state === "provisional" || state === "hypothesis") {
    return "border-amber-500/25 bg-amber-500/8 text-amber-800 dark:text-amber-200";
  }
  if (state === "retired") {
    return "border-border/45 bg-muted/30 text-muted-foreground line-through";
  }
  return "border-primary/20 bg-primary/5 text-primary";
}

function DetailRow({ label, value }: { readonly label: string; readonly value: string }) {
  if (!value.trim()) return null;
  return (
    <div className="grid grid-cols-[minmax(72px,0.28fr)_1fr] gap-2 text-xs leading-5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-foreground/90">{value}</dd>
    </div>
  );
}

function AnchorCard({ anchor, index }: { readonly anchor: StoryRailAnchorPreview; readonly index: number }) {
  return (
    <li className="relative rounded-xl border border-border/55 bg-background/70 px-3.5 py-3 shadow-[0_10px_28px_-26px_rgba(0,0,0,0.7)]">
      {index > 0 && <span aria-hidden className="absolute -top-3 left-6 h-3 w-px bg-primary/30" />}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-primary/75">
            <span>{tr(`锚点 ${index + 1}`, `Anchor ${index + 1}`, `Anchor ${index + 1}`)}</span>
            <span className="font-mono normal-case tracking-normal text-muted-foreground/70">{anchor.id}</span>
          </div>
          <h5 className="mt-1 text-[15px] font-semibold leading-5 text-foreground">{anchor.title || tr("未命名锚点", "Untitled anchor", "이름 없는 Anchor")}</h5>
        </div>
        <span className={`rounded-full border px-2 py-0.5 text-[11px] ${stateClasses(anchor.state)}`}>
          {anchorStateLabel(anchor.state)}
        </span>
      </div>
      <dl className="mt-3 space-y-1.5 border-t border-border/35 pt-2.5">
        <DetailRow label={tr("进入时", "On entry", "진입 상태")} value={anchor.entryState} />
        <DetailRow label={tr("触发点", "Trigger", "촉발점")} value={anchor.trigger} />
        <DetailRow label={tr("不可逆变化", "Permanent change", "비가역 변화")} value={anchor.irreversibleChange} />
        <DetailRow label={tr("人物余波", "Human aftermath", "인물에게 남는 결과")} value={anchor.humanAftermath} />
        <DetailRow label={tr("读者承诺", "Reader promise", "독자 약속")} value={anchor.readerDebt} />
        <DetailRow label={tr("回报方向", "Payoff direction", "보상 방향")} value={anchor.payoffAxis} />
        <DetailRow label={tr("下一股压力", "Next pressure", "다음 압력")} value={anchor.nextPressure} />
      </dl>
    </li>
  );
}

function RouteCard({
  entry,
  target,
}: {
  readonly entry: StoryRailRouteEntryPreview;
  readonly target: StoryRailAnchorPreview;
}) {
  return (
    <li className={`rounded-xl border px-3.5 py-3 ${entry.status === "active" ? "border-emerald-500/35 bg-emerald-500/5" : "border-border/55 bg-background/70"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] font-semibold text-primary">{entry.bId}</span>
            <span className={`rounded-full border px-2 py-0.5 text-[11px] ${stateClasses(entry.status)}`}>
              {routeStatusLabel(entry.status)}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Route size={13} className="shrink-0 text-primary" />
            <span className="text-muted-foreground">{tr("目标", "Toward", "목표")}</span>
            <span>{target.title || target.id}</span>
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          {entry.actualEpisodeCount !== undefined && (
            <span className="inline-flex items-center rounded-full border border-emerald-500/25 bg-emerald-500/8 px-2 py-1 text-[11px] text-emerald-700 dark:text-emerald-300">
              {tr(`实际 ${entry.actualEpisodeCount} 章`, `${entry.actualEpisodeCount} actual chapter${entry.actualEpisodeCount === 1 ? "" : "s"}`, `실제 ${entry.actualEpisodeCount}화`)}
            </span>
          )}
          <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] ${entry.arcId ? "border-sky-500/25 bg-sky-500/8 text-sky-700 dark:text-sky-300" : "border-border/50 bg-muted/25 text-muted-foreground"}`}>
            <Link2 size={10} />
            {entry.arcId
              ? tr(`已连接 Arc · ${entry.arcId}`, `Arc linked · ${entry.arcId}`, `Arc 연결 · ${entry.arcId}`)
              : tr("尚未连接 Arc", "Arc not linked yet", "아직 Arc 미연결")}
          </span>
        </div>
      </div>
      <dl className="mt-3 space-y-1.5 border-t border-border/35 pt-2.5">
        <DetailRow label={tr("叙事职责", "Story job", "서사 역할")} value={entry.narrativeFunction} />
        <DetailRow label={tr("回报方向", "Payoff direction", "보상 방향")} value={entry.payoffAxis} />
        <DetailRow label={tr("承接承诺", "Promise carried", "이어갈 독자 약속")} value={entry.carriedReaderDebt} />
        <DetailRow label={tr("差异要求", "Must contrast with", "이전 Arc와의 차이")} value={entry.contrastRequirement} />
      </dl>
    </li>
  );
}

function CapacitySummary({ plan }: { readonly plan: StoryRailPlanPreview }) {
  const maximum = calculateStoryRailRouteCapacity(plan);
  const target = plan.routeCapacity.targetChaptersSnapshot;
  const difference = maximum - target;
  const readyMismatch = plan.arcRouteRail.status === "ready" && difference < 0;
  return (
    <section
      data-story-rail-capacity={`${maximum}/${target}`}
      data-capacity-warning={readyMismatch ? "true" : "false"}
      className={`xl:col-span-2 rounded-xl border px-3.5 py-3 ${readyMismatch ? "border-amber-500/30 bg-amber-500/8" : "border-sky-500/20 bg-sky-500/5"}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            {readyMismatch ? <AlertTriangle size={14} className="text-amber-700 dark:text-amber-300" /> : <Route size={14} className="text-sky-700 dark:text-sky-300" />}
            {tr("路线容量", "Route capacity", "경로 수용량")}
          </div>
          <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
            {tr(
              "已完成的 B 按实际章数计算；其余开放 B 每段最多按 3 章计算。目标是保存 Rail 时的 Book 目标快照。",
              "Closed B entries use their actual count; each other open B can hold at most 3 chapters. The target is the Book snapshot saved with this Rail.",
              "완료된 B는 실제 화수로, 나머지 열린 B는 항목당 최대 3화로 계산합니다. 목표는 이 Rail 저장 시점의 Book 목표 화수입니다.",
            )}
          </p>
        </div>
        <div className="shrink-0 rounded-lg border border-border/50 bg-background/70 px-3 py-2 text-right">
          <div className="text-sm font-semibold text-foreground">
            {tr(`最多 ${maximum} 章 / 目标 ${target} 章`, `Up to ${maximum} / target ${target} chapters`, `최대 ${maximum}화 / 목표 ${target}화`)}
          </div>
          <div className={`mt-0.5 text-[11px] ${difference < 0 ? "text-amber-700 dark:text-amber-300" : "text-emerald-700 dark:text-emerald-300"}`}>
            {difference < 0
              ? tr(`还差 ${Math.abs(difference)} 章`, `${Math.abs(difference)} chapters short`, `${Math.abs(difference)}화 부족`)
              : difference === 0
                ? tr("正好覆盖目标", "Exactly covers target", "목표와 정확히 일치")
                : tr(`余量 ${difference} 章`, `${difference} chapters spare`, `${difference}화 여유`)}
          </div>
        </div>
      </div>
      {readyMismatch && (
        <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-background/55 px-3 py-2 text-xs leading-5 text-amber-900 dark:text-amber-100">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            {tr(
              "B-Rail 标记为可用，但最大容量低于 Book 目标快照。请增加路线段或把状态改回草稿。",
              "The B-Rail is marked ready, but its maximum capacity is below the Book target snapshot. Add route entries or return it to draft.",
              "B-Rail이 사용 가능으로 표시됐지만 최대 수용량이 Book 목표와 맞지 않습니다. 경로 항목을 늘리거나 초안 상태로 되돌리세요.",
            )}
          </span>
        </div>
      )}
    </section>
  );
}

function BindingNotice({ binding }: { readonly binding: StoryRailBindingPreview }) {
  let copy: string;
  let warning = false;
  if (binding.status === "bound") {
    copy = binding.changed
      ? tr(
        `当前 Arc ${binding.arcId ?? ""} 已连接到 ${binding.bId ?? "当前 B"}。`,
        `The active Arc ${binding.arcId ?? ""} was linked to ${binding.bId ?? "the active B"}.`,
        `현재 Arc ${binding.arcId ?? ""}를 ${binding.bId ?? "현재 B"}에 연결했습니다.`,
      )
      : tr(
        `当前 Arc 与 ${binding.bId ?? "当前 B"} 的连接保持不变。`,
        `The active Arc binding to ${binding.bId ?? "the active B"} is unchanged.`,
        `현재 Arc와 ${binding.bId ?? "현재 B"}의 연결을 그대로 유지했습니다.`,
      );
  } else if (binding.status === "conflict") {
    warning = true;
    copy = tr(
      "检测到已有 Arc 连接；为避免覆盖，InkOS 保留了原连接。",
      "An Arc was already linked, so InkOS kept the existing binding instead of overwriting it.",
      "기존 Arc 연결이 있어 덮어쓰지 않고 원래 연결을 유지했습니다.",
    );
  } else if (binding.status === "missing-active") {
    warning = true;
    copy = tr(
      "B-Rail 没有“当前”段，因此未自动连接当前 Arc。",
      "The B-Rail has no active entry, so the active Arc was not linked automatically.",
      "B-Rail에 ‘현재’ 항목이 없어 활성 Arc를 자동 연결하지 않았습니다.",
    );
  } else if (binding.status === "missing-plan" || binding.status === "error") {
    warning = true;
    copy = tr(
      "规划已保存，但无法确认当前 Arc 连接。",
      "The plan was saved, but the active Arc binding could not be confirmed.",
      "계획은 저장했지만 현재 Arc 연결은 확인하지 못했습니다.",
    );
  } else {
    copy = binding.reason === "active-arc-book-mismatch"
      ? tr(
        "当前 Arc 属于另一本书，因此没有自动连接。",
        "The active Arc belongs to another book, so it was not linked.",
        "활성 Arc가 다른 Book에 속해 자동 연결하지 않았습니다.",
      )
      : tr(
        "没有当前活动 Arc，暂时跳过自动连接。",
        "There is no active Arc, so automatic binding was skipped.",
        "현재 활성 Arc가 없어 자동 연결을 건너뛰었습니다.",
      );
  }
  return (
    <div className={`mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-5 ${warning ? "border-amber-500/25 bg-amber-500/8 text-amber-900 dark:text-amber-100" : "border-sky-500/20 bg-sky-500/5 text-sky-800 dark:text-sky-200"}`}>
      {warning ? <AlertTriangle size={14} className="mt-0.5 shrink-0" /> : <Link2 size={14} className="mt-0.5 shrink-0" />}
      <span>{copy}</span>
    </div>
  );
}

export function StoryRailsPreview({ exec }: { readonly exec: ToolExecution }) {
  const details = getStoryRailsPreviewDetails(exec);
  if (!details) return null;
  const plan = details.plan;
  const anchorById = new Map(plan?.anchorRail.anchors.map((anchor) => [anchor.id, anchor]) ?? []);
  return (
    <section
      data-story-rails-kind={details.kind}
      className="mx-3 mb-3 mt-1 overflow-hidden rounded-xl border border-violet-500/25 bg-gradient-to-br from-violet-500/7 via-card to-sky-500/5"
    >
      <div className="border-b border-border/40 px-4 py-3.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="mt-0.5 rounded-lg border border-violet-500/20 bg-violet-500/10 p-1.5 text-violet-700 dark:text-violet-300">
              <Milestone size={16} />
            </span>
            <div className="min-w-0">
              <h4 className="text-[16px] font-semibold leading-6 text-foreground">{tr("A/B 故事轨道", "A/B Story Rails", "A/B Story Rail")}</h4>
              <p className="text-xs text-muted-foreground">{details.bookId}</p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full border border-violet-500/20 bg-violet-500/8 px-2 py-1 text-[11px] font-medium text-violet-800 dark:text-violet-200">
            {details.kind === "story_rails" ? <CircleDot size={11} /> : <CheckCircle2 size={11} />}
            {details.kind === "story_rail_reflow_applied"
              ? tr("已完成 Reflow", "Reflow applied", "Reflow 적용됨")
              : details.kind === "story_rail_reflow_discarded"
                ? tr("已放弃待处理 Reflow", "Pending reflow discarded", "대기 Reflow 폐기됨")
              : details.kind === "story_rails_replaced"
                ? tr("已保存", "Saved", "저장됨")
                : tr("当前规划", "Current plan", "현재 계획")}
          </span>
        </div>
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-border/45 bg-background/55 px-3 py-2 text-xs leading-5 text-muted-foreground">
          <PencilLine size={14} className="mt-0.5 shrink-0 text-violet-600 dark:text-violet-300" />
          <span>
            {tr(
              "这是优先级低于 Book 正史的“可编辑未来规划”。Chapter 仍然直接属于 Book，不会变成 Arc 的子项。",
              "This is an editable future plan below Book canon. Chapters still belong directly to the Book; they do not become children of an Arc.",
              "Book 정본(캐논)보다 우선순위가 낮은 ‘편집 가능한 미래 계획’입니다. Chapter는 계속 Book에 직접 속하며 Arc의 하위 항목이 되지 않습니다.",
            )}
          </span>
        </div>
        {details.pendingReflow && (
          <div
            data-story-rail-reflow-pending={details.pendingReflow.pendingId}
            className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-2.5 text-xs leading-5 text-amber-950 dark:text-amber-100"
          >
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              {tr(
                `${details.pendingReflow.activeB.bId} 已在第 ${details.pendingReflow.endpointChapterNumber} 章形成结算候选。确认后续每个 B 的 keep/revise/retire，再应用 Reflow；若已继续直接写 Chapter，请明确放弃此待处理项。`,
                `${details.pendingReflow.activeB.bId} has a close candidate through chapter ${details.pendingReflow.endpointChapterNumber}. Review keep/revise/retire for every future B before applying reflow; explicitly discard it if direct Chapter production already continued.`,
                `${details.pendingReflow.activeB.bId}가 ${details.pendingReflow.endpointChapterNumber}화까지 종결 후보가 됐습니다. 이후 모든 B의 keep/revise/retire를 확인해 Reflow를 적용하세요. 이미 Chapter를 직접 이어 썼다면 이 대기 건을 명시적으로 폐기하세요.`,
              )}
            </span>
          </div>
        )}
        {details.kind === "story_rail_reflow_applied" && (
          <div
            data-story-rail-fresh-arc-required="true"
            className="mt-3 flex items-start gap-2 rounded-lg border border-sky-500/25 bg-sky-500/8 px-3 py-2.5 text-xs leading-5 text-sky-950 dark:text-sky-100"
          >
            <Link2 size={14} className="mt-0.5 shrink-0" />
            <span>
              {tr(
                "Reflow 已结算旧 Arc。未来 B 的旧 Arc 连接已失效；请基于最新状态重新选择 Arc，再开始下一章。",
                "Reflow settled the old Arc. Any pre-close future Arc binding is invalid now; select a fresh Arc from the latest state before the next Chapter.",
                "Reflow로 이전 Arc를 정산했습니다. 종결 전에 미리 연결된 미래 Arc는 무효화됐으니, 다음 Chapter를 쓰기 전에 최신 상태에서 새 Arc를 선택하세요.",
              )}
            </span>
          </div>
        )}
      </div>

      {!plan ? (
        <div className="px-4 py-6 text-center">
          <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-full border border-dashed border-violet-500/35 text-violet-600 dark:text-violet-300">
            <Milestone size={16} />
          </div>
          <div className="mt-2 text-sm font-medium text-foreground">{tr("尚未建立 Rail 规划", "No Rail plan yet", "아직 Rail 계획이 없습니다")}</div>
          <p className="mx-auto mt-1 max-w-lg text-xs leading-5 text-muted-foreground">
            {tr(
              "现有 Book → Chapter 写作仍可照常使用；需要时再添加 A-Rail 与 B-Rail。",
              "Existing Book → Chapter writing keeps working. Add A-Rail and B-Rail only when useful.",
              "기존 Book → Chapter 집필은 그대로 작동합니다. 필요할 때만 A-Rail과 B-Rail을 추가하면 됩니다.",
            )}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 px-4 py-4 xl:grid-cols-2">
          <CapacitySummary plan={plan} />
          <section>
            <div className="mb-2.5 flex items-center justify-between gap-2">
              <div>
                <h5 className="text-sm font-semibold text-foreground">{tr("A-Rail · 长程锚点", "A-Rail · Long-range anchors", "A-Rail · 장기 Anchor")}</h5>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{tr("故事必须抵达的不可逆变化", "Irreversible destinations the story must reach", "이야기가 도달해야 할 비가역적 도착점")}</p>
              </div>
              <span className="rounded-full border border-border/50 bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground">
                {readinessLabel(plan.anchorRail.status)} · {plan.anchorRail.anchors.length}
              </span>
            </div>
            <ol className="space-y-3">
              {plan.anchorRail.anchors.map((anchor, index) => <AnchorCard key={anchor.id} anchor={anchor} index={index} />)}
            </ol>
          </section>

          <section>
            <div className="mb-2.5 flex items-center justify-between gap-2">
              <div>
                <h5 className="text-sm font-semibold text-foreground">{tr("B-Rail · Arc 路线", "B-Rail · Arc route", "B-Rail · Arc 경로")}</h5>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{tr("通向各锚点的当前与候选 Arc", "Current and possible Arcs toward each anchor", "각 Anchor로 향하는 현재·후보 Arc")}</p>
              </div>
              <span className="rounded-full border border-border/50 bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground">
                {readinessLabel(plan.arcRouteRail.status)} · {plan.arcRouteRail.entries.length}
              </span>
            </div>
            {plan.arcRouteRail.entries.length > 0 ? (
              <ol className="space-y-3">
                {plan.arcRouteRail.entries.map((entry) => {
                  const target = anchorById.get(entry.targetAnchorId);
                  return target ? <RouteCard key={entry.bId} entry={entry} target={target} /> : null;
                })}
              </ol>
            ) : (
              <div className="rounded-xl border border-dashed border-border/60 bg-background/50 px-3 py-5 text-center text-xs leading-5 text-muted-foreground">
                {tr("尚未添加 B-Rail 路段。A-Rail 仍可单独作为长程方向。", "No B-Rail entries yet. A-Rail can still guide the long-range direction.", "아직 B-Rail 항목이 없습니다. A-Rail만으로도 장기 방향은 유지됩니다.")}
              </div>
            )}
            {details.binding && <BindingNotice binding={details.binding} />}
            {details.warnings.length > 0 && (
              <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-900 dark:text-amber-100">
                  <AlertTriangle size={13} />
                  {tr("需要确认", "Needs attention", "확인 필요")}
                </div>
                <ul className="mt-1.5 space-y-1 text-xs leading-5 text-amber-900/85 dark:text-amber-100/85">
                  {details.warnings.map((warning, index) => <li key={index}>· {warning}</li>)}
                </ul>
              </div>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
