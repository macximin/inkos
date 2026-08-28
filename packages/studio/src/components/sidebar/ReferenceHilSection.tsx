import { useState } from "react";
import { Check, ChevronDown, GitCompare, Loader2, Sparkles, X } from "lucide-react";
import { postApi, useApi } from "../../hooks/use-api";
import { tr } from "../../lib/app-language";
import { ConfirmDialog } from "../ConfirmDialog";

interface HilCandidateView {
  readonly candidate: {
    readonly candidateId: string;
    readonly chapterNumber: number;
    readonly status: "prepared" | "applied" | "rejected";
    readonly commercialScore?: { readonly overall: number };
    readonly preparedAt: string;
  };
  readonly report: {
    readonly status: "unreviewed" | "accepted" | "polish-requested" | "rejected";
    readonly retained: ReadonlyArray<string>;
    readonly variedSurface: ReadonlyArray<string>;
    readonly linkedConsequences: ReadonlyArray<string>;
    readonly exactSurfaceMatches: ReadonlyArray<{ readonly tokenCount: number; readonly text: string }>;
  };
  readonly currentContent: string;
  readonly candidateContent: string;
  readonly currentChapterMatchesPreparation: boolean;
  readonly applyTransition?: {
    readonly state: "applied-needs-resync" | "applied-needs-audit" | "ready" | "needs-attention";
    readonly phase: "apply" | "resync" | "audit" | "complete";
  };
}

export interface ReferenceHilResponse {
  readonly bookId: string;
  readonly pendingCount: number;
  readonly attentionCount: number;
  readonly candidates: ReadonlyArray<HilCandidateView>;
}

