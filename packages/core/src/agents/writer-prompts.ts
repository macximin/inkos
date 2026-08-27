import type { BookConfig, FanficMode } from "../models/book.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { BookRules } from "../models/book-rules.js";
import type { LengthSpec } from "../models/length-governance.js";
import { buildFanficCanonSection, buildCharacterVoiceProfiles, buildFanficModeInstructions } from "./fanfic-prompt-sections.js";
import { buildEnglishCoreRules, buildEnglishAntiAIRules, buildEnglishCharacterMethod, buildEnglishPreWriteChecklist, buildEnglishGenreIntro } from "./en-prompt-sections.js";
import { buildLengthSpec } from "../utils/length-metrics.js";

export interface FanficContext {
  readonly fanficCanon: string;
  readonly fanficMode: FanficMode;
  readonly allowedDeviations: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildWriterSystemPrompt(
  book: BookConfig,
  genreProfile: GenreProfile,
  bookRules: BookRules | null,
  bookRulesGuidance: string,
  genreBody: string,
  styleGuide: string,
  styleFingerprint?: string,
  chapterNumber?: number,
  mode: "full" | "creative" = "full",
  fanficContext?: FanficContext,
  languageOverride?: "zh" | "ko" | "en",
  inputProfile: "legacy" | "governed" = "legacy",
  lengthSpec?: LengthSpec,
): string {
  const resolvedLanguage = languageOverride ?? genreProfile.language;
  const governed = inputProfile === "governed";
  const resolvedLengthSpec = lengthSpec ?? buildLengthSpec(book.chapterWordCount, resolvedLanguage);

  if (resolvedLanguage === "ko") {
    return buildKoreanWriterSystemPrompt(
      book,
      genreProfile,
      bookRules,
      bookRulesGuidance,
      genreBody,
      styleGuide,
      styleFingerprint,
      chapterNumber,
      mode,
      fanficContext,
      governed,
      resolvedLengthSpec,
    );
  }

  const usesEnglishControl = resolvedLanguage !== "zh";

  const outputSection = usesEnglishControl
    ? (mode === "creative"
        ? buildEnglishCreativeOutputFormat(book, genreProfile, resolvedLengthSpec)
        : buildEnglishOutputFormat(book, genreProfile, resolvedLengthSpec))
    : (mode === "creative"
        ? buildCreativeOutputFormat(book, genreProfile, resolvedLengthSpec)
        : buildOutputFormat(book, genreProfile, resolvedLengthSpec));

  const sections = usesEnglishControl
    ? [
        buildEnglishGenreIntro(book, genreProfile),
        buildEnglishCoreRules(book),
        buildGovernedInputContract("en", governed),
        buildChapterMemoContract("en", governed),
        buildLengthGuidance(resolvedLengthSpec, resolvedLanguage),
        buildWritingCraftCard("en"),
        buildProseExecutionRules("en"),
        buildCreativeConstitution("en"),
        buildImmersionPillars("en"),
        buildGoldenOpeningDiscipline(chapterNumber, "en"),
        buildGenreRules(genreProfile, genreBody, resolvedLanguage),
        buildProtagonistRules(bookRules, "en"),
        buildNarrativePersonRule(bookRules, "en"),
        buildBookRulesGuidance(bookRulesGuidance),
        buildStyleGuide(styleGuide),
        buildStyleFingerprint(styleFingerprint),
        fanficContext ? buildFanficCanonSection(fanficContext.fanficCanon, fanficContext.fanficMode) : "",
        fanficContext ? buildCharacterVoiceProfiles(fanficContext.fanficCanon) : "",
        fanficContext ? buildFanficModeInstructions(fanficContext.fanficMode, fanficContext.allowedDeviations) : "",
        // Pre-write checklist moved to style_guide.md (v10)
        outputSection,
      ]
    : [
        buildGenreIntro(book, genreProfile),
        buildCoreRules(resolvedLengthSpec),
        buildGovernedInputContract("zh", governed),
        buildChapterMemoContract("zh", governed),
        buildLengthGuidance(resolvedLengthSpec, "zh"),
        buildWritingCraftCard("zh"),
        buildProseExecutionRules("zh"),
        buildCreativeConstitution("zh"),
        buildImmersionPillars("zh"),
        buildGoldenOpeningDiscipline(chapterNumber, "zh"),
        buildGoldenChaptersRules(chapterNumber, "zh"),
        bookRules?.enableFullCastTracking ? buildFullCastTracking() : "",
        buildGenreRules(genreProfile, genreBody, "zh"),
        buildProtagonistRules(bookRules, "zh"),
        buildNarrativePersonRule(bookRules, "zh"),
        buildBookRulesGuidance(bookRulesGuidance),
        buildStyleGuide(styleGuide),
        buildStyleFingerprint(styleFingerprint),
        fanficContext ? buildFanficCanonSection(fanficContext.fanficCanon, fanficContext.fanficMode) : "",
        fanficContext ? buildCharacterVoiceProfiles(fanficContext.fanficCanon) : "",
        fanficContext ? buildFanficModeInstructions(fanficContext.fanficMode, fanficContext.allowedDeviations) : "",
        // Pre-write checklist moved to style_guide.md (v10)
        outputSection,
      ];

  return sections.filter(Boolean).join("\n\n");
}

function buildKoreanWriterSystemPrompt(
  book: BookConfig,
  gp: GenreProfile,
  bookRules: BookRules | null,
  bookRulesGuidance: string,
  genreBody: string,
  styleGuide: string,
  styleFingerprint: string | undefined,
  chapterNumber: number | undefined,
  mode: "full" | "creative",
  fanficContext: FanficContext | undefined,
  governed: boolean,
  lengthSpec: LengthSpec,
): string {
  const openingRule = chapterNumber && chapterNumber <= 3
    ? `## 첫 3화 집필 규칙

지금은 ${chapterNumber}화입니다. ${chapterNumber === 1
      ? "첫 의미 있는 장면에서 핵심 갈등과 주인공의 선택을 알아볼 수 있게 보여 주세요. 정확한 글자 위치에 반전 문장을 끼워 맞출 필요는 없습니다."
      : chapterNumber === 2
        ? "주인공의 우위를 설명하지 말고 구체적인 사건 하나로 증명한 뒤 작은 보상을 지급하세요."
        : "앞으로 3-10화를 끌 단기 목표와 그 목표를 막을 상대를 장면 안에서 고정하세요."}
설정 설명보다 인물의 행동을 먼저 보여 주세요. 화말에는 이번 화가 약속한 결과를 먼저 보여 주고, 그 결과에서 자연스럽게 다음 선택이나 압력이 생기게 하세요. 억지로 결과를 감추지 않습니다.`
    : "";
  const governance = governed
    ? `## 입력과 정본

- 이번 화의 직접 지시는 chapter intent와 chapter_memo를 따릅니다.
- 권별 개요는 기본 계획이며, 이미 벌어진 회차와 충돌하면 실제 회차를 우선합니다.
- 세계 규칙, 연속성 사실, 사용자가 정한 금지는 반드시 지킵니다.
- 복선 목록은 증거이지 장면 할당량이 아닙니다. chapter_memo가 이번 화 advance/resolve 또는 완전 지급 대상으로 고른 항목만 장면 의무이며, defer 항목과 단순히 오래 묵었다는 이유만으로는 본문 의무가 생기지 않습니다. 새 복선도 memo가 명시할 때만 엽니다.
- 여러 인물이 나오는 장면에는 이해관계가 부딪히는 대화나 행동을 최소 한 번 넣습니다.`
    : "";
  const genreRules = [
    `## 작품과 장르\n\n- 작품: ${book.title}\n- 장르: ${book.genre}\n- 연재처: ${book.platform}`,
    gp.pacingRule ? `- 장르 리듬 참고(통과 할당량 아님): ${gp.pacingRule}` : "",
    gp.chapterTypes.length > 0 ? `- 가능한 회차 유형: ${gp.chapterTypes.join(" / ")}` : "",
    gp.satisfactionTypes.length > 0 ? `- 이번 화에 자연스럽게 맞을 때 고를 수 있는 장르 보상 후보: ${gp.satisfactionTypes.join(" / ")}. 목록을 채우기 위해 억지로 넣지는 않습니다.` : "",
    gp.fatigueWords.length > 0 ? `- 피로도가 높은 말은 장면에 꼭 맞을 때만 쓰고 반복하지 않습니다: ${gp.fatigueWords.join(", ")}` : "",
    genreBody,
  ].filter(Boolean).join("\n");
  const protagonistRules = buildKoreanProtagonistRules(bookRules);
  const narrativeRule = !bookRules?.narrativePerson
    ? ""
    : bookRules.narrativePerson === "first"
      ? "## 서술 시점 참고(자동 하드 규칙 아님)\n\nBookRules에는 1인칭 참고값이 있습니다. 장면의 시점을 고를 때 우선 참고하되, 검증된 작품 규칙이나 사용자 직접 지시가 아니므로 그 자체를 자동 오류 판정 근거로 쓰지 않습니다."
      : "## 서술 시점 참고(자동 하드 규칙 아님)\n\nBookRules에는 3인칭 참고값이 있습니다. 장면의 시점을 고를 때 우선 참고하되, 검증된 작품 규칙이나 사용자 직접 지시가 아니므로 그 자체를 자동 오류 판정 근거로 쓰지 않습니다.";
  const referenceRules = fanficContext
    ? `## 원작 정본과 허용 범위

${fanficContext.fanficCanon}

- 작업 방식: ${fanficContext.fanficMode}
- 허용된 변경: ${fanficContext.allowedDeviations.length > 0 ? fanficContext.allowedDeviations.join(", ") : "없음"}
- 원작 사실과 인물의 말투를 지키되, 원작 문장을 베껴 붙이지 않습니다.`
    : "";
  const localRules = bookRulesGuidance
    ? `## 검증된 작품 규칙 안내\n\n${bookRulesGuidance}`
    : "";
  const localStyle = styleGuide && styleGuide !== "(파일尚未创建)" && styleGuide !== "(文件尚未创建)"
    ? `## 문체 지침\n\n${styleGuide}`
    : "";
  const fingerprint = styleFingerprint
    ? `## 참고 문체의 특징\n\n${styleFingerprint}\n\n문장 호흡, 문단 밀도, 대화 간격과 실제 표면 예문을 적극 활용합니다. 원작과의 거리는 품질 기준이 아니며, 출력 표면의 채택 또는 polishing은 이후 사람 검토에서 결정합니다.`
    : "";
  const funAnchorRule = governed
    ? "- chapter_memo의 '독자가 지금 기다리는 것'에 적힌 재미 앵커를 이번 화의 가장 강한 장면으로 구현합니다. 메모 문구를 되풀이하지 말고 선택, 대응, 반전, 지급 결과로 보여 줍니다."
    : "- 직전 회차가 만든 구체적 약속과 현재 목표 가운데 가장 가까운 재미 앵커 하나를 이번 화의 강한 장면으로 구현합니다. 선택, 대응, 반전, 지급 결과로 보여 줍니다.";

  return [
    `당신은 한국 장르소설 작가입니다. 「${book.title}」의 다음 회차를 처음부터 한국어로 씁니다.`,
    `## 한국어 원고 출력 규칙

- 목표 분량은 공백을 포함한 ${lengthSpec.target}자, 허용 범위는 ${lengthSpec.softMin}-${lengthSpec.softMax}자입니다.
- 자연스러운 한국어 어순과 호흡을 씁니다. 외국어 문장을 한국어 단어로 바꾼 듯한 표현을 만들지 않습니다.
- 사람과 조직이 행동하게 씁니다. 신뢰, 관계, 구조, 승부 같은 추상 명사가 스스로 움직이게 하지 않습니다.
- 'A가 아니라 B', '단순한 X를 넘어 Y', 같은 길이의 세 항목 나열을 습관처럼 반복하지 않습니다.
- 정확한 동사, 구체적인 행동과 감각, 직접 묘사 순으로 고릅니다. 비유는 장면당 한 번 이하로 줄입니다.
- 인공지능식 총평, 장면 뒤의 의미 해설, 독자가 이미 본 감정의 재설명을 붙이지 않습니다.`,
    governance,
    `## 재미와 장면

${funAnchorRule}
- 이번 화의 중심 행동을 하나 정하고 끝까지 수행합니다. 주인공의 행동, 상대의 대응, 독자가 확인할 결과까지 원인과 결과로 잇습니다. 다음 선택이나 압력은 그 결과에서 자연스럽게 생길 때만 붙이고, 완전 수습이면 온전히 닫습니다.
- 돈, 지분, 자리, 정보, 평판, 관계 중 무엇이 바뀌었는지 장면에서 확인시킵니다.
- 상대는 가진 정보와 이해관계 안에서 최선으로 대응합니다. 주인공을 돋보이게 하려고 무능해지지 않습니다.
- 중요한 충돌, 반전, 지급 장면은 요약하지 말고 행동과 대화, 감각, 침묵까지 현장에서 보여 줍니다. 분량이 부족하면 사건 수를 줄입니다.
- 인물은 아는 것만 판단합니다. 시점 인물이 모르는 사실을 서술자가 몰래 알려 주지 않습니다.
- 일상과 전환 장면도 정보, 관계, 선택, 보상 가운데 하나를 실제로 바꿔야 합니다.
- 화말에는 정보, 관계, 물리적 상태, 권력 중 적어도 하나가 달라져야 합니다.`,
    openingRule,
    genreRules,
    protagonistRules,
    narrativeRule,
    localRules,
    localStyle,
    fingerprint,
    referenceRules,
    buildKoreanWriterOutputFormat(gp, lengthSpec, mode),
  ].filter(Boolean).join("\n\n");
}

function buildKoreanProtagonistRules(bookRules: BookRules | null): string {
  if (!bookRules?.protagonist && (bookRules?.prohibitions.length ?? 0) === 0) return "";
  const lines = ["## 인물 참고와 검증된 금지 사항"];
  if (bookRules?.protagonist) {
    lines.push(`- 주인공: ${bookRules.protagonist.name}`);
    if (bookRules.protagonist.personalityLock.length > 0) {
      lines.push(`- 성격 참고(인물 형상화용, 자동 금지 아님): ${bookRules.protagonist.personalityLock.join(", ")}`);
    }
    for (const rule of bookRules.protagonist.behavioralConstraints) lines.push(`- 검증된 행동 제약: ${rule}`);
  }
  for (const rule of bookRules?.prohibitions ?? []) lines.push(`- 금지: ${rule}`);
  for (const rule of bookRules?.genreLock?.forbidden ?? []) lines.push(`- 장르 금지: ${rule}`);
  return lines.join("\n");
}

function buildKoreanWriterOutputFormat(gp: GenreProfile, lengthSpec: LengthSpec, mode: "full" | "creative"): string {
  const resourceRows = gp.numericalSystem
    ? "| 현재 자원 | 기초 X / 증감 Y / 결과 Z | 장부와 맞출 것 |\n"
    : "";
  const base = `## 출력 형식

아래 표식은 기계가 읽으므로 영문 그대로 유지합니다. JSON이나 코드 블록으로 감싸지 않습니다.

=== PRE_WRITE_CHECK ===
| 점검 | 이번 화 기록 | 비고 |
| --- | --- | --- |
| 현재 작업 | chapter_memo의 행동과 실행 방식 | 추상 표현 금지 |
| 독자가 기다리는 것 | 지급, 지연, 확대 중 하나 | 메모와 일치 |
| 지급할 것과 감출 것 | 회수할 복선과 남길 패 | 실제 hook_id |
| 전환 장면의 기능 | 장면별 기능 | 없으면 없음 |
| 화말 변화 | 실제로 바뀔 1-3개 | 장면에 남길 것 |
| 금지 | 메모의 금지 목록 | 원고에서 위반 금지 |
| 현재 닻 | 장소 / 상대 / 보상 목표 | 구체적으로 |
${resourceRows}| 회수 대상 | 실제 hook_id, 없으면 none | 복선 목록과 일치 |
| 핵심 충돌 | 한 문장 | |
| 회차 유형 | ${gp.chapterTypes.length > 0 ? gp.chapterTypes.join(" / ") : "전환 / 충돌 / 고조 / 수습"} | |
| 위험 점검 | 인물 붕괴 / 정보 월경 / 설정 충돌 / 리듬 / 상투어 | |

=== CHAPTER_TITLE ===
(회차 번호를 빼고 제목만. 최근 제목과 같은 낱말이나 이미지를 되풀이하지 않습니다.)

=== CHAPTER_CONTENT ===
(한국어 원고. 공백 포함 ${lengthSpec.target}자, 허용 범위 ${lengthSpec.softMin}-${lengthSpec.softMax}자.)`;

  if (mode === "creative") {
    return `${base}\n\nPRE_WRITE_CHECK, CHAPTER_TITLE, CHAPTER_CONTENT 세 구역만 출력합니다. 상태와 복선 결산은 뒤 단계가 처리합니다.`;
  }

  return `${base}

=== POST_SETTLEMENT ===
| 결산 항목 | 이번 화 변화 | 근거 |
| --- | --- | --- |
| 복선 변화 | 새로 엶 / 진전 / 회수 / 미룸 | 실제 hook_id |

=== UPDATED_STATE ===
(갱신된 전체 상태표)

=== UPDATED_HOOKS ===
(갱신된 전체 복선표)

=== CHAPTER_SUMMARY ===
| 회차 | 제목 | 등장인물 | 핵심 사건 | 상태 변화 | 복선 변화 | 정서 | 회차 유형 |
| --- | --- | --- | --- | --- | --- | --- | --- |

=== UPDATED_SUBPLOTS ===
(갱신된 전체 보조 줄기 표)

=== UPDATED_EMOTIONAL_ARCS ===
(갱신된 전체 감정선 표)

=== UPDATED_CHARACTER_MATRIX ===
(인물별 갱신 내용)`;
}

// ---------------------------------------------------------------------------
// Genre intro
// ---------------------------------------------------------------------------

function buildGenreIntro(book: BookConfig, gp: GenreProfile): string {
  return `你是一位专业的${gp.name}网络小说作家。你为${book.platform}平台写作。`;
}

function buildGovernedInputContract(language: "zh" | "ko" | "en", governed: boolean): string {
  if (!governed) return "";

  if (language === "en") {
    return `## Input Governance Contract

- Chapter-specific steering comes from the provided chapter intent and composed context package.
- The outline is the default plan, not unconditional global supremacy.
- When the runtime rule stack records an active L4 -> L3 override, follow the current task over local planning.
- Keep hard guardrails compact: canon, continuity facts, and explicit prohibitions still win.
- If an English Variance Brief is provided, obey it: avoid the listed phrase/opening/ending patterns and satisfy the scene obligation.
- Hook Debt Briefs are evidence, not scene quotas. Use their original seed text only for hooks that chapter_memo explicitly selects under advance/resolve or marks as fully due this chapter, and make that selected continuation or payoff recognizably connected to what the reader saw.
- Entries under defer need no prose. Age or stale status alone never creates a scene obligation; it may inform planning for a later chapter.
- Open a new hook only when chapter_memo explicitly lists it, and place it where it grows naturally rather than forcing it at the ending.
- In multi-character scenes, include at least one resistance-bearing exchange instead of reducing the beat to summary or explanation.`;
  }

  return `## 输入治理契约

- 本章具体写什么，以提供给你的 chapter intent 和 composed context package 为准。
- 卷纲是默认规划，不是全局最高规则。
- 当 runtime rule stack 明确记录了 L4 -> L3 的 active override 时，优先执行当前任务意图，再局部调整规划层。
- 真正不能突破的只有硬护栏：世界设定、连续性事实、显式禁令。
- 如果提供了 English Variance Brief，必须主动避开其中列出的高频短语、重复开头和重复结尾模式，并完成 scene obligation。
- Hook Debt 简报是证据，不是场景配额。只有 chapter_memo 明确列在 advance/resolve 或写明本章完整兑现的条目，才使用原始种子文本写出读者能认出的延续或兑现。
- defer 条目不需要落进正文；仅仅放久了或被标成 stale，不会自动变成本章场景义务，只作为后续规划参考。
- 只有 chapter_memo 明确列出 open 时才开新钩子，并放在自然生长的位置，不强塞到章末。
- 多角色场景里，至少给出一轮带阻力的直接交锋，不要把人物关系写成纯解释或纯总结。`;
}

// ---------------------------------------------------------------------------
// Chapter memo alignment — 7 sections from mobile web-fiction craft methodology
// ---------------------------------------------------------------------------

function buildChapterMemoContract(language: "zh" | "ko" | "en", governed: boolean): string {
  if (!governed) return "";

  if (language === "en") {
    return `## Chapter Memo Alignment

You will receive a chapter_memo composed of 7 markdown sections:

- ## Current task → the concrete action this chapter must complete; stay aligned with it throughout
- ## What the reader is waiting for right now → names the nearest concrete promise and whether this chapter satisfies, deepens, or causally carries it forward
- ## To pay off / to keep buried → payoffs that must land this chapter + cards you must NOT reveal
- ## What the slow / transitional beats carry → function map for non-conflict passages ([passage location] → [function])
- ## Three-question check on the key choice → three-question check every key character choice must pass
- ## Required end-of-chapter change → 1-3 concrete changes the ending must deliver (info / relation / physical / power)
- ## Hook ledger for this chapter → **hard correspondence rule**: each hook_id explicitly listed under advance/resolve MUST have a **concretely locatable payoff scene** in the prose — explicit characters acting on or talking about a specific object/event/piece of information, with observable actions. No "sideways hints" or "deferred to next chapter". Example: if the memo says 'advance: H007 Huzi's IOU → planted → pressured', the prose must contain a scene where Lin Qiu actually touches / sees / picks up that specific IOU and does something. An inner mention like "he remembered the IOU was still in the drawer" does NOT count. Give the scene the space its dramatic weight needs; there is no fixed character quota. Entries under defer need no prose. Open a new hook only when the memo explicitly lists it, and place it where it grows naturally rather than forcing it at the chapter end
- ## Do not → hard prohibitions for this chapter

Treat the memo as a steering contract, not a checklist. Preserve the core task, any payoff explicitly due in full this chapter, hard prohibitions, and any required ending state whose absence would break the promised result or causality. The three-question rationale and transition-function map are planning aids: they do not require a literal one-to-one trace in the prose. A different scene implementation is valid when it delivers the same reader promise and result. **After the first draft, self-check the hook ledger**: list each hook_id from advance/resolve and point each one to a specific prose span containing action / object / dialogue. If you cannot point to one, go back and add it; do not submit a draft where the ledger lives in the memo but nowhere in the prose — review will flag the missing payoff and ask for a concrete scene.`;
  }

  return `## 章节备忘对齐

你将收到本章的 chapter_memo，由 7 段 markdown 组成：

- ## 当前任务 → 本章必须完成的具体动作，写作时始终对齐这条
- ## 读者此刻在等什么 → 写清离读者最近的具体承诺，以及本章是兑现、加深，还是有因果地继续承接
- ## 该兑现的 / 暂不掀的 → 本章必须兑现的伏笔清单 + 必须压住不掀的底牌
- ## 日常/过渡承担什么任务 → 非冲突段落的功能映射（[段落位置] → [承担功能]）
- ## 关键抉择过三连问 → 关键人物选择必须过的检查
- ## 章尾必须发生的改变 → 结尾落地的 1-3 条具体改变（信息/关系/物理/权力）
- ## 本章 hook 账 → **硬对应规则**：advance/resolve 下面明确列出的每一个 hook_id 都必须在正文里有一个**具体可定位的兑现段**——写明人物对着什么物件/事件/信息做出什么可观察的动作或交谈。不允许"侧面暗示""留给下章"。举例：memo 写 'advance: H007 胖虎借条 → planted → pressured'，正文里必须出现一段林秋真的伸手摸到/看到/拿起那张胖虎借条并做出动作的场景；不能只写"他想起借条还在抽屉里"这种内心提及。段落长度服从戏剧重量，不设固定字数。defer 下的不用落；只有 memo 明确列出 open 时才开新钩子，并放在自然生长的位置，不强塞到章末
- ## 不要做 → 硬约束红线

把 memo 当作方向契约，不是逐项打勾的清单。必须守住本章核心任务、明确写着本章完整兑现的承诺、硬禁令，以及一旦缺失就会破坏既定结果或因果的章尾状态。关键抉择三连问和日常/过渡功能图是规划辅助，不要求在正文里逐条留下字面痕迹；只要用另一种有效场景实现同一个读者承诺与结果，也算成立。**写完初稿后自检一遍 hook 账**：把 advance 和 resolve 的 hook_id 列下来，对照正文，确认每一个都能指到一段带具体动作/物件/对话的 prose。如果指不到，回去补写；不要提交"账本在 memo 里、正文里没落"的稿子——审稿会标记缺口并要求补出具体场景。`;
}

function buildLengthGuidance(lengthSpec: LengthSpec, language: "zh" | "ko" | "en"): string {
  if (language === "ko") {
    return `## 분량 기준

- 목표 분량: ${lengthSpec.target}자(공백 포함)
- 허용 범위: ${lengthSpec.softMin}-${lengthSpec.softMax}자
- 절대 범위: ${lengthSpec.hardMin}-${lengthSpec.hardMax}자`;
  }
  if (language === "en") {
    return `## Length Guidance

- Target length: ${lengthSpec.target} words
- Acceptable range: ${lengthSpec.softMin}-${lengthSpec.softMax} words
- Hard range: ${lengthSpec.hardMin}-${lengthSpec.hardMax} words`;
  }

  return `## 字数治理

- 目标字数：${lengthSpec.target}字
- 允许区间：${lengthSpec.softMin}-${lengthSpec.softMax}字
- 硬区间：${lengthSpec.hardMin}-${lengthSpec.hardMax}字`;
}

// ---------------------------------------------------------------------------
// Core rules (~25 universal rules)
// ---------------------------------------------------------------------------

function buildCoreRules(lengthSpec: LengthSpec): string {
  return `## 核心规则

1. 以简体中文工作，句子长短交替，段落适合手机阅读（3-5行/段）
2. 目标字数：${lengthSpec.target}字，允许区间：${lengthSpec.softMin}-${lengthSpec.softMax}字
3. 伏笔前后呼应，不留悬空线；所有埋下的伏笔都必须在后续收回
4. 只读必要上下文，不机械重复已有内容

## 人物塑造铁律

- 人设一致性：角色行为必须由"过往经历 + 当前利益 + 性格底色"共同驱动，永不无故崩塌
- 人物立体化：核心标签 + 反差细节 = 活人；十全十美的人设是失败的
- 拒绝工具人：配角必须有独立动机和反击能力；主角的强大在于压服聪明人，而不是碾压傻子
- 角色区分度：不同角色的说话语气、发怒方式、处事模式必须有显著差异
- 情感/动机逻辑链：任何关系的改变（结盟、背叛、从属）都必须有铺垫和事件驱动

## 叙事技法

- Show, don't tell：用细节堆砌真实，用行动证明强大；角色的野心和价值观内化于行为，不通过口号喊出来
- 五感代入法：场景描写中加入1-2种五感细节（视觉、听觉、嗅觉、触觉），增强画面感
- 章尾推进：先让本章行动产生看得见的结果、选择或压力。完整收束和有余韵的平静都是合法结尾；只有从结果中自然长出来时才留悬念，不能为了断章扣住已经挣到的兑现
- 对话驱动：有角色互动的场景中，优先用对话传递冲突和信息，不要用大段叙述替代角色交锋。独处/逃生/探索场景除外
- 信息分层植入：基础信息在行动中自然带出，关键设定结合剧情节点揭示，严禁大段灌输世界观
- 描写必须服务叙事：环境描写烘托氛围或暗示情节，一笔带过即可；禁止无效描写
- 日常/过渡段落必须有当下功能：深化情绪、改变关系、揭示信息、迫使选择、兑现承诺或展示后果都可以，不必强行埋新伏笔。纯填充式日常是流水账的温床

## 看点与节奏（创作准则）

本章先选一个最有力的趣味锚点，把它写成全章最强的场景：行动、阻力、转折和读者能看见的结果。写完后按场景功能自检：

- 不按每多少字几个爽点、钩子或未解悬念来凑数；按语义重量和读者体验判断是否发平
- 安静段落只要实际改变情绪、关系、信息、选择、兑现或后果，就有价值，不必制造未来债务
- 任何看点都必须服务本章 goal 和最近的读者承诺，不能是与主线无关的孤立段落
- 如果一段环境、回忆、议论或心理独白既不推进目标，也不改变读者体验，就是水文，必须删或改
- **密度是靠段落内的语义密度实现，不是靠把段落切碎**：
  - 叙事段通常把相连的动作、观察和反应聚在一起，让一个段落承担完整的语义重量；对话行可以自然地短
  - 短段是节奏标点，可用于真正重要的转折、决定、兑现或少见的重击，不限定在开场反转或章末钩子，也不按固定个数配给
  - 避免把每个动作和反应都拆成连续电报体；高压场面确实需要急促节奏时可以短促，随后在自然位置用完整动作、细节或情绪重新收束呼吸
  - 段落形状是诊断信号，不是返工硬阈值。先判断它是否放大本章最有趣的场景，而不是计算短段百分比
  - 正反例：
    - ✗ "他转身。/ 看向门外。/ 门开了一条缝。/ 赵无尘站在光里。"（4 段全 <15 字，4 连短段）
    - ✓ "他转身看向门外。门开了一条缝，赵无尘站在光里，手里还端着一碗凉透的茶。"（两段合并成 1 段 60 字，动作 + 观察 + 细节完整）
    - ✗ "他一愣。/ 手停了。/ 嘴唇发白。"（3 连心理反应各自一段）
    - ✓ "他一愣，手停了，嘴唇发白。"（并段为 1 句节奏紧凑的叙事）

## 章节收束与翻页动力

- 完成本章承诺的行动和兑现，不得只为制造断章而扣住读者已经挣到的结果
- 只有 chapter_memo 或 Arc 明确需要、且延后结果在戏剧上诚实时，才断在 action-climax；完整兑现、后效、决定或有余韵的平静都是合法结尾
- 章节结构优先于字数：先完成一个连贯节拍，再选择最有力量的切口，不要为了卡字数切断节奏
- 不要为了凑字数硬加无关对话/描写，也不要为了做钩子提前截断已经成熟的兑现

## 逻辑自洽

- 三连反问自检：每写一个情节，反问"他为什么要这么做？""这符合他的利益吗？""这符合他之前的人设吗？"
- 反派不能基于不可能知道的信息行动（信息越界检查）
- 关系改变必须事件驱动：如果主角要救人必须给出利益理由，如果反派要妥协必须是被抓住了死穴
- 场景转换必须有过渡：禁止前一刻在A地、下一刻毫无过渡出现在B地
- 每段至少带来一项新信息、态度变化或利益变化，避免空转

## 语言约束

- 句式多样化：长短句交替，严禁连续使用相同句式或相同主语开头
- 词汇控制：多用动词和名词驱动画面，少用形容词；一句话中最多1-2个精准形容词
- 群像反应不要一律"全场震惊"，改写成1-2个具体角色的身体反应
- 情绪用细节传达：✗"他感到非常愤怒" → ✓"他捏碎了手中的茶杯，滚烫的茶水流过指缝"
- 禁止元叙事（如"到这里算是钉死了"这类编剧旁白）

## 去AI味铁律

- 【铁律】叙述者永远不得替读者下结论。读者能从行为推断的意图，叙述者不得直接说出。✗"他想看陆焚能不能活" → ✓只写踢水囊的动作，让读者自己判断
- 【铁律】正文中严禁出现分析报告式语言：禁止"核心动机""信息边界""信息落差""核心风险""利益最大化""当前处境"等推理框架术语。人物内心独白必须口语化、直觉化。✗"核心风险不在今晚吵赢" → ✓"他心里转了一圈，知道今晚不是吵赢的问题"
- 【铁律】转折/惊讶标记词（仿佛、忽然、竟、竟然、猛地、猛然、不禁、宛如）全篇总数不超过每3000字1次。超出时改用具体动作或感官描写传递突然性
- 【铁律】同一体感/意象禁止连续渲染超过两轮。第三次出现相同意象域（如"火在体内流动"）时必须切换到新信息或新动作，避免原地打转
- 【铁律】六步走心理分析是写作推导工具，其中的术语（"当前处境""核心动机""信息边界""性格过滤"等）只用于PRE_WRITE_CHECK内部推理，绝不可出现在正文叙事中
- 反例→正例速查：✗"虽然他很强，但是他还是输了"→✓"他确实强，可对面那个老东西更脏"；✗"然而事情并没有那么简单"→✓"哪有那么便宜的事"；✗"这一刻他终于明白了什么是力量"→✓删掉，让读者自己感受

## 硬性禁令

- 【硬性禁令】全文严禁出现"不是……而是……""不是……，是……""不是A，是B"句式，出现即判定违规。改用直述句
- 【硬性禁令】全文严禁出现破折号"——"，用逗号或句号断句
- 正文中禁止出现hook_id/账本式数据（如"余量由X%降到Y%"），数值结算只放POST_SETTLEMENT`;
}

// ---------------------------------------------------------------------------
// 去AI味正面范例（反例→正例对照表）
// ---------------------------------------------------------------------------

function buildAntiAIExamples(): string {
  return `## 去AI味：反例→正例对照

以下对照表展示AI常犯的"味道"问题和修正方法。正文必须贴近正例风格。

### 情绪描写
| 反例（AI味） | 正例（人味） | 要点 |
|---|---|---|
| 他感到非常愤怒。 | 他捏碎了手中的茶杯，滚烫的茶水流过指缝，但他像没感觉一样。 | 用动作外化情绪 |
| 她心里很悲伤，眼泪流了下来。 | 她攥紧手机，指节发白，屏幕上的聊天记录模糊成一片。 | 用身体细节替代直白标签 |
| 他感到一阵恐惧。 | 他后背的汗毛竖了起来，脚底像踩在了冰上。 | 五感传递恐惧 |

### 转折与衔接
| 反例（AI味） | 正例（人味） | 要点 |
|---|---|---|
| 虽然他很强，但是他还是输了。 | 他确实强，可对面那个老东西更脏。 | 口语化转折，少用"虽然...但是" |
| 然而，事情并没有那么简单。 | 哪有那么便宜的事。 | "然而"换成角色内心吐槽 |
| 因此，他决定采取行动。 | 他站起来，把凳子踢到一边。 | 删掉因果连词，直接写动作 |

### "了"字与助词控制
| 反例（AI味） | 正例（人味） | 要点 |
|---|---|---|
| 他走了过去，拿了杯子，喝了一口水。 | 他走过去，端起杯子，灌了一口。 | 连续"了"字削弱节奏，保留最有力的一个 |
| 他看了看四周，发现了一个洞口。 | 他扫了一眼四周，墙根裂开一道缝。 | 两个"了"减为一个，"发现"换成具体画面 |

### 词汇与句式
| 反例（AI味） | 正例（人味） | 要点 |
|---|---|---|
| 那双眼睛充满了智慧和深邃。 | 那双眼睛像饿狼见了肉。 | 用具体比喻替代空洞形容词 |
| 他的内心充满了矛盾和挣扎。 | 他攥着拳头站了半天，最后骂了句脏话，转身走了。 | 内心活动外化为行动 |
| 全场为之震惊。 | 老陈的烟掉在了裤子上，烫得他跳起来。 | 群像反应具体到个人 |
| 不禁感叹道…… | （直接写感叹内容，删掉"不禁感叹"） | 删除无意义的情绪中介词 |

### 叙述者姿态
| 反例（AI味） | 正例（人味） | 要点 |
|---|---|---|
| 这一刻，他终于明白了什么是真正的力量。 | （删掉这句——让读者自己从前文感受） | 不替读者下结论 |
| 显然，对方低估了他的实力。 | （只写对方的表情变化，让读者自己判断） | "显然"是作者在说教 |
| 他知道，这将是改变命运的一战。 | 他把刀从鞘里拔了一寸，又推回去。 | 用犹豫的动作暗示重要性 |`;
}

// ---------------------------------------------------------------------------
// 六步走人物心理分析（新增方法论）
// ---------------------------------------------------------------------------

function buildCharacterPsychologyMethod(): string {
  return `## 六步走人物心理分析

每个重要角色在关键场景中的行为，必须经过以下六步推导：

1. **当前处境**：角色此刻面临什么局面？手上有什么牌？
2. **核心动机**：角色最想要什么？最害怕什么？
3. **信息边界**：角色知道什么？不知道什么？对局势有什么误判？
4. **性格过滤**：同样的局面，这个角色的性格会怎么反应？（冲动/谨慎/阴险/果断）
5. **行为选择**：基于以上四点，角色会做出什么选择？
6. **情绪外化**：这个选择伴随什么情绪？用什么身体语言、表情、语气表达？

禁止跳过步骤直接写行为。如果推导不出合理行为，说明前置铺垫不足，先补铺垫。

### 人设防崩三问（每次写角色行为前）
1. "他为什么要这么做？"——必须有利益或情感驱动
2. "这符合他之前的人设吗？"——行为由"过往经历+当前利益+性格底色"共同驱动
3. "如果把这段给一个只看过前面章节的读者，他会觉得突兀吗？"——人设一致性检验

### "盐溶于汤"原则
主角的野心和价值观不能通过口号喊出来，必须内化于行为。
- 反例：主角说"我要成为最强的人！" → 空洞口号
- 正例：主角在别人放弃时默默多练了两个小时 → 用行动传达野心`;
}

// ---------------------------------------------------------------------------
// 配角设计方法论
// ---------------------------------------------------------------------------

function buildSupportingCharacterMethod(): string {
  return `## 配角设计方法论

### 配角B面原则
配角必须有反击，有自己的算盘。主角的强大在于压服聪明人，而不是碾压傻子。

### 构建方法
1. **动机绑定主线**：每个配角的行为动机必须与主线产生关联
   - 反派对抗主角不是因为"反派脸谱"，而是有自己的诉求（如保护家人、争夺生存资源）
   - 盟友帮助主角是因为有共同敌人或欠了人情，而非无条件忠诚
2. **核心标签 + 反差细节**：让配角"活"过来
   - 表面冷硬的角色有不为人知的温柔一面（如偷偷照顾流浪动物）
   - 看似粗犷的角色有出人意料的细腻爱好
   - 反派头子对老母亲言听计从
3. **通过事件立人设**：禁止通过外貌描写和形容词堆砌来立人设，用角色在事件中的反应、选择、语气来展现性格
4. **语言区分度**：不同角色的说话方式必须有辨识度——用词习惯、句子长短、口头禅、方言痕迹都是工具
5. **拒绝集体反应**：群戏中不写"众人齐声惊呼"，而是挑1-2个角色写具体反应`;
}

// ---------------------------------------------------------------------------
// 读者心理学框架（新增方法论）
// ---------------------------------------------------------------------------

function buildReaderPsychologyMethod(): string {
  return `## 读者心理学框架

写作时同步考虑读者的心理状态：

- **期待管理**：先让读者看见本章已经挣到的结果；只有因果和人物选择确实需要时才继续承接，不为放大快感故意拖延兑现
- **信息落差**：让读者比角色多知道一点（制造紧张），或比角色少知道一点（制造好奇）
- **情绪节拍**：让压力、释放、后果服从当前场景功能。需要升级时逐层加码；需要结算时让结果完整落地，不把“更大压制”当作固定配额
- **锚定效应**：先给读者一个参照（对手有多强/困难有多大），再展示主角的表现
- **已付价值**：留存先来自本章已经给到的结果、情绪或变化，再由自然生长的下一选择或压力承接
- **代入感维护**：主角的困境必须让读者能共情，主角的选择必须让读者觉得"我也会这么做"`;
}

// ---------------------------------------------------------------------------
// 情感节点设计方法论
// ---------------------------------------------------------------------------

function buildEmotionalPacingMethod(): string {
  return `## 情感节点设计

关系发展（友情、爱情、从属）必须经过事件驱动的节点递进：

1. **设计3-5个关键事件**：共同御敌、秘密分享、利益冲突、信任考验、牺牲/妥协
2. **递进升温**：每个事件推进关系一个层级，禁止跨越式发展（初见即死忠、一面之缘即深情）
3. **情绪用场景传达**：环境烘托（暴雨中独坐）+ 微动作（攥拳指尖发白）替代直白抒情
4. **情感与题材匹配**：末世侧重"共患难的信任"、悬疑侧重"试探与默契"、玄幻侧重"利益捆绑到真正认可"
5. **禁止标签化互动**：不可突然称兄道弟、莫名深情告白，每次称呼变化都需要事件支撑

### 强情绪升级法（避免流水账的核武器）
流水账的修法不是删掉日常，而是给日常加"料"：
1. **加入前因后果**：下班回家→加上"催债电话刚打来"的前因→日常立刻有了紧迫感
2. **情绪递进**：不是一个坏事，而是坏事接着坏事——被骂→赶不上公交→手机掉了→直播课结束了→包子把自己噎住了。每层比上一层更过分
3. **日常必须有当下功能**：深化情绪、改变关系、揭示信息、迫使选择、兑现承诺或展示后果都成立，不必把万物都变成未来伏笔。纯填充的日常才是流水账`;
}

// ---------------------------------------------------------------------------
// 代入感具体技法
// ---------------------------------------------------------------------------

function buildImmersionTechniques(): string {
  return `## 代入感技法

- **自然信息交代**：角色身份/外貌/背景通过行动和对话带出，禁止"资料卡式"直接罗列
- **画面代入法**：开场先给画面（动作、环境、声音），再给信息，让读者"看到"而非"被告知"
- **共鸣锚点**：主角的困境必须有普遍性（被欺压、不公待遇、被低估），让读者觉得"这也是我"
- **欲望承接**：先让本章期待得到可见回应，再让下一选择、后果或压力自然接住读者；完整收束也合法
- **信息落差应用**：让读者比角色多知道一点（紧张感）或少知道一点（好奇心），动态切换
- **具体化/可视化**：描写时具体到读者脑海能浮现的东西——不写"一个大城市"，写"三环堵了四十分钟的出租车后座"
- **熟悉感**：接地气的场景自带代入感——医院走廊的消毒水味、深夜便利店的暖光、雨天公交站的积水

### 欲望驱动（网文核心）
网文本质是满足读者的欲望。两种欲望必须交替使用：
- **基础欲望**（被动）：不劳而获、高人一等、权势地位、扬眉吐气——读者天然渴望的东西
- **主动欲望**（期待感）：把读者正在等待的具体承诺摆上台面，由本章兑现、加深或有因果地继续承接
- 关键：已经挣到的结果必须让读者看见；不得只为制造下一章牵引而扣住兑现`;
}

// ---------------------------------------------------------------------------
// Writing Craft Card (v10: compact rules, replaces 9 full modules)
// Full methodology is in style_guide.md; this is the always-on reminder.
// ---------------------------------------------------------------------------

function buildWritingCraftCard(language: "zh" | "ko" | "en"): string {
  if (language === "en") {
    return `## Writing Craft Rules

- **Emotion**: Externalize through action — never write "he felt angry", write "he crushed the teacup"
- **Salt in soup**: Values conveyed through behavior, not slogans
- **Supporting cast**: Every side character has their own agenda. Protagonist wins by outsmarting smart people, not crushing fools
- **Five senses**: Wet shirt sticking to the back, hospital disinfectant smell, rain puddles at the bus stop
- **Concrete**: Don't write "a big city" — write "the back seat of a taxi stuck in traffic for forty minutes"
- **Sentence craft**: Avoid "although...however" / "nevertheless" / excessive "was". Use character reactions instead of transition words
- **Desire engine**: Identify the nearest concrete promise, then satisfy, deepen, or consciously carry it forward through visible causality; never withhold an earned result
- **Character check**: Before every character action ask: Why? Does it match their profile? Would the reader find it jarring?
- **Dialogue**: Different characters speak differently — vocabulary, sentence length, verbal tics, dialect traces
- **Forbidden**: Info-dump character introductions / introducing 3+ new characters at once / "everyone gasped in unison"
- **Escalation**: When the scene calls for escalation, make each added setback causally sharper; when it calls for settlement, let the result land without inventing a worse problem
- **Cycle awareness**: If currently in build-up phase, lay new obstacles and information; if climax phase, write payoff that exceeds expectations; if aftermath phase, write consequences — who lost what, who gained what, how relationships changed
- **Post-climax impact**: Let earned payoffs, actual costs, status shifts, or the new normal land before any new build-up; clean settlement is valid, carries no fixed chapter quota, and needs no invented cost or growth beat
- **Expectation management**: Make an earned result visible. Carry expectation forward only when causality or character choice genuinely requires it, never merely to amplify payoff
- **Information boundary**: What does this character know? What don't they know? What are they wrong about? Characters must act only on information they possess`;
  }

  return `## 写作铁律

- **情绪**：用动作外化，不写"他感到愤怒"，写"他捏碎了茶杯，滚烫的茶水流过指缝"
- **盐溶于汤**：价值观通过行为传达，不喊口号
- **配角**：有自己的算盘和反击，主角压服聪明人不是碾压傻子
- **五感**：潮湿的短袖黏在后背上、医院消毒水的味、雨天公交站的积水
- **具体化**：不写"大城市"，写"三环堵了四十分钟的出租车后座"
- **句式**：少用"虽然但是/然而/因此/了"，用角色内心吐槽替代转折词
- **欲望驱动**：找到离读者最近的具体承诺，让本章以可见因果兑现、加深或有意识地继续承接；不得扣住已经挣到的结果
- **人设三问**：为什么这么做？符合人设吗？读者会觉得突兀吗？
- **对话**：不同角色说话方式不同——用词习惯、句子长短、口头禅、方言痕迹
- **禁止**：资料卡式介绍角色 / 一次引入超3个新角色 / 众人齐声惊呼
- **升级**：场景确实需要升级时，让新增阻力在因果上更尖锐；场景需要结算时，让结果落地，不为续压强造更坏的问题
- **小目标周期意识**：如果当前处于蓄压阶段，铺新阻力新信息；如果是爆发阶段，写兑现超预期；如果是后效阶段，写改变和代价
- **高潮后影响**：先让已经发生的兑现、实际代价、地位变化或新常态落地，再决定是否进入下一轮；完整收束合法，不设固定章数配额，也不凭空补代价或成长
- **期待管理**：让已经挣到的结果可见。只有因果或人物选择确实需要时才继续承接，不为放大快感故意拖延兑现
- **信息边界**：角色此刻知道什么？不知道什么？对局势有什么误判？角色只能基于已掌握的信息行动`;
}

// ---------------------------------------------------------------------------
// 创作宪法（14 条原则精华） — always-on prose; internalise, do not report back
// ---------------------------------------------------------------------------

function buildCreativeConstitution(language: "zh" | "ko" | "en"): string {
  if (language === "en") {
    return `## Creative Constitution

These fourteen principles are your spine. Internalise them — never quote them, never list them, never narrate them. They tell you how to pick between two plausible next sentences.

Show don't tell: stack real detail to make truth visible, never deliver feeling in a flat declarative line. Let values dissolve in action like salt in soup — conviction is proved by what a character does when nobody is watching. Every character act sits on three legs at once: lived history, current interest, temperamental core; remove any leg and the act reads as authorial fiat. Every side character keeps their own ledger with their own profit motive; they exist before the protagonist meets them and continue after. Rhythm breathes — slow fires cook the richest broth, and daily moments earn their place through present emotion, relationship, information, choice, payoff, or consequence. Let an ending carry momentum through a visible result, decision, or pressure; clean settlement is valid, and a hook is never a quota. Everyone on stage stays smart — no convenient stupidity, saint-mode mercy, or un-set-up compromise. Use after-time references in the voice of the era they land in. Timeline and period common sense cannot be bent. Relationship changes need an event to drive them — no overnight brotherhood, no out-of-nowhere love. Character setup holds across the arc; when growth occurs, show its work, but do not require it. Important plot beats and foreshadowing earn their detail — scene over summary. Refuse chronicle drift: every line either moves the plot, sharpens a person, or lets a consequence land.`;
  }
  return `## 创作宪法

这十四条原则是你写作的脊梁。内化它们——绝不引用、绝不列表、绝不在正文里复述。它们的用途是帮你在"两个都说得通的下一句"之间做出选择。

Show don't tell，用细节堆出真实，禁止用一行直白陈述替代情绪。价值观要像盐溶于汤——角色的信念靠"没人看时他在做什么"来证明，不靠口号。任何角色的任何行动都必须同时立于三条腿上：过往经历、当前利益、性格底色；缺一条就成了作者强行安排。每个配角都有自己的账本和利益诉求，他们在遇到主角之前就存在、在离开主角之后继续过日子，不是工具人。节奏即呼吸——慢火才能炖出高汤，日常靠当下的情绪、关系、信息、选择、兑现或后果成立，不靠强行埋饵。章尾用看得见的结果、决定或压力保持动力；完整收束合法，钩子从来不是配额。全员智商在线——禁止降智、圣母心、无铺垫的妥协。后世梗用符合年代语境的说法落地。时间线与时代常识不能错。任何关系的改变都要事件驱动——没有一夜称兄道弟、没有莫名其妙的深情。人设前后一致，成长有过程。重要剧情和伏笔用场景，不用总结。拒绝流水账——每一行字要么推动剧情、塑造人物，要么让后果真正落地。`;
}

// ---------------------------------------------------------------------------
// 代入感六支柱 — always-on prose; internalise, do not narrate checklist items
// ---------------------------------------------------------------------------

function buildImmersionPillars(language: "zh" | "ko" | "en"): string {
  if (language === "en") {
    return `## Six Pillars of Immersion

Reader immersion rests on six pillars. Write to install all six inside the first few pages of every scene — tacitly, without ever addressing them by name.

Tag the basics: within a hundred words the reader knows who is on stage, where the stage is, and what is happening, so they can build the room in their head. Reach for visible familiarity: give ground-level specifics the reader has touched in their own life, so the scene loads before the second paragraph ends. Earn resonance twice — cognitive (the reader would make the same choice) and emotional (family feeling, anger at unfair treatment, grief, quiet pride). Feed desire on two tracks: the base wants (getting something for nothing, outranking those above, exhaling after being pressed down) and the active want the chapter stages and then satisfies, deepens, or consciously carries forward. Plant sensory hooks: every scene carries one or two senses beyond sight (sound, smell, touch, taste), dropped in passing, never a paragraph of weather. Make characters alive with a core tag plus one contrasting detail — the cold killer who feeds stray cats, the warm father whose jokes land like knives. These pillars are the default shape of every scene, not a checklist you tick at the end.`;
  }
  return `## 代入感六支柱

读者代入感靠六根支柱支撑。每一个场景的前几页都要把六根柱子立起来——静默地立，不要点名、不要报告。

基础信息标签化：一百字内让读者知道谁在场、在哪儿、发生什么，读者脑里才能搭出这个房间。可视化熟悉感：给出读者亲身碰过的地面级具体细节——医院消毒水的味、地铁座椅的凉、外卖塑料袋的塑胶感——场景在第二段之前就要加载完。共鸣分两层：认知共鸣（"这种情况下我也会这么选"）+ 情绪共鸣（亲情、被欺压时的愤怒、不公、隐忍的骄傲）。欲望两条腿走路：基础欲望（不劳而获、压制比自己高的人、被欺压之后的扬眉吐气）+ 主动欲望（本章摆上台面的期待，由本章兑现、加深或有意识地带往后面）。五感钩子：每个场景除视觉外放 1-2 种感官细节（听/嗅/触/味），顺手带过，绝不写成大段天气描写。人设要"核心标签 + 一个反差细节"才活——冷面杀手偷偷喂流浪猫、和善父亲开的玩笑像刀子。这六根柱子是场景的默认形状，不是章末打勾的清单。`;
}

// ---------------------------------------------------------------------------
// 黄金三章 prose discipline — Phase 6.5
// Single conditional append (chapterNumber <= 3). No new schema, no new
// runtime branch. Cohesive paragraphs, NOT a numbered checklist.
// ---------------------------------------------------------------------------

export function buildGoldenOpeningDiscipline(
  chapterNumber: number | undefined,
  language: "zh" | "ko" | "en",
): string {
  if (chapterNumber === undefined || chapterNumber > 3) return "";

  if (language === "en") {
    return `## Golden Opening Discipline — Chapter ${chapterNumber}

The opening chapters must earn attention through visible story value, not through a sentence-position formula. In Chapter 1, make the core conflict and a meaningful protagonist choice recognisable within the first active beat; a reversal or striking line is one valid method, never a required last sentence on the first phone screen. In Chapter 2, **perform** the protagonist's edge — power, system, rebirth-memory, or information advantage — through a concrete event with a visible consequence rather than merely announcing it. In Chapter 3, let a meaningful short-term aim become clear enough that the reader understands what the protagonist chooses next.

Across all three chapters, let paragraph rhythm, scene count, and cast size serve clarity and dramatic weight rather than fixed caps. Put verbs and concrete action ahead of explanation, layer world information into what characters do, and end with a visible result plus whatever honestly follows from it: a choice, consequence, pressure, aftermath, or earned calm. A striking turn and natural forward pull are useful tools, but never withhold an earned result merely to fabricate a cliffhanger.`;
  }

  return `## 黄金三章写作纪律 — 第 ${chapterNumber} 章

开篇要靠读者看得见的故事价值留人，不靠固定句位公式。第 1 章在第一个有效动作节拍里，让核心冲突和主角一次有意义的选择变得清楚；反转或金句只是可选手段，不要求卡在手机第一页的最后一句。第 2 章把金手指、能力、系统、重生记忆或信息差"做出来"——用一次具体事件和看得见的后果证明，而不是用旁白"说出来"。第 3 章让一个有意义的短期目标自然浮现，使读者知道主角接下来选择做什么。

贯穿开篇三章的纪律：段落节奏、场景数量和出场人物都服从清晰度与戏剧重量，不设固定配额。用动作带出信息，先给出本章行动的可见结果，再让下一步选择、后果、压力、后效或有余韵的平静从结果中自然生长。反差与翻页动力都是工具，不能为了伪造悬念扣住已经挣到的兑现。`;
}

// ---------------------------------------------------------------------------
// 黄金开篇（中文3章/英文5章）
// ---------------------------------------------------------------------------

function buildGoldenChaptersRules(chapterNumber?: number, language?: string): string {
  const isEnglish = language === "en";
  const goldenLimit = isEnglish ? 5 : 3;
  if (chapterNumber === undefined || chapterNumber > goldenLimit) return "";

  const zhRules: Record<number, string> = {
    1: `### 第一章：抛出核心冲突
- 开篇直接进入冲突场景，禁止用背景介绍/世界观设定开头
- 第一段必须有动作或对话，让读者"看到"画面
- 第一屏应让核心冲突、主角选择或具体后果至少有一项清楚可见；反转或反差句是可选手段，不规定在最后一句
- 场景与出场人物以读者能清楚追踪冲突为准，不按固定数量卡死
- 主角身份/外貌/背景通过行动自然带出，禁止资料卡式罗列
- 本章结束前，核心矛盾必须浮出水面
- 一句对话能交代的信息不要用一段叙述，角色身份、性格、地位都可以从一句有特色的台词中带出`,
    2: `### 第二章：展现金手指/核心能力
- 主角的核心优势（金手指/特殊能力/信息差等）必须在本章初现
- 金手指的展现必须通过具体事件，不能只是内心独白"我获得了XX"
- 开始建立"主角有什么不同"的读者认知
- 第一个小爽点应在本章出现
- 继续收紧核心冲突，不引入新支线`,
    3: `### 第三章：明确短期目标
- 主角的第一个阶段性目标必须在本章确立
- 目标必须具体可衡量（打败某人/获得某物/到达某处），不能是抽象的"变强"
- 读完本章，读者应能说出"接下来主角要干什么"
- 章尾先让本章选择产生可见结果，再让下一目标或压力自然浮现；不得扣住已到手的兑现`,
  };

  const enRules: Record<number, string> = {
    1: `### Chapter 1: Drop into conflict
- Open with action or dialogue — no worldbuilding preamble
- First paragraph must show a scene, not tell backstory
- In the first active screen, make at least one source of story value clearly visible: the core conflict, a protagonist choice, or a concrete consequence. A reversal is optional, not a required last sentence
- Use as many locations and named characters as the conflict can keep clear; there is no fixed opening quota
- Protagonist identity revealed through behavior, not info-dump
- Core conflict must surface before chapter end`,
    2: `### Chapter 2: Reveal the edge
- The protagonist's unique advantage (power/secret/skill) must appear
- Show it through a concrete event, not internal monologue ("I gained X")
- First small payoff/satisfaction beat should land here
- Tighten the core conflict, don't open new subplots`,
    3: `### Chapter 3: Lock in the short-term goal
- A specific, measurable goal must be established (defeat someone / obtain something / reach somewhere)
- Reader must be able to say "I know what the protagonist wants next"
- End with a visible result and let the next goal or pressure arise naturally; do not withhold an earned payoff`,
    4: `### Chapter 4: First major payoff
- Deliver the first BIG satisfaction beat — reader has invested 3 chapters, reward them
- Protagonist uses their edge to achieve something meaningful (not just survive)
- Raise the emotional stakes: what the protagonist stands to LOSE becomes clear
- Introduce or deepen a relationship that matters (ally, rival, love interest)`,
    5: `### Chapter 5: Raise the stakes before paywall
- New threat or complication that makes the goal harder (new antagonist, betrayal, revelation)
- The world expands: reader sees there's a bigger game beyond the initial conflict
- Deliver a satisfying result, then let the larger game create honest forward pressure
- The conversion must come from value already received, not an artificially withheld result`,
  };

  const rules = isEnglish ? enRules : zhRules;
  const header = isEnglish
    ? `## Golden ${goldenLimit} Chapters — Chapter ${chapterNumber}

The opening ${goldenLimit} chapters determine whether readers stay or leave. Before the paywall (ch6-8), make each chapter's own core value visible; do not force every chapter to escalate or manufacture forward pressure.

- Start from an explosion, not the first brick
- No info-dumps: worldbuilding reveals through action
- Keep the central conflict easy to follow. Storyline count and named cast size serve clarity and dramatic weight, not fixed opening caps
- Lead with strong emotion: injustice, danger, mystery, desire`
    : `## 黄金${goldenLimit}章特殊指令（当前第${chapterNumber}章）

开篇${goldenLimit}章决定读者是否追读。以下是优先指导，不是固定配额：

- 开篇不要从第一块砖头开始砌楼——从炸了一栋楼开始写
- 禁止信息轰炸：世界观、力量体系等设定随剧情自然揭示
- 让核心冲突保持清楚；故事线和有名角色的数量服从场面清晰度与戏剧重量，不设开篇固定上限
- 强情绪优先：利用读者共情（亲情纽带、不公待遇、被低估）快速建立代入感`;

  return `${header}

${rules[chapterNumber] ?? ""}`;
}

// ---------------------------------------------------------------------------
// Full cast tracking (conditional)
// ---------------------------------------------------------------------------

function buildFullCastTracking(): string {
  return `## 全员追踪

本书启用全员追踪模式。每章结束时，POST_SETTLEMENT 必须额外包含：
- 本章出场角色清单（名字 + 一句话状态变化）
- 角色间关系变动（如有）
- 未出场但被提及的角色（名字 + 提及原因）`;
}

// ---------------------------------------------------------------------------
// Genre-specific rules
// ---------------------------------------------------------------------------

function buildGenreRules(gp: GenreProfile, genreBody: string, language: "zh" | "ko" | "en"): string {
  if (language !== "zh") {
    const fatigueLine = gp.fatigueWords.length > 0
      ? `- High-fatigue terms are a repetition diagnostic, not a word quota: ${gp.fatigueWords.join(", ")}. Use one only when it is the most precise choice.`
      : "";
    const chapterTypesLine = gp.chapterTypes.length > 0
      ? `Possible chapter functions; choose only what fits the current memo and Arc:\n${gp.chapterTypes.map((type) => `- ${type}`).join("\n")}`
      : "";
    const pacingLine = gp.pacingRule ? `- Genre rhythm diagnostic (not a pass/fail quota): ${gp.pacingRule}` : "";
    const precedenceLine = "Cadence, chapter-shape, payoff, and ending examples in the profile below are advisory. The current memo, Arc, causality, and earned reader payoff decide the scene; clean closure is valid. Canon, system rules, and explicit genre prohibitions remain hard.";
    return [
      `## Genre rules (${gp.name})`,
      fatigueLine,
      pacingLine,
      chapterTypesLine,
      precedenceLine,
      genreBody,
    ].filter(Boolean).join("\n\n");
  }
  const fatigueLine = gp.fatigueWords.length > 0
    ? `- 高疲劳词只作为重复诊断，不是用词配额：${gp.fatigueWords.join("、")}。只有它最准确时才使用`
    : "";

  const chapterTypesLine = gp.chapterTypes.length > 0
    ? `可选章节功能，只选择符合当前 memo 与 Arc 的一项或组合：\n${gp.chapterTypes.map(t => `- ${t}`).join("\n")}`
    : "";

  const pacingLine = gp.pacingRule
    ? `- 题材节奏诊断（不是通过配额）：${gp.pacingRule}`
    : "";
  const precedenceLine = "下方题材资料里的章数频率、章节形状、回报与章尾例子都只是参考。当前 memo、Arc、因果和已经挣到的读者回报决定场面，完整收束合法；世界正典、系统规则和显式题材禁令仍是硬约束。";

  return [
    `## 题材规范（${gp.name}）`,
    fatigueLine,
    pacingLine,
    chapterTypesLine,
    precedenceLine,
    genreBody,
  ].filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// Protagonist rules from book_rules
// ---------------------------------------------------------------------------

// Legacy BookRules can carry narrative person without proving who authorized
// it. Keep it as style advice only; verified hard rules travel separately.
function buildNarrativePersonRule(bookRules: BookRules | null, language: "zh" | "ko" | "en"): string {
  const person = bookRules?.narrativePerson;
  if (!person) return "";
  if (language === "en") {
    return person === "first"
      ? "## Narrative-person reference (advisory)\nBookRules records first person as a preferred style reference. Follow it when it fits established canon, but this unverified field is not a hard rule and cannot by itself justify automatic revision."
      : "## Narrative-person reference (advisory)\nBookRules records third person as a preferred style reference. Follow it when it fits established canon, but this unverified field is not a hard rule and cannot by itself justify automatic revision.";
  }
  return person === "first"
    ? "## 叙事人称参考（非自动硬规则）\nBookRules 记录了第一人称偏好。与既有正典一致时优先参考，但未经验证的字段本身不能成为自动修改理由。"
    : "## 叙事人称参考（非自动硬规则）\nBookRules 记录了第三人称偏好。与既有正典一致时优先参考，但未经验证的字段本身不能成为自动修改理由。";
}

/**
 * Cross-theme failure modes surfaced by results-oriented testing across genres:
 *  - simile over-reliance (~3 "像/仿佛/如同" per 1000 chars regardless of theme)
 *  - high-density dramatic beats summarized instead of dramatized when the
 *    chapter is tight (climaxes told, not shown).
 * Theme-independent, so this lives in the always-on writer discipline.
 */
function buildProseExecutionRules(language: "zh" | "ko" | "en"): string {
  if (language === "en") {
    return `## Prose execution (cross-theme failure modes)

**Simile restraint.** Do not lean on "like / as if / as though" as a default device. At most one simile per scene, and only when it lights the image up better than plain rendering would. Priority is always: a precise verb > a concrete action or sensory detail > direct description > simile. Before reaching for "like…", check whether an exact verb or a concrete action would hit harder.

**Play out the climax — never summarize it.** This chapter's high-density / high-stakes beats — a conflict erupting, life-or-death, a major turn, a reveal, an action climax — MUST be played out beat by beat (action, dialogue, the senses, pauses, pacing). Never compress them into "then he saved them, the police came, the antagonist was arrested." When a chapter packs several major events, expand the single most important one into a full scene; connective tissue may be compressed, but the key beat must never decay into a summary. The tighter the chapter, the harder this holds — if you are short on words, pack fewer events, do not render the climax as a synopsis.`;
  }
  return `## 文笔执行（跨题材通病纠正）

**明喻节制。** 不要把"像/仿佛/如同/像……一样"当默认修辞反复用。每个场景明喻最多 1 处，且只在它真能点亮画面、比直写更准时才用。优先级永远是：精确的动词 > 具体的动作或感官细节 > 直接描写 > 明喻。想写"像……"之前，先问一句：换成一个准确的动词或一个具体动作，是不是更狠。

**高潮必须演出、不许概述。** 本章的高密度／高风险节拍——冲突爆发、生死、重大转折、真相揭露、动作高潮——必须一拍一拍现场演出（动作、对话、五感、停顿、节奏），绝不能用一两句"然后他救了人、警察来了、对手被捕"带过。当一章里挤了多个重大事件时，挑最关键的那一拍写成完整场景，次要的可压成过渡，但最关键那拍永远不许退化成总结。章节越紧凑越要守这条——字数不够就少塞事件，而不是把高潮写成梗概。`;
}

function buildProtagonistRules(bookRules: BookRules | null, language: "zh" | "en"): string {
  if (!bookRules?.protagonist) return "";

  const p = bookRules.protagonist;
  const lines = [language === "en"
    ? `## Protagonist reference and verified rules (${p.name})`
    : `## 主角参考与已验证规则（${p.name}）`];

  if (p.personalityLock.length > 0) {
    lines.push(language === "en"
      ? `\nCharacterization reference (advisory, not a hard rule): ${p.personalityLock.join(", ")}`
      : `\n性格参考（仅供人物塑造，不是硬规则）：${p.personalityLock.join("、")}`);
  }
  if (p.behavioralConstraints.length > 0) {
    lines.push(language === "en" ? "\nVerified behavioral constraints:" : "\n已验证行为约束：");
    for (const c of p.behavioralConstraints) {
      lines.push(`- ${c}`);
    }
  }

  if (bookRules.prohibitions.length > 0) {
    lines.push("\n本书禁忌：");
    for (const p of bookRules.prohibitions) {
      lines.push(`- ${p}`);
    }
  }

  if (bookRules.genreLock?.forbidden && bookRules.genreLock.forbidden.length > 0) {
    lines.push(`\n风格禁区：禁止出现${bookRules.genreLock.forbidden.join("、")}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Compact provenance-labelled BookRules guidance. Raw Markdown is display-only.
// ---------------------------------------------------------------------------

function buildBookRulesGuidance(guidance: string): string {
  if (!guidance) return "";
  return `## Verified Book Rule Guidance\n\n${guidance}`;
}

// ---------------------------------------------------------------------------
// Style guide
// ---------------------------------------------------------------------------

function buildStyleGuide(styleGuide: string): string {
  if (!styleGuide || styleGuide === "(文件尚未创建)") return "";
  return `## 文风指南\n\n${styleGuide}`;
}

// ---------------------------------------------------------------------------
// Style fingerprint (Phase 9: C3)
// ---------------------------------------------------------------------------

function buildStyleFingerprint(fingerprint?: string): string {
  if (!fingerprint) return "";
  return `## 文风指纹（模仿目标）

以下是从参考文本中提取的写作风格特征。你的输出必须尽量贴合这些特征：

${fingerprint}`;
}

// ---------------------------------------------------------------------------
// Pre-write checklist
// ---------------------------------------------------------------------------

function buildPreWriteChecklist(book: BookConfig, gp: GenreProfile): string {
  let idx = 1;
  const lines = [
    "## 动笔前必须自问",
    "",
    `${idx++}. 【大纲锚定】本章对应卷纲中的哪个节点/阶段？本章必须推进该节点的剧情，不得跳过或提前消耗后续节点。如果卷纲指定了章节范围，严格遵守节奏。`,
    `${idx++}. 主角此刻利益最大化的选择是什么？`,
    `${idx++}. 这场冲突是谁先动手，为什么非做不可？`,
    `${idx++}. 配角/反派是否有明确诉求、恐惧和反制？行为是否由"过往经历+当前利益+性格底色"驱动？`,
    `${idx++}. 反派当前掌握了哪些已知信息？哪些信息只有读者知道？有无信息越界？`,
    `${idx++}. 章尾是否完成了完整收束、兑现后果或从结果自然生出的下一选择/压力？是否为了造钩子扣住了已挣到的兑现？`,
  ];

  if (gp.numericalSystem) {
    lines.push(`${idx++}. 本章收益能否落到具体资源、数值增量、地位变化或已回收伏笔？`);
  }

  // 17雷点精华预防
  lines.push(
    `${idx++}. 【流水账检查】本章是否有无冲突的日常流水叙述？如有，加入前因后果或强情绪改造`,
    `${idx++}. 【主线偏离检查】本章是否推进了主线目标？支线是否在2-3章内与核心目标关联？`,
    `${idx++}. 【爽点节奏检查】把最近3-5章当作诊断窗口：是否有可辨认的目标变化、兑现或后果？不要按章数凑爽点或情绪缺口。`,
    `${idx++}. 【人设崩塌检查】角色行为是否与已建立的性格标签一致？有无无铺垫的突然转变？`,
    `${idx++}. 【视角检查】本章视角是否清晰？同场景内说话人物是否控制在3人以内？`,
    `${idx++}. 如果任何问题答不上来，先补逻辑链，再写正文`,
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Creative-only output format (no settlement blocks)
// ---------------------------------------------------------------------------

function buildCreativeOutputFormat(book: BookConfig, gp: GenreProfile, lengthSpec: LengthSpec): string {
  const resourceRow = gp.numericalSystem
    ? "| 当前资源总量 | X | 与账本一致 |\n| 本章预计增量 | +X（来源） | 无增量写+0 |"
    : "";

  const preWriteTable = `=== PRE_WRITE_CHECK ===
（必须输出Markdown表格，全部检查项对齐 chapter_memo 七段，而不是卷纲）
| 检查项 | 本章记录 | 备注 |
|--------|----------|------|
| 当前任务 | 复述 chapter_memo 的「当前任务」并写出本章执行动作 | 必须具体，不能抽象 |
| 读者在等什么 | 本章如何处理「读者此刻在等什么」—制造/延迟/兑现 | 与 memo 一致 |
| 该兑现的 / 暂不掀的 | 本章确认要兑现的伏笔 + 必须压住不掀的底牌 | 引用 memo 原文 |
| 日常/过渡承担任务 | 若有日常/过渡段落，说明各自承担的功能 | 对齐 memo 映射表 |
| 章尾必须发生的改变 | 列出 memo「章尾必须发生的改变」中 1-3 条具体改变 | 必须落地 |
| 不要做 | 复述 memo「不要做」清单 | 正文不得触碰 |
| 上下文范围 | 第X章至第Y章 / 状态卡 / 设定文件 | |
| 当前锚点 | 地点 / 对手 / 收益目标 | 锚点必须具体 |
${resourceRow}| 待回收伏笔 | 用真实 hook_id 填写（无则写 none） | 与伏笔池一致 |
| 本章冲突 | 一句话概括 | |
| 章节类型 | ${gp.chapterTypes.join("/")} | |
| 风险扫描 | OOC/信息越界/设定冲突${gp.powerScaling ? "/战力崩坏" : ""}/节奏/词汇疲劳 | |`;

  return `## 输出格式（严格遵守）

${preWriteTable}

=== CHAPTER_TITLE ===
(章节标题，不含"第X章"。标题必须与已有章节标题不同，不要重复使用相同或相似的标题；若提供了 recent title history 或高频标题词，必须主动避开重复词根和高频意象)

=== CHAPTER_CONTENT ===
(正文内容，目标${lengthSpec.target}字，允许区间${lengthSpec.softMin}-${lengthSpec.softMax}字)

【重要】本次只需输出以上三个区块（PRE_WRITE_CHECK、CHAPTER_TITLE、CHAPTER_CONTENT）。
状态卡、伏笔池、摘要等追踪文件将由后续结算阶段处理，请勿输出。`;
}

// ---------------------------------------------------------------------------
// Output format
// ---------------------------------------------------------------------------

function buildOutputFormat(book: BookConfig, gp: GenreProfile, lengthSpec: LengthSpec): string {
  const resourceRow = gp.numericalSystem
    ? "| 当前资源总量 | X | 与账本一致 |\n| 本章预计增量 | +X（来源） | 无增量写+0 |"
    : "";

  const preWriteTable = `=== PRE_WRITE_CHECK ===
（必须输出Markdown表格，全部检查项对齐 chapter_memo 七段，而不是卷纲）
| 检查项 | 本章记录 | 备注 |
|--------|----------|------|
| 当前任务 | 复述 chapter_memo 的「当前任务」并写出本章执行动作 | 必须具体，不能抽象 |
| 读者在等什么 | 本章如何处理「读者此刻在等什么」—制造/延迟/兑现 | 与 memo 一致 |
| 该兑现的 / 暂不掀的 | 本章确认要兑现的伏笔 + 必须压住不掀的底牌 | 引用 memo 原文 |
| 日常/过渡承担任务 | 若有日常/过渡段落，说明各自承担的功能 | 对齐 memo 映射表 |
| 章尾必须发生的改变 | 列出 memo「章尾必须发生的改变」中 1-3 条具体改变 | 必须落地 |
| 不要做 | 复述 memo「不要做」清单 | 正文不得触碰 |
| 上下文范围 | 第X章至第Y章 / 状态卡 / 设定文件 | |
| 当前锚点 | 地点 / 对手 / 收益目标 | 锚点必须具体 |
${resourceRow}| 待回收伏笔 | 用真实 hook_id 填写（无则写 none） | 与伏笔池一致 |
| 本章冲突 | 一句话概括 | |
| 章节类型 | ${gp.chapterTypes.join("/")} | |
| 风险扫描 | OOC/信息越界/设定冲突${gp.powerScaling ? "/战力崩坏" : ""}/节奏/词汇疲劳 | |`;

  const postSettlement = gp.numericalSystem
    ? `=== POST_SETTLEMENT ===
（如有数值变动，必须输出Markdown表格）
| 结算项 | 本章记录 | 备注 |
|--------|----------|------|
| 资源账本 | 期初X / 增量+Y / 期末Z | 无增量写+0 |
| 重要资源 | 资源名 -> 贡献+Y（依据） | 无写"无" |
| 伏笔变动 | 新增/回收/延后 Hook | 同步更新伏笔池 |`
    : `=== POST_SETTLEMENT ===
（如有伏笔变动，必须输出）
| 结算项 | 本章记录 | 备注 |
|--------|----------|------|
| 伏笔变动 | 新增/回收/延后 Hook | 同步更新伏笔池 |`;

  const updatedLedger = gp.numericalSystem
    ? `\n=== UPDATED_LEDGER ===\n(更新后的完整资源账本，Markdown表格格式)`
    : "";

  return `## 输出格式（严格遵守）

${preWriteTable}

=== CHAPTER_TITLE ===
(章节标题，不含"第X章"。标题必须与已有章节标题不同，不要重复使用相同或相似的标题；若提供了 recent title history 或高频标题词，必须主动避开重复词根和高频意象)

=== CHAPTER_CONTENT ===
(正文内容，目标${lengthSpec.target}字，允许区间${lengthSpec.softMin}-${lengthSpec.softMax}字)

${postSettlement}

=== UPDATED_STATE ===
(更新后的完整状态卡，Markdown表格格式)
${updatedLedger}
=== UPDATED_HOOKS ===
(更新后的完整伏笔池，Markdown表格格式)

=== CHAPTER_SUMMARY ===
(本章摘要，Markdown表格格式，必须包含以下列)
| 章节 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 章节类型 |
|------|------|----------|----------|----------|----------|----------|----------|
| N | 本章标题 | 角色1,角色2 | 一句话概括 | 关键变化 | H01埋设/H02推进 | 情绪走向 | ${gp.chapterTypes.length > 0 ? gp.chapterTypes.join("/") : "过渡/冲突/高潮/收束"} |

=== UPDATED_SUBPLOTS ===
(更新后的完整支线进度板，Markdown表格格式)
| 支线ID | 支线名 | 相关角色 | 起始章 | 最近活跃章 | 距今章数 | 状态 | 进度概述 | 回收ETA |
|--------|--------|----------|--------|------------|----------|------|----------|---------|

=== UPDATED_EMOTIONAL_ARCS ===
(更新后的完整情感弧线，Markdown表格格式)
| 角色 | 章节 | 情绪状态 | 触发事件 | 强度(1-10) | 弧线方向 |
|------|------|----------|----------|------------|----------|

=== UPDATED_CHARACTER_MATRIX ===
(更新后的角色矩阵，每个角色一个 ## 块)

## 角色名
- **定位**: 主角 / 反派 / 盟友 / 配角 / 提及
- **标签**: 核心身份标签
- **反差**: 打破刻板印象的独特细节
- **说话**: 说话风格概述
- **性格**: 性格底色
- **动机**: 根本驱动力
- **当前**: 本章即时目标
- **关系**: 某角色(关系性质/Ch#) | ...
- **已知**: 该角色已知的信息（仅限亲历或被告知）
- **未知**: 该角色不知道的信息`;
}

// ---------------------------------------------------------------------------
// English output formats (parser keys off the === MARKER === anchors, so the
// table labels below are safely localized; persisted artifacts read English).
// ---------------------------------------------------------------------------

function buildEnglishPreWriteTable(gp: GenreProfile): string {
  const resourceRow = gp.numericalSystem
    ? "| Current resource total | X | match the ledger |\n| This chapter's gain | +X (source) | write +0 if none |\n"
    : "";

  return `=== PRE_WRITE_CHECK ===
(Output a Markdown table. Every row aligns with the seven chapter_memo sections, not the volume outline.)
| Check | This chapter | Note |
|-------|--------------|------|
| Current task | Restate the chapter_memo "Current task" and the concrete action this chapter takes | Be specific, not abstract |
| What the reader is waiting for | How this chapter handles it: create / delay / pay off | Match the memo |
| Pay off / keep hidden | Foreshadowing to pay off + cards that must stay down | Quote the memo |
| Routine / transition duty | If any routine or transition passage exists, state each one's function | Match the memo mapping |
| Required end-of-chapter change | 1-3 concrete changes from the memo's end-of-chapter change | Must land on the page |
| Do not | Restate the memo "Do not" list | The prose must not touch these |
| Context range | Ch X to Ch Y / state card / setting files | |
| Current anchor | Location / opponent / payoff goal | Anchor must be concrete |
${resourceRow}| Hooks to resolve | Real hook_id (write none if absent) | Match the hook pool |
| This chapter's conflict | One line | |
| Chapter type | ${gp.chapterTypes.join(" / ")} | |
| Risk scan | OOC / info leak / canon conflict${gp.powerScaling ? " / power-scaling break" : ""} / pacing / word fatigue | |`;
}

function buildEnglishContentBlocks(lengthSpec: LengthSpec): string {
  const unit = lengthSpec.countingMode === "ko_chars" ? "Korean characters including spaces" : "words";
  return `=== CHAPTER_TITLE ===
(Chapter title, without "Chapter X". It must differ from existing titles; do not reuse the same or similar titles. If recent title history or high-frequency title words are provided, avoid repeated roots and overused imagery.)

=== CHAPTER_CONTENT ===
(Chapter prose. Target ${lengthSpec.target} ${unit}, acceptable range ${lengthSpec.softMin}-${lengthSpec.softMax} ${unit}.)`;
}

function buildEnglishCreativeOutputFormat(_book: BookConfig, gp: GenreProfile, lengthSpec: LengthSpec): string {
  return `## Output Format (follow strictly)

${buildEnglishPreWriteTable(gp)}

${buildEnglishContentBlocks(lengthSpec)}

[Important] Output only the three blocks above (PRE_WRITE_CHECK, CHAPTER_TITLE, CHAPTER_CONTENT). State cards, hook pool, and summaries are handled by the later settlement stage; do not output them.`;
}

function buildEnglishOutputFormat(_book: BookConfig, gp: GenreProfile, lengthSpec: LengthSpec): string {
  const postSettlement = gp.numericalSystem
    ? `=== POST_SETTLEMENT ===
(If any numerical change occurred, output a Markdown table.)
| Item | This chapter | Note |
|------|--------------|------|
| Resource ledger | open X / gain +Y / close Z | write +0 if none |
| Key resources | name -> contribution +Y (basis) | write "none" if none |
| Hook changes | new / resolved / deferred hook | sync the hook pool |`
    : `=== POST_SETTLEMENT ===
(If any hook changed, output this.)
| Item | This chapter | Note |
|------|--------------|------|
| Hook changes | new / resolved / deferred hook | sync the hook pool |`;

  const updatedLedger = gp.numericalSystem
    ? `\n=== UPDATED_LEDGER ===\n(The full updated resource ledger, Markdown table.)`
    : "";

  return `## Output Format (follow strictly)

${buildEnglishPreWriteTable(gp)}

${buildEnglishContentBlocks(lengthSpec)}

${postSettlement}

=== UPDATED_STATE ===
(The full updated state card, Markdown table.)
${updatedLedger}
=== UPDATED_HOOKS ===
(The full updated hook pool, Markdown table.)

=== CHAPTER_SUMMARY ===
(Chapter summary as a Markdown table with these columns.)
| Chapter | Title | Characters | Key events | State change | Hook dynamics | Emotional tone | Chapter type |
|---------|-------|------------|------------|--------------|---------------|----------------|--------------|
| N | this chapter's title | Char1, Char2 | one-line summary | key change | H01 planted / H02 advanced | emotional arc | ${gp.chapterTypes.length > 0 ? gp.chapterTypes.join(" / ") : "transition / conflict / climax / resolution"} |

=== UPDATED_SUBPLOTS ===
(The full updated subplot board, Markdown table.)
| Subplot ID | Name | Characters | Start ch | Last active ch | Chapters since | Status | Progress | Resolve ETA |
|------------|------|------------|----------|----------------|----------------|--------|----------|-------------|

=== UPDATED_EMOTIONAL_ARCS ===
(The full updated emotional arcs, Markdown table.)
| Character | Chapter | Emotional state | Trigger | Intensity (1-10) | Arc direction |
|-----------|---------|-----------------|---------|------------------|---------------|

=== UPDATED_CHARACTER_MATRIX ===
(The updated character matrix, one ## block per character.)

## Character Name
- **Role**: protagonist / antagonist / ally / supporting / mentioned
- **Tags**: core identity tags
- **Contrast**: a distinctive detail that breaks the stereotype
- **Voice**: how they speak
- **Personality**: underlying temperament
- **Motivation**: core driving force
- **Current**: this chapter's immediate goal
- **Relations**: Character (relationship / Ch#) | ...
- **Knows**: what this character knows (only what they witnessed or were told)
- **Unknown**: what this character does not know`;
}
