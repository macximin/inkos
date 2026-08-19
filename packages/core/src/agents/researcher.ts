import { fetchUrl, searchWeb, type SearchResult } from "../utils/web-search.js";

export type ResearchPurpose = "worldbuilding" | "era" | "profession" | "market" | "fact-check" | "general";
export type ResearchDepth = "quick" | "standard" | "deep";

export interface ResearchInput {
  readonly topic: string;
  readonly purpose: ResearchPurpose;
  readonly depth: ResearchDepth;
  readonly language?: "zh" | "ko" | "en";
}

export interface ResearchSource {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly excerpt?: string;
}

export interface ResearchClaim {
  readonly text: string;
  readonly sourceIds: readonly string[];
  readonly confidence: "low" | "medium" | "high";
}

export interface ResearchReport {
  readonly summary: string;
  readonly claims: readonly ResearchClaim[];
  readonly conflicts: readonly string[];
  readonly unknowns: readonly string[];
  readonly creativeImplications: readonly string[];
  readonly sources: readonly ResearchSource[];
  readonly confidence: "low" | "medium" | "high";
  readonly queryLog: readonly string[];
  readonly partialFailures: readonly string[];
  readonly markdown: string;
}

export interface ResearchDeps {
  readonly search?: (query: string, maxResults: number) => Promise<ReadonlyArray<SearchResult>>;
  readonly fetch?: (url: string, maxChars: number) => Promise<string>;
}

const PURPOSE_HINTS: Record<"zh" | "ko" | "en", Record<ResearchPurpose, string>> = {
  zh: {
    worldbuilding: "世界观 背景 生活细节",
    era: "年代 背景 制度 物价 生活",
    profession: "职业 流程 术语 工作细节",
    market: "市场 趋势 受众 竞品",
    "fact-check": "事实核查 来源",
    general: "资料 参考",
  },
  ko: {
    worldbuilding: "세계관 배경 생활상",
    era: "시대 배경 제도 물가 생활상",
    profession: "직업 업무 절차 용어",
    market: "시장 동향 독자 경쟁작",
    "fact-check": "사실 확인 근거 출처",
    general: "자료 참고",
  },
  en: {
    worldbuilding: "worldbuilding background everyday life",
    era: "historical era institutions prices everyday life",
    profession: "profession workflow terminology",
    market: "market trends audience comparable works",
    "fact-check": "fact check evidence sources",
    general: "references sources",
  },
};

export async function runResearchReport(
  input: ResearchInput,
  deps: ResearchDeps = {},
): Promise<ResearchReport> {
  const topic = input.topic.trim();
  if (!topic) throw new Error("research topic is required.");
  const search = deps.search ?? searchWeb;
  const fetch = deps.fetch ?? fetchUrl;
  const depth = depthConfig(input.depth);
  const queryLanguage = input.language ?? "zh";
  const reportLanguage = input.language ?? "en";
  const queries = buildQueries(topic, input.purpose, input.depth, queryLanguage);
  const queryLog: string[] = [];
  const partialFailures: string[] = [];
  const found = new Map<string, SearchResult>();

  for (const query of queries.slice(0, depth.queryCount)) {
    queryLog.push(query);
    try {
      const results = await search(query, depth.maxResults);
      for (const result of results) {
        if (!result.url || found.has(result.url)) continue;
        found.set(result.url, result);
      }
    } catch (error) {
      partialFailures.push(localizedFailure("search", reportLanguage, query, error));
    }
  }

  const sources: ResearchSource[] = [];
  for (const result of [...found.values()].slice(0, depth.fetchCount)) {
    let excerpt: string | undefined;
    try {
      excerpt = await fetch(result.url, 1800);
    } catch (error) {
      partialFailures.push(localizedFailure("fetch", reportLanguage, result.url, error));
    }
    sources.push({
      id: `S${sources.length + 1}`,
      title: result.title || result.url,
      url: result.url,
      snippet: result.snippet,
      ...(excerpt ? { excerpt: firstSentences(excerpt, 3) } : {}),
    });
  }

  const claims = sources.map((source): ResearchClaim => ({
    text: firstSentences(source.excerpt || source.snippet || source.title, 1) || source.title,
    sourceIds: [source.id],
    confidence: source.excerpt ? "medium" : "low",
  }));
  const unknowns = sources.length === 0
    ? [localizedText(reportLanguage, "noSources")]
    : partialFailures.length > 0
      ? [localizedText(reportLanguage, "partialSources")]
      : [];
  const confidence: ResearchReport["confidence"] = sources.length >= 3 && partialFailures.length === 0
    ? "high"
    : sources.length >= 1
      ? "medium"
      : "low";
  const report = {
    summary: localizedSummary(reportLanguage, topic, input.purpose, input.depth, sources.length),
    claims,
    conflicts: [],
    unknowns,
    creativeImplications: buildCreativeImplications(input.purpose, sources.length, reportLanguage),
    sources,
    confidence,
    queryLog,
    partialFailures,
  };
  return {
    ...report,
    markdown: renderResearchMarkdown(topic, input, report),
  };
}

