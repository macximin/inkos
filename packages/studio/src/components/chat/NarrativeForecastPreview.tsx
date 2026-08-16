import { useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  GitFork,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  NarrativeForecastSchema,
  type ForecastBranch,
  type ForecastRisk,
  type NarrativeForecast,
} from "@actalk/inkos-core/forecast/schema";
import type { ToolExecution } from "../../store/chat/types";
import { tr } from "../../lib/app-language";

export type NarrativeForecastPreviewDetails =
  | {
      readonly kind: "forecast";
      readonly forecast: NarrativeForecast;
      readonly stale: boolean;
    }
  | {
      readonly kind: "selected";
      readonly branchId: string;
      readonly planPath: string;
      readonly stale: boolean;
      readonly arcActivated: boolean;
      readonly arc?: {
        readonly id: string;
        readonly chapterNumbers: readonly number[];
      };
      readonly railWarning?: string;
    };

export interface NarrativeForecastPreviewProps {
  readonly exec: ToolExecution;
  readonly onSelectBranch?: (forecastId: string, branchId: string) => void | Promise<void>;
  readonly onRecheck?: (forecastId: string) => void | Promise<void>;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function getNarrativeForecastPreviewDetails(exec: ToolExecution): NarrativeForecastPreviewDetails | null {
  if (!["create_narrative_forecast", "get_narrative_forecast", "select_narrative_branch"].includes(exec.tool)) {
    return null;
  }
  const details = recordOf(exec.details);
  if (!details) return null;

  if (details.kind === "narrative_forecast_created" || details.kind === "narrative_forecast") {
    const parsed = NarrativeForecastSchema.safeParse(details.forecast);
    if (!parsed.success) return null;
    return {
      kind: "forecast",
      forecast: parsed.data,
      stale: details.stale === true || parsed.data.status === "stale",
    };
  }

  if (details.kind === "narrative_branch_selected") {
    const branchId = nonEmptyString(details.branchId);
    const planPath = nonEmptyString(details.planPath);
    if (!branchId || !planPath || typeof details.arcActivated !== "boolean") return null;
    let arc: Extract<NarrativeForecastPreviewDetails, { kind: "selected" }>["arc"];
    if (details.arc !== undefined) {
      const arcRecord = recordOf(details.arc);
      const id = arcRecord ? nonEmptyString(arcRecord.id) : null;
      const chapterNumbers = arcRecord?.chapterNumbers;
      if (
        !id
        || !Array.isArray(chapterNumbers)
        || chapterNumbers.length < 1
        || chapterNumbers.length > 3
        || chapterNumbers.some((chapter) => !Number.isSafeInteger(chapter) || Number(chapter) < 1)
        || new Set(chapterNumbers).size !== chapterNumbers.length
      ) return null;
      arc = { id, chapterNumbers: chapterNumbers as number[] };
    }
    if (details.arcActivated && !arc) return null;
    const railWarning = details.railWarning === undefined ? undefined : nonEmptyString(details.railWarning);
    if (details.railWarning !== undefined && !railWarning) return null;
    return {
      kind: "selected",
      branchId,
      planPath,
      stale: details.stale === true,
      arcActivated: details.arcActivated,
      ...(arc ? { arc } : {}),
      ...(railWarning ? { railWarning } : {}),
    };
  }

  return null;
}

export function buildNarrativeForecastSelectionInstruction(
  forecastId: string,
  branchId: string,
  language: "zh" | "en" | "ko",
): string {
  if (language === "ko") {
    return `select_narrative_branch를 호출해 예측 ${forecastId}의 ${branchId}를 선택해. 원고·개요·정본 상태는 바꾸지 말고, 편집 가능한 활성 Arc 초안만 만들어.`;
  }
  return language === "zh"
    ? `请调用 select_narrative_branch，选择推演 ${forecastId} 的 ${branchId}。只保存候选计划并创建可编辑的 active Arc 草稿，不修改正文、大纲或正史状态。`
    : `Call select_narrative_branch for ${branchId} in forecast ${forecastId}. Save the candidate plan and create an editable active Arc draft; do not modify prose, outlines, or canonical state.`;
}

export function buildNarrativeForecastRecheckInstruction(
  forecastId: string,
  language: "zh" | "en" | "ko",
): string {
  if (language === "ko") return `get_narrative_forecast를 호출해 예측 ${forecastId}가 오래된 상태인지 다시 확인해.`;
  return language === "zh"
    ? `请调用 get_narrative_forecast，重新核验推演 ${forecastId} 是否已经过期。`
    : `Call get_narrative_forecast for forecast ${forecastId} and report whether it is stale.`;
}

const RISK_LABELS: Record<ForecastRisk["kind"], readonly [string, string]> = {
  continuity: ["连续性", "Continuity"],
  causality: ["因果", "Causality"],
  character: ["人物", "Character"],
};

function label(zh: boolean, values: readonly [string, string]): string {
  return zh ? values[0] : values[1];
}

function RiskPills({ risks, zh }: { risks: readonly ForecastRisk[]; zh: boolean }) {
  if (risks.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/5 px-2 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300">
        <ShieldCheck size={11} />
        {zh ? "未发现硬风险" : "No hard risks"}
      </span>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {risks.map((risk, index) => (
        <span
          key={`${risk.kind}-${index}`}
          title={risk.description}
          className="inline-flex items-center rounded-full border border-amber-500/25 bg-amber-500/8 px-2 py-0.5 text-[11px] text-amber-800 dark:text-amber-200"
        >
          {label(zh, RISK_LABELS[risk.kind])}
        </span>
      ))}
    </div>
  );
}

function ChangeList({ title, items }: { title: string; items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70">{title}</div>
      <ul className="space-y-1 text-xs leading-5 text-muted-foreground">
        {items.map((item, index) => <li key={index}>· {item}</li>)}
      </ul>
    </div>
  );
}

function BranchCard({
  branch,
  forecastId,
  stale,
  zh,
  pending,
  onSelect,
}: {
  readonly branch: ForecastBranch;
  readonly forecastId: string;
  readonly stale: boolean;
  readonly zh: boolean;
  readonly pending: boolean;
  readonly onSelect?: (branchId: string) => void;
}) {
  return (
    <article className="relative flex min-w-0 flex-col rounded-xl border border-border/55 bg-background/70 p-3.5 shadow-[0_10px_30px_-24px_rgba(0,0,0,0.65)]">
      <div className="absolute -top-[19px] left-1/2 h-4 w-px -translate-x-1/2 bg-primary/35" />
      <div className="absolute -top-[22px] left-1/2 h-2 w-2 -translate-x-1/2 rounded-full border border-primary/50 bg-card" />

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-[0.13em] text-primary/75">{branch.branchId}</div>
          <h4 className="mt-1 text-[15px] font-semibold leading-5 text-foreground">{branch.title}</h4>
        </div>
        <div className="shrink-0 rounded-lg border border-primary/20 bg-primary/5 px-2 py-1 text-right">
          <div className="text-[15px] font-semibold leading-none text-primary">{branch.intentAlignment.score}</div>
          <div className="mt-1 text-[9px] uppercase tracking-wide text-muted-foreground">{zh ? "意图" : "intent"}</div>
        </div>
      </div>

      <p className="mt-3 text-xs leading-5 text-muted-foreground">{branch.premise}</p>

      <ol className="mt-3 space-y-2 border-l border-primary/20 pl-3">
        {branch.beats.map((beat) => (
          <li key={`${branch.branchId}-${beat.chapter}`} className="relative text-xs leading-5 text-foreground/90">
            <span className="absolute -left-[15px] top-[7px] h-1.5 w-1.5 rounded-full bg-primary/65" />
            <span className="font-medium text-primary">{zh ? `第 ${beat.chapter} 章` : `Ch. ${beat.chapter}`}</span>
            <span className="ml-1.5">{beat.summary}</span>
          </li>
        ))}
      </ol>

      <div className="mt-3"><RiskPills risks={branch.risks} zh={zh} /></div>

      <details className="group mt-3 border-t border-border/40 pt-2.5">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRight size={13} className="transition-transform group-open:rotate-90" />
          {zh ? "人物决定、变化与不确定性" : "Decisions, changes, uncertainties"}
        </summary>
        <div className="mt-3 space-y-3">
          <ChangeList
            title={zh ? "人物决定" : "Character decisions"}
            items={branch.characterDecisions.map((item) => `${item.character}：${item.decision}`)}
          />
          <ChangeList title={zh ? "人物变化" : "Character changes"} items={branch.projectedChanges.characters} />
          <ChangeList title={zh ? "关系变化" : "Relationship changes"} items={branch.projectedChanges.relationships} />
          <ChangeList title={zh ? "世界变化" : "World changes"} items={branch.projectedChanges.world} />
          <ChangeList title={zh ? "伏笔变化" : "Hook changes"} items={branch.projectedChanges.hooks} />
          <ChangeList title={zh ? "不确定性" : "Uncertainties"} items={branch.uncertainties} />
          <p className="rounded-lg bg-muted/45 px-2.5 py-2 text-xs leading-5 text-muted-foreground">
            {branch.intentAlignment.rationale}
          </p>
        </div>
      </details>

      <button
        type="button"
        data-forecast-id={forecastId}
        data-branch-id={branch.branchId}
        disabled={stale || pending || !onSelect}
        onClick={() => onSelect?.(branch.branchId)}
        className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-primary/35 bg-primary/10 px-3 py-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/15 disabled:cursor-not-allowed disabled:border-border/40 disabled:bg-muted/30 disabled:text-muted-foreground/60"
      >
        {pending ? <RefreshCw size={13} className="animate-spin" /> : <Check size={13} />}
        {stale
          ? (zh ? "过期推演不可采用" : "Stale forecast")
          : (zh ? "采用此分支" : "Use this branch")}
      </button>
    </article>
  );
}

export function NarrativeForecastPreview({ exec, onSelectBranch, onRecheck }: NarrativeForecastPreviewProps) {
  const details = getNarrativeForecastPreviewDetails(exec);
  const [pendingBranch, setPendingBranch] = useState<string | null>(null);
  const [rechecking, setRechecking] = useState(false);
  if (!details) return null;

  if (details.kind === "selected") {
    const activationBlocked = !details.stale && !details.arcActivated;
    return (
      <div
        data-arc-activated={details.arcActivated ? "true" : "false"}
        className={`mx-3 mb-3 mt-1 rounded-xl border px-3.5 py-3 ${activationBlocked ? "border-amber-500/35 bg-amber-500/8" : "border-primary/25 bg-primary/5"}`}
      >
        <div className="flex items-center gap-2 text-sm font-semibold text-primary">
          <Check size={15} />
          {tr("候选分支已保存", "Candidate branch saved", "후보 분기 저장됨")}
        </div>
        <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
          {tr(
            `${details.branchId} 已写入候选计划；正文、大纲和正史状态没有修改。`,
            `${details.branchId} was written to the candidate plan; prose, outline, and canon were not modified.`,
            `${details.branchId}를 후보 계획에 저장했습니다. 원고·개요·정본 상태는 바뀌지 않았습니다.`,
          )}
        </p>
        {details.arcActivated && details.arc && (
          <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/8 px-3 py-2 text-xs leading-5 text-emerald-800 dark:text-emerald-200">
            <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
            <span>
              {tr(
                `已启用活动 Arc ${details.arc.id} · 第 ${details.arc.chapterNumbers.join(", ")} 章`,
                `Active Arc ${details.arc.id} · chapters ${details.arc.chapterNumbers.join(", ")}`,
                `활성 Arc ${details.arc.id} · ${details.arc.chapterNumbers.join(", ")}화`,
              )}
            </span>
          </div>
        )}
        {activationBlocked && (
          <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-background/60 px-3 py-2 text-xs leading-5 text-amber-900 dark:text-amber-100">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              {tr(
                `候选 Arc${details.arc ? ` ${details.arc.id}` : ""} 已保存，但为保护 ready B 的现有连接，没有将其设为活动 Arc。`,
                `Candidate Arc${details.arc ? ` ${details.arc.id}` : ""} was saved but not activated because the existing ready B binding is protected.`,
                `후보 Arc${details.arc ? ` ${details.arc.id}` : ""}는 저장됐지만 기존 ready B 연결을 보호하기 위해 활성화하지 않았습니다.`,
              )}
            </span>
          </div>
        )}
        {details.railWarning && (
          <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-950 dark:text-amber-100">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="font-semibold">{tr("Rail 连接警告", "Rail binding warning", "Rail 연결 경고")}</div>
              <div className="mt-0.5 whitespace-pre-wrap break-words">{details.railWarning}</div>
            </div>
          </div>
        )}
        {details.stale && (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
            {tr("该推演基于旧正史，请核验后再继续写作。", "This forecast is stale; verify it before writing.", "이 예측은 이전 정본을 기준으로 합니다. 집필 전 다시 확인하세요.")}
          </p>
        )}
      </div>
    );
  }

  const { forecast, stale } = details;
  const zh = forecast.language === "zh";
  const selectBranch = async (branchId: string) => {
    if (!onSelectBranch || stale) return;
    setPendingBranch(branchId);
    try {
      await onSelectBranch(forecast.forecastId, branchId);
    } finally {
      setPendingBranch(null);
    }
  };
  const recheck = async () => {
    if (!onRecheck) return;
    setRechecking(true);
    try {
      await onRecheck(forecast.forecastId);
    } finally {
      setRechecking(false);
    }
  };

  return (
    <section className="mx-3 mb-3 mt-1 overflow-hidden rounded-2xl border border-primary/25 bg-[linear-gradient(145deg,hsl(var(--card))_0%,hsl(var(--muted)/0.32)_100%)]">
      <header className="border-b border-border/45 px-4 py-3.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-[15px] font-semibold text-foreground">
                <GitFork size={16} className="text-primary" />
                {zh ? "剧情多线推演" : "Narrative forecast"}
              </span>
              <span className="rounded-full border border-primary/20 bg-primary/8 px-2 py-0.5 text-[10px] font-medium tracking-wide text-primary">
                {zh ? "非正史规划" : "NON-CANONICAL"}
              </span>
              {stale && (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-200">
                  <AlertTriangle size={11} />
                  {zh ? "正史已变化" : "Canon changed"}
                </span>
              )}
            </div>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-foreground/85">{forecast.divergence}</p>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span>{zh ? `基于第 ${forecast.baseChapter} 章` : `After chapter ${forecast.baseChapter}`}</span>
              <span>{zh ? `${forecast.branches.length} 条候选分支` : `${forecast.branches.length} branches`}</span>
              <span>{zh ? `推演未来约 ${forecast.horizon} 章` : `~${forecast.horizon} chapters ahead`}</span>
            </div>
          </div>
          {onRecheck && (
            <button
              type="button"
              onClick={() => { void recheck(); }}
              disabled={rechecking}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/60 bg-background/60 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw size={12} className={rechecking ? "animate-spin" : ""} />
              {zh ? "重新核验" : "Recheck"}
            </button>
          )}
        </div>
        {stale && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/8 px-3 py-2 text-xs leading-5 text-amber-900 dark:text-amber-100">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{zh ? "正史输入已在生成后变化。请重新推演，不要继续采用旧分支。" : "Canonical inputs changed after generation. Regenerate before selecting a branch."}</span>
          </div>
        )}
      </header>

      <div className="relative px-4 pb-4 pt-7">
        <div className="pointer-events-none absolute left-8 right-8 top-[17px] h-px bg-gradient-to-r from-transparent via-primary/35 to-transparent" />
        <div className="pointer-events-none absolute left-1/2 top-[9px] -translate-x-1/2 text-primary/70">
          <Sparkles size={14} />
        </div>
        <div className="grid auto-cols-[minmax(17rem,1fr)] grid-flow-col gap-3 overflow-x-auto pb-1 [scrollbar-width:thin]">
          {forecast.branches.map((branch) => (
            <BranchCard
              key={branch.branchId}
              branch={branch}
              forecastId={forecast.forecastId}
              stale={stale}
              zh={zh}
              pending={pendingBranch === branch.branchId}
              onSelect={onSelectBranch ? (branchId) => { void selectBranch(branchId); } : undefined}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
