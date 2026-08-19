import { BaseAgent } from "./base.js";
import type { LengthNormalizeMode, LengthSpec } from "../models/length-governance.js";
import { countChapterLength, chooseNormalizeMode, isOutsideHardRange, isOutsideSoftRange } from "../utils/length-metrics.js";

export interface NormalizeLengthInput {
  readonly chapterContent: string;
  readonly lengthSpec: LengthSpec;
  readonly chapterIntent?: string;
  readonly reducedControlBlock?: string;
}

export interface NormalizeLengthOutput {
  readonly normalizedContent: string;
  readonly finalCount: number;
  readonly applied: boolean;
  readonly mode: LengthNormalizeMode;
  readonly warning?: string;
  readonly tokenUsage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

export class LengthNormalizerAgent extends BaseAgent {
  get name(): string {
    return "length-normalizer";
  }

  async normalizeChapter(input: NormalizeLengthInput): Promise<NormalizeLengthOutput> {
    const originalCount = countChapterLength(input.chapterContent, input.lengthSpec.countingMode);
    const mode = input.lengthSpec.normalizeMode === "none"
      ? chooseNormalizeMode(originalCount, input.lengthSpec)
      : input.lengthSpec.normalizeMode;

    if (mode === "none") {
      return {
        normalizedContent: input.chapterContent,
        finalCount: originalCount,
        applied: false,
        mode,
      };
    }

    const language = input.lengthSpec.countingMode === "ko_chars"
      ? "ko"
      : input.lengthSpec.countingMode === "en_words"
        ? "en"
        : "zh";
    const systemPrompt = this.buildSystemPrompt(mode, language);
    const userPrompt = this.buildUserPrompt(input, originalCount, mode, language);
    const response = await this.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      {
        temperature: 0.2,
      },
    );

    const sanitizedContent = this.sanitizeNormalizedContent(response.content, input.chapterContent);
    const sanitizedCount = countChapterLength(sanitizedContent, input.lengthSpec.countingMode);
    const wasTruncated = sanitizedContent !== input.chapterContent
      && sanitizedCount < input.lengthSpec.hardMin
      && this.looksTruncated(sanitizedContent);
    const crossedHardRange = sanitizedContent !== input.chapterContent
      && this.crossesOppositeHardBound(originalCount, sanitizedCount, input.lengthSpec);
    const normalizedContent = (wasTruncated || crossedHardRange) ? input.chapterContent : sanitizedContent;
    const finalCount = countChapterLength(normalizedContent, input.lengthSpec.countingMode);
    const warning = wasTruncated
      ? (language === "ko"
          ? "분량 보정 결과가 중간에 끊긴 것으로 보여 원문을 유지했습니다."
          : "Length normalizer output appeared truncated; kept original chapter.")
      : crossedHardRange
        ? (language === "ko"
            ? "분량 보정 결과가 절대 범위를 반대로 넘어 원문을 유지했습니다."
            : "Length normalizer output crossed the hard range; kept original chapter.")
      : this.buildWarning(finalCount, input.lengthSpec);

    return {
      normalizedContent,
      finalCount,
      applied: normalizedContent !== input.chapterContent,
      mode,
      warning,
      tokenUsage: response.usage,
    };
  }

  private buildSystemPrompt(mode: LengthNormalizeMode, language: "zh" | "ko" | "en"): string {
    const action = mode === "compress"
      ? "compress"
      : "expand";

    if (language === "ko") {
      return `당신은 한국 장르소설의 분량을 한 번만 보정하는 편집자입니다. 원고를 처음부터 한국어로 판단하고, ${mode === "compress" ? "군더더기를 덜어" : "필요한 장면 밀도를 보강해"} 지정 범위에 맞춥니다.

보정 원칙:
- 인물, 사건, 인과, 복선, 고유명사, 화말의 변화는 그대로 둡니다.
- 번역하거나 문체를 새로 덮어쓰지 않습니다. 원문의 말투와 문장 호흡을 보존합니다.
- 분량을 줄일 때는 중복 설명과 이미 보여 준 감정의 재설명부터 덜어냅니다.
- 분량을 늘릴 때는 새 사건을 만들지 말고 기존 장면의 행동, 대화, 감각, 상대 반응을 구체화합니다.
- 추상적인 의미 해설, 요약, 새 복선, 새 설정을 추가하지 않습니다.
- 보정은 한 번만 수행하며 원고 밖의 설명은 출력하지 않습니다.`;
    }

    if (language === "en") {
      return `You adjust a web-fiction chapter's length in one pass. ${action === "compress" ? "Compress" : "Expand"} it into the requested range without translating it or replacing its voice.

Rules:
- Preserve facts, causality, hooks, names, and the ending change.
- Do not invent subplots, future reveals, or explanatory summaries.
- When compressing, remove repeated explanation before cutting scene action.
- When expanding, deepen existing action, dialogue, sensory detail, and reaction.
- Output only the complete adjusted chapter.`;
    }

    return `你是一位章节长度修正器。你的任务是对章节正文做一次单次修正，只能执行一次，不得递归重写。

修正目标：
- ${action} 章节长度到给定目标区间
- 保留章节原有事实、关键钩子、角色名和必须保留的标记
- 不要引入新的支线、未来揭示或额外总结
- 不要在正文外输出任何解释`;
  }

