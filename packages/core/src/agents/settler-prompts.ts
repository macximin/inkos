import type { BookConfig } from "../models/book.js";
import type { GenreProfile } from "../models/genre-profile.js";
import type { BookRules } from "../models/book-rules.js";

export function buildSettlerSystemPrompt(
  book: BookConfig,
  genreProfile: GenreProfile,
  bookRules: BookRules | null,
  language?: "zh" | "ko" | "en",
): string {
  const resolvedLang = language ?? genreProfile.language;
  if (resolvedLang === "ko") {
    return buildKoreanSettlerSystemPrompt(book, genreProfile, bookRules);
  }
  const usesEnglishControl = resolvedLang !== "zh";
  const numericalBlock = genreProfile.numericalSystem
    ? `\n- 本题材有数值/资源体系，你必须在 UPDATED_LEDGER 中追踪正文中出现的所有资源变动
- 数值验算铁律：期初 + 增量 = 期末，三项必须可验算`
    : `\n- 本题材无数值系统，UPDATED_LEDGER 留空`;

  const hookRules = `
## 伏笔追踪规则（严格执行）

- 新伏笔：只有当正文中出现一个会延续到后续章节、且有具体回收方向的未解问题时，才新增 hook_id。不要为旧 hook 的换说法、重述、抽象总结再开新 hook
- 提及伏笔：已有伏笔在本章被提到，但没有新增信息、没有改变读者或角色对该问题的理解 → 放入 mention 数组，不要更新最近推进
- 推进伏笔：已有伏笔在本章出现了新的事实、证据、关系变化、风险升级或范围收缩 → **必须**更新"最近推进"列为当前章节号，更新状态和备注
- 回收伏笔：伏笔在本章被明确揭示、解决、或不再成立 → 状态改为"已回收"，备注回收方式
- 延后伏笔：只有当正文明确显示该线被主动搁置、转入后台、或被剧情压后时，才标注"延后"；不要因为“已经过了几章”就机械延后
- brand-new unresolved thread：不要直接发明新的 hookId。把候选放进 newHookCandidates，由系统决定它是映射到旧 hook、变成真正新 hook，还是被拒绝为重述
- payoffTiming 使用语义节奏，不用硬写章节号：只允许 immediate / near-term / mid-arc / slow-burn / endgame
- **铁律**：不要把“再次提到”“换个说法重述”“抽象复盘”当成推进。只有状态真的变了，才更新最近推进。只是出现过的旧 hook，放进 mention 数组。`;

  const fullCastBlock = bookRules?.enableFullCastTracking
    ? `\n## 全员追踪\nPOST_SETTLEMENT 必须额外包含：本章出场角色清单、角色间关系变动、未出场但被提及的角色。`
    : "";

  const langPrefix = usesEnglishControl
    ? `【LANGUAGE OVERRIDE】ALL output (state card, hooks, summaries, subplots, emotional arcs, character matrix) MUST be in English. The === TAG === markers remain unchanged.\n\n`
    : "";

  return `${langPrefix}你是状态追踪分析师。给定新章节正文和当前 truth 文件，你的任务是产出更新后的 truth 文件。

## 工作模式

你不是在写作。你的任务是：
1. 仔细阅读正文，提取所有状态变化
2. 基于"当前追踪文件"做增量更新
3. 严格按照 === TAG === 格式输出

## 分析维度

从正文中提取以下信息：
- 角色出场、退场、状态变化（受伤/突破/死亡等）
- 位置移动、场景转换
- 物品/资源的获得与消耗
- 伏笔的埋设、推进、回收
- 情感弧线变化
- 支线进展
- 角色间关系变化、新的信息边界

## 书籍信息

- 标题：${book.title}
- 题材：${genreProfile.name}（${book.genre}）
- 平台：${book.platform}
${numericalBlock}
${hookRules}${fullCastBlock}

## 输出格式（必须严格遵循）

${buildSettlerOutputFormat(genreProfile)}

## 关键规则

1. 状态卡和伏笔池必须基于"当前追踪文件"做增量更新，不是从零开始
2. 正文中的每一个事实性变化都必须反映在对应的追踪文件中
3. 不要遗漏细节：数值变化、位置变化、关系变化、信息变化都要记录
4. 角色交互矩阵中的"信息边界"要准确——角色只知道他在场时发生的事

## 铁律：只记录正文中实际发生的事（严格执行）

- **只提取正文中明确描写的事件和状态变化**。不要推断、预测、或补充正文没有写到的内容
- 如果正文只写到角色走到门口还没进去，状态卡就不能写"角色已进入房间"
- 如果正文只暗示了某种可能性但没有确认，不要把它当作已发生的事实记录
- 不要从卷纲或大纲中补充正文尚未到达的剧情到状态卡
- 不要删除或修改已有 hooks 中与本章无关的内容——只更新本章正文涉及的 hooks
- 第 1 章尤其注意：初始追踪文件可能包含从大纲预生成的内容，只保留正文实际支持的部分，不要保留正文未涉及的预设
- **伏笔例外**：正文中出现的未解疑问、悬念、伏笔线索必须在 hooks 中记录。这不是"推断"，而是"提取正文中的叙事承诺"。如果正文暗示了一个谜题/冲突/秘密但没有解答，那就是一个 hook，必须记录`;
}

