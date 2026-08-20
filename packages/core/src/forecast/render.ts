import type { ForecastBranch, NarrativeForecast } from "./schema.js";

// Deterministic markdown renderers for forecast artifacts. Both documents are
// derived purely from forecast.json so re-rendering never needs another LLM
// call and tests stay clock-free.

export function renderForecastComparisonMarkdown(forecast: NarrativeForecast): string {
  const zh = forecast.language === "zh";
  const ko = forecast.language === "ko";
  const header = ko
    ? [
        `# 서사 예측 비교: ${forecast.divergence}`,
        "",
        `- 예측 ID: ${forecast.forecastId}`,
        `- 작품: ${forecast.bookId}`,
        `- 기준 회차: ${forecast.baseChapter}화`,
        `- 예측 범위: 약 ${forecast.horizon}화`,
        `- 생성 시각: ${forecast.createdAt}`,
        "",
        "> 정사가 아닌 기획 자료입니다. 본문이나 정본 상태를 바꾸지 않습니다.",
      ]
    : zh
    ? [
        `# 叙事推演对比：${forecast.divergence}`,
        "",
        `- 推演 ID：${forecast.forecastId}`,
        `- 书籍：${forecast.bookId}`,
        `- 基准章节：第 ${forecast.baseChapter} 章`,
        `- 推演跨度：约 ${forecast.horizon} 章`,
        `- 生成时间：${forecast.createdAt}`,
        "",
        "> 本文件是非正史规划材料，不会改动正文或权威状态。",
      ]
    : [
        `# Narrative forecast comparison: ${forecast.divergence}`,
        "",
        `- Forecast id: ${forecast.forecastId}`,
        `- Book: ${forecast.bookId}`,
        `- Base chapter: ${forecast.baseChapter}`,
        `- Horizon: ~${forecast.horizon} chapters`,
        `- Created at: ${forecast.createdAt}`,
        "",
        "> Non-canonical planning material. Nothing here modifies prose or authoritative state.",
      ];

  const tableHeader = ko
    ? ["| 분기 | 제목 | 의도 부합 | 위험 | 전제 |", "| --- | --- | --- | --- | --- |"]
    : zh
    ? ["| 分支 | 标题 | 意图匹配 | 风险数 | 前提 |", "| --- | --- | --- | --- | --- |"]
    : ["| Branch | Title | Intent fit | Risks | Premise |", "| --- | --- | --- | --- | --- |"];
  const tableRows = forecast.branches.map((branch) =>
    `| ${branch.branchId} | ${escapeCell(branch.title)} | ${branch.intentAlignment.score} | ${branch.risks.length} | ${escapeCell(branch.premise)} |`);

  const sections = forecast.branches.map((branch) => renderBranchSection(branch, forecast.language));

  return [...header, "", ...tableHeader, ...tableRows, "", sections.join("\n\n")].join("\n");
}

export function renderSelectedBranchPlanMarkdown(input: {
  readonly forecast: NarrativeForecast;
  readonly branch: ForecastBranch;
  readonly selectedAt: string;
  readonly stale: boolean;
}): string {
  const { forecast, branch } = input;
  const zh = forecast.language === "zh";
  const ko = forecast.language === "ko";

  const staleWarning = input.stale
    ? (ko
        ? "> ⚠️ 정사 회차나 상태가 예측 생성 뒤에 바뀌었습니다. 아래 계획은 이전 컨텍스트 기준이므로 적용 전에 다시 확인하고 필요하면 예측을 새로 만드세요."
        : zh
        ? "> ⚠️ 该推演已过期：正史章节或状态在推演生成后发生了变化。以下计划基于旧上下文，采用前请重新核对，必要时重新生成推演。"
        : "> ⚠️ This forecast is stale: canonical chapters or state changed after it was generated. The plan below is based on outdated context — re-check before applying, and regenerate if needed.")
    : "";

  const header = ko
    ? [
        `# 선택한 분기 계획: ${branch.title}`,
        "",
        `- 예측 ID: ${forecast.forecastId}`,
        `- 분기: ${branch.branchId}`,
        `- 분기점: ${forecast.divergence}`,
        `- 기준 회차: ${forecast.baseChapter}화`,
        `- 선택 시각: ${input.selectedAt}`,
      ]
    : zh
    ? [
        `# 已选分支计划：${branch.title}`,
        "",
        `- 推演 ID：${forecast.forecastId}`,
        `- 分支：${branch.branchId}`,
        `- 分歧点：${forecast.divergence}`,
        `- 基准章节：第 ${forecast.baseChapter} 章`,
        `- 选择时间：${input.selectedAt}`,
      ]
    : [
        `# Selected branch plan: ${branch.title}`,
        "",
        `- Forecast id: ${forecast.forecastId}`,
        `- Branch: ${branch.branchId}`,
        `- Divergence: ${forecast.divergence}`,
        `- Base chapter: ${forecast.baseChapter}`,
        `- Selected at: ${input.selectedAt}`,
      ];

  const footer = ko
    ? "> 이 계획은 정사를 바꾸지 않습니다. 대강·회차 의도·정본 상태에 반영하려면 별도의 명시적 확정이 필요합니다."
    : zh
    ? "> 本计划不修改正史。要把它应用到大纲、章节意图或权威状态，需要另行确认的操作（v1 不自动执行）。"
    : "> This plan does not modify canon. Applying it to the outline, chapter intents, or authoritative state is a separate, explicitly confirmed operation (not automated in v1).";

  return [
    ...header,
    ...(staleWarning ? ["", staleWarning] : []),
    "",
    renderBranchSection(branch, forecast.language, { headingLevel: 2, includeBranchId: false }),
    "",
    footer,
  ].join("\n");
}

