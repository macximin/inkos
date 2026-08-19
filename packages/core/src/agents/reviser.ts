import { BaseAgent } from "./base.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { BookRules } from "../models/book-rules.js";
import type { LengthSpec } from "../models/length-governance.js";
import type { AuditIssue } from "./continuity.js";
import type { ChapterIntent, ChapterMemo, ContextPackage, RuleStack } from "../models/input-governance.js";
import { readGenreProfile, readBookLanguage, readBookRules } from "./rules-reader.js";
import { countChapterLength } from "../utils/length-metrics.js";
import { buildGovernedMemoryEvidenceBlocks } from "../utils/governed-context.js";
import { filterSummaries } from "../utils/context-filter.js";
import {
  buildGovernedCharacterMatrixWorkingSet,
  buildGovernedHookWorkingSet,
  mergeTableMarkdownByKey,
} from "../utils/governed-working-set.js";
import { applySpotFixPatches, parseSpotFixPatches } from "../utils/spot-fix-patches.js";
import {
  buildNarrativeIntentBrief,
  renderMemoAsNarrativeBlock,
  renderNarrativeSelectedContext,
  sanitizeNarrativeEvidenceBlock,
} from "../utils/narrative-control.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  readStoryFrame,
  readVolumeMap,
  readCharacterContext,
  readCurrentStateWithFallback,
} from "../utils/outline-paths.js";

export type ReviseMode = "auto" | "polish" | "rewrite" | "rework" | "anti-detect" | "spot-fix";

export const DEFAULT_REVISE_MODE: ReviseMode = "auto";

export interface ReviseOutput {
  readonly revisedContent: string;
  readonly wordCount: number;
  readonly fixedIssues: ReadonlyArray<string>;
  readonly updatedState: string;
  readonly updatedLedger: string;
  readonly updatedHooks: string;
  readonly tokenUsage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

type AutoOutputMode = "patch-only" | "rewrite-only" | "allow-full";

function buildTieredIssueList(
  issues: ReadonlyArray<AuditIssue>,
  language: "zh" | "ko" | "en",
): string {
  const critical: string[] = [];
  const high: string[] = [];
  const medium: string[] = [];

  for (const issue of issues) {
    const line = `- ${issue.category}: ${issue.description}`;
    if (issue.severity === "critical") {
      critical.push(line);
    } else if (issue.severity === "warning") {
      high.push(line);
    } else {
      medium.push(line);
    }
  }

  const parts: string[] = [];
  if (critical.length > 0) {
    parts.push(language === "ko"
      ? `## 치명적 문제: 반드시 수정\n${critical.join("\n")}`
      : language === "en"
        ? `## Critical — Must Fix\n${critical.join("\n")}`
        : `## Critical（必须解决）\n${critical.join("\n")}`);
  }
  if (high.length > 0) {
    parts.push(language === "ko"
      ? `## 주요 문제: 수정 권장\n${high.join("\n")}`
      : language === "en"
        ? `## High — Should Improve\n${high.join("\n")}`
        : `## High（应当改善）\n${high.join("\n")}`);
  }
  if (medium.length > 0) {
    parts.push(language === "ko"
      ? `## 참고 사항\n${medium.join("\n")}`
      : language === "en"
        ? `## Medium — Reference\n${medium.join("\n")}`
        : `## Medium（参考建议）\n${medium.join("\n")}`);
  }

  return parts.join("\n\n");
}

const MODE_DESCRIPTIONS: Record<ReviseMode, string> = {
  auto: "", // auto mode uses buildAutoSystemPrompt instead
  polish: "润色：只改表达、节奏、段落呼吸，不改事实与剧情结论。禁止：增删段落、改变人名/地名/物品名、增加新情节或新对话、改变因果关系。只允许：替换用词、调整句序、修改标点节奏",
  rewrite: "改写：允许重组问题段落、调整画面和叙述力度，但优先保留原文的绝大部分句段。除非问题跨越整章，否则禁止整章推倒重写；只能围绕问题段落及其直接上下文改写，同时保留核心事实与人物动机",
  rework: "重写：可重构场景推进和冲突组织，但不改主设定和大事件结果",
  "anti-detect": `反检测改写：在保持剧情不变的前提下，降低AI生成可检测性。

改写手法（附正例）：
1. 打破句式规律：连续短句 → 长短交替，句式不可预测
2. 口语化替代：✗"然而事情并没有那么简单" → ✓"哪有那么便宜的事"
3. 减少"了"字密度：✗"他走了过去，拿了杯子" → ✓"他走过去，端起杯子"
4. 转折词降频：✗"虽然…但是…" → ✓ 用角色内心吐槽或直接动作切换
5. 情绪外化：✗"他感到愤怒" → ✓"他捏碎了茶杯，滚烫的茶水流过指缝"
6. 删掉叙述者结论：✗"这一刻他终于明白了力量" → ✓ 只写行动，让读者自己感受
7. 群像反应具体化：✗"全场震惊" → ✓"老陈的烟掉在裤子上，烫得他跳起来"
8. 段落长度差异化：不再等长段落，有的段只有一句话，有的段七八行
9. 消灭"不禁""仿佛""宛如"等AI标记词：换成具体感官描写`,
  "spot-fix": "定点修复：只修改审稿意见指出的具体句子或段落，其余所有内容必须原封不动保留。修改范围限定在问题句子及其前后各一句。禁止改动无关段落",
};

const KOREAN_MODE_DESCRIPTIONS: Record<ReviseMode, string> = {
  auto: "",
  polish: "윤문: 사실과 사건의 결론은 건드리지 않고 어휘, 문장 호흡, 문단 리듬만 다듬습니다. 새 장면과 새 대사를 만들지 않습니다.",
  rewrite: "부분 재작성: 문제가 있는 문단과 바로 이어지는 문맥을 고칩니다. 문제가 회차 전체에 걸치지 않았다면 원고 전체를 새로 쓰지 않습니다.",
  rework: "전면 재구성: 장면 순서와 충돌의 진행을 다시 짤 수 있지만, 정본 설정과 핵심 사건의 결과는 바꾸지 않습니다.",
  "anti-detect": `기계적인 문장 제거: 사건은 유지하면서 반복되는 문장 틀과 해설투를 걷어냅니다.

- 같은 길이의 문장과 문단이 이어지지 않게 호흡을 바꿉니다.
- 'A가 아니라 B', '단순한 X를 넘어 Y' 같은 대조문을 직설문으로 고칩니다.
- 추상 명사가 행동하는 문장을 인물의 행동과 대사로 바꿉니다.
- 이미 보여 준 감정과 장면의 의미를 다시 설명하지 않습니다.
- 집단의 과장된 반응을 한두 사람의 구체적인 반응으로 바꿉니다.`,
  "spot-fix": "정해진 부분만 수정: 지적된 문장이나 문단과 필요한 최소 문맥만 고칩니다. 나머지 원고는 그대로 둡니다.",
};

export class ReviserAgent extends BaseAgent {
  get name(): string {
    return "reviser";
  }

