import { readNarrativeEvidenceContext } from "../state/narrative-evidence.js";
import { readDraftDiscoveryPlanningContext } from "../planning/draft-discovery-runtime.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BaseAgent } from "./base.js";
import type { BookConfig } from "../models/book.js";
import type { ChapterArcProvenance } from "../models/chapter.js";
import { readGenreProfile } from "./rules-reader.js";
import { readEffectiveBookRules } from "./effective-book-rules.js";
import {
  ChapterIntentSchema,
  type ChapterIntent,
  type ChapterMemo,
} from "../models/input-governance.js";
import {
  renderHookSnapshot,
  renderSummarySnapshot,
} from "../utils/memory-retrieval.js";
import {
  gatherPlanningMaterials,
  loadPlanningSeedMaterials,
} from "../utils/planning-materials.js";
import { parseMemo, PlannerParseError } from "../utils/chapter-memo-parser.js";
import { sanitizeUnauthorizedMemoProhibitions } from "../utils/chapter-memo-authority.js";
import {
  findUnauthorizedMandatoryMoralCorrectionsInNarrativeEvidence,
  findUnauthorizedMandatoryMoralCorrectionsInText,
  type ArchitectMoralAuthoritySource,
} from "./architect.js";
import {
  buildPlannerUserMessage,
  getPlannerMemoSystemPrompt,
  type PlannerGenreFunContract,
} from "./planner-prompts.js";
import {
  composeCurrentArcProse,
  extractCollaboratorRows,
  extractOpponentRows,
  extractProtagonistRow,
  extractRelevantThreads,
  formatRecentSummaries,
  formatRecyclableHooks,
  readCharacterMatrix,
  readEmotionalArcs,
  readPendingHooks,
  readSubplotBoard,
} from "./planner-context.js";
import { readBookCreativeBrief, renderBookCreativeBrief, recordBookCreativeBrief } from "../planning/creative-brief.js";
import { readSceneDecision, recordSceneDecision, sceneDecisionGuidance } from "../planning/scene-decision.js";
import type { StoredHook } from "../state/memory-db.js";
import { ENTITY_OBSERVATION_CONTEXT_SOURCE, readEntityObservationContext } from "../state/entity-observations.js";
import { resolveAuthorCraftContext, recordAuthorCraftContext, availableAuthorCraftTokens } from "../reference/author-craft.js";

export interface PlanChapterInput {
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly externalContext?: string;
  readonly arcContext?: string;
  readonly arcProvenance?: ChapterArcProvenance;
}

export interface PlanChapterOutput {
  readonly authorCraftReceiptPath?: string;
  readonly sceneDecisionReceiptPath?: string;
  readonly creativeBriefReceiptPath?: string;
  readonly intent: ChapterIntent;
  readonly memo: ChapterMemo;
  readonly intentMarkdown: string;
  readonly plannerInputs: ReadonlyArray<string>;
  readonly runtimePath: string;
  readonly arcProvenance?: ChapterArcProvenance;
}

const MEMO_RETRY_LIMIT = 3;

/**
 * Phase 3 planner.
 *
 * Produces:
 *   - a simplified ChapterIntent (goal + outline + keep/avoid/style) —
 *     still deterministic, used for retrieval hints and the intent markdown.
 *   - a full ChapterMemo (plain markdown sections) via LLM call + strict
 *     parser.
 *
 * Retry policy: up to 3 attempts. Each failed parse appends an error
 * feedback block to the user message and re-invokes the LLM. If all attempts
 * fail, the planner emits a degraded but valid memo with an explicit warning
 * instead of crashing the whole chapter pipeline.
 */
export class PlannerAgent extends BaseAgent {
  get name(): string {
    return "planner";
  }