function depthConfig(depth: ResearchDepth): { queryCount: number; maxResults: number; fetchCount: number } {
  if (depth === "deep") return { queryCount: 3, maxResults: 5, fetchCount: 6 };
  if (depth === "standard") return { queryCount: 2, maxResults: 4, fetchCount: 4 };
  return { queryCount: 1, maxResults: 3, fetchCount: 2 };
}

function buildQueries(
  topic: string,
  purpose: ResearchPurpose,
  depth: ResearchDepth,
  language: "zh" | "ko" | "en",
): string[] {
  const hint = PURPOSE_HINTS[language][purpose];
  const queries = [`${topic} ${hint}`];
  if (depth !== "quick") {
    queries.push(language === "ko" ? `${topic} 자료 출처` : language === "en" ? `${topic} sources evidence` : `${topic} 资料 来源`);
  }
  if (depth === "deep") {
    queries.push(language === "ko" ? `${topic} 논쟁 오류 사실 확인` : language === "en" ? `${topic} disputes misconceptions fact check` : `${topic} 争议 误区 核查`);
  }
  return queries;
}

function firstSentences(text: string, maxSentences: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const parts = normalized.match(/[^。！？.!?]+[。！？.!?]?/g) ?? [normalized];
  return parts.slice(0, maxSentences).join("").trim().slice(0, 700);
}

function buildCreativeImplications(
  purpose: ResearchPurpose,
  sourceCount: number,
  language: "zh" | "ko" | "en",
): string[] {
  const messages = CREATIVE_IMPLICATIONS[language];
  if (sourceCount === 0) return [messages.empty];
  return [messages[purpose]];
}

function renderResearchMarkdown(
  topic: string,
  input: ResearchInput,
  report: Omit<ResearchReport, "markdown">,
): string {
  if (input.language === "ko") return renderKoreanResearchMarkdown(topic, input, report);
  if (input.language === "zh") return renderChineseResearchMarkdown(topic, input, report);
  return [
    `# Research: ${topic}`,
    "",
    `- Purpose: ${input.purpose}`,
    `- Depth: ${input.depth}`,
    `- Confidence: ${report.confidence}`,
    "",
    "## Summary",
    report.summary,
    "",
    "## Claims",
    ...(report.claims.length > 0
      ? report.claims.map((claim) => `- ${claim.text} (${claim.sourceIds.map((id) => `[${id}]`).join(", ")}, ${claim.confidence})`)
      : ["- No sourced claims collected."]),
    "",
    "## Conflicts",
    ...(report.conflicts.length > 0 ? report.conflicts.map((item) => `- ${item}`) : ["- None detected by the collection pass."]),
    "",
    "## Unknowns",
    ...(report.unknowns.length > 0 ? report.unknowns.map((item) => `- ${item}`) : ["- None recorded."]),
    "",
    "## Creative implications",
    ...report.creativeImplications.map((item) => `- ${item}`),
    "",
    "## Sources",
    ...(report.sources.length > 0
      ? report.sources.map((source) => [
          `### [${source.id}] ${source.title}`,
          source.url,
          "",
          source.excerpt || source.snippet || "",
        ].join("\n"))
      : ["No sources collected."]),
    "",
    "## Query log",
    ...report.queryLog.map((query) => `- ${query}`),
    "",
    "## Partial failures",
    ...(report.partialFailures.length > 0 ? report.partialFailures.map((item) => `- ${item}`) : ["- None."]),
    "",
  ].join("\n");
}