  private buildUserPrompt(
    input: NormalizeLengthInput,
    originalCount: number,
    mode: LengthNormalizeMode,
    language: "zh" | "ko" | "en",
  ): string {
    const intentHeading = language === "ko" ? "이번 화 의도" : language === "en" ? "Chapter Intent" : "本章意图";
    const controlHeading = language === "ko" ? "보존할 제어 조건" : language === "en" ? "Reduced Control Block" : "精简控制条件";
    const intentBlock = input.chapterIntent
      ? `\n## ${intentHeading}\n${input.chapterIntent}\n`
      : "";
    const controlBlock = input.reducedControlBlock
      ? `\n## ${controlHeading}\n${input.reducedControlBlock}\n`
      : "";

    if (language === "ko") {
      return `아래 원고를 한 번만 ${mode === "compress" ? "압축" : "확장"}하세요.

## 분량 조건
- 목표: 공백 포함 ${input.lengthSpec.target}자
- 허용 범위: ${input.lengthSpec.softMin}-${input.lengthSpec.softMax}자
- 절대 범위: ${input.lengthSpec.hardMin}-${input.lengthSpec.hardMax}자
- 현재: ${originalCount}자

## 보정 조건
- 한국어 원문을 한국어로 직접 다룹니다.
- 인물 이름, 장소, 기존 사실, 핵심 행동과 표식을 보존합니다.
- 새 사건이나 새 인물을 만들지 않습니다.
- 장면 뒤에 의미를 해설하거나 교훈을 붙이지 않습니다.
- 보정된 전체 원고만 출력합니다.

${intentBlock}${controlBlock}
## 원고
${input.chapterContent}`;
    }

    if (language === "en") {
      return `${mode === "compress" ? "Compress" : "Expand"} the chapter below once.

## Length Spec
- Target: ${input.lengthSpec.target} words
- Soft Range: ${input.lengthSpec.softMin}-${input.lengthSpec.softMax} words
- Hard Range: ${input.lengthSpec.hardMin}-${input.lengthSpec.hardMax} words
- Current: ${originalCount} words

## Rules
- Preserve names, places, existing facts, required markers, and the central action.
- Do not invent subplots or add analysis after scenes.
- Output only the complete adjusted chapter.

${intentBlock}${controlBlock}
## Chapter Content
${input.chapterContent}`;
    }

    return `请对下面正文做一次${mode === "compress" ? "压缩" : "扩写"}修正。

## Length Spec
- Target: ${input.lengthSpec.target}
- Soft Range: ${input.lengthSpec.softMin}-${input.lengthSpec.softMax}
- Hard Range: ${input.lengthSpec.hardMin}-${input.lengthSpec.hardMax}
- Counting Mode: ${input.lengthSpec.countingMode}

## Current Count
${originalCount}

## Correction Rules
- 只修正一次，不要递归
- 保留正文中的关键标记、人物名、地点名和已有事实
- 不要凭空新增子情节
- 不要插入解释性总结或分析
- 输出修正后的完整正文，不要加标签

${intentBlock}${controlBlock}
## Chapter Content
${input.chapterContent}`;
  }