  async planChapter(input: PlanChapterInput): Promise<PlanChapterOutput> {
    const storyDir = join(input.bookDir, "story");
    const runtimeDir = join(storyDir, "runtime");
    await mkdir(runtimeDir, { recursive: true });

    const [seedMaterials, genreProfile] = await Promise.all([
      loadPlanningSeedMaterials({
        bookDir: input.bookDir,
        chapterNumber: input.chapterNumber,
      }),
      readGenreProfile(this.ctx.projectRoot, input.book.genre),
    ]);
    const plannerLanguage = input.book.language ?? genreProfile.profile.language;
    const genreFunContract: PlannerGenreFunContract | undefined = plannerLanguage === "ko"
      && genreProfile.profile.language === "ko"
      ? {
          name: genreProfile.profile.name,
          pacingRule: genreProfile.profile.pacingRule,
          chapterTypes: genreProfile.profile.chapterTypes,
          satisfactionTypes: genreProfile.profile.satisfactionTypes,
        }
      : undefined;
    const outlineNode = this.findOutlineNode(seedMaterials.volumeOutline, input.chapterNumber);
    const goal = this.deriveGoal(
      input.externalContext,
      seedMaterials.currentFocus,
      seedMaterials.authorIntent,
      outlineNode,
      input.chapterNumber,
    );
    // Only host-verified hard prohibitions may become mustAvoid. Raw/display
    // BookRules remain visible to the UI, but cannot silently steer planning.
    const effectiveRules = await readEffectiveBookRules(input.bookDir, input.book.id);
    const prohibitions = effectiveRules?.automatic.prohibitions ?? [];
    const moralAuthoritySources: ArchitectMoralAuthoritySource[] = [
      { kind: "owner-direction", text: input.externalContext ?? "" },
      { kind: "owner-direction", text: seedMaterials.brief },
      { kind: "owner-direction", text: seedMaterials.authorIntent },
      { kind: "owner-direction", text: seedMaterials.currentFocus },
      { kind: "persisted-book-canon", text: seedMaterials.storyBible },
      { kind: "persisted-book-canon", text: seedMaterials.volumeOutline },
      ...(effectiveRules?.hardEntries ?? []).map((entry) => ({
        kind: "persisted-book-canon" as const,
        text: entry.text,
      })),
    ];
    this.assertPlanningInputsMoralAuthority([
      seedMaterials.currentState,
      input.arcContext,
    ], moralAuthoritySources);
    this.assertPlanningInputsMoralAuthority([
      seedMaterials.chapterSummariesRaw,
      seedMaterials.previousEndingExcerpt,
    ], moralAuthoritySources, true);
    const mustKeep = this.collectMustKeep(seedMaterials.currentState, seedMaterials.storyBible);
    const mustAvoid = this.collectMustAvoid(seedMaterials.currentFocus, prohibitions);
    const styleEmphasis = this.collectStyleEmphasis(seedMaterials.authorIntent, seedMaterials.currentFocus);
    const materials = await gatherPlanningMaterials({
      bookDir: input.bookDir,
      chapterNumber: input.chapterNumber,
      goal,
      outlineNode,
      mustKeep,
      seed: seedMaterials,
    });
    const memorySelection = materials.memorySelection;
    const activeHookCount = memorySelection.activeHooks.filter(
      (hook) => hook.status !== "resolved" && hook.status !== "deferred",
    ).length;

    const arcContext = this.buildArcContext(
      plannerLanguage,
      seedMaterials.volumeOutline,
      outlineNode,
    );

    const intent = ChapterIntentSchema.parse({
      chapter: input.chapterNumber,
      goal,
      outlineNode,
      arcContext,
      mustKeep,
      mustAvoid,
      styleEmphasis,
      ...(input.arcProvenance?.futureAdvantageMove
        ? {
            futureAdvantageMoveIds: [input.arcProvenance.futureAdvantageMove.moveId],
            researchClaimIds: [...input.arcProvenance.futureAdvantageMove.researchClaimIds],
            authorizedDivergences: [...input.arcProvenance.futureAdvantageMove.authorizedDivergences],
          }
        : {}),
    });

    const isGoldenOpening = this.isGoldenOpeningChapter(plannerLanguage, input.chapterNumber);
    let authorCraftReceiptPath: string | undefined;
    let creativeBriefReceiptPath: string | undefined;
    const creativeBrief = await readBookCreativeBrief({ bookDir: input.bookDir, bookId: input.book.id, chapterNumber: input.chapterNumber });
    const memo = await this.planChapterMemo({
      storyDir,
      bookDir: input.bookDir,
      chapterNumber: input.chapterNumber,
      isGoldenOpening,
      fallbackGoal: goal,
      chapterSummariesRaw: seedMaterials.chapterSummariesRaw,
      previousEndingExcerpt: seedMaterials.previousEndingExcerpt,
      brief: seedMaterials.brief,
      chapterContext: input.externalContext,
      arcContext: input.arcContext,
      bookRulesRelevant: effectiveRules?.guidance ?? "",
      moralAuthoritySources,
      recyclableHooks: memorySelection.recyclableHooks,
      genreFunContract,
      sceneDecisionEnabled: Boolean(input.book.writing?.authorCraft),
      resolveAuthorCraft: async (reservedText) => {
        const briefContext = renderBookCreativeBrief(creativeBrief, { language: plannerLanguage,
          maxInputTokens: availableAuthorCraftTokens({ contextWindow: this.ctx.client._piModel?.contextWindow,
            outputTokens: this.ctx.client.defaults.maxTokens, reservedText, extraReserve: 512 }) });
        creativeBriefReceiptPath = await recordBookCreativeBrief(input.bookDir, input.chapterNumber, "planning", briefContext).catch(() => { this.ctx.logger?.warn("[creative-brief] Optional input receipt could not be saved."); return undefined; });
        const discoveryContext = await readDraftDiscoveryPlanningContext(input.bookDir, input.book.id, plannerLanguage,
          availableAuthorCraftTokens({ contextWindow: this.ctx.client._piModel?.contextWindow,
            outputTokens: this.ctx.client.defaults.maxTokens, reservedText: [reservedText, briefContext.rendered].join("\n\n"), extraReserve: 512 }), input.chapterNumber - 1);
        const narrativeContext = await readNarrativeEvidenceContext(input.bookDir, { bookId: input.book.id,
          throughChapter: input.chapterNumber - 1, language: plannerLanguage, query: [goal, outlineNode, input.externalContext].filter(Boolean).join("\n"),
          maxInputTokens: availableAuthorCraftTokens({ contextWindow: this.ctx.client._piModel?.contextWindow,
            outputTokens: this.ctx.client.defaults.maxTokens, reservedText: [reservedText, briefContext.rendered, discoveryContext.rendered].join("\n\n"), extraReserve: 512 }),
        });
        const authorCraft = await resolveAuthorCraftContext({
          projectRoot: this.ctx.projectRoot,
          bookId: input.book.id,
          config: input.book.writing?.authorCraft,
          language: plannerLanguage,
          stage: "planning",
          query: [goal, outlineNode, input.externalContext].filter(Boolean).join("\n"),
          maxContextTokens: availableAuthorCraftTokens({ contextWindow: this.ctx.client._piModel?.contextWindow,
            outputTokens: this.ctx.client.defaults.maxTokens, reservedText: [reservedText, briefContext.rendered, discoveryContext.rendered, narrativeContext.rendered].join("\n\n"), extraReserve: 512 }),
        });
        authorCraftReceiptPath = await recordAuthorCraftContext(input.bookDir, input.chapterNumber, authorCraft);
        return [briefContext.rendered, discoveryContext.rendered, narrativeContext.rendered, authorCraft?.rendered].filter(Boolean).join("\n\n");
      },
      // Phase hotfix 4: thread book language through so the planner uses
      // English prompts (system + user template + golden opening guidance)
      // for English books instead of always-Chinese.
      language: plannerLanguage,
    });

    // memo.goal is LLM-produced and specific (<=50 chars, validated).
    // Overwrite intent.goal so downstream composer/retrieval gets the
    // concrete task statement instead of the outline-derived fallback.
    intent.goal = memo.goal;
    const sceneDecision = input.book.writing?.authorCraft || readSceneDecision(memo).status !== "missing"
      ? await recordSceneDecision(input.bookDir, memo).catch(() => { this.ctx.logger?.warn("[scene-decision] Optional decision receipt could not be saved."); return undefined; }) : undefined;

    const runtimePath = join(runtimeDir, `chapter-${String(input.chapterNumber).padStart(4, "0")}.intent.md`);
    const intentMarkdown = this.renderIntentMarkdown(
      intent,
      memo,
      plannerLanguage,
      renderHookSnapshot(memorySelection.hooks, plannerLanguage),
      renderSummarySnapshot(memorySelection.summaries, plannerLanguage),
      activeHookCount,
    );
    await writeFile(runtimePath, intentMarkdown, "utf-8");

    return {
      intent,
      ...(authorCraftReceiptPath ? { authorCraftReceiptPath } : {}),
      ...(sceneDecision ? { sceneDecisionReceiptPath: sceneDecision.path } : {}),
      ...(creativeBriefReceiptPath ? { creativeBriefReceiptPath } : {}),
      memo,
      intentMarkdown,
      plannerInputs: [...materials.plannerInputs, ENTITY_OBSERVATION_CONTEXT_SOURCE],
      runtimePath,
      ...(input.arcProvenance ? { arcProvenance: input.arcProvenance } : {}),
    };
  }

