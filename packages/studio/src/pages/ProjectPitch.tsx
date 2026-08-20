import { ArrowLeft, BookOpen, FileText, Sparkles } from "lucide-react";
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { useApi } from "../hooks/use-api";

type ProjectPitchData = {
  readonly content: string;
  readonly path: string;
  readonly futureAdvantageContract?: {
    readonly originMoment?: string;
    readonly corePromise?: string;
    readonly allowedDomains: ReadonlyArray<string>;
    readonly known: ReadonlyArray<string>;
    readonly unknown: ReadonlyArray<string>;
    readonly forbiddenShortcuts: ReadonlyArray<string>;
    readonly memoryPolicy?: string;
    readonly researchPolicy: string;
  };
  readonly references: ReadonlyArray<{
    readonly materialId: string;
    readonly title: string;
    readonly uses: ReadonlyArray<string>;
    readonly note?: string;
    readonly available: boolean;
    readonly source?: string;
  }>;
  readonly referenceError?: string;
};

export default function ProjectPitch({ bookId }: { readonly bookId: string }) {
  const { data, loading, error } = useApi<ProjectPitchData>(`/books/${encodeURIComponent(bookId)}/project-pitch`);

  if (loading) return <div className="p-8 text-sm text-muted-foreground">기획서를 불러오는 중...</div>;
  if (error || !data) return <div className="p-8 text-sm text-muted-foreground">이 작품에 연결된 기획서가 아직 없습니다.</div>;

  return (
    <article className="mx-auto w-full max-w-4xl px-6 py-10 md:px-10 lg:py-14" data-testid="project-pitch">
      <a href={`#/book/${encodeURIComponent(bookId)}`} className="mb-5 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-primary"><ArrowLeft size={14} /> 작품 대화</a>
      <header className="mb-8 border-b border-border/60 pb-6">
        <div className="flex items-center gap-2 text-sm font-semibold text-primary"><FileText size={16} /> 기획서</div>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">이야기 입력을 정리한 작품의 약속과 장기 성장 지도입니다.</p>
      </header>
      {data.futureAdvantageContract ? (
        <section className="mb-8 rounded-xl border border-amber-400/30 bg-amber-400/5 p-5" aria-labelledby="future-advantage-contract-title">
          <div id="future-advantage-contract-title" className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Sparkles size={16} className="text-amber-500" /> 미래 선점 계약
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <ContractField label="회귀 기준 시점" value={data.futureAdvantageContract.originMoment} />
            <ContractField label="핵심 재미" value={data.futureAdvantageContract.corePromise} />
            <ContractField label="허용 분야" values={data.futureAdvantageContract.allowedDomains} />
            <ContractField label="알고 있는 것" values={data.futureAdvantageContract.known} />
            <ContractField label="모르는 것" values={data.futureAdvantageContract.unknown} />
            <ContractField label="금지된 지름길" values={data.futureAdvantageContract.forbiddenShortcuts} />
            <ContractField label="기억 원칙" value={data.futureAdvantageContract.memoryPolicy} />
            <ContractField label="고증 정책" value={data.futureAdvantageContract.researchPolicy} />
          </div>
        </section>
      ) : null}
      <section className="mb-8 rounded-xl border border-border/70 bg-muted/25 p-5" aria-labelledby="pitch-references-title">
        <div id="pitch-references-title" className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <BookOpen size={16} /> 레퍼런스 사용 기록
        </div>
        {data.referenceError ? (
          <p className="mt-3 text-sm leading-6 text-destructive">레퍼런스 기록을 읽지 못했습니다: {data.referenceError}</p>
        ) : data.references.length === 0 ? (
          <p className="mt-3 text-sm leading-6 text-muted-foreground">이 작품에 연결된 작품·자료가 없습니다. 특정 작품을 참고했다는 InkOS 기록도 없습니다.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {data.references.map((reference) => (
              <li key={reference.materialId} className="rounded-lg border border-border/60 bg-background/70 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{reference.title}</span>
                  {!reference.available && <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">원본 없음</span>}
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">활용: {reference.uses.join(" · ")}</p>
                {reference.source && <p className="mt-1 break-all text-xs leading-5 text-muted-foreground">출처: {reference.source}</p>}
                {reference.note && <p className="mt-1 text-xs leading-5 text-muted-foreground">메모: {reference.note}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="prose prose-neutral max-w-none dark:prose-invert prose-headings:font-serif prose-p:leading-8 prose-li:leading-8">
        <Streamdown plugins={{ cjk }} mode="static">{data.content}</Streamdown>
      </div>
    </article>
  );
}

function ContractField({
  label,
  value,
  values,
}: {
  readonly label: string;
  readonly value?: string;
  readonly values?: ReadonlyArray<string>;
}) {
  const text = value?.trim() || values?.join(" · ").trim();
  if (!text) return null;
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">{label}</div>
      <p className="mt-1 text-sm leading-6 text-foreground/90">{text}</p>
    </div>
  );
}