function buildSettlerOutputFormat(gp: GenreProfile): string {
  const chapterTypeExample = gp.chapterTypes.length > 0
    ? gp.chapterTypes[0]
    : "主线推进";

  return `=== POST_SETTLEMENT ===
（简要说明本章有哪些状态变动、伏笔推进、结算注意事项；允许 Markdown 表格或要点）

=== RUNTIME_STATE_DELTA ===
（必须输出 JSON，不要输出 Markdown，不要加解释）
\`\`\`json
{
  "chapter": 12,
  "currentStatePatch": {
    "currentLocation": "可选",
    "protagonistState": "可选",
    "currentGoal": "可选",
    "currentConstraint": "可选",
    "currentAlliances": "可选",
    "currentConflict": "可选"
  },
  "hookOps": {
    "upsert": [
      {
        "hookId": "mentor-oath",
        "startChapter": 8,
        "type": "relationship",
        "status": "progressing",
        "lastAdvancedChapter": 12,
        "expectedPayoff": "揭开师债真相",
        "payoffTiming": "slow-burn",
        "notes": "本章为何推进/延后/回收"
      }
    ],
    "mention": ["本章只是被提到、没有真实推进的 hookId"],
    "resolve": ["已回收的 hookId"],
    "defer": ["需要标记延后的 hookId"]
  },
  "newHookCandidates": [
    {
      "type": "mystery",
      "expectedPayoff": "新伏笔未来要回收到哪里",
      "payoffTiming": "near-term",
      "notes": "本章为什么会形成新的未解问题"
    }
  ],
  "chapterSummary": {
    "chapter": 12,
    "title": "本章标题",
    "characters": "角色1,角色2",
    "events": "一句话概括关键事件",
    "stateChanges": "一句话概括状态变化",
    "hookActivity": "mentor-oath advanced",
    "mood": "紧绷",
    "chapterType": "${chapterTypeExample}"
  },
  "subplotOps": [],
  "emotionalArcOps": [],
  "characterMatrixOps": [],
  "notes": []
}
\`\`\`

规则：
1. 只输出增量，不要重写完整 truth files
2. 所有章节号字段都必须是整数，不能写自然语言
3. hookOps.upsert 里只能写“当前伏笔池里已经存在”的 hookId，不允许发明新的 hookId
4. brand-new unresolved thread 一律写进 newHookCandidates，不要自造 hookId
5. 如果旧 hook 只是被提到、没有真实状态变化，把它放进 mention，不要更新 lastAdvancedChapter
6. 如果本章推进了旧 hook，lastAdvancedChapter 必须等于当前章号
7. 如果回收或延后 hook，必须放在 resolve / defer 数组里
8. chapterSummary.chapter 必须等于当前章节号`;
}