  async reviseChapter(
    bookDir: string,
    chapterContent: string,
    chapterNumber: number,
    issues: ReadonlyArray<AuditIssue>,
    mode: ReviseMode = DEFAULT_REVISE_MODE,
    genre?: string,
    options?: {
      chapterIntent?: string;
      chapterMemo?: ChapterMemo;
      chapterIntentData?: ChapterIntent;
      contextPackage?: ContextPackage;
      ruleStack?: RuleStack;
      lengthSpec?: LengthSpec;
      arcProvenanceContext?: string;
    },
  ): Promise<ReviseOutput> {
    const [currentState, ledger, hooks, styleGuideRaw, volumeOutline, storyBible, characterMatrix, chapterSummaries, parentCanon, fanficCanon] = await Promise.all([
      // Phase 5 consolidation: derive initial state from roles + seed hooks
      // when current_state.md is still the architect seed placeholder.
      readCurrentStateWithFallback(bookDir, "(文件不存在)"),
      this.readFileSafe(join(bookDir, "story/particle_ledger.md")),
      this.readFileSafe(join(bookDir, "story/pending_hooks.md")),
      this.readFileSafe(join(bookDir, "story/style_guide.md")),
      readVolumeMap(bookDir, "(文件不存在)"),
      readStoryFrame(bookDir, "(文件不存在)"),
      readCharacterContext(bookDir, "(文件不存在)"),
      this.readFileSafe(join(bookDir, "story/chapter_summaries.md")),
      this.readFileSafe(join(bookDir, "story/parent_canon.md")),
      this.readFileSafe(join(bookDir, "story/fanfic_canon.md")),
    ]);

    // Load genre profile and book rules
    const genreId = genre ?? "other";
    const [{ profile: gp }, bookLanguage] = await Promise.all([
      readGenreProfile(this.ctx.projectRoot, genreId),
      readBookLanguage(bookDir),
    ]);
    const parsedRules = await readBookRules(bookDir);
    const bookRules = parsedRules?.rules ?? null;

    // Fallback: use book_rules body when style_guide.md doesn't exist.
    // Phase 5 hotfix 2: parsedRules.body is only populated for legacy
    // book_rules.md sources — story_frame.md frontmatter yields an empty
    // body, and an empty string is NOT a usable style guide. Treat
    // missing/empty body as "no fallback available".
    const resolvedLanguage = bookLanguage ?? gp.language;
    const usesEnglishControl = resolvedLanguage !== "zh";
    const legacyRulesBody = parsedRules?.body?.trim();
    const styleGuide = styleGuideRaw !== "(文件不存在)"
      ? styleGuideRaw
      : (legacyRulesBody || (resolvedLanguage === "ko" ? "(문체 지침 없음)" : "(无文风指南)"));

    const issueList = mode === "auto"
      ? buildTieredIssueList(issues, resolvedLanguage)
      : issues
          .map((i) => `- [${i.severity}] ${i.category}: ${i.description}\n  ${resolvedLanguage === "ko" ? "수정 제안" : usesEnglishControl ? "Suggestion" : "建议"}: ${i.suggestion}`)
          .join("\n");

    const numericalRule = gp.numericalSystem
      ? (resolvedLanguage === "ko"
          ? "\n3. 돈, 지분, 수량, 날짜는 수정 전후 장부와 정확히 맞춥니다."
          : usesEnglishControl
            ? "\n3. Numerical errors must be fixed precisely — cross-check before and after"
            : "\n3. 数值错误必须精确修正，前后对账")
      : "";
    const protagonistBlock = bookRules?.protagonist
      ? (resolvedLanguage === "ko"
          ? `\n\n주인공 고정점: ${bookRules.protagonist.name}. ${bookRules.protagonist.personalityLock.join(", ")}. 수정하면서 성격과 행동 원칙을 바꾸지 않습니다.`
          : usesEnglishControl
            ? `\n\nProtagonist lock: ${bookRules.protagonist.name} — ${bookRules.protagonist.personalityLock.join(", ")}. Revisions must not violate the protagonist profile.`
            : `\n\n主角人设锁定：${bookRules.protagonist.name}，${bookRules.protagonist.personalityLock.join("、")}。修改不得违反人设。`)
      : "";
    // Length guardrail only used by legacy modes (manual CLI revise).
    // Auto mode delegates length to normalize, not reviser.
    const lengthGuardrail = mode !== "auto" && options?.lengthSpec
      ? (resolvedLanguage === "ko"
          ? "\n8. 수정한 원고도 목표 분량 범위 안에 둡니다. 치명적 문제를 고치는 데 꼭 필요할 때만 조금 벗어날 수 있습니다."
          : usesEnglishControl
            ? "\n8. Keep the chapter word count within the target range; only allow minor deviation when fixing critical issues truly requires it"
            : "\n8. 保持章节字数在目标区间内；只有在修复关键问题确实需要时才允许轻微偏离")
      : "";
    const langPrefix = resolvedLanguage === "ko"
      ? `【언어 우선 규칙】FIXED_ISSUES, PATCHES, REVISED_CONTENT, UPDATED_STATE, UPDATED_HOOKS의 자연어를 모두 한국어로 작성하세요. 원고와 제어 입력을 다른 언어로 번역해 처리하지 마세요.
UPDATED_STATE는 반드시 '# 현재 상태' 제목으로 시작하세요.
UPDATED_HOOKS는 입력 pending_hooks의 Markdown 표 머리글, 열 순서, 기존 hook_id를 그대로 유지한 완전한 표여야 합니다. 글머리표 목록으로 바꾸거나 hook_id를 삭제하지 마세요. 새 복선이 꼭 필요하면 기존 표에 새 H 번호 행을 추가하세요.

`
      : usesEnglishControl
      ? `【LANGUAGE OVERRIDE】ALL output (FIXED_ISSUES, PATCHES, REVISED_CONTENT, UPDATED_STATE, UPDATED_HOOKS) MUST be in English.\n\n`
      : "";
    const governedMode = Boolean(options?.chapterIntent && options?.contextPackage && options?.ruleStack);
    const hooksWorkingSet = governedMode && options?.contextPackage
      ? buildGovernedHookWorkingSet({
          hooksMarkdown: hooks,
          contextPackage: options.contextPackage,
          chapterNumber,
          language: resolvedLanguage,
        })
      : hooks;
    const chapterSummariesWorkingSet = governedMode
      ? filterSummaries(chapterSummaries, chapterNumber)
      : chapterSummaries;
    const characterMatrixWorkingSet = governedMode
      ? buildGovernedCharacterMatrixWorkingSet({
          matrixMarkdown: characterMatrix,
          chapterIntent: options?.chapterIntent ?? volumeOutline,
          contextPackage: options!.contextPackage!,
          protagonistName: bookRules?.protagonist?.name,
        })
      : characterMatrix;

    const autoOutputMode = mode === "auto" ? resolveAutoOutputMode(issues) : "allow-full";
    const systemPromptBase = mode === "auto"
      ? this.buildAutoSystemPrompt({ langPrefix, gp, protagonistBlock, numericalRule, lengthGuardrail, resolvedLanguage, lengthSpec: options?.lengthSpec, autoOutputMode })
      : this.buildLegacySystemPrompt({ langPrefix, gp, protagonistBlock, numericalRule, lengthGuardrail, mode, resolvedLanguage });
    const systemPrompt = await this.withPromptPackGuidance(systemPromptBase, "longform.reviser");

    const ledgerForPrompt = resolvedLanguage === "ko" && ledger === "(文件不存在)" ? "(장부 없음)" : ledger;
    const hooksForPrompt = resolvedLanguage === "ko" && hooksWorkingSet === "(文件不存在)" ? "(복선 없음)" : hooksWorkingSet;
    const ledgerBlock = gp.numericalSystem
      ? `\n## ${resolvedLanguage === "ko" ? "자원 장부" : "资源账本"}\n${ledgerForPrompt}`
      : "";
    const governedMemoryBlocks = options?.contextPackage
      ? buildGovernedMemoryEvidenceBlocks(options.contextPackage, resolvedLanguage)
      : undefined;
    const hookDebtBlock = governedMemoryBlocks?.hookDebtBlock ?? "";
    const hooksBlock = governedMemoryBlocks?.hooksBlock
      ?? `\n## ${resolvedLanguage === "ko" ? "복선 목록" : "伏笔池"}\n${hooksForPrompt}\n`;
    const outlineBlock = volumeOutline !== "(文件不存在)"
      ? `\n## ${resolvedLanguage === "ko" ? "권별 개요" : "卷纲"}\n${volumeOutline}\n`
      : "";
    const bibleBlock = !governedMode && storyBible !== "(文件不存在)"
      ? `\n## ${resolvedLanguage === "ko" ? "세계와 작품 규칙" : "世界观设定"}\n${storyBible}\n`
      : "";
    const matrixBlock = characterMatrixWorkingSet !== "(文件不存在)"
      ? `\n## ${resolvedLanguage === "ko" ? "인물 관계와 상호작용" : "角色交互矩阵"}\n${characterMatrixWorkingSet}\n`
      : "";
    const summariesBlock = governedMemoryBlocks?.summariesBlock
      ?? (chapterSummariesWorkingSet !== "(文件不存在)"
        ? `\n## ${resolvedLanguage === "ko" ? "최근 회차 요약" : "章节摘要"}\n${chapterSummariesWorkingSet}\n`
        : "");
    const volumeSummariesBlock = governedMemoryBlocks?.volumeSummariesBlock ?? "";

    const hasParentCanon = parentCanon !== "(文件不存在)";
    const hasFanficCanon = fanficCanon !== "(文件不存在)";

    const canonBlock = hasParentCanon
      ? resolvedLanguage === "ko"
        ? `\n## 본편 정본\n이 작품은 외전입니다. 본편에서 확정된 사실을 바꾸지 않습니다.\n${parentCanon}\n`
        : `\n## 正传正典参照（修稿专用）\n本书为番外作品。修改时参照正典约束，不可改变正典事实。\n${parentCanon}\n`
      : "";

    const fanficCanonBlock = hasFanficCanon
      ? resolvedLanguage === "ko"
        ? `\n## 원작 정본\n원작의 인물과 세계 규칙, 이미 확정된 사실을 지킵니다. 인물의 말투도 유지합니다.\n${fanficCanon}\n`
        : `\n## 同人正典参照（修稿专用）\n本书为同人作品。修改时参照正典角色档案和世界规则，不可违反正典事实。角色对话必须保留原作语癖。\n${fanficCanon}\n`
      : "";
    const reducedControlBlock = options?.contextPackage && options.ruleStack
      ? this.buildReducedControlBlock(options.chapterMemo, options.chapterIntentData, options.chapterIntent, options.contextPackage, options.ruleStack, resolvedLanguage)
      : "";
    // Length guardrail only in legacy modes — auto mode delegates length to normalize.
    const lengthGuidanceBlock = mode !== "auto" && options?.lengthSpec
      ? resolvedLanguage === "ko"
        ? `\n## 분량 조건\n목표: 공백 포함 ${options.lengthSpec.target}자\n허용 범위: ${options.lengthSpec.softMin}-${options.lengthSpec.softMax}자\n절대 범위: ${options.lengthSpec.hardMin}-${options.lengthSpec.hardMax}자\n범위를 맞출 때 중복 설명과 이미 보여 준 감정의 재설명을 먼저 덜어냅니다. 새 사건을 만들거나 핵심 사실을 삭제하지 않습니다.\n`
        : `\n## 字数护栏\n目标字数：${options.lengthSpec.target}\n允许区间：${options.lengthSpec.softMin}-${options.lengthSpec.softMax}\n极限区间：${options.lengthSpec.hardMin}-${options.lengthSpec.hardMax}\n如果修正后超出允许区间，请优先压缩冗余解释、重复动作和弱信息句，不得新增支线或删掉核心事实。\n`
      : "";
    const styleGuideBlock = reducedControlBlock.length === 0
      ? `\n## ${resolvedLanguage === "ko" ? "문체 지침" : "文风指南"}\n${styleGuide}`
      : "";
    const arcProvenanceBlock = options?.arcProvenanceContext?.trim()
      ? `\n${options.arcProvenanceContext.trim()}\n`
      : "";

    const userPrompt = resolvedLanguage === "ko" ? `제${chapterNumber}화를 수정하세요.

## 감리 결과
${issueList}

## 현재 상태
${currentState === "(文件不存在)" ? "(현재 상태 없음)" : currentState}
${ledgerBlock}
${sanitizeNarrativeEvidenceBlock(hookDebtBlock, resolvedLanguage) ?? ""}${sanitizeNarrativeEvidenceBlock(hooksBlock, resolvedLanguage) ?? ""}${sanitizeNarrativeEvidenceBlock(volumeSummariesBlock, resolvedLanguage) ?? ""}${reducedControlBlock || outlineBlock}${arcProvenanceBlock}${bibleBlock}${matrixBlock}${sanitizeNarrativeEvidenceBlock(summariesBlock, resolvedLanguage) ?? ""}${canonBlock}${fanficCanonBlock}${styleGuideBlock}${lengthGuidanceBlock}

## 수정할 원고
${chapterContent}` : `请修正第${chapterNumber}章。

## 审稿问题
${issueList}

## 当前状态卡
${currentState}
${ledgerBlock}
${sanitizeNarrativeEvidenceBlock(hookDebtBlock, resolvedLanguage) ?? ""}${sanitizeNarrativeEvidenceBlock(hooksBlock, resolvedLanguage) ?? ""}${sanitizeNarrativeEvidenceBlock(volumeSummariesBlock, resolvedLanguage) ?? ""}${reducedControlBlock || outlineBlock}${arcProvenanceBlock}${bibleBlock}${matrixBlock}${sanitizeNarrativeEvidenceBlock(summariesBlock, resolvedLanguage) ?? ""}${canonBlock}${fanficCanonBlock}${styleGuideBlock}${lengthGuidanceBlock}

## 待修正章节
${chapterContent}`;

    const response = await this.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      { temperature: 0.3 },
    );

