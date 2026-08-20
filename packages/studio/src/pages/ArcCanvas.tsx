import { useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AlertCircle, ArrowLeft, CheckCircle2, CircleDot, LockKeyhole, Map as MapIcon, Route } from "lucide-react";
import { useApi } from "../hooks/use-api";

type Anchor = {
  readonly id: string;
  readonly routeOrder: number;
  readonly title: string;
  readonly detailLevel: "compound" | "sparse";
  readonly state: "planned" | "reached" | "retired";
  readonly entryState: string;
  readonly trigger: string;
  readonly irreversibleChange: string;
  readonly humanAftermath: string;
  readonly readerDebt: string;
  readonly payoffAxis: string;
  readonly nextPressure: string;
};

type Arc = {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly episodeCount: number;
  readonly chapterNumbers: readonly number[];
  readonly openingState: string;
  readonly promise: string;
  readonly goal: string;
  readonly obstacle: string;
  readonly pressure: string;
  readonly turn: string;
  readonly payoff: string;
  readonly irreversibleChange: string;
  readonly nextHook: string;
  readonly episodeBeats: readonly {
    readonly chapterNumber: number;
    readonly role: string;
    readonly beats: readonly string[];
    readonly endingHook: string;
  }[];
  readonly futureAdvantageMove?: {
    readonly moveId: string;
    readonly mode: string;
    readonly domain: string;
    readonly target: string;
    readonly rememberedOutcome: string;
    readonly baselineQuestions: readonly string[];
    readonly bridgeSteps: readonly string[];
    readonly resistance: readonly string[];
    readonly proof: string;
    readonly reward: string;
    readonly downstreamConsequences: readonly string[];
  };
};

type RouteEntry = {
  readonly bId: string;
  readonly routeOrder: number;
  readonly status: "closed" | "active" | "provisional" | "hypothesis" | "retired";
  readonly targetAnchorId: string;
  readonly arcId?: string;
  readonly narrativeFunction: string;
  readonly payoffAxis: string;
};

type ArcCanvasData = {
  readonly plan: {
    readonly anchorRail: { readonly anchors: readonly Anchor[] };
    readonly arcRouteRail: { readonly entries: readonly RouteEntry[] };
  } | null;
  readonly activeArcId: string | null;
  readonly arcs: readonly Arc[];
};

type CanvasNode = Node<{
  readonly kind: "anchor" | "arc";
  readonly title: string;
  readonly subtitle: string;
  readonly state?: string;
  readonly active?: boolean;
  readonly arcId?: string;
}, "canvas">;

function statusLabel(status: string) {
  if (status === "active") return "진행 중";
  if (status === "ready") return "집필 준비";
  if (status === "closed") return "완료";
  if (status === "hypothesis") return "가설";
  return "초안";
}