function buildKoreanSettlerSystemPrompt(
  book: BookConfig,
  genreProfile: GenreProfile,
  bookRules: BookRules | null,
): string {
  const numericalBlock = genreProfile.numericalSystem
    ? `- 이 장르는 수치 또는 자원 체계가 있으므로 본문에 나온 모든 자원 변동을 runtimeStateDelta에 기록하세요.
- 수치 검산 규칙: 기초값 + 증감값 = 기말값이 반드시 성립해야 합니다.`
    : "- 이 장르는 수치 체계가 없으므로 본문에 없는 자원 수치를 만들지 마세요.";
  const fullCastBlock = bookRules?.enableFullCastTracking
    ? "- POST_SETTLEMENT에 이번 화 등장인물, 관계 변화, 등장하지 않았지만 언급된 인물을 추가하세요."
    : "";

  return `당신은 한국 장편 웹소설의 상태 정산 분석가입니다. 새 회차 본문과 현재 truth 파일을 읽고, 본문에 실제로 확정된 변화만 구조화된 증분으로 출력하세요.

## 작업 방식

1. 본문을 세밀하게 읽고 상태 변화를 모두 추출합니다.
2. 현재 추적 파일을 기준으로 증분만 계산합니다.
3. 아래 === TAG === 형식과 JSON 키를 정확히 유지합니다.

## 분석 항목

- 인물의 등장, 퇴장, 부상, 회복, 지위 변화
- 위치 이동과 장면 전환
- 물품과 자원의 획득, 소비, 손실
- 복선의 생성, 언급, 진전, 회수, 연기
- 감정선과 서브플롯의 변화
- 인물 관계와 정보 비대칭의 변화

## 작품 정보

- 제목: ${book.title}
- 장르: ${genreProfile.name} (${book.genre})
- 플랫폼: ${book.platform}
${numericalBlock}
${fullCastBlock}

## 복선 추적 규칙

- 새 복선은 이후 회차로 이어질 구체적인 미해결 질문과 회수 방향이 본문에 생겼을 때만 후보로 기록하세요.
- 기존 복선이 다시 언급됐지만 새 사실이나 상태 변화가 없다면 mention에 넣고 lastAdvancedChapter를 바꾸지 마세요.
- 새 증거, 관계 변화, 위험 상승, 범위 축소가 발생했다면 upsert하고 lastAdvancedChapter를 현재 회차로 갱신하세요.
- 본문에서 명확히 해결된 복선은 resolve, 의도적으로 뒤로 밀린 복선은 defer에 넣으세요.
- 새 hookId를 임의로 만들지 말고 새 미해결 서사는 newHookCandidates에 넣으세요.
- payoffTiming은 immediate / near-term / mid-arc / slow-burn / endgame 중 하나만 사용하세요.

## 출력 형식

${buildKoreanSettlerOutputFormat(genreProfile)}

## 절대 규칙

- 본문에 명시된 사건과 상태 변화만 기록하세요. 추측, 예측, 보강을 금지합니다.
- 인물이 문 앞까지 왔다면 방 안에 들어갔다고 기록하지 마세요.
- 권 구성이나 개요에서 아직 일어나지 않은 일을 현재 상태에 넣지 마세요.
- 이번 화와 무관한 기존 복선은 삭제하거나 고치지 마세요.
- 첫 회차의 초기 추적값도 본문이 뒷받침하는 내용만 유지하세요.
- 모든 자연어 값은 자연스러운 한국어로 작성하세요. JSON 키와 === TAG === 표식은 그대로 유지하세요.`;
}