    const output = this.parseOutput(
      response.content,
      gp,
      mode,
      chapterContent,
      autoOutputMode,
    );
    const mergedOutput = governedMode
      ? {
          ...output,
          updatedHooks: mergeTableMarkdownByKey(hooks, output.updatedHooks, [0]),
        }
      : output;
    const wordCount = options?.lengthSpec
      ? countChapterLength(mergedOutput.revisedContent, options.lengthSpec.countingMode)
      : mergedOutput.wordCount;
    return { ...mergedOutput, wordCount, tokenUsage: response.usage };
  }

  private parseOutput(
    content: string,
    gp: GenreProfile,
    mode: ReviseMode,
    originalChapter: string,
    autoOutputMode: AutoOutputMode = "allow-full",
  ): ReviseOutput {
    const extract = (tag: string): string => {
      const regex = new RegExp(
        `=== ${tag} ===\\s*([\\s\\S]*?)(?==== [A-Z_]+ ===|$)`,
      );
      const match = content.match(regex);
      return match?.[1]?.trim() ?? "";
    };

    const fixedRaw = extract("FIXED_ISSUES");
    const fixedIssues = fixedRaw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const makeResult = (revisedContent: string, applied: boolean): ReviseOutput => ({
      revisedContent,
      wordCount: revisedContent.length,
      fixedIssues: applied ? fixedIssues : [],
      updatedState: extract("UPDATED_STATE") || "(状态卡未更新)",
      updatedLedger: gp.numericalSystem
        ? (extract("UPDATED_LEDGER") || "(账本未更新)")
        : "",
      updatedHooks: extract("UPDATED_HOOKS") || "(伏笔池未更新)",
    });

    // Auto mode: route by issue type — structural issues require REVISED_CONTENT,
    // local-only issues only accept PATCHES, mixed sets accept either.
    if (mode === "auto") {
      if (autoOutputMode === "patch-only") {
        const patchesRaw = extract("PATCHES");
        if (patchesRaw) {
          const patches = parseSpotFixPatches(patchesRaw);
          if (patches.length > 0) {
            const patchResult = applySpotFixPatches(originalChapter, patches);
            if (patchResult.applied && patchResult.appliedPatchCount / patches.length >= 0.5) {
              return makeResult(patchResult.revisedContent, true);
            }
          }
        }
        return makeResult(originalChapter, false);
      }

      if (autoOutputMode === "rewrite-only") {
        const revisedContent = extract("REVISED_CONTENT");
        if (revisedContent) {
          return makeResult(revisedContent, true);
        }
        // No rewrite produced — don't fall back to patches; structural issues
        // cannot be safely patched. Return original unchanged.
        return makeResult(originalChapter, false);
      }

      const revisedContent = extract("REVISED_CONTENT");
      if (revisedContent) {
        return makeResult(revisedContent, true);
      }
      const patchesRaw = extract("PATCHES");
      if (patchesRaw) {
        const patches = parseSpotFixPatches(patchesRaw);
        if (patches.length > 0) {
          const patchResult = applySpotFixPatches(originalChapter, patches);
          if (patchResult.applied && patchResult.appliedPatchCount / patches.length >= 0.5) {
            return makeResult(patchResult.revisedContent, true);
          }
        }
      }
      // Both empty — no fix
      return makeResult(originalChapter, false);
    }

    // Legacy spot-fix mode: patches only
    if (mode === "spot-fix") {
      const patches = parseSpotFixPatches(extract("PATCHES"));
      const patchResult = applySpotFixPatches(originalChapter, patches);
      return makeResult(patchResult.revisedContent, patchResult.applied);
    }

    // Legacy rewrite/polish/rework/anti-detect: full content
    const revisedContent = extract("REVISED_CONTENT");
    return makeResult(revisedContent || originalChapter, revisedContent.length > 0);
  }