const CREATIVE_IMPLICATIONS = {
  ko: {
    empty: "수집된 내용을 아직 작품의 확정 설정으로 올리지 마세요.",
    worldbuilding: "확인된 사회·물질·제도 정보를 설명문이 아니라 장면 규칙으로 바꾸세요.",
    era: "실제 역사 기준은 장면·소품·대사·제도의 출발점을 확인하는 데 쓰고, 허용된 가상 분기는 별도로 판단하세요.",
    profession: "업무 절차와 용어는 질감으로 쓰되, 강한 사실 주장은 출처와 연결하세요.",
    market: "시장 관찰은 작품 포지셔닝 참고로만 쓰고 작품 설정으로 취급하지 마세요.",
    "fact-check": "출처가 하나뿐인 사실은 교차 확인 전까지 잠정 정보로 두세요.",
    general: "출처가 있는 내용만 참고하고, 풀리지 않은 쟁점은 확정 설정에서 빼세요.",
  },
  zh: {
    empty: "暂时不要把任何收集项提升为作品硬设定。",
    worldbuilding: "把已核实的社会、物质与制度细节转成场景规则，不要堆成说明。",
    era: "用真实历史基线检查场景、道具、对话与制度；已授权的虚构分歧要另行判断。",
    profession: "把流程和术语用作质感，但强事实主张必须关联来源。",
    market: "市场观察只用于定位参考，不作为作品正典。",
    "fact-check": "只有一个来源的事实，在交叉核实前保持为软信息。",
    general: "把有来源的细节作为参考，未解决内容不要进入硬设定。",
  },
  en: {
    empty: "Do not promote any collected item to hard story canon yet.",
    worldbuilding: "Convert verified social, material, and institutional details into scene rules rather than exposition dumps.",
    era: "Use real-history baselines to check scenes, props, dialogue, and institutions; judge authorized fictional divergence separately.",
    profession: "Use workflow details and terminology as texture, but keep hard claims source-backed.",
    market: "Treat market observations as positioning hints, not as story canon.",
    "fact-check": "Facts with only one source should remain soft until cross-checked.",
    general: "Use sourced details as references; unresolved points should stay out of hard canon.",
  },
} as const;

function localizedSummary(
  language: "zh" | "ko" | "en",
  topic: string,
  purpose: ResearchPurpose,
  depth: ResearchDepth,
  sourceCount: number,
): string {
  if (language === "ko") return `“${topic}”에 관한 출처 ${sourceCount}개를 수집했습니다. (목적: ${purpose}, 깊이: ${depth})`;
  if (language === "zh") return `已为“${topic}”收集 ${sourceCount} 个来源。（用途：${purpose}，深度：${depth}）`;
  return `Research collected ${sourceCount} source(s) for "${topic}" (${purpose}, ${depth}).`;
}

function localizedText(language: "zh" | "ko" | "en", key: "noSources" | "partialSources"): string {
  if (key === "noSources") {
    if (language === "ko") return "사용할 수 있는 출처를 수집하지 못했습니다. 이 보고서는 미완성으로 취급하세요.";
    if (language === "zh") return "未收集到可用来源，请把本报告视为未完成。";
    return "No usable sources were collected. Treat this report as incomplete.";
  }
  if (language === "ko") return "일부 검색이나 원문 수집에 실패했습니다. 중요한 사실은 확정 설정에 쓰기 전에 다시 확인하세요.";
  if (language === "zh") return "部分检索或原文抓取失败；关键事实进入硬设定前必须再次核实。";
  return "Some queries or source fetches failed; verify critical facts before using them as hard canon.";
}

function localizedFailure(
  kind: "search" | "fetch",
  language: "zh" | "ko" | "en",
  target: string,
  error: unknown,
): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (language === "ko") return `${kind === "search" ? "검색" : "원문 수집"} 실패 “${target}”: ${detail}`;
  if (language === "zh") return `${kind === "search" ? "检索" : "原文抓取"}失败“${target}”：${detail}`;
  return `${kind} failed for "${target}": ${detail}`;
}