export function ReferenceHilSection({ bookId }: { readonly bookId: string }) {
  const path = `/books/${bookId}/reference-hil`;
  const { data, loading, error, refetch } = useApi<ReferenceHilResponse>(path);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{
    readonly view: HilCandidateView;
    readonly action: "apply" | "reject";
  } | null>(null);

  const act = async (view: HilCandidateView, action: "apply" | "polish" | "reject") => {
    const key = `${view.candidate.candidateId}:${action}`;
    setPendingAction(key);
    setActionMessage(null);
    try {
      const result = await postApi<{ followUpStatus?: string; followUpError?: string }>(
        `/books/${bookId}/reference-hil/${view.candidate.chapterNumber}/${encodeURIComponent(view.candidate.candidateId)}/${action}`,
      );
      setActionMessage(result.followUpError
        ? tr("候选稿已应用，但同步/审计仍需处理。", "Candidate applied; sync/audit still needs attention.", "후보는 적용됐지만 동기화·검수 후속 처리가 필요합니다.")
        : action === "apply"
          ? tr("候选稿已应用，并完成同步与审计。", "Candidate applied, synced, and audited.", "후보 적용과 truth 동기화·검수를 마쳤습니다.")
          : action === "polish"
            ? tr("已请求润色。", "Polish requested.", "폴리싱 요청을 기록했습니다.")
            : tr("候选稿已拒绝。", "Candidate rejected.", "후보를 거절했습니다."));
      await refetch();
    } catch (actionError) {
      setActionMessage(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setPendingAction(null);
    }
  };

  if (!loading && !error && (data?.candidates.length ?? 0) === 0) return null;

  return (
    <section className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-3" aria-label={tr("参考改写候选", "Reference transformation candidates", "문체 후보 HIL")}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <GitCompare size={15} className="text-amber-500" />
          {tr("候选稿 HIL", "Candidate HIL", "문체 후보 HIL")}
        </span>
        {(data?.pendingCount ?? 0) > 0 && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-bold text-amber-600 dark:text-amber-400">
            {tr(`${data!.pendingCount} 个待审`, `${data!.pendingCount} pending`, `${data!.pendingCount}개 대기`)}
          </span>
        )}
        {(data?.attentionCount ?? 0) > 0 && (
          <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-bold text-destructive">
            {tr(`${data!.attentionCount} 个需处理`, `${data!.attentionCount} need attention`, `${data!.attentionCount}개 후속 처리`)}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        {tr("比较当前稿与候选稿，再决定接受、润色或拒绝。", "Compare the current and candidate drafts before deciding.", "현재 원고와 후보를 비교한 뒤 수락·폴리싱·거절합니다.")}
      </p>

      {loading && <Loader2 size={15} className="mt-3 animate-spin text-muted-foreground" />}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {actionMessage && <p className="mt-2 rounded-lg bg-background/70 px-2.5 py-2 text-xs leading-5 text-foreground">{actionMessage}</p>}

      <div className="mt-2 space-y-2">
        {data?.candidates.map((view) => {
          const id = view.candidate.candidateId;
          const open = expanded === id;
          const actionable = view.candidate.status === "prepared";
          return (
            <article key={id} className="overflow-hidden rounded-lg border border-border/50 bg-card/80">
              <button
                type="button"
                onClick={() => setExpanded(open ? null : id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left"
                aria-expanded={open}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold">{view.candidate.chapterNumber}화 · {id}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {view.applyTransition ? applyStateLabel(view.applyTransition.state) : reportStatusLabel(view.report.status)} · {view.currentChapterMatchesPreparation
                      ? tr("当前稿一致", "baseline current", "기준 원고 일치")
                      : tr("当前稿已变更", "baseline changed", "기준 원고 변경됨")}
                  </span>
                </span>
                {view.candidate.commercialScore && (
                  <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-bold text-primary">
                    {view.candidate.commercialScore.overall.toFixed(1)}
                  </span>
                )}
                <ChevronDown size={14} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
              </button>

              {open && (
                <div className="border-t border-border/40 p-3">
                  <div className="grid gap-2 xl:grid-cols-2">
                    <DraftPane label={tr("当前稿", "Current", "현재 원고")} content={view.currentContent} />
                    <DraftPane label={tr("候选稿", "Candidate", "후보 원고")} content={view.candidateContent} />
                  </div>
                  <div className="mt-2 grid gap-1 text-[11px] leading-5 text-muted-foreground">
                    <p><strong className="text-foreground">{tr("保留", "Retained", "보존")}</strong> · {view.report.retained.join(" · ") || "—"}</p>
                    <p><strong className="text-foreground">{tr("表面变化", "Surface variation", "표면 변주")}</strong> · {view.report.variedSurface.join(" · ") || "—"}</p>
                    <p><strong className="text-foreground">{tr("后续影响", "Consequences", "후속 결과")}</strong> · {view.report.linkedConsequences.join(" · ") || "—"}</p>
                    <p><strong className="text-foreground">{tr("逐字匹配", "Exact matches", "표면 일치")}</strong> · {view.report.exactSurfaceMatches.length}</p>
                  </div>
                  {actionable && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <ActionButton icon={<Check size={13} />} label={tr("接受", "Accept", "수락")} busy={pendingAction === `${id}:apply`} disabled={!view.currentChapterMatchesPreparation || pendingAction !== null} onClick={() => setConfirmation({ view, action: "apply" })} primary />
                      <ActionButton icon={<Sparkles size={13} />} label={tr("请求润色", "Request polish", "폴리싱 요청")} busy={pendingAction === `${id}:polish`} disabled={pendingAction !== null} onClick={() => void act(view, "polish")} />
                      <ActionButton icon={<X size={13} />} label={tr("拒绝", "Reject", "거절")} busy={pendingAction === `${id}:reject`} disabled={pendingAction !== null} onClick={() => setConfirmation({ view, action: "reject" })} />
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
      <ConfirmDialog
        open={confirmation !== null}
        title={confirmation?.action === "apply"
          ? tr("接受候选稿", "Accept candidate", "후보 원고 수락")
          : tr("拒绝候选稿", "Reject candidate", "후보 원고 거절")}
        message={confirmation?.action === "apply"
          ? tr("当前章节将替换为候选稿，并立即重新同步与审计。", "The current chapter will be replaced, then resynced and audited.", "현재 회차를 후보 원고로 교체한 뒤 truth 동기화와 검수를 다시 실행합니다.")
          : tr("此候选稿将标记为已拒绝，当前稿件不会改变。", "This candidate will be rejected. The current draft will not change.", "후보를 거절로 기록합니다. 현재 원고는 바뀌지 않습니다.")}
        confirmLabel={confirmation?.action === "apply"
          ? tr("接受", "Accept", "수락")
          : tr("拒绝", "Reject", "거절")}
        cancelLabel={tr("取消", "Cancel", "취소")}
        variant={confirmation?.action === "reject" ? "danger" : "default"}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => {
          if (!confirmation) return;
          const target = confirmation;
          setConfirmation(null);
          void act(target.view, target.action);
        }}
      />
    </section>
  );
}

function reportStatusLabel(status: HilCandidateView["report"]["status"]): string {
  if (status === "accepted") return tr("已接受", "Accepted", "수락됨");
  if (status === "polish-requested") return tr("已请求润色", "Polish requested", "폴리싱 요청됨");
  if (status === "rejected") return tr("已拒绝", "Rejected", "거절됨");
  return tr("待审", "Awaiting review", "검토 대기");
}

function applyStateLabel(state: NonNullable<HilCandidateView["applyTransition"]>["state"]): string {
  if (state === "ready") return tr("已完成", "Ready", "적용 완료");
  if (state === "needs-attention") return tr("需要处理", "Needs attention", "후속 처리 필요");
  if (state === "applied-needs-audit") return tr("等待审计", "Awaiting audit", "검수 대기");
  return tr("等待同步", "Awaiting resync", "동기화 대기");
}

function DraftPane({ label, content }: { readonly label: string; readonly content: string }) {
  return (
    <div className="rounded-lg border border-border/40 bg-background/70 p-2.5">
      <p className="mb-1 text-[11px] font-bold text-foreground">{label}</p>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans text-[12px] leading-6 text-muted-foreground">{content}</pre>
    </div>
  );
}

function ActionButton({ icon, label, busy, disabled, onClick, primary = false }: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly primary?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40 ${primary ? "bg-primary text-primary-foreground" : "border border-border/60 bg-background text-foreground hover:bg-secondary/50"}`}>
      {busy ? <Loader2 size={13} className="animate-spin" /> : icon}{label}
    </button>
  );
}