  private buildAutoSystemPrompt(params: {
    langPrefix: string;
    gp: GenreProfile;
    protagonistBlock: string;
    numericalRule: string;
    lengthGuardrail: string;
    resolvedLanguage: "zh" | "ko" | "en";
    lengthSpec?: LengthSpec;
    autoOutputMode: AutoOutputMode;
  }): string {
    const { langPrefix, gp, protagonistBlock, numericalRule, resolvedLanguage, lengthSpec, autoOutputMode } = params;
    // lengthGuardrail intentionally not used in auto mode — length constraint is embedded in REVISED_CONTENT description
    if (resolvedLanguage === "ko") {
      const route = autoOutputMode === "rewrite-only"
        ? "\n\n분기 규칙: 인물 붕괴, 주선 이탈, 보상 누락, 시간선 오류, 복선 미회수처럼 구조적인 문제입니다. PATCHES를 쓰지 말고 REVISED_CONTENT에 수정한 전체 원고를 출력합니다. 안전하게 재작성할 수 없으면 FIXED_ISSUES에 이유를 적고 REVISED_CONTENT를 비웁니다."
        : autoOutputMode === "patch-only"
          ? "\n\n분기 규칙: 표현, 문단 모양, 피로 표현, 정보 월경처럼 국소적인 문제입니다. 전체를 다시 쓰지 말고 PATCHES만 출력합니다. 안전한 패치를 만들 수 없으면 PATCHES를 비웁니다."
          : "";
      const lengthConstraint = lengthSpec
        ? `\nREVISED_CONTENT를 출력할 때는 공백 포함 ${lengthSpec.softMin}-${lengthSpec.softMax}자 안에 맞춥니다. 목표는 ${lengthSpec.target}자입니다.`
        : "";
      const ledgerSection = gp.numericalSystem
        ? "\n=== UPDATED_LEDGER ===\n(수정한 전체 자원 장부)"
        : "";

      return `${langPrefix}당신은 한국 장르소설 수정 편집자입니다. 「${gp.name}」 장르의 원고를 감리 결과에 맞춰 고칩니다.${protagonistBlock}${route}

PATCHES는 특정 문장과 문단만 고칠 때 사용합니다. TARGET_TEXT에는 원문에서 한 번만 나오는 정확한 문장을 넣고, REPLACEMENT_TEXT에는 바꿀 한국어 문장만 넣습니다. 손대지 않은 원고는 그대로 둡니다.

REVISED_CONTENT는 구조, 인과, 분량, 사건 배열처럼 회차 전체를 손봐야 할 때만 사용합니다.${lengthConstraint}

수정 원칙:
1. 지적된 문제의 원인을 고칩니다.${numericalRule}
2. 사건의 방향, 정본 사실, 인물의 욕망과 말투를 보존합니다.
3. 복선 상태와 실제 원고를 맞춥니다.
4. 원문의 한국어 호흡을 보존합니다. 외국어 문장을 번역한 듯한 어순으로 바꾸지 않습니다.
5. 추상 명사가 행동하는 문장, 반복되는 대조문, 장면 뒤의 의미 해설을 걷어냅니다.
6. 인물의 감정과 달라진 관계는 행동, 대사, 선택으로 보여 줍니다.
7. 수정 과정에서 새 사건이나 새 설정을 발명하지 않습니다.

출력 형식:

=== FIXED_ISSUES ===
(고친 문제를 한 줄씩 기록합니다.)

=== PATCHES ===
(국소 수정일 때만 출력합니다. REVISED_CONTENT를 사용하면 이 구역은 생략합니다.)
--- PATCH 1 ---
TARGET_TEXT:
(원문에서 정확히 복사한 수정 대상)
REPLACEMENT_TEXT:
(교체할 한국어 문장)
--- END PATCH ---

=== REVISED_CONTENT ===
(전체 재작성이 필요할 때만 수정한 전체 한국어 원고를 출력합니다.)

=== UPDATED_STATE ===
(수정한 전체 상태표)
${ledgerSection}
=== UPDATED_HOOKS ===
(수정한 전체 복선표)`;
    }

    const en = resolvedLanguage !== "zh";
    const ledgerSection = gp.numericalSystem
      ? (en ? "\n=== UPDATED_LEDGER ===\n(Full updated resource ledger)" : "\n=== UPDATED_LEDGER ===\n(更新后的完整资源账本)")
      : "";
    const rewriteLengthConstraint = lengthSpec
      ? (en
          ? `\n  HARD CONSTRAINT: The revised chapter must stay within ${lengthSpec.softMin}-${lengthSpec.softMax} characters (target: ${lengthSpec.target}, ±25%). This is non-negotiable — do not exceed this range.`
          : `\n  硬性约束：重写后的章节必须控制在 ${lengthSpec.softMin}-${lengthSpec.softMax} 字以内（目标 ${lengthSpec.target} 字，±25%）。这是不可突破的底线。`)
      : "";

    const routingDirectiveEn = autoOutputMode === "rewrite-only"
      ? "\n\nROUTING: The reviewer's blocking issues are structural / semantic (character collapse, mainline drift, missing payoff, timeline break, unpaid hook, memo drift, etc.). You MUST output REVISED_CONTENT — do not emit PATCHES, they cannot fix this class of problem. If you cannot safely rewrite, say so in FIXED_ISSUES and leave REVISED_CONTENT empty."
      : autoOutputMode === "patch-only"
        ? "\n\nROUTING: The reviewer's blocking issues are local (wording, paragraph shape, fatigue word, information boundary, knowledge pollution). You MUST output PATCHES only — do not rewrite the whole chapter. If patches are not possible, leave PATCHES empty."
        : "";
    const routingDirectiveZh = autoOutputMode === "rewrite-only"
      ? "\n\n分流指令：reviewer 报告的阻塞问题属于结构/语义错（人设崩、主线偏、爽点缺、时间线错、伏笔未收、memo 偏离等）。你必须输出 REVISED_CONTENT——禁止输出 PATCHES，这类问题不能靠补丁修复。如果无法安全重写，在 FIXED_ISSUES 里说明并留空 REVISED_CONTENT。"
      : autoOutputMode === "patch-only"
        ? "\n\n分流指令：reviewer 报告的阻塞问题属于局部错（措辞、段落形状、疲劳词、信息越界、知识污染）。你必须只输出 PATCHES——不要整章改写。如果做不出补丁，留空 PATCHES。"
        : "";

    return en
      ? `${langPrefix}You are a professional ${gp.name} web-fiction revision editor. Fix the chapter according to the review notes.${protagonistBlock}${routingDirectiveEn}

PATCHES and REVISED_CONTENT serve different problems — choose by problem type, not preference:

PATCHES — for local text issues (wording, dialogue, AI-tell phrases, small continuity errors).
  Each PATCH quotes the passage to change (a sentence, a paragraph, or multiple paragraphs) and provides a replacement. Untouched text stays exactly as-is.

REVISED_CONTENT — for whole-chapter issues (length compression, structural rewrite, pacing restructure, major plot realignment).
  Outputs the full revised chapter. When Critical issues include length or structural problems, you must use REVISED_CONTENT — patches cannot compress or restructure a chapter.${rewriteLengthConstraint}

If Critical issues include both local and whole-chapter problems, use REVISED_CONTENT (it addresses everything in one pass).

Revision principles:
1. Fix root causes — do not apply superficial polish${numericalRule}
2. Hook status must stay in sync with the hooks board. If hook debt briefs are provided, preserve hook payoff scenes
3. Do not alter the plot direction or core conflicts
4. Preserve the original language style, rhythm, and pacing — do not compress transitional scenes or remove breathing room
5. Emotion through action (never "he felt angry" — show it). Values through behavior, not slogans
6. Different characters speak differently. No "everyone gasped in unison"
7. Escalate: bad things stack, each worse than the last

Cycle-aware revision:
- If this chapter should be "aftermath" but is still escalating tension, rewrite the densest conflict passage into a change-showing passage — who lost what, whose attitude shifted, what the new normal is
- If this chapter should be "climax" but has no clear payoff, find the closest scene to a reward and amplify it — make the promised release exceed reader expectations
- Daily passages that don't serve the main line: rewrite as "bait" — add a detail pointing to the future, a hint, a character reaction that seeds curiosity

Output format:

=== FIXED_ISSUES ===
(List each fix on its own line; if a safe local fix is not possible, explain here)

=== PATCHES ===
(Output local patches if applicable. Omit this section entirely if using REVISED_CONTENT)
--- PATCH 1 ---
TARGET_TEXT:
(Exact quote from the original that identifies the passage to change)
REPLACEMENT_TEXT:
(Replacement text for this passage)
--- END PATCH ---

=== REVISED_CONTENT ===
(Full revised chapter content — only when PATCHES cannot solve the problem. Omit this section if using PATCHES)

=== UPDATED_STATE ===
(Full updated state card)
${ledgerSection}
=== UPDATED_HOOKS ===
(Full updated hooks board)`
      : `${langPrefix}你是一位专业的${gp.name}网络小说修稿编辑。你的任务是根据审稿意见对章节进行修正。${protagonistBlock}${routingDirectiveZh}

PATCHES 和 REVISED_CONTENT 分别处理不同类型的问题——按问题类型选择，不是按偏好：

PATCHES——处理局部文字问题（措辞、对话、AI痕迹、小的连续性错误）。
  每个 PATCH 引用要修改的原文段落（一句、一段或多段皆可），给出替换文本。未涉及的内容保持原样。

REVISED_CONTENT——处理全章级问题（字数压缩、结构重组、节奏重排、重大剧情偏离）。
  输出修正后的完整正文。当 Critical 问题包含字数或结构性问题时，必须使用 REVISED_CONTENT——PATCHES 无法压缩或重构整章。${rewriteLengthConstraint}

如果 Critical 同时包含局部问题和全章问题，使用 REVISED_CONTENT（一次性解决所有问题）。

修稿原则：
1. 修根因，不做表面润色${numericalRule}
2. 伏笔状态必须与伏笔池同步。如果提供了 Hook Debt 简报，必须保留伏笔兑现段落
3. 不改变剧情走向和核心冲突
4. 保持原文的语言风格、节奏和呼吸——不要压缩过渡段、不要删掉减速段
5. 情绪用动作外化（不写"他感到愤怒"，写动作）。价值观通过行为传达
6. 不同角色说话方式必须不同。禁止"众人齐声惊呼"
7. 坏事叠坏事，每层比上一层过分

小目标周期修稿指引：
- 如果本章应该是"后效"阶段但仍在加压，把最密集的冲突段落改写为展示改变的段落——谁失去了什么、谁的态度变了、新的常态是什么
- 如果本章应该是"爆发"阶段但没有明确兑现，找到最接近回报的场景并放大它——让承诺的释放超过读者预期
- 日常段落如果不服务主线，改写为"饵"：加入一个指向未来的细节、一句暗示、一个角色反应

输出格式：

=== FIXED_ISSUES ===
(逐条说明修正了什么)

=== PATCHES ===
(局部补丁——仅用于局部文字问题。有全章级问题时省略此区块)
--- PATCH 1 ---
TARGET_TEXT:
(从原文中精确引用要修改的段落)
REPLACEMENT_TEXT:
(替换后的文本)
--- END PATCH ---

=== REVISED_CONTENT ===
(修正后的完整正文——用于字数/结构/节奏等全章级问题。仅局部问题时省略此区块)

=== UPDATED_STATE ===
(更新后的完整状态卡)
${ledgerSection}
=== UPDATED_HOOKS ===
(更新后的完整伏笔池)`;
  }