function renderKoreanResearchMarkdown(
  topic: string,
  input: ResearchInput,
  report: Omit<ResearchReport, "markdown">,
): string {
  return renderLocalizedResearchMarkdown(topic, input, report, {
    title: "리서치",
    purpose: "목적",
    depth: "깊이",
    confidence: "신뢰도",
    summary: "요약",
    claims: "확인된 주장",
    conflicts: "충돌",
    unknowns: "미확인 사항",
    implications: "창작 적용",
    sources: "출처",
    queries: "검색 기록",
    failures: "부분 실패",
    noClaims: "출처와 연결된 주장을 수집하지 못했습니다.",
    noConflicts: "수집 단계에서 발견하지 못했습니다.",
    noneRecorded: "기록 없음.",
    noSources: "수집된 출처 없음.",
    none: "없음.",
  });
}

function renderChineseResearchMarkdown(
  topic: string,
  input: ResearchInput,
  report: Omit<ResearchReport, "markdown">,
): string {
  return renderLocalizedResearchMarkdown(topic, input, report, {
    title: "资料研究",
    purpose: "用途",
    depth: "深度",
    confidence: "可信度",
    summary: "摘要",
    claims: "已核实主张",
    conflicts: "冲突",
    unknowns: "未知项",
    implications: "创作应用",
    sources: "来源",
    queries: "检索记录",
    failures: "部分失败",
    noClaims: "未收集到带来源的主张。",
    noConflicts: "本轮收集未发现。",
    noneRecorded: "无记录。",
    noSources: "未收集到来源。",
    none: "无。",
  });
}

interface ResearchMarkdownLabels {
  readonly title: string;
  readonly purpose: string;
  readonly depth: string;
  readonly confidence: string;
  readonly summary: string;
  readonly claims: string;
  readonly conflicts: string;
  readonly unknowns: string;
  readonly implications: string;
  readonly sources: string;
  readonly queries: string;
  readonly failures: string;
  readonly noClaims: string;
  readonly noConflicts: string;
  readonly noneRecorded: string;
  readonly noSources: string;
  readonly none: string;
}

function renderLocalizedResearchMarkdown(
  topic: string,
  input: ResearchInput,
  report: Omit<ResearchReport, "markdown">,
  labels: ResearchMarkdownLabels,
): string {
  return [
    `# ${labels.title}: ${topic}`,
    "",
    `- ${labels.purpose}: ${input.purpose}`,
    `- ${labels.depth}: ${input.depth}`,
    `- ${labels.confidence}: ${report.confidence}`,
    "",
    `## ${labels.summary}`,
    report.summary,
    "",
    `## ${labels.claims}`,
    ...(report.claims.length > 0
      ? report.claims.map((claim) => `- ${claim.text} (${claim.sourceIds.map((id) => `[${id}]`).join(", ")}, ${claim.confidence})`)
      : [`- ${labels.noClaims}`]),
    "",
    `## ${labels.conflicts}`,
    ...(report.conflicts.length > 0 ? report.conflicts.map((item) => `- ${item}`) : [`- ${labels.noConflicts}`]),
    "",
    `## ${labels.unknowns}`,
    ...(report.unknowns.length > 0 ? report.unknowns.map((item) => `- ${item}`) : [`- ${labels.noneRecorded}`]),
    "",
    `## ${labels.implications}`,
    ...report.creativeImplications.map((item) => `- ${item}`),
    "",
    `## ${labels.sources}`,
    ...(report.sources.length > 0
      ? report.sources.map((source) => [
          `### [${source.id}] ${source.title}`,
          source.url,
          "",
          source.excerpt || source.snippet || "",
        ].join("\n"))
      : [labels.noSources]),
    "",
    `## ${labels.queries}`,
    ...report.queryLog.map((query) => `- ${query}`),
    "",
    `## ${labels.failures}`,
    ...(report.partialFailures.length > 0 ? report.partialFailures.map((item) => `- ${item}`) : [`- ${labels.none}`]),
    "",
  ].join("\n");
}