  /**
   * Invoke the LLM to produce a 7-section memo and parse it. Retries up to
   * 3 times on parse failure, injecting the error message back into the user
   * prompt so the LLM can correct itself.
   */
  async planChapterMemo(input: {
    readonly storyDir: string;
    readonly bookDir: string;
    readonly chapterNumber: number;
    readonly isGoldenOpening: boolean;
    readonly fallbackGoal: string;
    readonly chapterSummariesRaw: string;
    readonly previousEndingExcerpt?: string;
    readonly brief?: string;
    readonly chapterContext?: string;
    readonly arcContext?: string;
    readonly bookRulesRelevant?: string;
    readonly moralAuthoritySources?: ReadonlyArray<ArchitectMoralAuthoritySource>;
    readonly recyclableHooks?: ReadonlyArray<StoredHook>;
    readonly genreFunContract?: PlannerGenreFunContract;
    readonly authorCraftContext?: string;
    readonly sceneDecisionEnabled?: boolean;
    readonly resolveAuthorCraft?: (reservedText: string) => Promise<string>;
    readonly language?: "zh" | "ko" | "en";
  }): Promise<ChapterMemo> {
    const [characterMatrix, subplotBoard, emotionalArcs, pendingHooks] = await Promise.all([
      readCharacterMatrix(input.storyDir),
      readSubplotBoard(input.storyDir),
      readEmotionalArcs(input.storyDir),
      readPendingHooks(input.storyDir),
    ]);
    this.assertPlanningInputsMoralAuthority([
      input.arcContext,
      characterMatrix,
      subplotBoard,
      emotionalArcs,
      pendingHooks,
    ], input.moralAuthoritySources ?? []);
    this.assertPlanningInputsMoralAuthority([
      input.chapterSummariesRaw,
      input.previousEndingExcerpt,
    ], input.moralAuthoritySources ?? [], true);

    const language = input.language ?? "zh";
    const noPriorChapter = language === "ko"
      ? "(첫 회차라 직전 회차 없음)"
      : language === "en"
        ? "(this is the opening chapter — no prior chapter)"
        : "（本章为起始章，无前章）";
    const noBookRules = language === "ko"
      ? "(작품 규칙 항목 없음)"
      : language === "en"
        ? "(no book_rules entries)"
        : "（暂无 book_rules 条目）";
    const retryFeedbackHeader = language === "ko"
      ? "## 직전 출력 오류"
      : language === "en"
        ? "## Error from previous output"
        : "## 上次输出的错误";
    const retryFeedbackTrailer = language === "ko"
      ? "오류를 고쳐 같은 형식으로 다시 출력하세요."
      : language === "en"
        ? "Fix and re-emit."
        : "请修正后重新输出。";

    const entityContext = await readEntityObservationContext(input.bookDir, {
      throughChapter: input.chapterNumber - 1,
      query: [input.fallbackGoal, input.chapterContext, input.arcContext].filter(Boolean).join("\n"),
      language,
    });
    this.assertPlanningInputsMoralAuthority([entityContext], input.moralAuthoritySources ?? [], true);
    const baseUserMessage = buildPlannerUserMessage({
      chapterNumber: input.chapterNumber,
      previousChapterEndingExcerpt: input.previousEndingExcerpt?.trim()
        ? input.previousEndingExcerpt.trim()
        : noPriorChapter,
      recentSummaries: formatRecentSummaries(input.chapterSummariesRaw, input.chapterNumber, 3, language),
      currentArcProse: composeCurrentArcProse(subplotBoard, emotionalArcs, input.chapterNumber, language),
      protagonistMatrixRow: extractProtagonistRow(characterMatrix, language),
      opponentRows: extractOpponentRows(characterMatrix, 3, language),
      collaboratorRows: extractCollaboratorRows(characterMatrix, 3, language),
      relevantThreads: extractRelevantThreads(pendingHooks, subplotBoard, language),
      recyclableHooks: formatRecyclableHooks(
        input.recyclableHooks ?? [],
        input.chapterNumber,
        language,
      ),
      isGoldenOpening: input.isGoldenOpening,
      bookRulesRelevant: input.bookRulesRelevant?.trim()
        ? input.bookRulesRelevant.trim()
        : noBookRules,
      brief: input.brief ?? "",
      chapterContext: input.chapterContext ?? "",
      arcContext: input.arcContext ?? "",
      genreFunContract: input.genreFunContract,
      language,
    });
    const systemPrompt = [getPlannerMemoSystemPrompt(language), input.sceneDecisionEnabled ? sceneDecisionGuidance(language) : ""].filter(Boolean).join("\n\n");
    const authorCraft = input.resolveAuthorCraft
      ? await input.resolveAuthorCraft([systemPrompt, baseUserMessage, entityContext].filter(Boolean).join("\n\n"))
      : input.authorCraftContext;
    const userMessage = [baseUserMessage, entityContext, authorCraft].filter(Boolean).join("\n\n");

    let currentUserMessage = userMessage;
    let lastError: PlannerParseError | undefined;

    for (let attempt = 0; attempt < MEMO_RETRY_LIMIT; attempt += 1) {
      const response = await this.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: currentUserMessage },
        ],
        { temperature: 0.7 },
      );

      try {
        return this.parseAndValidateMemo(
          response.content,
          input.chapterNumber,
          input.isGoldenOpening,
          input.moralAuthoritySources ?? [],
        );
      } catch (error) {
        if (!(error instanceof PlannerParseError)) {
          throw error;
        }
        lastError = error;
        this.log?.warn(`[planner] memo parse failed (attempt ${attempt + 1}/${MEMO_RETRY_LIMIT}): ${error.message}`);
        currentUserMessage = `${userMessage}\n\n${retryFeedbackHeader}\n${error.message}\n${retryFeedbackTrailer}`;
      }
    }

    const fallbackError = lastError ?? new PlannerParseError("memo planner exhausted retries without a specific error");
    this.log?.warn(`[planner] memo planner fell back after ${MEMO_RETRY_LIMIT} attempts: ${fallbackError.message}`);
    return this.parseAndValidateMemo(
      this.buildFallbackMemoMarkdown({
        chapterNumber: input.chapterNumber,
        isGoldenOpening: input.isGoldenOpening,
        fallbackGoal: input.fallbackGoal,
        errorMessage: fallbackError.message,
        language,
      }),
      input.chapterNumber,
      input.isGoldenOpening,
      input.moralAuthoritySources ?? [],
    );
  }

  private parseAndValidateMemo(
    raw: string,
    chapterNumber: number,
    isGoldenOpening: boolean,
    moralAuthoritySources: ReadonlyArray<ArchitectMoralAuthoritySource>,
  ): ChapterMemo {
    const parsedMemo = parseMemo(raw, chapterNumber, isGoldenOpening);
    const { memo } = sanitizeUnauthorizedMemoProhibitions(
      parsedMemo,
      moralAuthoritySources,
    );
    const findings = findUnauthorizedMandatoryMoralCorrectionsInText(
      `${memo.goal}\n${memo.body}`,
      moralAuthoritySources,
    );
    if (findings.length > 0) {
      throw new PlannerParseError(
        `unauthorized mandatory moral-correction constraint: ${findings.join(" | ")}`,
      );
    }
    return memo;
  }

  private assertPlanningInputsMoralAuthority(
    surfaces: ReadonlyArray<string | undefined>,
    moralAuthoritySources: ReadonlyArray<ArchitectMoralAuthoritySource>,
    narrativeEvidence = false,
  ): void {
    const findings = new Set<string>();
    for (const surface of surfaces) {
      if (!surface) continue;
      const detector = narrativeEvidence
        ? findUnauthorizedMandatoryMoralCorrectionsInNarrativeEvidence
        : findUnauthorizedMandatoryMoralCorrectionsInText;
      for (const finding of detector(
        surface,
        moralAuthoritySources,
      )) findings.add(finding);
    }
    if (findings.size > 0) {
      throw new PlannerParseError(
        `persisted planning input contains an unauthorized mandatory moral-correction constraint; repair the source before continuing: ${[...findings].join(" | ")}`,
      );
    }
  }

  private buildFallbackMemoMarkdown(input: {
    readonly chapterNumber: number;
    readonly isGoldenOpening: boolean;
    readonly fallbackGoal: string;
    readonly errorMessage: string;
    readonly language: "zh" | "ko" | "en";
  }): string {
    if (input.language === "ko") {
      return [
        `# ${input.chapterNumber}화 메모`,
        "",
        "## 회차 목표",
        input.fallbackGoal || `현재 개요에 따라 ${input.chapterNumber}화를 이어 간다`,
        "",
        "## 연결 복선",
        "없음",
        "",
        "## 현재 작업",
        `현재 회차 목표와 작품 정본을 따라 ${input.chapterNumber}화를 진행하고 임의의 새 방향을 만들지 않는다.`,
        "",
        "## 독자가 지금 기다리는 것",
        "- 재미 앵커: 개요와 직전 회차가 만든 가장 가까운 구체적 약속 하나",
        "- 이번 화의 지급 장면: 주인공 행동 → 상대 대응 → 독자가 확인할 결과",
        "- 상태: 현재 목표가 약속한 결과를 먼저 독자가 알아볼 수 있게 지급한다. 완전히 수습하는 회차라면 새 압력을 만들지 않고 완결 상태를 기록한다.",
        "",
        "## 이번 화에 지급할 것 / 감출 것",
        "근거가 있는 가까운 약속은 이번 화 목표가 요구하는 만큼 지급한다. 더 큰 비밀만 개요가 명시적으로 보류할 때 감춘다.",
        "",
        "## 일상/전환 장면의 기능",
        "느린 장면도 감정, 관계, 정보, 선택, 지급 또는 후과 가운데 이 회차에 맞는 구체 기능을 맡긴다.",
        "",
        "## 핵심 선택 세 가지 점검",
        "주인공의 핵심 선택에는 이유가 있고 현재 이익과 기존 인물성에 맞아야 한다.",
        "",
        "## 화말에 반드시 바뀔 것",
        "이번 화 행동의 결과를 분명히 보여 준 뒤, 완전 수습·후과·자연스러운 다음 선택이나 압력 가운데 장면에 맞는 기능으로 끝낸다. 완전 수습이면 새 압력을 만들 필요가 없다.",
        "",
        "## 이번 화 훅 장부",
        "advance/resolve: 이번 화 목표가 실제로 고른 약속만 장면으로 다룬다. defer: 나머지는 이유와 다음 점검 시점을 남기며, 묵었다는 이유만으로 장면 의무를 만들지 않는다.",
        "",
        "## 금지",
        "기존 사실과 사용자 지시를 어기거나 fallback 메모를 새 장거리 개요로 확대하지 않는다.",
        "",
        "## 기획 경고",
        `모델이 ${MEMO_RETRY_LIMIT}번 연속 유효한 회차 메모를 만들지 못했다. 마지막 오류: ${input.errorMessage}`,
      ].join("\n");
    }
    if (input.language !== "zh") {
      return [
        `# Chapter ${input.chapterNumber} memo`,
        "",
        "## Chapter goal",
        input.fallbackGoal || `Continue chapter ${input.chapterNumber} according to the current outline`,
        "",
        "## Thread refs",
        "none",
        "",
        "## Current task",
        `Use the current chapter goal and authoritative book context to continue chapter ${input.chapterNumber} without inventing a new direction.`,
        "",
        "## What the reader is waiting for right now",
        "Keep the reader's active expectation from the outline and previous chapter in focus; do not replace it with a generic scene.",
        "",
        "## To pay off / to keep buried",
        "Deliver the result promised by the current task to the degree this chapter calls for. Keep only larger secrets that the outline explicitly says to withhold.",
        "",
        "## What the slow / transitional beats carry",
        "If a slower beat is needed, let it carry emotion, relationship movement, information, choice, payoff, or consequence that belongs to this chapter.",
        "",
        "## Three-question check on the key choice",
        "The protagonist's main choice must have a reason, match current interest, and stay consistent with the established persona.",
        "",
        "## Required end-of-chapter change",
        "Show the concrete result of this chapter's action, then choose the ending function that honestly fits: full settlement, aftermath, a natural next choice, or pressure. Full settlement does not need fresh pressure.",
        "",
        "## Hook ledger for this chapter",
        "advance/resolve: stage only promises selected by this chapter's task; defer: record a reason and next review point for the rest. Staleness alone is not a scene obligation.",
        "",
        "## Do not",
        "Do not contradict established facts, ignore the user's current instruction, or turn the fallback memo into a new outline.",
        "",
        "## Planner warning",
        `The model failed to produce a valid chapter memo after ${MEMO_RETRY_LIMIT} attempts. Last parser error: ${input.errorMessage}`,
      ].join("\n");
    }

    return [
      `# 第 ${input.chapterNumber} 章 memo`,
      "",
      "## 本章目标",
      input.fallbackGoal || `按当前大纲继续推进第 ${input.chapterNumber} 章`,
      "",
      "## 关联线索",
      "无",
      "",
      "## 当前任务",
      `沿用当前章节目标和权威设定推进第 ${input.chapterNumber} 章，不临时改方向，也不把章节写成泛泛过渡。`,
      "",
      "## 读者此刻在等什么",
      "延续大纲和上一章形成的读者期待，先让当前任务承诺的结果变得可见；如果本章适合完整收束，就不要另造压力。",
      "",
      "## 该兑现的 / 暂不掀的",
      "按本章目标所需兑现已有上下文支撑的近端承诺；只压住大纲明确要求暂不揭开的更大秘密。",
      "",
      "## 日常/过渡承担什么任务",
      "如果需要日常或过渡，让它承担情绪、关系、信息、选择、兑现或后效中适合本章的一项具体功能。",
      "",
      "## 关键抉择过三连问",
      "主角本章的关键选择必须有原因、符合当前利益，并且不背离已经建立的人设和行为逻辑。",
      "",
      "## 章尾必须发生的改变",
      "先写清本章行动产生的具体结果，再从完整收束、后效、自然的下一选择或压力中选择最诚实的章尾功能；完整收束不需要新造压力。",
      "",
      "## 本章 hook 账",
      "advance/resolve: 只处理本章任务实际选中的承诺；defer: 其余条目写明理由和下次检查点。仅仅陈旧不会产生本章场景义务。",
      "",
      "## 不要做",
      "不要违背既成事实，不要无视用户当前指令，不要把 fallback memo 当成新大纲重写整本书。",
      "",
      "## Planner warning",
      `模型连续 ${MEMO_RETRY_LIMIT} 次没有产出合格章节 memo。最后一次解析错误：${input.errorMessage}`,
    ].join("\n");
  }

  private isGoldenOpeningChapter(language: string | undefined, chapterNumber: number): boolean {
    // Planner, Writer, and narrative-control all implement the Golden Three
    // Chapters contract. Keep the boundary identical after language inference;
    // otherwise an omitted-language Korean profile accidentally marks chapters
    // 4-5 as opening chapters and forces opening-density guidance downstream.
    return chapterNumber <= 3;
  }

  private buildArcContext(
    language: string | undefined,
    volumeOutline: string,
    outlineNode: string | undefined,
  ): string | undefined {
    if (!outlineNode) return undefined;
    if (volumeOutline === "(文件尚未创建)") return undefined;
    return language === "ko"
      ? `개요 노드: ${outlineNode}`
      : this.isChineseLanguage(language)
        ? `卷纲节点：${outlineNode}`
        : `Outline node: ${outlineNode}`;
  }

  private deriveGoal(
    externalContext: string | undefined,
    currentFocus: string,
    authorIntent: string,
    outlineNode: string | undefined,
    chapterNumber: number,
  ): string {
    const first = this.extractFirstDirective(externalContext);
    if (first) return first;
    const localOverride = this.extractLocalOverrideGoal(currentFocus);
    if (localOverride) return localOverride;
    const outline = this.extractFirstDirective(outlineNode);
    if (outline) return outline;
    const focus = this.extractFocusGoal(currentFocus);
    if (focus) return focus;
    const author = this.extractFirstDirective(authorIntent);
    if (author) return author;
    return `Advance chapter ${chapterNumber} with clear narrative focus.`;
  }

  private collectMustKeep(currentState: string, storyBible: string): string[] {
    return this.unique([
      ...this.extractListItems(currentState, 2),
      ...this.extractListItems(storyBible, 2),
    ]).slice(0, 4);
  }

  private collectMustAvoid(currentFocus: string, prohibitions: ReadonlyArray<string>): string[] {
    const avoidSection = this.extractSection(currentFocus, [
      "avoid",
      "must avoid",
      "禁止",
      "避免",
      "避雷",
    ]);
    const focusAvoids = avoidSection
      ? this.extractListItems(avoidSection, 10)
      : currentFocus
        .split("\n")
        .map((line) => line.trim())
        .filter((line) =>
          line.startsWith("-") &&
          /avoid|don't|do not|不要|别|禁止/i.test(line),
        )
        .map((line) => this.cleanListItem(line))
        .filter((line): line is string => Boolean(line));

    return this.unique([...focusAvoids, ...prohibitions]).slice(0, 6);
  }

  private collectStyleEmphasis(authorIntent: string, currentFocus: string): string[] {
    return this.unique([
      ...this.extractFocusStyleItems(currentFocus),
      ...this.extractListItems(authorIntent, 2),
    ]).slice(0, 4);
  }

  private extractFirstDirective(content?: string): string | undefined {
    if (!content) return undefined;
    return content
      .split("\n")
      .map((line) => line.trim())
      .find((line) =>
        line.length > 0
        && !line.startsWith("#")
        && !line.startsWith("-")
        && !this.isTemplatePlaceholder(line),
      );
  }

  private extractListItems(content: string, limit: number): string[] {
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("-"))
      .map((line) => this.cleanListItem(line))
      .filter((line): line is string => Boolean(line))
      .slice(0, limit);
  }

  private extractFocusGoal(currentFocus: string): string | undefined {
    const focusSection = this.extractSection(currentFocus, [
      "active focus",
      "focus",
      "当前聚焦",
      "当前焦点",
      "近期聚焦",
    ]) ?? currentFocus;
    const directives = this.extractFocusStyleItems(focusSection, 3);
    if (directives.length === 0) {
      return this.extractFirstDirective(focusSection);
    }
    return directives.join(this.containsChinese(focusSection) ? "；" : "; ");
  }

  private extractLocalOverrideGoal(currentFocus: string): string | undefined {
    const overrideSection = this.extractSection(currentFocus, [
      "local override",
      "explicit override",
      "chapter override",
      "local task override",
      "局部覆盖",
      "本章覆盖",
      "临时覆盖",
      "当前覆盖",
    ]);
    if (!overrideSection) {
      return undefined;
    }

    const directives = this.extractListItems(overrideSection, 3);
    if (directives.length > 0) {
      return directives.join(this.containsChinese(overrideSection) ? "；" : "; ");
    }

    return this.extractFirstDirective(overrideSection);
  }

  private extractFocusStyleItems(currentFocus: string, limit = 3): string[] {
    const focusSection = this.extractSection(currentFocus, [
      "active focus",
      "focus",
      "当前聚焦",
      "当前焦点",
      "近期聚焦",
    ]) ?? currentFocus;
    return this.extractListItems(focusSection, limit);
  }

  private renderHookBudget(activeCount: number, language: "zh" | "ko" | "en"): string {
    const cap = 12;
    if (activeCount < 10) {
      return language === "ko"
        ? `### 복선 예산\n- 활성 복선 ${activeCount}개 (한도: ${cap})`
        : language === "en"
          ? `### Hook Budget\n- ${activeCount} active hooks (capacity: ${cap})`
          : `### 伏笔预算\n- 当前 ${activeCount} 条活跃伏笔（容量：${cap}）`;
    }
    const remaining = Math.max(0, cap - activeCount);
    return language === "ko"
      ? `### 복선 예산\n- 활성 복선 ${activeCount}개로 한도(${cap})에 가깝습니다. 새 복선은 ${remaining}개만 허용됩니다. 새 복선을 열기보다 기존 복선을 먼저 회수하세요.`
      : language === "en"
        ? `### Hook Budget\n- ${activeCount} active hooks — approaching capacity (${cap}). Only ${remaining} new hook(s) allowed. Prioritize resolving existing debt over opening new threads.`
        : `### 伏笔预算\n- 当前 ${activeCount} 条活跃伏笔——接近容量上限（${cap}）。仅剩 ${remaining} 个新坑位。优先回收旧债，不要轻易开新线。`;
  }

  private extractSection(content: string, headings: ReadonlyArray<string>): string | undefined {
    const targets = headings.map((heading) => this.normalizeHeading(heading));
    const lines = content.split("\n");
    let buffer: string[] | null = null;
    let sectionLevel = 0;

    for (const line of lines) {
      const headingMatch = line.match(/^(#+)\s*(.+?)\s*$/);
      if (headingMatch) {
        const level = headingMatch[1]!.length;
        const heading = this.normalizeHeading(headingMatch[2]!);

        if (buffer && level <= sectionLevel) {
          break;
        }

        if (targets.includes(heading)) {
          buffer = [];
          sectionLevel = level;
          continue;
        }
      }

      if (buffer) {
        buffer.push(line);
      }
    }

    const section = buffer?.join("\n").trim();
    return section && section.length > 0 ? section : undefined;
  }

  private normalizeHeading(heading: string): string {
    return heading
      .toLowerCase()
      .replace(/[*_`:#]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private cleanListItem(line: string): string | undefined {
    const cleaned = line.replace(/^-\s*/, "").trim();
    if (cleaned.length === 0) return undefined;
    if (/^[-|]+$/.test(cleaned)) return undefined;
    if (this.isTemplatePlaceholder(cleaned)) return undefined;
    return cleaned;
  }

  private isTemplatePlaceholder(line: string): boolean {
    const normalized = line.trim();
    if (!normalized) return false;

    return (
      /^\((describe|briefly describe|write)\b[\s\S]*\)$/i.test(normalized)
      || /^（(?:在这里描述|描述|填写|写下)[\s\S]*）$/u.test(normalized)
    );
  }

  private containsChinese(content: string): boolean {
    return /[\u4e00-\u9fff]/.test(content);
  }

  private findOutlineNode(volumeOutline: string, chapterNumber: number): string | undefined {
    const lines = volumeOutline.split("\n").map((line) => line.trim()).filter(Boolean);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const match = this.matchExactOutlineLine(line, chapterNumber);
      if (!match) continue;

      const inlineContent = this.cleanOutlineContent(match[1]);
      if (inlineContent) {
        return inlineContent;
      }

      const nextContent = this.findNextOutlineContent(lines, index + 1);
      if (nextContent) {
        return nextContent;
      }
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const match = this.matchRangeOutlineLine(line, chapterNumber);
      if (!match) continue;

      const inlineContent = this.cleanOutlineContent(match[3]);
      if (inlineContent) {
        return inlineContent;
      }

      const rangeStart = Number(match[1]);
      const sectionContent = this.extractSectionAroundRange(lines, index);
      if (sectionContent) {
        const beatIndex = chapterNumber - rangeStart;
        const specificBeat = this.extractNumberedBeat(sectionContent, beatIndex);
        return specificBeat ?? sectionContent;
      }

      const nextContent = this.findNextOutlineContent(lines, index + 1);
      if (nextContent) {
        return nextContent;
      }
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!this.isOutlineAnchorLine(line)) continue;

      const exactMatch = this.matchAnyExactOutlineLine(line);
      if (exactMatch) {
        const inlineContent = this.cleanOutlineContent(exactMatch[1]);
        if (inlineContent) {
          return inlineContent;
        }
      }

      const rangeMatch = this.matchAnyRangeOutlineLine(line);
      if (rangeMatch) {
        const inlineContent = this.cleanOutlineContent(rangeMatch[3]);
        if (inlineContent) {
          return inlineContent;
        }
      }

      const nextContent = this.findNextOutlineContent(lines, index + 1);
      if (nextContent) {
        return nextContent;
      }

      break;
    }

    return this.extractFirstDirective(volumeOutline);
  }

  private cleanOutlineContent(content?: string): string | undefined {
    const cleaned = content?.trim();
    if (!cleaned) return undefined;
    if (/^[*_`~:：-]+$/.test(cleaned)) return undefined;
    return cleaned;
  }

  private extractSectionAroundRange(lines: ReadonlyArray<string>, rangeLineIndex: number): string | undefined {
    let headingIndex = -1;
    for (let i = rangeLineIndex - 1; i >= 0; i--) {
      if (lines[i]!.startsWith("#")) {
        headingIndex = i;
        break;
      }
      if (this.matchAnyRangeOutlineLine(lines[i]!) || this.matchAnyExactOutlineLine(lines[i]!)) {
        break;
      }
    }

    if (headingIndex < 0) {
      return undefined;
    }

    const headingLine = lines[headingIndex]!;
    const headingLevel = headingLine.match(/^(#+)/)?.[1]?.length ?? 3;

    const sectionLines: string[] = [];
    for (let i = headingIndex; i < lines.length; i++) {
      if (i > headingIndex) {
        const nextHeadingMatch = lines[i]!.match(/^(#+)/);
        if (nextHeadingMatch && (nextHeadingMatch[1]?.length ?? 0) <= headingLevel) {
          break;
        }
      }
      sectionLines.push(lines[i]!);
    }

    const content = sectionLines.join("\n").trim();
    return content.length > 0 ? content : undefined;
  }

  private extractNumberedBeat(section: string, beatIndex: number): string | undefined {
    if (beatIndex < 0) return undefined;

    const beats: string[] = [];
    for (const line of section.split("\n")) {
      const trimmed = line.trim();
      if (/^\d+[.)]\s/.test(trimmed)) {
        beats.push(trimmed.replace(/^\d+[.)]\s*/, ""));
      }
    }

    if (beats.length === 0 || beatIndex >= beats.length) return undefined;
    return beats[beatIndex];
  }

  private findNextOutlineContent(lines: ReadonlyArray<string>, startIndex: number): string | undefined {
    for (let index = startIndex; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line) {
        continue;
      }

      if (this.isOutlineAnchorLine(line)) {
        return undefined;
      }

      if (line.startsWith("#")) {
        continue;
      }

      const cleaned = this.cleanOutlineContent(line);
      if (cleaned) {
        return cleaned;
      }
    }

    return undefined;
  }

  private matchExactOutlineLine(line: string, chapterNumber: number): RegExpMatchArray | undefined {
    const patterns = [
      new RegExp(`^(?:#+\\s*)?(?:[-*]\\s+)?(?:\\*\\*)?Chapter\\s*${chapterNumber}(?!\\d|\\s*[-~–—]\\s*\\d)(?:[:：-])?(?:\\*\\*)?\\s*(.*)$`, "i"),
      new RegExp(`^(?:#+\\s*)?(?:[-*]\\s+)?(?:\\*\\*)?第\\s*${chapterNumber}\\s*章(?!\\d|\\s*[-~–—]\\s*\\d)(?:[:：-])?(?:\\*\\*)?\\s*(.*)$`),
    ];

    return patterns
      .map((pattern) => line.match(pattern))
      .find((result): result is RegExpMatchArray => Boolean(result));
  }

  private matchAnyExactOutlineLine(line: string): RegExpMatchArray | undefined {
    const patterns = [
      /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?Chapter\s*\d+(?!\s*[-~–—]\s*\d)(?:[:：-])?(?:\*\*)?\s*(.*)$/i,
      /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?第\s*\d+\s*章(?!\s*[-~–—]\s*\d)(?:[:：-])?(?:\*\*)?\s*(.*)$/i,
    ];

    return patterns
      .map((pattern) => line.match(pattern))
      .find((result): result is RegExpMatchArray => Boolean(result));
  }

  private matchRangeOutlineLine(line: string, chapterNumber: number): RegExpMatchArray | undefined {
    const match = this.matchAnyRangeOutlineLine(line);
    if (!match) return undefined;
    if (this.isChapterWithinRange(match[1], match[2], chapterNumber)) {
      return match;
    }

    return undefined;
  }

  private matchAnyRangeOutlineLine(line: string): RegExpMatchArray | undefined {
    const patterns = [
      /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?Chapter\s*(\d+)\s*[-~–—]\s*(\d+)\b(?:[:：-])?(?:\*\*)?\s*(.*)$/i,
      /^(?:#+\s*)?(?:[-*]\s+)?(?:\*\*)?第\s*(\d+)\s*[-~–—]\s*(\d+)\s*章(?:[:：-])?(?:\*\*)?\s*(.*)$/i,
      /^(?:[-*]\s+)?(?:\*\*)?章节范围(?:\*\*)?[：:]\s*(\d+)\s*[-~–—]\s*(\d+)\s*章\s*(.*)$/,
      /^(?:[-*]\s+)?(?:\*\*)?Chapter\s*[Rr]ange(?:\*\*)?[：:]\s*(\d+)\s*[-~–—]\s*(\d+)\b\s*(.*)$/i,
    ];

    return patterns
      .map((pattern) => line.match(pattern))
      .find((result): result is RegExpMatchArray => Boolean(result));
  }

  private isOutlineAnchorLine(line: string): boolean {
    return this.matchAnyExactOutlineLine(line) !== undefined
      || this.matchAnyRangeOutlineLine(line) !== undefined;
  }

  private isChapterWithinRange(startText: string | undefined, endText: string | undefined, chapterNumber: number): boolean {
    const start = Number.parseInt(startText ?? "", 10);
    const end = Number.parseInt(endText ?? "", 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    const lower = Math.min(start, end);
    const upper = Math.max(start, end);
    return chapterNumber >= lower && chapterNumber <= upper;
  }

  private renderIntentMarkdown(
    intent: ChapterIntent,
    memo: ChapterMemo,
    language: "zh" | "ko" | "en",
    pendingHooks: string,
    chapterSummaries: string,
    activeHookCount: number,
  ): string {
    const label = (zh: string, ko: string, en: string) => language === "ko" ? ko : language === "en" ? en : zh;
    const empty = language === "ko" ? "없음" : language === "en" ? "none" : "无";
    const renderIntentList = (items: ReadonlyArray<string>) => items.length > 0
      ? items.map((item) => `- ${item}`).join("\n")
      : `- ${empty}`;
    const mustKeep = intent.mustKeep.length > 0
      ? intent.mustKeep.map((item) => `- ${item}`).join("\n")
      : `- ${empty}`;

    const mustAvoid = intent.mustAvoid.length > 0
      ? intent.mustAvoid.map((item) => `- ${item}`).join("\n")
      : `- ${empty}`;

    const styleEmphasis = intent.styleEmphasis.length > 0
      ? intent.styleEmphasis.map((item) => `- ${item}`).join("\n")
      : `- ${empty}`;

    const routedFutureAdvantage = intent.futureAdvantageMoveIds
      ? [
          "",
          `## ${label("未来先机 move", "미래 선점 move", "Future Advantage Moves")}`,
          renderIntentList(intent.futureAdvantageMoveIds),
          "",
          `## ${label("研究 claim", "리서치 claim", "Research Claims")}`,
          renderIntentList(intent.researchClaimIds ?? []),
          "",
          `## ${label("允许的历史分歧", "허용된 역사 분기", "Authorized Divergences")}`,
          renderIntentList(intent.authorizedDivergences ?? []),
        ]
      : [];

    const memoBody = memo.body.trim();
    const threadRefsLine = memo.threadRefs.length > 0
      ? memo.threadRefs.map((id) => `- ${id}`).join("\n")
      : `- (${empty})`;

    return [
      `# ${label("Chapter Intent", "회차 의도", "Chapter Intent")}`,
      "",
      `## ${label("Goal", "목표", "Goal")}`,
      intent.goal,
      "",
      `## ${label("Outline Node", "개요 노드", "Outline Node")}`,
      intent.outlineNode ?? `(${label("not found", "찾지 못함", "not found")})`,
      "",
      `## ${label("Arc Context", "이야기 흐름 맥락", "Arc Context")}`,
      intent.arcContext ?? `(${empty})`,
      "",
      `## ${label("Must Keep", "반드시 유지", "Must Keep")}`,
      mustKeep,
      "",
      `## ${label("Must Avoid", "반드시 회피", "Must Avoid")}`,
      mustAvoid,
      "",
      `## ${label("Style Emphasis", "문체 강조점", "Style Emphasis")}`,
      styleEmphasis,
      ...routedFutureAdvantage,
      "",
      `## ${label("Chapter Memo", "회차 메모", "Chapter Memo")}`,
      `- ${label("isGoldenOpening", "골든 오프닝", "isGoldenOpening")}: ${memo.isGoldenOpening ? "true" : "false"}`,
      "",
      `### ${label("Thread Refs", "연결 복선", "Thread Refs")}`,
      threadRefsLine,
      "",
      `### ${label("Body", "본문", "Body")}`,
      memoBody,
      "",
      this.renderHookBudget(activeHookCount, language),
      "",
      `## ${label("Pending Hooks Snapshot", "미회수 복선 스냅샷", "Pending Hooks Snapshot")}`,
      pendingHooks,
      "",
      `## ${label("Chapter Summaries Snapshot", "회차 요약 스냅샷", "Chapter Summaries Snapshot")}`,
      chapterSummaries,
      "",
    ].join("\n");
  }

  private unique(values: ReadonlyArray<string>): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  }

  private isChineseLanguage(language: string | undefined): boolean {
    return (language ?? "zh").toLowerCase().startsWith("zh");
  }

  // Kept for potential subclasses reading seed files directly.
  protected async readFileOrDefault(path: string): Promise<string> {
    try {
      return await readFile(path, "utf-8");
    } catch {
      return "(文件尚未创建)";
    }
  }
}