  private buildLegacySystemPrompt(params: {
    langPrefix: string;
    gp: GenreProfile;
    protagonistBlock: string;
    numericalRule: string;
    lengthGuardrail: string;
    mode: ReviseMode;
    resolvedLanguage: "zh" | "ko" | "en";
  }): string {
    const { langPrefix, gp, protagonistBlock, numericalRule, lengthGuardrail, mode, resolvedLanguage } = params;
    if (resolvedLanguage === "ko") {
      const modeDescription = KOREAN_MODE_DESCRIPTIONS[mode];
      const outputFormat = mode === "spot-fix"
        ? `=== FIXED_ISSUES ===
(수정한 문제를 한 줄씩 적습니다. 안전하게 고칠 수 없으면 그 이유를 적습니다.)

=== PATCHES ===
--- PATCH 1 ---
TARGET_TEXT:
(원문에서 정확히 복사하고 한 번만 나오는 문장이나 문단)
REPLACEMENT_TEXT:
(교체할 한국어 문장이나 문단)
--- END PATCH ---

=== UPDATED_STATE ===
(수정한 전체 상태표)
${gp.numericalSystem ? "\n=== UPDATED_LEDGER ===\n(수정한 전체 자원 장부)" : ""}
=== UPDATED_HOOKS ===
(수정한 전체 복선표)`
        : `=== FIXED_ISSUES ===
(수정한 문제를 한 줄씩 적습니다.)

=== REVISED_CONTENT ===
(수정한 전체 한국어 원고)

=== UPDATED_STATE ===
(수정한 전체 상태표)
${gp.numericalSystem ? "\n=== UPDATED_LEDGER ===\n(수정한 전체 자원 장부)" : ""}
=== UPDATED_HOOKS ===
(수정한 전체 복선표)`;

      return `${langPrefix}당신은 한국 장르소설 수정 편집자입니다. 「${gp.name}」 원고를 한국어로 직접 읽고 고칩니다.${protagonistBlock}

수정 방식: ${modeDescription}

수정 원칙:
1. 선택된 방식의 수정 범위를 넘지 않습니다.
2. 표면적인 말만 바꾸지 말고 지적된 원인을 고칩니다.${numericalRule}
4. 복선표와 원고의 사실을 맞춥니다.
5. 사건의 방향과 핵심 충돌을 바꾸지 않습니다.
6. 원문의 말투와 문장 호흡을 보존합니다.
7. 상태표${gp.numericalSystem ? ", 자원 장부" : ""}, 복선표도 원고와 맞게 갱신합니다.
${lengthGuardrail}
${mode === "spot-fix" ? "\n9. PATCHES만 출력하며 원고 전체를 다시 쓰지 않습니다. TARGET_TEXT는 원문에서 한 번만 나오는 정확한 인용이어야 합니다.\n10. 넓은 범위의 재작성이 필요하면 안전하게 고칠 수 없다고 기록하고 PATCHES를 비웁니다." : ""}

출력 형식:

${outputFormat}`;
    }

    const modeDesc = MODE_DESCRIPTIONS[mode];
    const outputFormat = mode === "spot-fix"
      ? `=== FIXED_ISSUES ===
(逐条说明修正了什么，一行一条；如果无法安全定点修复，也在这里说明)

=== PATCHES ===
--- PATCH 1 ---
TARGET_TEXT:
(必须从原文中精确复制、且能唯一命中的原句或原段)
REPLACEMENT_TEXT:
(替换后的局部文本)
--- END PATCH ---

=== UPDATED_STATE ===
(更新后的完整状态卡)
${gp.numericalSystem ? "\n=== UPDATED_LEDGER ===\n(更新后的完整资源账本)" : ""}
=== UPDATED_HOOKS ===
(更新后的完整伏笔池)`
      : `=== FIXED_ISSUES ===
(逐条说明修正了什么，一行一条)

=== REVISED_CONTENT ===
(修正后的完整正文)

=== UPDATED_STATE ===
(更新后的完整状态卡)
${gp.numericalSystem ? "\n=== UPDATED_LEDGER ===\n(更新后的完整资源账本)" : ""}
=== UPDATED_HOOKS ===
(更新后的完整伏笔池)`;

    return `${langPrefix}你是一位专业的${gp.name}网络小说修稿编辑。你的任务是根据审稿意见对章节进行修正。${protagonistBlock}

修稿模式：${modeDesc}

修稿原则：
1. 按模式控制修改幅度
2. 修根因，不做表面润色${numericalRule}
4. 伏笔状态必须与伏笔池同步
5. 不改变剧情走向和核心冲突
6. 保持原文的语言风格和节奏
7. 修改后同步更新状态卡${gp.numericalSystem ? "、账本" : ""}、伏笔池
${lengthGuardrail}
${mode === "spot-fix" ? "\n9. spot-fix 只能输出局部补丁，禁止输出整章改写；TARGET_TEXT 必须能在原文中唯一命中\n10. 如果需要大面积改写，说明无法安全 spot-fix，并让 PATCHES 留空" : ""}

输出格式：

${outputFormat}`;
  }