  private buildWarning(finalCount: number, lengthSpec: LengthSpec): string | undefined {
    if (!isOutsideSoftRange(finalCount, lengthSpec)) {
      return undefined;
    }

    if (isOutsideHardRange(finalCount, lengthSpec)) {
      if (lengthSpec.countingMode === "ko_chars") {
        return `한 번 보정한 뒤에도 ${finalCount}자로 절대 범위 ${lengthSpec.hardMin}-${lengthSpec.hardMax}자를 벗어났습니다.`;
      }
      return `Final count ${finalCount} is outside the hard range ${lengthSpec.hardMin}-${lengthSpec.hardMax} after one normalization pass.`;
    }

    if (lengthSpec.countingMode === "ko_chars") {
      return `한 번 보정한 뒤에도 ${finalCount}자로 허용 범위 ${lengthSpec.softMin}-${lengthSpec.softMax}자를 벗어났습니다.`;
    }
    return `Final count ${finalCount} is outside the soft range ${lengthSpec.softMin}-${lengthSpec.softMax} after one normalization pass.`;
  }

  private crossesOppositeHardBound(
    originalCount: number,
    candidateCount: number,
    lengthSpec: LengthSpec,
  ): boolean {
    if (originalCount > lengthSpec.hardMax && candidateCount < lengthSpec.hardMin) {
      return true;
    }
    if (originalCount < lengthSpec.hardMin && candidateCount > lengthSpec.hardMax) {
      return true;
    }
    return false;
  }

  private sanitizeNormalizedContent(rawContent: string, fallbackContent: string): string {
    const trimmed = rawContent.trim();
    if (!trimmed) return fallbackContent;

    const fenced = this.extractFirstFencedBlock(trimmed);
    if (fenced) return fenced;

    const stripped = this.stripCommonWrappers(trimmed);
    if (stripped !== undefined) {
      // Empty after stripping = response was only wrapper text, use original
      if (!stripped) return fallbackContent;
      // Guard: if stripping removed more than 50% of content, the regex was too aggressive.
      if (stripped.length < trimmed.length * 0.5) return trimmed;
      return stripped;
    }

    return trimmed;
  }

  private looksTruncated(content: string): boolean {
    const trimmed = content.trim();
    if (!trimmed) return false;
    if (trimmed.endsWith("```")) return false;
    if (/[。！？!?」』”’）)\]】》…]$/.test(trimmed)) return false;
    if (/\n\s*$/.test(content) && /[，,；;：:]$/.test(trimmed)) return true;
    return /[，,；;：:、]$/.test(trimmed) || /[\u4e00-\u9fff\uac00-\ud7a3A-Za-z0-9]$/.test(trimmed);
  }

  private extractFirstFencedBlock(content: string): string | undefined {
    const match = content.match(/```(?:[a-zA-Z-]+)?\s*\n([\s\S]*?)\n```/);
    if (!match) return undefined;
    const body = match[1]?.trim();
    return body ? body : undefined;
  }

  private stripCommonWrappers(content: string): string | undefined {
    const lines = content.split("\n");
    let removedAny = false;
    const keptLines: string[] = [];

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (this.isWrapperLine(trimmed)) {
        removedAny = true;
        continue;
      }
      keptLines.push(rawLine);
    }

    if (!removedAny) {
      return undefined;
    }

    return keptLines.join("\n").trim();
  }

  private isWrapperLine(line: string): boolean {
    if (!line) return false;
    if (/^```/.test(line)) return true;
    if (/^#+\s*(说明|解释|注释|analysis|analysis note)\b/i.test(line)) return true;

    if (/^(下面是|以下是).*(正文|章节|压缩|扩写|修正|修改|调整|改写|润色|结果|内容|输出|版本)/i.test(line)) {
      return true;
    }

    if (/^我先.*(压缩|扩写|修正|修改|调整|改写|润色|处理).*(正文|章节)?/i.test(line)) {
      return true;
    }

    if (/^(here(?:'s| is)|below is).*(chapter|draft|content|rewrite|revised|compressed|expanded|normalized|adjusted|output|version|result)/i.test(line)) {
      return true;
    }

    if (/^i(?:'ll| will)\s+(rewrite|revise|reword|compress|expand|normalize|adjust|shorten|lengthen|trim|fix)\b/i.test(line)) {
      return true;
    }

    if (/^(아래는|다음은).*(원고|회차|본문|압축|확장|보정|수정|결과|버전)/.test(line)) {
      return true;
    }

    if (/^(먼저|우선).*(원고|회차|본문).*(압축|확장|보정|수정|다듬)/.test(line)) {
      return true;
    }

    return false;
  }
}