function ArcCanvasNode({ data }: NodeProps<CanvasNode>) {
  const isAnchor = data.kind === "anchor";
  return (
    <div
      className={`w-[218px] rounded-2xl border px-4 py-3 shadow-sm transition-all ${
        isAnchor
          ? "border-primary/35 bg-card"
          : data.active
            ? "border-amber-400 bg-amber-400/10 ring-2 ring-amber-400/25"
            : "border-border/70 bg-card/95"
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-primary" />
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
        {isAnchor ? <Route size={12} /> : data.active ? <CircleDot size={12} className="text-amber-500" /> : <MapIcon size={12} />}
        <span>{data.subtitle}</span>
      </div>
      <div className="mt-1.5 line-clamp-2 text-sm font-semibold leading-5 text-foreground">{data.title}</div>
      <div className="mt-2 text-[11px] text-muted-foreground">{statusLabel(data.state ?? "draft")}</div>
      <Handle type="source" position={Position.Right} className="!bg-primary" />
    </div>
  );
}

const nodeTypes = { canvas: ArcCanvasNode };

function DetailRow({ label, value }: { readonly label: string; readonly value: string }) {
  if (!value.trim()) return null;
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <p className="text-sm leading-6 text-foreground/90">{value}</p>
    </div>
  );
}

export default function ArcCanvas({ bookId }: { readonly bookId: string }) {
  const { data, loading, error } = useApi<ArcCanvasData>(`/books/${encodeURIComponent(bookId)}/arc-canvas`);
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedArcId, setSelectedArcId] = useState<string | null>(null);

  const arcsById = useMemo(() => new Map((data?.arcs ?? []).map((arc) => [arc.id, arc])), [data]);
  const selectedArc = arcsById.get(selectedArcId ?? data?.activeArcId ?? "") ?? null;

  useEffect(() => {
    if (!data?.plan) return;
    const anchors = [...data.plan.anchorRail.anchors].sort((a, b) => a.routeOrder - b.routeOrder);
    const entries = [...data.plan.arcRouteRail.entries].sort((a, b) => a.routeOrder - b.routeOrder);
    const nextNodes: CanvasNode[] = anchors.map((anchor, index) => ({
      id: anchor.id,
      type: "canvas",
      position: { x: index * 290, y: 30 },
      data: {
        kind: "anchor",
        title: anchor.title,
        subtitle: `${anchor.id} · 장기 목적지`,
        state: anchor.state,
      },
    }));
    const anchorEntryCounts = new Map<string, number>();
    for (const entry of entries) {
      const offset = anchorEntryCounts.get(entry.targetAnchorId) ?? 0;
      anchorEntryCounts.set(entry.targetAnchorId, offset + 1);
      const arc = entry.arcId ? arcsById.get(entry.arcId) : undefined;
      nextNodes.push({
        id: entry.bId,
        type: "canvas",
        position: { x: (anchors.findIndex((anchor) => anchor.id === entry.targetAnchorId) * 290), y: 225 + offset * 155 },
        data: {
          kind: "arc",
          title: arc?.title ?? entry.narrativeFunction,
          subtitle: `${entry.bId} · ${arc?.chapterNumbers.join("~") ?? "회차 미정"}화`,
          state: entry.status,
          active: entry.arcId === data.activeArcId,
          arcId: entry.arcId,
        },
      });
    }
    const nextEdges: Edge[] = anchors.slice(1).map((anchor, index) => ({
      id: `anchor-${anchors[index].id}-${anchor.id}`,
      source: anchors[index].id,
      target: anchor.id,
      animated: false,
      style: { stroke: "var(--primary)", strokeWidth: 2 },
    }));
    for (const entry of entries) {
      nextEdges.push({
        id: `route-${entry.targetAnchorId}-${entry.bId}`,
        source: entry.targetAnchorId,
        target: entry.bId,
        type: "smoothstep",
        style: { stroke: entry.arcId === data.activeArcId ? "#f59e0b" : "#94a3b8", strokeWidth: entry.arcId === data.activeArcId ? 2.5 : 1.5 },
      });
    }
    setNodes(nextNodes);
    setEdges(nextEdges);
    if (!selectedArcId && data.activeArcId) setSelectedArcId(data.activeArcId);
  }, [arcsById, data, selectedArcId, setEdges, setNodes]);

  if (loading) return <div className="p-8 text-sm text-muted-foreground">Arc 지도를 불러오는 중...</div>;
  if (error || !data?.plan) return <div className="p-8 text-sm text-muted-foreground">이 작품에는 아직 Arc/Rail 지도가 없습니다.</div>;

  return (
    <div className="flex h-full min-h-[680px] flex-col bg-background" data-testid="arc-canvas">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/50 px-6 py-5">
        <div>
          <a href={`#/book/${encodeURIComponent(bookId)}`} className="mb-3 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-primary"><ArrowLeft size={13} /> 작품 대화</a>
          <div className="flex items-center gap-2 text-sm font-semibold"><MapIcon size={16} className="text-primary" /> Arc 지도</div>
          <p className="mt-1 text-sm text-muted-foreground">위는 장기 성장선, 아래는 실제 1~3화 제작 Arc입니다.</p>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-border/60 bg-card px-3 py-1.5 text-xs text-muted-foreground">
          <LockKeyhole size={12} /> 읽기 전용 · 정사는 수정하지 않음
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-h-[520px] border-b border-border/50 xl:border-b-0 xl:border-r">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={(_event, node) => {
              const arcId = (node.data as CanvasNode["data"]).arcId;
              if (arcId) setSelectedArcId(arcId);
            }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            fitView
            fitViewOptions={{ padding: 0.2 }}
          >
            <Background gap={20} size={1} />
            <Controls showInteractive={false} />
            <MiniMap nodeColor={(node) => (node.data as CanvasNode["data"]).active ? "#f59e0b" : "#64748b"} />
          </ReactFlow>
        </div>
        <aside className="overflow-y-auto bg-card/30 p-5">
          {selectedArc ? (
            <div className="space-y-6">
              <div>
                <div className="flex items-center gap-2 text-xs font-semibold text-amber-600 dark:text-amber-400"><CheckCircle2 size={14} /> {selectedArc.id === data.activeArcId ? "현재 Arc" : "제작 Arc"}</div>
                <h1 className="mt-2 text-xl font-semibold tracking-tight">{selectedArc.title}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{selectedArc.chapterNumbers.join("~")}화 · {selectedArc.episodeCount}화 구성 · {statusLabel(selectedArc.status)}</p>
              </div>
              <DetailRow label="독자 약속" value={selectedArc.promise} />
              <DetailRow label="목표" value={selectedArc.goal} />
              <DetailRow label="압박" value={selectedArc.pressure} />
              <DetailRow label="전환" value={selectedArc.turn} />
              <DetailRow label="이번 보상" value={selectedArc.payoff} />
              <DetailRow label="다음 훅" value={selectedArc.nextHook} />
              {selectedArc.futureAdvantageMove ? (
                <div className="space-y-4 rounded-2xl border border-amber-400/30 bg-amber-400/5 p-4">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">미래 선점 · {selectedArc.futureAdvantageMove.moveId}</div>
                    <div className="mt-1 text-sm font-semibold">{selectedArc.futureAdvantageMove.domain} · {selectedArc.futureAdvantageMove.target}</div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">기억하는 결과: {selectedArc.futureAdvantageMove.rememberedOutcome}</p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
                    <div className="rounded-xl border border-border/60 bg-background/60 p-3">
                      <div className="text-xs font-semibold text-foreground">A 레일 · 실행과 보상</div>
                      <ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
                        {selectedArc.futureAdvantageMove.bridgeSteps.map((step) => <li key={step}>• {step}</li>)}
                      </ul>
                      <p className="mt-2 text-xs leading-5"><span className="font-semibold">증거</span> · {selectedArc.futureAdvantageMove.proof || "미정"}</p>
                      <p className="text-xs leading-5"><span className="font-semibold">보상</span> · {selectedArc.futureAdvantageMove.reward || "미정"}</p>
                    </div>
                    <div className="rounded-xl border border-border/60 bg-background/60 p-3">
                      <div className="text-xs font-semibold text-foreground">B 레일 · 저항과 후폭풍</div>
                      <ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
                        {selectedArc.futureAdvantageMove.resistance.map((item) => <li key={`r-${item}`}>• {item}</li>)}
                        {selectedArc.futureAdvantageMove.downstreamConsequences.map((item) => <li key={`c-${item}`}>• {item}</li>)}
                      </ul>
                    </div>
                  </div>
                </div>
              ) : null}
              <div className="border-t border-border/50 pt-5">
                <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">회차 비트</div>
                <div className="space-y-3">
                  {selectedArc.episodeBeats.map((episode) => (
                    <div key={episode.chapterNumber} className="rounded-xl border border-border/60 bg-background/60 p-3">
                      <div className="text-sm font-semibold">{episode.chapterNumber}화 <span className="font-normal text-muted-foreground">· {episode.role}</span></div>
                      <ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
                        {episode.beats.map((beat) => <li key={beat}>• {beat}</li>)}
                      </ul>
                      <div className="mt-2 flex gap-1.5 text-xs leading-5 text-foreground/80"><AlertCircle size={13} className="mt-0.5 shrink-0 text-amber-500" />{episode.endingHook}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : <p className="text-sm text-muted-foreground">Arc 카드를 선택하면 제작 내용이 열립니다.</p>}
        </aside>
      </div>
    </div>
  );
}