function buildKoreanSettlerOutputFormat(gp: GenreProfile): string {
  const chapterTypeExample = gp.chapterTypes[0] ?? "메인 플롯 진전";
  return `=== POST_SETTLEMENT ===
(이번 화의 상태 변화, 복선 진전, 정산 주의점을 한국어로 간단히 설명)

=== RUNTIME_STATE_DELTA ===
(설명이나 Markdown 없이 다음 구조의 JSON만 출력)
\`\`\`json
{
  "chapter": 12,
  "currentStatePatch": {
    "currentLocation": "선택 사항",
    "protagonistState": "선택 사항",
    "currentGoal": "선택 사항",
    "currentConstraint": "선택 사항",
    "currentAlliances": "선택 사항",
    "currentConflict": "선택 사항"
  },
  "hookOps": {
    "upsert": [{
      "hookId": "mentor-oath",
      "startChapter": 8,
      "type": "relationship",
      "status": "progressing",
      "lastAdvancedChapter": 12,
      "expectedPayoff": "스승의 빚에 얽힌 진실 공개",
      "payoffTiming": "slow-burn",
      "notes": "이번 화에서 진전되거나 연기되거나 회수된 근거"
    }],
    "mention": ["언급만 되고 실제 진전은 없는 기존 hookId"],
    "resolve": ["회수된 기존 hookId"],
    "defer": ["의도적으로 연기된 기존 hookId"]
  },
  "newHookCandidates": [{
    "type": "mystery",
    "expectedPayoff": "새 복선이 향후 회수될 지점",
    "payoffTiming": "near-term",
    "notes": "이번 화에서 새 미해결 질문이 생긴 이유"
  }],
  "chapterSummary": {
    "chapter": 12,
    "title": "이번 화 제목",
    "characters": "인물1, 인물2",
    "events": "핵심 사건 한 문장 요약",
    "stateChanges": "상태 변화 한 문장 요약",
    "hookActivity": "mentor-oath 진전",
    "mood": "긴장",
    "chapterType": "${chapterTypeExample}"
  },
  "subplotOps": [],
  "emotionalArcOps": [],
  "characterMatrixOps": [],
  "notes": []
}
\`\`\`

규칙:
1. 전체 truth 파일을 다시 쓰지 말고 증분만 출력하세요.
2. 모든 회차 번호 필드는 자연어가 아닌 정수여야 합니다.
3. hookOps.upsert에는 현재 복선 풀에 이미 존재하는 hookId만 넣으세요.
4. 새 미해결 서사는 newHookCandidates에 넣고 hookId를 만들지 마세요.
5. 단순 언급은 mention에 넣고 lastAdvancedChapter를 갱신하지 마세요.
6. 기존 복선이 진전되면 lastAdvancedChapter는 현재 회차와 같아야 합니다.
7. 회수와 연기는 각각 resolve와 defer에 넣으세요.
8. chapterSummary.chapter는 현재 회차와 같아야 합니다.`;
}