function renderBranchSection(
  branch: ForecastBranch,
  language: "zh" | "ko" | "en",
  options: { readonly headingLevel?: number; readonly includeBranchId?: boolean } = {},
): string {
  const level = "#".repeat(options.headingLevel ?? 2);
  const sub = `${level}#`;
  const heading = options.includeBranchId === false
    ? `${level} ${branch.title}`
    : `${level} ${branch.branchId}：${branch.title}`;

  const labels = language === "ko"
    ? {
        premise: "전제와 가정",
        beats: "향후 회차 비트",
        decisions: "인물의 결정",
        changes: "예상 변화",
        characters: "인물",
        relationships: "관계",
        world: "세계",
        hooks: "복선",
        risks: "정합성 위험",
        uncertainties: "불확실한 점",
        alignment: "작가 의도 부합도",
        futureAdvantage: "미래 선점 move",
        chapterPrefix: (n: number) => `${n}화`,
        none: "(없음)",
      }
    : language === "zh"
    ? {
        premise: "前提与假设",
        beats: "未来章节节拍",
        decisions: "人物决策",
        changes: "预计变化",
        characters: "人物",
        relationships: "关系",
        world: "世界",
        hooks: "伏笔",
        risks: "一致性风险",
        uncertainties: "不确定性",
        alignment: "作者意图匹配度",
        futureAdvantage: "未来先机 move",
        chapterPrefix: (n: number) => `第 ${n} 章`,
        none: "（无）",
      }
    : {
        premise: "Premise and assumptions",
        beats: "Future chapter beats",
        decisions: "Character decisions",
        changes: "Projected changes",
        characters: "Characters",
        relationships: "Relationships",
        world: "World",
        hooks: "Hooks",
        risks: "Consistency risks",
        uncertainties: "Uncertainties",
        alignment: "Author intent alignment",
        futureAdvantage: "Future-advantage move",
        chapterPrefix: (n: number) => `Chapter ${n}`,
        none: "(none)",
      };

  const list = (items: ReadonlyArray<string>): string =>
    items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : labels.none;

  const move = branch.futureAdvantageMove;
  const moveLabels = language === "ko"
    ? { target: "대상", outcome: "기억하는 결과", bridge: "A 레일 / 실행 다리", proof: "A 레일 / 증거", reward: "A 레일 / 보상", resistance: "B 레일 / 저항", aftermath: "B 레일 / 후폭풍", memoryRisk: "B 레일 / 기억 열화 위험" }
    : language === "zh"
      ? { target: "目标", outcome: "记忆中的结果", bridge: "A 线 / 落地桥梁", proof: "A 线 / 证据", reward: "A 线 / 回报", resistance: "B 线 / 阻力", aftermath: "B 线 / 后果", memoryRisk: "B 线 / 记忆失准风险" }
      : { target: "Target", outcome: "Remembered outcome", bridge: "A-Rail / bridge", proof: "A-Rail / proof", reward: "A-Rail / reward", resistance: "B-Rail / resistance", aftermath: "B-Rail / aftermath", memoryRisk: "B-Rail / memory risk" };
  const moveSection = move
    ? [
        "",
        `${sub} ${labels.futureAdvantage}`,
        "",
        `- ${move.moveId} · ${move.mode} · ${move.domain}`,
        `- ${moveLabels.target}: ${move.target}`,
        `- ${moveLabels.outcome}: ${move.rememberedOutcome}`,
        `- ${moveLabels.bridge}: ${joinOrNone(move.bridgeSteps, labels.none)}`,
        `- ${moveLabels.proof}: ${move.proof || labels.none}`,
        `- ${moveLabels.reward}: ${move.reward || labels.none}`,
        `- ${moveLabels.resistance}: ${joinOrNone(move.resistance, labels.none)}`,
        `- ${moveLabels.aftermath}: ${joinOrNone(move.downstreamConsequences, labels.none)}`,
        `- ${moveLabels.memoryRisk}: ${move.memoryRisk || labels.none}`,
      ]
    : [];

  return [
    heading,
    "",
    `${sub} ${labels.premise}`,
    "",
    branch.premise,
    "",
    `${sub} ${labels.beats}`,
    "",
    list(branch.beats.map((beat) => `${labels.chapterPrefix(beat.chapter)}：${beat.summary}`)),
    "",
    `${sub} ${labels.decisions}`,
    "",
    list(branch.characterDecisions.map((decision) => `${decision.character}：${decision.decision}`)),
    "",
    `${sub} ${labels.changes}`,
    "",
    `- ${labels.characters}：${joinOrNone(branch.projectedChanges.characters, labels.none)}`,
    `- ${labels.relationships}：${joinOrNone(branch.projectedChanges.relationships, labels.none)}`,
    `- ${labels.world}：${joinOrNone(branch.projectedChanges.world, labels.none)}`,
    `- ${labels.hooks}：${joinOrNone(branch.projectedChanges.hooks, labels.none)}`,
    "",
    `${sub} ${labels.risks}`,
    "",
    list(branch.risks.map((risk) => `[${risk.kind}] ${risk.description}`)),
    "",
    `${sub} ${labels.uncertainties}`,
    "",
    list([...branch.uncertainties]),
    "",
    `${sub} ${labels.alignment}`,
    "",
    `${branch.intentAlignment.score}/100 — ${branch.intentAlignment.rationale}`,
    ...moveSection,
  ].join("\n");
}

function joinOrNone(items: ReadonlyArray<string>, none: string): string {
  return items.length > 0 ? items.join("；") : none;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
