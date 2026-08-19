import { BaseAgent } from "./base.js";
import type { ArchitectOutput } from "./architect.js";

export interface FoundationReviewResult {
  readonly passed: boolean;
  readonly totalScore: number;
  readonly dimensions: ReadonlyArray<{
    readonly name: string;
    readonly score: number;
    readonly feedback: string;
  }>;
  readonly overallFeedback: string;
}

const PASS_THRESHOLD = 80;
const DIMENSION_FLOOR = 60;

export class FoundationReviewerAgent extends BaseAgent {
  get name(): string {
    return "foundation-reviewer";
  }

  async review(params: {
    readonly foundation: ArchitectOutput;
    readonly mode: "original" | "fanfic" | "series";
    readonly sourceCanon?: string;
    readonly styleGuide?: string;
    readonly language: "zh" | "ko" | "en";
    readonly targetChapters?: number;
  }): Promise<FoundationReviewResult> {
    const canonBlock = params.sourceCanon
      ? params.language === "ko"
        ? `\n## 원작 정본 참고\n${params.sourceCanon}\n`
        : `\n## 原作正典参照\n${params.sourceCanon}\n`
      : "";
    const styleBlock = params.styleGuide
      ? params.language === "ko"
        ? `\n## 원작 문체 참고\n${params.styleGuide}\n`
        : `\n## 原作风格参照\n${params.styleGuide}\n`
      : "";

    const dimensions = params.mode === "original"
      ? this.originalDimensions(params.language, params.targetChapters)
      : this.derivativeDimensions(params.language, params.mode);

    const systemPrompt = params.language === "ko"
      ? this.buildKoreanReviewPrompt(dimensions, canonBlock, styleBlock)
      : params.language === "en"
        ? this.buildEnglishReviewPrompt(dimensions, canonBlock, styleBlock)
        : this.buildChineseReviewPrompt(dimensions, canonBlock, styleBlock);

    const userPrompt = this.buildFoundationExcerpt(params.foundation, params.language);

    const response = await this.chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ], { temperature: 0.3 });

    return this.parseReviewResult(response.content, dimensions, params.language === "ko" ? 70 : DIMENSION_FLOOR);
  }

  private originalDimensions(language: "zh" | "ko" | "en", targetChapters?: number): ReadonlyArray<string> {
    const target = Number.isFinite(targetChapters) && targetChapters && targetChapters > 0
      ? Math.round(targetChapters)
      : 40;
    const openingWindow = Math.min(5, target);
    const repeatWindow = Math.min(10, Math.max(3, target));
    if (language === "ko") {
      return [
        `대표 재미와 독자 약속 (이 작품이 ${target}화 동안 반복해 줄 재미가 한 문장으로 선명한가?)`,
        `첫 ${openingWindow}화 추진력 (주인공이 바로 움직이고 독자가 확인할 첫 성과와 다음 압력이 있는가?)`,
        "사건의 재미 인과 (주인공의 행동, 상대의 대응, 보상, 다음 문제가 원인과 결과로 이어지는가?)",
        "보상과 상승 (돈·자리·정보·평판·관계의 변화가 장면으로 보이고 갈수록 커지는가?)",
        "인물의 행동과 상대의 실력 (주요 인물이 자기 욕망으로 선택하며 상대도 유능하게 맞서는가?)",
        "한국어 기획 문체 (번역형 추상어와 인공지능식 대조 없이 한국 작가가 바로 쓰는 말로 설명되는가?)",
        "세계와 사실의 일관성 (시대·업종·권력·경제 규칙이 사건을 돕고 앞뒤가 맞는가?)",
        `장기 연재 가능성 (${target}화 분량을 버티되 같은 승부를 ${repeatWindow}화씩 되풀이하지 않는가?)`,
      ];
    }
    return language === "en"
      ? [
          `Core Conflict (Is there a clear, compelling central conflict that can sustain the requested ${target} chapters?)`,
          `Opening Momentum (Can the first ${openingWindow} chapters create a page-turning hook?)`,
          "World Coherence (Is the worldbuilding internally consistent and specific?)",
          "Character Differentiation (Are the main characters distinct in voice and motivation?)",
          `Pacing Feasibility (Does the outline fit the requested ${target} chapters and avoid repeating the same beat for ${repeatWindow} chapters?)`,
        ]
      : [
          `核心冲突（是否有清晰且有足够张力的核心冲突支撑用户要求的${target}章？）`,
          `开篇节奏（前${openingWindow}章能否形成翻页驱动力？）`,
          "世界一致性（世界观是否内洽且具体？）",
          "角色区分度（主要角色的声音和动机是否各不相同？）",
          `节奏可行性（大纲是否适配用户要求的${target}章，并避免连续${repeatWindow}章同一种节拍？）`,
        ];
  }

  private derivativeDimensions(language: "zh" | "ko" | "en", mode: "fanfic" | "series"): ReadonlyArray<string> {
    const modeLabel = mode === "fanfic"
      ? (language !== "zh" ? "Fan Fiction" : "同人")
      : (language !== "zh" ? "Series" : "系列");

    if (language === "ko") {
      const koreanModeLabel = mode === "fanfic" ? "팬픽" : "시리즈";
      return [
        `원작 정본 보존 (${koreanModeLabel}이 원작의 세계 규칙, 인물 성격, 확정 사실을 지키는가?)`,
        "새 이야기의 자리 (원작을 되풀이하지 않고 분기점과 새 목표가 선명한가?)",
        "대표 재미와 핵심 갈등 (이 작품만의 승부와 독자 보상이 분명한가?)",
        "첫 5화 추진력 (설명 세 화를 거치지 않고 인물이 움직이고 첫 성과를 내는가?)",
        "사건의 재미 인과 (행동, 대응, 보상, 다음 문제가 장면으로 이어지는가?)",
        "한국어 기획 문체 (추상 명사와 번역형 대조 없이 사람이 행동하는 문장인가?)",
        "장기 연재 가능성 (원작 사건을 순서만 바꿔 다시 걷지 않는가?)",
      ];
    }
    return language === "en"
      ? [
          `Source DNA Preservation (Does the ${modeLabel} respect the original's world rules, character personalities, and established facts?)`,
          `New Narrative Space (Is there a clear divergence point or new territory that gives the story room to be ORIGINAL, not a retelling?)`,
          "Core Conflict (Is the new story's central conflict compelling and distinct from the original?)",
          "Opening Momentum (Can the first 5 chapters create a page-turning hook without requiring 3 chapters of setup?)",
          `Pacing Feasibility (Does the outline avoid the trap of re-walking the original's plot beats?)`,
        ]
      : [
          `原作DNA保留（${modeLabel}是否尊重原作的世界规则、角色性格、已确立事实？）`,
          `新叙事空间（是否有明确的分岔点或新领域，让故事有原创空间，而非复述原作？）`,
          "核心冲突（新故事的核心冲突是否有足够张力且区别于原作？）",
          "开篇节奏（前5章能否形成翻页驱动力，不需要3章铺垫？）",
          `节奏可行性（卷纲是否避免了重走原作剧情节拍的陷阱？）`,
        ];
  }

  private buildChineseReviewPrompt(
    dimensions: ReadonlyArray<string>,
    canonBlock: string,
    styleBlock: string,
  ): string {
    return `你是一位资深小说编辑，正在审核一本新书的基础设定（世界观 + 大纲 + 规则）。

你需要从以下维度逐项打分（0-100），并给出具体意见：

${dimensions.map((dim, i) => `${i + 1}. ${dim}`).join("\n")}

## 评分标准
- 80+ 通过，可以开始写作
- 60-79 有明显问题，需要修改
- <60 方向性错误，需要重新设计

## 输出格式（严格遵守）
=== DIMENSION: 1 ===
分数：{0-100}
意见：{具体反馈}

=== DIMENSION: 2 ===
分数：{0-100}
意见：{具体反馈}

...（每个维度一个 block）

=== OVERALL ===
总分：{加权平均}
通过：{是/否}
总评：{1-2段总结，指出最大的问题和最值得保留的优点}
${canonBlock}${styleBlock}

审核时要严格。不要因为"还行"就给高分。80分意味着"可以直接开写，不需要改"。`;
  }

  private buildEnglishReviewPrompt(
    dimensions: ReadonlyArray<string>,
    canonBlock: string,
    styleBlock: string,
  ): string {
    return `You are a senior fiction editor reviewing a new book's foundation (worldbuilding + outline + rules).

Score each dimension (0-100) with specific feedback:

${dimensions.map((dim, i) => `${i + 1}. ${dim}`).join("\n")}

## Scoring
- 80+ Pass — ready to write
- 60-79 Needs revision
- <60 Fundamental direction problem

## Output format (strict)
=== DIMENSION: 1 ===
Score: {0-100}
Feedback: {specific feedback}

=== DIMENSION: 2 ===
Score: {0-100}
Feedback: {specific feedback}

...

=== OVERALL ===
Total: {weighted average}
Passed: {yes/no}
Summary: {1-2 paragraphs — biggest problem and best quality}
${canonBlock}${styleBlock}

Be strict. 80 means "ready to write without changes."`;
  }

  private buildKoreanReviewPrompt(
    dimensions: ReadonlyArray<string>,
    canonBlock: string,
    styleBlock: string,
  ): string {
    return `당신은 한국 장르소설을 오래 다룬 편집자입니다. 새 작품의 기획 기반을 재미 우선으로 심사합니다.

아래 항목을 각각 0-100점으로 매기고, 실제 문서의 사건과 문장을 근거로 의견을 적으세요.

${dimensions.map((dim, i) => `${i + 1}. ${dim}`).join("\n")}

## 판정 기준

- 80점 이상: 손대지 않고 집필을 시작해도 됨
- 70-79점: 장점은 있으나 고칠 대목이 분명함
- 70점 미만: 한국어 창작 경로의 품질 문턱 미달
- 설정의 앞뒤가 맞는 것만으로 점수를 주지 마세요. 독자가 다음 화를 누를 사건과 보상이 없으면 낮게 평가하세요.
- '구조가 전진한다', '관계가 이동한다' 같은 추상 표현을 구체적인 인물 행동으로 바꿀 수 없다면 문체 항목을 통과시키지 마세요.

## 출력 형식

=== DIMENSION: 1 ===
점수: {0-100}
의견: {구체적인 근거와 수정 방향}

=== DIMENSION: 2 ===
점수: {0-100}
의견: {구체적인 근거와 수정 방향}

각 항목을 같은 형식으로 빠짐없이 출력하세요.

=== OVERALL ===
총점: {평균}
통과: {예/아니요}
총평: {가장 먼저 고칠 한 가지와 반드시 살릴 장점}
${canonBlock}${styleBlock}

엄격하게 평가하세요. 80점은 '지금 바로 써도 된다'는 뜻입니다.`;
  }

  private buildFoundationExcerpt(foundation: ArchitectOutput, language: "zh" | "ko" | "en"): string {
    return language === "ko"
      ? `## 이야기 기반\n${foundation.storyBible}\n\n## 권별 흐름\n${foundation.volumeOutline}\n\n## 작품 규칙\n${foundation.bookRules}\n\n## 시작 상태\n${foundation.currentState}\n\n## 시작 복선\n${foundation.pendingHooks}`
      : language === "en"
      ? `## Story Bible\n${foundation.storyBible}\n\n## Volume Outline\n${foundation.volumeOutline}\n\n## Book Rules\n${foundation.bookRules}\n\n## Initial State\n${foundation.currentState}\n\n## Initial Hooks\n${foundation.pendingHooks}`
      : `## 世界设定\n${foundation.storyBible}\n\n## 卷纲\n${foundation.volumeOutline}\n\n## 规则\n${foundation.bookRules}\n\n## 初始状态\n${foundation.currentState}\n\n## 初始伏笔\n${foundation.pendingHooks}`;
  }

  private parseReviewResult(
    content: string,
    dimensions: ReadonlyArray<string>,
    dimensionFloor = DIMENSION_FLOOR,
  ): FoundationReviewResult {
    const parsedDimensions: Array<{ readonly name: string; readonly score: number; readonly feedback: string }> = [];

    for (let i = 0; i < dimensions.length; i++) {
      const regex = new RegExp(
        `=== DIMENSION: ${i + 1} ===\\s*[\\s\\S]*?(?:점수|分数|Score)[：:]\\s*(\\d+)[\\s\\S]*?(?:의견|意见|Feedback)[：:]\\s*([\\s\\S]*?)(?==== |$)`,
      );
      const match = content.match(regex);
      parsedDimensions.push({
        name: dimensions[i]!,
        score: match ? parseInt(match[1]!, 10) : 50,
        feedback: match ? match[2]!.trim() : "(parse failed)",
      });
    }

    const totalScore = parsedDimensions.length > 0
      ? Math.round(parsedDimensions.reduce((sum, d) => sum + d.score, 0) / parsedDimensions.length)
      : 0;
    const anyBelowFloor = parsedDimensions.some((d) => d.score < dimensionFloor);
    const passed = totalScore >= PASS_THRESHOLD && !anyBelowFloor;

    const overallMatch = content.match(
      /=== OVERALL ===[\s\S]*?(?:총평|总评|Summary)[：:]\s*([\s\S]*?)$/,
    );
    const overallFeedback = overallMatch ? overallMatch[1]!.trim() : "(parse failed)";

    return { passed, totalScore, dimensions: parsedDimensions, overallFeedback };
  }
}