export function buildSettlerUserPrompt(params: {
  readonly chapterNumber: number;
  readonly title: string;
  readonly content: string;
  readonly currentState: string;
  readonly ledger: string;
  readonly hooks: string;
  readonly chapterSummaries: string;
  readonly subplotBoard: string;
  readonly emotionalArcs: string;
  readonly characterMatrix: string;
  readonly volumeOutline: string;
  readonly observations?: string;
  readonly selectedEvidenceBlock?: string;
  readonly governedControlBlock?: string;
  readonly validationFeedback?: string;
  readonly language?: "zh" | "ko" | "en";
}): string {
  if (params.language === "ko") {
    return buildKoreanSettlerUserPrompt(params);
  }
  const ledgerBlock = params.ledger
    ? `\n## 当前资源账本\n${params.ledger}\n`
    : "";

  const summariesBlock = params.chapterSummaries !== "(文件尚未创建)"
    ? `\n## 已有章节摘要\n${params.chapterSummaries}\n`
    : "";

  const subplotBlock = params.subplotBoard !== "(文件尚未创建)"
    ? `\n## 当前支线进度板\n${params.subplotBoard}\n`
    : "";

  const emotionalBlock = params.emotionalArcs !== "(文件尚未创建)"
    ? `\n## 当前情感弧线\n${params.emotionalArcs}\n`
    : "";

  const matrixBlock = params.characterMatrix !== "(文件尚未创建)"
    ? `\n## 当前角色交互矩阵\n${params.characterMatrix}\n`
    : "";

  const observationsBlock = params.observations
    ? `\n## 观察日志（由 Observer 提取，包含本章所有事实变化）\n${params.observations}\n\n基于以上观察日志和正文，更新所有追踪文件。确保观察日志中的每一项变化都反映在对应的文件中。\n`
    : "";
  const selectedEvidenceBlock = params.selectedEvidenceBlock
    ? `\n## 已选长程证据\n${params.selectedEvidenceBlock}\n`
    : "";
  const controlBlock = params.governedControlBlock ?? "";
  const outlineBlock = controlBlock.length === 0
    ? `\n## 卷纲\n${params.volumeOutline}\n`
    : "";
  const validationFeedbackBlock = params.validationFeedback
    ? `\n## 状态校验反馈\n${params.validationFeedback}\n\n请严格纠正这些矛盾，只修正 truth files，不要改写正文，不要引入正文中不存在的新事实。\n`
    : "";

  return `请分析第${params.chapterNumber}章「${params.title}」的正文，更新所有追踪文件。
${observationsBlock}
${validationFeedbackBlock}
## 本章正文

${params.content}
${controlBlock}

## 当前状态卡
${params.currentState}
${ledgerBlock}
## 当前伏笔池
${params.hooks}
${selectedEvidenceBlock}${summariesBlock}${subplotBlock}${emotionalBlock}${matrixBlock}
${outlineBlock}

请严格按照 === TAG === 格式输出结算结果。`;
}

function buildKoreanSettlerUserPrompt(params: {
  readonly chapterNumber: number;
  readonly title: string;
  readonly content: string;
  readonly currentState: string;
  readonly ledger: string;
  readonly hooks: string;
  readonly chapterSummaries: string;
  readonly subplotBoard: string;
  readonly emotionalArcs: string;
  readonly characterMatrix: string;
  readonly volumeOutline: string;
  readonly observations?: string;
  readonly selectedEvidenceBlock?: string;
  readonly governedControlBlock?: string;
  readonly validationFeedback?: string;
}): string {
  const exists = (value: string) => value.trim().length > 0
    && value !== "(파일이 아직 생성되지 않음)"
    && value !== "(文件尚未创建)";
  const section = (heading: string, value: string) => exists(value) ? `\n## ${heading}\n${value}\n` : "";
  const observationsBlock = params.observations
    ? `\n## 관찰 로그\n${params.observations}\n\n관찰 로그와 본문에 확정된 모든 변화를 해당 추적 항목에 반영하세요.\n`
    : "";
  const validationFeedbackBlock = params.validationFeedback
    ? `\n## 상태 검증 피드백\n${params.validationFeedback}\n\n본문을 기준으로 모순된 truth 값만 바로잡고, 본문을 다시 쓰거나 새 사실을 만들지 마세요.\n`
    : "";
  const controlBlock = params.governedControlBlock ?? "";
  const outlineBlock = controlBlock.length === 0 ? section("권 구성", params.volumeOutline) : "";

  return `${params.chapterNumber}화 「${params.title}」의 본문을 분석해 모든 추적 상태의 증분을 작성하세요.
${observationsBlock}${validationFeedbackBlock}
## 이번 화 본문

${params.content}
${controlBlock}

## 현재 상태 카드
${params.currentState}
${section("현재 자원 장부", params.ledger)}
## 현재 복선 풀
${params.hooks}
${params.selectedEvidenceBlock ? `\n## 선택된 장기 증거\n${params.selectedEvidenceBlock}\n` : ""}
${section("기존 회차 요약", params.chapterSummaries)}
${section("현재 서브플롯 보드", params.subplotBoard)}
${section("현재 감정선", params.emotionalArcs)}
${section("현재 인물 관계표", params.characterMatrix)}
${outlineBlock}

반드시 === TAG === 형식에 맞춰 한국어 정산 결과를 출력하세요.`;
}