  private async readFileSafe(path: string): Promise<string> {
    try {
      return await readFile(path, "utf-8");
    } catch {
      return "(文件不存在)";
    }
  }

  private buildReducedControlBlock(
    memo: ChapterMemo | undefined,
    intent: ChapterIntent | undefined,
    chapterIntent: string | undefined,
    contextPackage: ContextPackage,
    ruleStack: RuleStack,
    language: "zh" | "ko" | "en",
  ): string {
    const selectedContext = renderNarrativeSelectedContext(contextPackage.selectedContext, language)
      .replace(/^### /gm, "- ");
    const overrides = ruleStack.activeOverrides.length > 0
      ? ruleStack.activeOverrides
        .map((override) => `- ${override.from} -> ${override.to}: ${override.reason} (${override.target})`)
        .join("\n")
      : language === "ko" ? "- 없음" : "- none";
    // Prefer memo-based narrative block; fall back to legacy intent markdown
    const narrativeBlock = memo
      ? renderMemoAsNarrativeBlock(memo, intent, language)
      : chapterIntent
        ? buildNarrativeIntentBrief(chapterIntent, language)
        : language === "ko" ? "(없음)" : "(无)";

    if (language === "ko") {
      return `\n## 이번 화 제어 입력
${narrativeBlock}

### 선택한 근거
${selectedContext || "- 없음"}

### 적용 규칙
- 반드시 지킬 것: ${ruleStack.sections.hard.join(", ") || "(없음)"}
- 가급적 지킬 것: ${ruleStack.sections.soft.join(", ") || "(없음)"}
- 진단 기준: ${ruleStack.sections.diagnostic.join(", ") || "(없음)"}

### 현재 덮어쓰기
${overrides}\n`;
    }

    return `\n## 本章控制输入（由 Planner/Composer 编译）
${narrativeBlock}

### 已选上下文
${selectedContext || "- none"}

### 规则栈
- 硬护栏：${ruleStack.sections.hard.join("、") || "(无)"}
- 软约束：${ruleStack.sections.soft.join("、") || "(无)"}
- 诊断规则：${ruleStack.sections.diagnostic.join("、") || "(无)"}

### 当前覆盖
${overrides}\n`;
  }
}

// Local-only categories: reviser produces line/paragraph patches. Fixing these
// with a full rewrite risks introducing new issues, so we force patch-only.
const LOCAL_ONLY_PATTERNS: ReadonlyArray<RegExp> = [
  /Paragraph uniformity|段落等长/i,
  /Hedge density|套话密度/i,
  /Formulaic transitions|접속어 반복|公式化转折/i,
  /List-like structure|나열식 문장 구조|列表式结构/i,
  /Cross-chapter repetition|跨章重复/i,
  /AI-tell word density/i,
  /Fatigue word|高疲劳词/i,
  /Information Boundary Check|信息越界/i,
  /Knowledge Base Pollution|知识库污染/i,
];

// Structural/semantic categories: character collapse, mainline drift, conflict
// absence, timeline breaks, unpaid hooks, memo drift. These cannot be patched;
// the reviser must rewrite the chapter in full.
const STRUCTURAL_PATTERNS: ReadonlyArray<RegExp> = [
  /OOC|人设|Character Fidelity|Character Matrix|Character.*Consistency/i,
  /Mainline.*Drift|主线偏离|Outline Drift|大纲偏离|Chapter Memo Drift|章节备忘偏离/i,
  /Conflict|冲突乏力|Payoff Dilution|爽点虚化/i,
  /Timeline|时间线/i,
  /Hook Check|伏笔检查|Hook.*Debt|伏笔.*债|未兑现/i,
  /Power Scaling|战力崩坏|金手指/i,
  /Pacing|节奏/i,
  /POV Consistency|视角/i,
  /Subplot Stagnation|支线停滞|Arc Flatline|弧线平坦/i,
  /Relationship Dynamics|关系动态|情感表达/i,
  /Incentive Chain|利益链/i,
  /Canon Event|正典|Mainline Canon/i,
];

function resolveAutoOutputMode(issues: ReadonlyArray<AuditIssue>): AutoOutputMode {
  if (issues.length === 0) {
    return "allow-full";
  }
  const scopedBlocking = issues.filter((issue) => issue.severity !== "info" && issue.repairScope);
  if (scopedBlocking.length > 0) {
    if (scopedBlocking.some((issue) => issue.repairScope === "structural")) {
      return "rewrite-only";
    }
    if (
      scopedBlocking.length === issues.filter((issue) => issue.severity !== "info").length
      && scopedBlocking.every((issue) => issue.repairScope === "local")
    ) {
      return "patch-only";
    }
  }

  const isStructural = (issue: AuditIssue): boolean => {
    const text = `${issue.category} ${issue.description}`;
    return STRUCTURAL_PATTERNS.some((pattern) => pattern.test(text));
  };
  const isLocal = (issue: AuditIssue): boolean => {
    const text = `${issue.category} ${issue.description}`;
    return LOCAL_ONLY_PATTERNS.some((pattern) => pattern.test(text));
  };

  // Count blocking (critical + warning) structural vs local issues. Info-level
  // findings are reviewer hints for the Polisher — they do not drive routing.
  const blocking = issues.filter((issue) => issue.severity !== "info");
  if (blocking.length === 0) {
    return "patch-only"; // only hints / info — at most local polish
  }

  const structuralCount = blocking.filter(isStructural).length;
  const localOnlyCount = blocking.filter(isLocal).length;

  // Any structural issue forces a rewrite — patches cannot fix character
  // collapse, mainline drift, missing payoff, or timeline breaks.
  if (structuralCount > 0) {
    return "rewrite-only";
  }

  // All blocking issues are in the local-only list → safe to patch.
  if (localOnlyCount === blocking.length) {
    return "patch-only";
  }

  // Mixed / unknown blocking issue set — let the reviser pick (usually ends
  // up rewriting when critical, patching when warning).
  return "allow-full";
}
