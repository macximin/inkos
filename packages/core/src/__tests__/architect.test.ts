import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArchitectAgent,
  findUnauthorizedMandatoryMoralCorrections,
  findUnauthorizedMandatoryMoralCorrectionsInText,
  isExactTextAuthorizedBySources,
  resolveFutureAdvantageFoundationMode,
} from "../agents/architect.js";
import type { BookConfig } from "../models/book.js";
import type { LLMClient } from "../llm/provider.js";

const ZERO_USAGE = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
} as const;

const KOREAN_FOUNDATION_OUTPUT = [
  "=== SECTION: story_frame ===",
  "## 01_독자가_기대할_재미",
  "주인공이 첫 거래를 성사시킨다.",
  "",
  "=== SECTION: volume_map ===",
  "## 01_권별_승부와_감정",
  "제1권 (1-20화)에서 첫 회사를 인수한다.",
  "",
  "=== SECTION: roles ===",
  "---ROLE---",
  "tier: major",
  "name: 한도경",
  "---CONTENT---",
  "## 첫인상과 버릇",
  "계약서를 읽을 때 숫자를 손가락으로 짚는다.",
  "",
  "=== SECTION: book_rules ===",
  "## 주인공",
  "- 이름: 한도경",
  "",
  "=== SECTION: pending_hooks ===",
  "| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | payoff_timing | depends_on | pays_off_in_arc | core_hook | half_life | notes |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  "| H001 | 0 | 인수 | deferred | 0 | 채권 회수 | near-term | none | 1권 중반 | true | 10 | 부도어음 장부 |",
].join("\n");

const KOREAN_FUTURE_FOUNDATION_OUTPUT = KOREAN_FOUNDATION_OUTPUT.replace(
  "## 주인공\n- 이름: 한도경",
  [
    "## 주인공",
    "- 이름: 한도경",
    "",
    "## 미래 선점",
    "- 활성화: true",
    "- 회귀 기준 시점: 1996년 12월",
    "- 핵심 재미: 미래의 승자를 현재의 자원으로 먼저 차지한다",
    "- 허용 분야: 금융, 경영, 기술, 인재",
    "- 알고 있는 것: 외환 위기의 큰 방향, 훗날의 산업 승자",
    "- 모르는 것: 정확한 날짜, 현재의 구현법, 타인의 선택",
    "- 금지된 지름길: 무한 자금, 완성 설계도 암기, 저항 없는 도입",
    "- 기억 원칙: 역사가 바뀔수록 세부 기억의 신뢰도가 낮아진다",
    "- 검색 정책: 핵심 주장 필수",
  ].join("\n"),
);

function koreanBook(overrides: Partial<BookConfig> = {}): BookConfig {
  return {
    id: "korean-book",
    title: "IMF를 독식한 재벌 3세",
    platform: "other",
    genre: "urban",
    status: "active",
    targetChapters: 200,
    chapterWordCount: 5000,
    language: "ko",
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

function koreanArchitect(): ArchitectAgent {
  return new ArchitectAgent({
    client: {
      provider: "openai",
      apiFormat: "chat",
      stream: false,
      defaults: {
        temperature: 0.7,
        maxTokens: 4096,
        thinkingBudget: 0,
        extra: {},
      },
    },
    model: "test-model",
    projectRoot: process.cwd(),
  });
}

describe("ArchitectAgent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses a Korean-native fun-first prompt for a new Korean work", async () => {
    const agent = koreanArchitect();
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({ content: KOREAN_FOUNDATION_OUTPUT, usage: ZERO_USAGE });

    await agent.generateFoundation(koreanBook());

    const messages = chat.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("한국 상업 웹소설을 기획하는 작가");
    expect(messages[0]?.content).toContain("## 재미적 정합성");
    expect(messages[0]?.content).toContain("독자가 다음 화를 누르게 할 사건과 보상");
    expect(messages[0]?.content).toContain("## 01_독자가_기대할_재미");
    expect(messages[0]?.content).toContain("## 02_주인공의_승부와_적");
    expect(messages[0]?.content).toContain("몇 화마다 훅 하나");
    expect(messages[0]?.content).toContain("화말은 완전한 수습, 보상의 후과, 다음 선택이나 압력을 작품에 맞게 섞고");
    expect(messages[0]?.content).toContain("눈에 보이는 보상을 먼저 지급");
    expect(messages[0]?.content).toContain("자연스럽게 생기는 선택·후과·압력 또는 완결된 결산");
    expect(messages[0]?.content).not.toContain("권말의 새 문제");
    expect(messages[0]?.content).not.toContain("상대의 대응과 다음 문제");
    expect(messages[0]?.content).not.toContain("얻은 것 때문에 생긴 새 문제");
    expect(messages[0]?.content).not.toContain("첫 30화의 보상 간격은 숫자로 적습니다");
    expect(messages[0]?.content).toContain("추상어가 스스로 움직이게 쓰지 않습니다");
    expect(messages[0]?.content).toContain("변화 없음과 대가 없음도 합법");
    expect(messages[0]?.content).toContain("범죄·비도덕적 선택을 했다는 이유만으로 반성·개심·속죄를 만들지 않습니다");
    expect(messages[0]?.content).toContain("사용자 지시나 기존 Book 정본에서 확인되는 금지만");
    expect(messages[0]?.content).not.toContain("어떤 대가를 치렀는지 적습니다");
    expect(messages[0]?.content).not.toContain("작품이 편해져도 시키지 않을 행동");
    expect(messages[0]?.content).not.toContain("전경_배경_이야기");
    expect(messages[0]?.content).not.toContain("You are the architect of this book");
    expect(messages[1]?.content).toBe("제목이 \"IMF를 독식한 재벌 3세\"인 urban 장편소설의 전체 작품 기반을 한국어로 생성하세요.");
  });

  it("flags unrequested mandatory moral correction across every production-steering foundation surface", () => {
    const output = {
      storyBible: "The crime cannot go unpunished.",
      volumeOutline: "The victory must not end without a moral consequence.",
      bookRules: "## 금지 사항\n- 죄의 값을 치르다.",
      currentState: "",
      pendingHooks: "| H009 | 결말 | 대가 없는 승리로 끝나서는 안 된다. |",
      storyFrame: "그의 범죄는 성공한다. 그러나 결말에서는 반드시 반성하고 속죄해야 한다.",
      volumeMap: "罪行不能不受惩罚。",
      rhythmPrinciples: "不能以毫无代价的胜利收场。",
      roles: [{
        tier: "major" as const,
        name: "한도경",
        content: "He must pay for his crimes.",
      }],
    };

    const findings = findUnauthorizedMandatoryMoralCorrections(output);
    expect(findings).toEqual(expect.arrayContaining([
      "그러나 결말에서는 반드시 반성하고 속죄해야 한다.",
      "The crime cannot go unpunished.",
      "The victory must not end without a moral consequence.",
      "He must pay for his crimes.",
      "- 죄의 값을 치르다.",
      "| H009 | 결말 | 대가 없는 승리로 끝나서는 안 된다.",
      "罪行不能不受惩罚。",
      "不能以毫无代价的胜利收场。",
    ]));
  });

  it("preserves concrete causal consequences and exact owner/canon-authorized moral events", () => {
    const output = {
      storyBible: "법원이 증거를 채택해 징역 3년을 선고하고, 그는 수감된다.",
      volumeOutline: "The witness testimony leads to arrest and a prison sentence.",
      bookRules: "## 세계 법칙\n- 계약 위반 시 담보권이 실행된다.",
      currentState: "",
      pendingHooks: "",
      storyFrame: "결말에서는 반드시 반성하고 속죄해야 한다.",
      roles: [],
    };
    expect(findUnauthorizedMandatoryMoralCorrections(
      output,
      "결말에서는 반드시 반성하고 속죄해야 한다.",
    )).toEqual([]);
  });

  it("blocks whitespace and accountability aliases without treating causal consequences as moral quotas", () => {
    const base = {
      storyBible: "",
      volumeOutline: "",
      bookRules: "",
      currentState: "",
      pendingHooks: "",
      roles: [],
    };
    for (const storyFrame of [
      "He must\nbe punished for his crimes.",
      "He must ultimately face accountability for his crimes.",
      "The story ensures that his crimes receive a reckoning.",
      "He must be _punished_ for his crimes.",
      "He must be<br>punished for his crimes.",
    ]) {
      expect(findUnauthorizedMandatoryMoralCorrections({ ...base, storyFrame }))
        .not.toEqual([]);
    }

    expect(findUnauthorizedMandatoryMoralCorrections({
      ...base,
      storyFrame: "The forged transfer leaves a paper trail; investigators arrest him under the statute, and the board removes him under the bylaws.",
    })).toEqual([]);
    expect(findUnauthorizedMandatoryMoralCorrections({
      ...base,
      storyFrame: "결말에서 그는 범죄 책임을 밝히기 위해 장부를 법원에 제출한다.",
    })).toEqual([]);
    expect(findUnauthorizedMandatoryMoralCorrections({
      ...base,
      storyFrame: "The story requires investigators to establish accountability for the fraud through bank records and sworn testimony.",
    })).toEqual([]);
  });

  it("blocks justice and ruin aliases in EN, KO, and ZH while preserving concrete causality", () => {
    const base = {
      storyBible: "",
      volumeOutline: "",
      bookRules: "",
      currentState: "",
      pendingHooks: "",
      roles: [],
    };
    const mandates = [
      "The story must ensure that the fraudster faces justice for his crimes.",
      "The protagonist must answer for his crimes before the ending.",
      "The story must explicitly condemn the protagonist for his crimes.",
      "The narrative should make clear that his criminal conduct is wrong.",
      "The protagonist must not be rewarded for his crimes.",
      "The ending must provide moral balance after the protagonist commits fraud.",
      "The chapter must show a safer alternative to the protagonist’s violent solution.",
      "The story should avoid normalizing or glorifying the protagonist’s abuse.",
      "The chapter must include diverse representation.",
      "Female characters must have agency and a positive portrayal.",
      "Queer characters must have agency and must not be portrayed negatively.",
      "Minority characters must be portrayed positively.",
      "Avoid stereotypes and offensive language.",
      "The villain must not belong to a protected group.",
      "The story must balance every male viewpoint with a female viewpoint.",
      "Ensure the cast is diverse.",
      "Include at least one woman, one queer character, and one racial minority in every arc.",
      "Every chapter requires inclusive representation.",
      "All female leads should be empowered and sympathetic.",
      "No protected-group character may be portrayed as evil.",
      "The antagonist cannot be gay.",
      "The narrative may not use offensive language or perpetuate harmful stereotypes.",
      "사기꾼 주인공은 결말에서 반드시 파멸해야 한다.",
      "범죄를 저지른 주인공이 무사히 승리하게 두지 않는다.",
      "범죄를 저지른 주인공을 서사가 반드시 비판해야 한다.",
      "주인공의 폭력을 미화하거나 정상화해서는 안 된다.",
      "결말은 반드시 도덕적 균형을 회복해야 한다.",
      "이번 화에는 반드시 다양한 대표성을 포함한다.",
      "모든 회차에 여성 인물을 최소 한 명씩 포함해야 한다.",
      "각 화마다 여성 인물을 하나 이상 배치한다.",
      "소수자 캐릭터는 악역으로 설정하지 않는다.",
      "여성 캐릭터는 항상 주체적으로 묘사할 것.",
      "모든 남성 시점에는 여성 시점을 균형 있게 붙인다.",
      "여성 인물에게는 반드시 주도성과 긍정적 묘사를 부여한다.",
      "퀴어 인물은 부정적으로 묘사해서는 안 된다.",
      "고정관념과 불쾌감을 줄 수 있는 표현을 피한다.",
      "악역은 소수자 집단에 속하면 안 된다.",
      "각 회차마다 여성, 퀴어, 소수자 인물을 최소 한 명씩 넣는다.",
      "등장인물 구성을 다양하게 유지해야 한다.",
      "여성 주연은 모두 주체적이고 호감 가게 묘사한다.",
      "소수자 인물을 악인으로 묘사하지 않는다.",
      "악역을 성소수자로 설정하면 안 된다.",
      "매 회차 포용적 대표성을 확보한다.",
      "故事必须让作恶的主角最终接受正义审判。",
      "故事必须明确谴责主角的犯罪行为。",
      "叙事不得美化或正常化主角的暴力。",
      "结局必须恢复道德平衡。",
      "本章必须包含多元代表性。",
      "女性角色必须有能动性并得到正面描写。",
      "酷儿角色不得被负面描写。",
      "避免刻板印象和冒犯性语言。",
      "反派不得属于受保护群体。",
      "每章至少加入一名女性、一名酷儿和一名少数族裔角色。",
      "确保角色阵容多元化。",
      "所有女性主角都应当坚强、讨喜。",
      "不得把少数群体角色描写成恶人。",
      "反派不能是同性恋。",
    ];
    for (const storyFrame of mandates) {
      expect(findUnauthorizedMandatoryMoralCorrections({ ...base, storyFrame }))
        .not.toEqual([]);
    }

    for (const storyFrame of [
      "Bank records prove the fraud, so the court convicts him under the statute.",
      "분식회계가 드러나 거래처가 계약을 해지했고, 회사는 파산해 주인공도 몰락한다.",
      "证据确凿后，法院依法判决，主角因合同违约失去公司控制权。",
    ]) {
      expect(findUnauthorizedMandatoryMoralCorrections({ ...base, storyFrame }))
        .toEqual([]);
    }

    for (const storyFrame of mandates) {
      expect(findUnauthorizedMandatoryMoralCorrections(
        { ...base, storyFrame },
        [{ kind: "persisted-book-canon", text: storyFrame }],
      )).toEqual([]);
    }
  });

  it("does not treat dismissed or vetoed authority mentions as positive adoption", () => {
    const base = {
      storyBible: "",
      volumeOutline: "",
      bookRules: "",
      currentState: "",
      pendingHooks: "",
      roles: [],
    };
    const en = "The story must ensure that the fraudster faces justice for his crimes.";
    const ko = "사기꾼 주인공은 결말에서 반드시 파멸해야 한다.";
    const zh = "故事必须让作恶的主角最终接受正义审判。";
    const cases = [
      { storyFrame: en, authority: `Reviewer dismissed this requirement: ${en}` },
      { storyFrame: en, authority: `The owner vetoed this rule: ${en}` },
      { storyFrame: en, authority: `${en} was vetoed.` },
      { storyFrame: en, authority: `The owner never approved this rule: ${en}` },
      { storyFrame: en, authority: `The owner said this was not canon: ${en}` },
      { storyFrame: ko, authority: `검토자가 다음 요구를 기각했다: ${ko}` },
      { storyFrame: ko, authority: `${ko}라는 규칙은 폐기했다.` },
      { storyFrame: zh, authority: `评审否决了这条要求：${zh}` },
      { storyFrame: zh, authority: `${zh}这条规则被驳回。` },
    ];
    for (const { storyFrame, authority } of cases) {
      expect(findUnauthorizedMandatoryMoralCorrections(
        { ...base, storyFrame },
        [{ kind: "owner-direction", text: authority }],
      )).not.toEqual([]);
    }
  });

  it("generalizes mandatory representation and moral-duty corrections without blocking cast facts", () => {
    const mandates = [
      "At least half the cast must be women.",
      "Reserve 50 percent of speaking roles for underrepresented groups.",
      "All villains must be cisgender heterosexual men.",
      "Marginalized characters must never be portrayed as perpetrators.",
      "Use inclusive language throughout.",
      "Avoid ableist, sexist, racist, or homophobic tropes.",
      "The story should celebrate diversity and inclusion.",
      "No marginalized identity may be associated with vice.",
      "등장인물 절반 이상을 여성으로 구성해야 한다.",
      "발화 역할의 50퍼센트를 소수자에게 배정한다.",
      "악역은 비장애인 이성애자 남성으로만 설정한다.",
      "소수자 인물을 가해자로 묘사해서는 안 된다.",
      "전반적으로 포용적 언어를 사용한다.",
      "성차별적·인종차별적·동성애 혐오 표현을 피한다.",
      "至少一半角色必须是女性。",
      "把百分之五十的有台词角色分配给少数群体。",
      "所有反派必须是顺性别异性恋男性。",
      "少数群体角色不得被描写为施害者。",
      "全文使用包容性语言。",
      "避免性别歧视、种族歧视或恐同表达。",
      "The narrative has a duty to model responsible behavior.",
      "Ensure readers understand that violence is unacceptable.",
      "Frame the fraud as morally reprehensible.",
      "Never glamorize unethical conduct.",
      "The book should uphold prosocial values.",
      "Treat the abusive protagonist as a cautionary example.",
      "서사는 책임 있는 행동의 본보기가 되어야 한다.",
      "폭력이 용납될 수 없다는 점을 독자가 이해하게 한다.",
      "사기를 도덕적으로 비난받아 마땅한 행위로 묘사한다.",
      "비윤리적 행동을 매력적으로 그리지 않는다.",
      "작품은 건전한 가치를 지켜야 한다.",
      "학대하는 주인공을 반면교사로 다룬다.",
      "叙事有责任示范负责任的行为。",
      "确保读者明白暴力不可接受。",
      "把欺诈描写成应受道德谴责的行为。",
      "绝不美化不道德行为。",
      "作品应当维护正向价值观。",
      "把施虐的主角当作反面教材。",
      "Ensure gender parity among all speaking characters.",
      "Give every woman an independent arc.",
      "Include positive LGBTQ+ role models.",
      "Do not use marginalized identities for villains.",
      "Maintain cultural sensitivity.",
      "Use respectful terminology for marginalized groups.",
      "The narrative must signal disapproval of exploitation.",
      "Never depict abuse without critique.",
      "Do not reward toxic behavior.",
      "Make clear that coercion is wrong.",
      "모든 발화 인물의 성비를 동등하게 맞춘다.",
      "모든 여성 인물에게 독립적인 아크를 부여한다.",
      "소수자 정체성을 악역 설정에 이용하지 않는다.",
      "학대를 비판 없이 묘사해서는 안 된다.",
      "서사는 착취에 대한 비판적 태도를 분명히 해야 한다.",
      "确保所有有台词角色实现性别平衡。",
      "给每位女性角色独立的人物弧。",
      "不得把少数身份用于塑造反派。",
      "不得在缺乏批判的情况下描写虐待。",
      "叙事必须明确反对剥削。",
      "Each chapter is obligated to feature at least one queer character.",
      "It is compulsory for every chapter to include a minority character.",
      "Every chapter shall include diverse representation.",
      "각 화마다 여성 인물을 한 명 이상 넣도록 한다.",
      "매 화 여성 인물을 최소 한 명 배치하도록 한다.",
      "퀴어 캐릭터를 악역으로 쓰지 말 것.",
      "所有章节均应包含多元代表性。",
      "The chapter must include diverse&nbsp;representation.",
      "The chapter must include diverse&#32;representation.",
      "The chapter must include diverse [representation](https://example.test).",
      "The protagonist must re\u00ADpent for his crimes.",
      "The protagonist must rep\uFE0Fent for his crimes.",
      "이번 화에는 반드시 다양한&nbsp;대표성을 포함한다.",
      "本章必须包含多元&nbsp;代表性。",
    ];
    for (const mandate of mandates) {
      expect(findUnauthorizedMandatoryMoralCorrectionsInText(mandate, []))
        .not.toEqual([]);
    }

    for (const fact of [
      "Half the cast are women after the evacuation.",
      "The antagonist is a gay banker whose fraud is exposed by records.",
      "A diplomat uses inclusive language to placate the donors.",
      "The board linked [the representation report](https://example.test) before the meeting.",
      "The invoice contains A&nbsp;B spacing inherited from the vendor export.",
      "반군 지도자는 여성이고 악역은 그의 동생이다.",
      "여성 CFO가 이사회에서 인수안을 승인했다.",
      "The editor sneered, Every chapter shall include diverse representation, before burning the memo.",
      "편집자가 각 화마다 여성 인물을 한 명 이상 넣도록 한다고 비웃었다.",
      "编辑嘲笑道：“所有章节均应包含多元代表性。”",
      "The CFO promoted two women after they won the proxy fight.",
      "여성 CFO가 적대적 공개매수에 성공했다.",
      "法院依据账本证据判处他有罪。",
    ]) {
      expect(findUnauthorizedMandatoryMoralCorrectionsInText(fact, []))
        .toEqual([]);
    }
  });

  it("requires standalone or explicit owner adoption instead of reported exact text", () => {
    const rule = "The story must ensure that the fraudster faces justice for his crimes.";
    const reported = [
      `The reviewer suggested this rule: ${rule}`,
      `The model proposed this rule: ${rule}`,
      `An unapproved suggestion is: ${rule}`,
      `We are discussing whether to adopt this rule: ${rule}`,
      `The current draft says: ${rule}`,
      `The audit report contains this requirement: ${rule}`,
      `For comparison, another book uses: ${rule}`,
      `Remove this rule: ${rule}`,
      `Delete this requirement: ${rule}`,
      `Example of what not to do: ${rule}`,
      `A bad rule would be: ${rule}`,
      `If we chose moral correction, the rule would be: ${rule}`,
      `Should we adopt this rule? ${rule}`,
      `Did the reviewer propose this rule? ${rule}`,
      `The following is only a hypothetical: ${rule}`,
      `Hypothetically, the owner explicitly adopts this rule: ${rule}`,
      `If the owner explicitly adopted this rule, it would be: ${rule}`,
      `The owner might adopt this rule: ${rule}`,
      `The owner may approve this rule later: ${rule}`,
      `The reviewer falsely claimed that the owner explicitly adopts this rule: ${rule}`,
      `Someone wrote that the owner requires this rule: ${rule}`,
      `We asked whether the owner approves this rule: ${rule}`,
      `If owner explicitly adopted this rule: ${rule}`,
      `Suppose the owner explicitly adopts this rule: ${rule}`,
      `Assuming the owner explicitly adopts this rule: ${rule}`,
      `According to the reviewer, the owner explicitly adopts this rule: ${rule}`,
      `A draft memo alleges that the owner explicitly adopts this rule: ${rule}`,
      `The owner supposedly adopted this rule: ${rule}`,
      `The owner reportedly adopted this rule: ${rule}`,
    ];
    for (const text of reported) {
      expect(isExactTextAuthorizedBySources(rule, [{ kind: "owner-direction", text }]))
        .toBe(false);
    }
    expect(isExactTextAuthorizedBySources(rule, [{ kind: "owner-direction", text: rule }]))
      .toBe(true);
    expect(isExactTextAuthorizedBySources(rule, [{
      kind: "owner-direction",
      text: `The owner explicitly adopts this rule: ${rule}`,
    }])).toBe(true);
    expect(isExactTextAuthorizedBySources(rule, [{
      kind: "owner-direction",
      text: `Owner explicitly adopts this Book rule: ${rule}`,
    }])).toBe(true);
    expect(isExactTextAuthorizedBySources(rule, [{
      kind: "owner-direction",
      text: `I require this Book rule: ${rule}`,
    }])).toBe(true);
  });

  it("preserves exact authority and quoted-source rejection across wrapped whitespace", () => {
    const output = {
      storyBible: "",
      volumeOutline: "",
      bookRules: "",
      currentState: "",
      pendingHooks: "",
      storyFrame: "He must\nbe punished for his crimes.",
      roles: [],
    };
    expect(findUnauthorizedMandatoryMoralCorrections(output, [{
      kind: "owner-direction",
      text: "He must\nbe punished for his crimes.",
    }])).toEqual([]);
    expect(findUnauthorizedMandatoryMoralCorrections(output, [{
      kind: "owner-direction",
      text: "Reviewer wrote \"He must\nbe punished for his crimes.\"; ignore it.",
    }])).not.toEqual([]);
  });

  it("does not authorize a mandate merely because owner context negates or quotes it", () => {
    const output = {
      storyBible: "",
      volumeOutline: "",
      bookRules: "",
      currentState: "",
      pendingHooks: "",
      storyFrame: "He must pay for his crimes. 대가 없는 승리로 끝나서는 안 된다. 罪行不能不受惩罚。",
      roles: [],
    };
    const findings = findUnauthorizedMandatoryMoralCorrections(output, [{
      kind: "owner-direction",
      text: [
        "Do not require that he must pay for his crimes.",
        "사용자는 ‘대가 없는 승리로 끝나서는 안 된다’라는 감리 문구를 거부했다.",
        "不要写“罪行不能不受惩罚”。",
      ].join("\n"),
    }]);
    expect(findings).toEqual(expect.arrayContaining([
      "He must pay for his crimes.",
      "대가 없는 승리로 끝나서는 안 된다.",
      "罪行不能不受惩罚。",
    ]));
  });

  it("repairs an unrequested mandatory moral beat while preserving the foundation", async () => {
    const agent = koreanArchitect();
    const moralized = KOREAN_FOUNDATION_OUTPUT.replace(
      "주인공이 첫 거래를 성사시킨다.",
      "주인공이 첫 거래를 성사시킨다. 결말에서는 반드시 반성하고 속죄해야 한다.",
    );
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValueOnce({ content: moralized, usage: ZERO_USAGE })
      .mockResolvedValueOnce({ content: KOREAN_FOUNDATION_OUTPUT, usage: ZERO_USAGE });

    const result = await agent.generateFoundation(koreanBook());

    expect(chat).toHaveBeenCalledTimes(2);
    const repairMessages = chat.mock.calls[1]?.[0] as Array<{ role: string; content: string }>;
    expect(repairMessages[0]?.content).toContain("의무적 처벌, 반성, 사과, 개심");
    expect(result.storyFrame).not.toContain("속죄해야");
  });

  it("does not treat reviewer/model feedback as authority for a moral mandate", async () => {
    const agent = koreanArchitect();
    const moralized = KOREAN_FOUNDATION_OUTPUT.replace(
      "제1권 (1-20화)에서 첫 회사를 인수한다.",
      "제1권 (1-20화)에서 첫 회사를 인수한다. 대가 없는 승리로 끝나서는 안 된다.",
    );
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValueOnce({ content: moralized, usage: ZERO_USAGE })
      .mockResolvedValueOnce({ content: KOREAN_FOUNDATION_OUTPUT, usage: ZERO_USAGE });

    const result = await agent.generateFoundation(
      koreanBook(),
      undefined,
      "대가 없는 승리로 끝나서는 안 된다.",
    );

    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.volumeMap).not.toContain("대가 없는 승리");
  });

  it("does not treat a free-form positive owner direction as structured moral authority", async () => {
    const agent = koreanArchitect();
    const ownerBeat = "결말에서는 반드시 반성하고 속죄해야 한다.";
    const directed = KOREAN_FOUNDATION_OUTPUT.replace(
      "주인공이 첫 거래를 성사시킨다.",
      `주인공이 첫 거래를 성사시킨다. ${ownerBeat}`,
    );
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValueOnce({ content: directed, usage: ZERO_USAGE })
      .mockResolvedValueOnce({ content: KOREAN_FOUNDATION_OUTPUT, usage: ZERO_USAGE });

    const result = await agent.generateFoundation(koreanBook(), ownerBeat);

    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.storyFrame).not.toContain(ownerBeat);
    expect(result.bookRuleAuthoritySources).toBeUndefined();
  });

  it("does not let free-form revise feedback authorize a mandatory moral event", async () => {
    const agent = koreanArchitect();
    const authorizedBeat = "결말에서는 반드시 반성하고 속죄해야 한다.";
    const revised = KOREAN_FOUNDATION_OUTPUT.replace(
      "주인공이 첫 거래를 성사시킨다.",
      `주인공이 첫 거래를 성사시킨다. ${authorizedBeat}`,
    );
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValueOnce({ content: revised, usage: ZERO_USAGE })
      .mockResolvedValueOnce({ content: KOREAN_FOUNDATION_OUTPUT, usage: ZERO_USAGE });

    const result = await agent.generateFoundation(
      koreanBook(),
      undefined,
      "모델 감리 의견은 권한이 아니다.",
      {
        reviseFrom: {
          storyBible: authorizedBeat,
          volumeOutline: "제1권에서 첫 회사를 인수한다.",
          bookRules: "## 주인공\n- 이름: 한도경",
          characterMatrix: "한도경은 계약서를 읽는다.",
          userFeedback: authorizedBeat,
        },
      },
    );

    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.storyFrame).not.toContain(authorizedBeat);
  });

  it("does not treat a quoted legacy canon suggestion as current moral authority", async () => {
    const agent = koreanArchitect();
    const clean = KOREAN_FOUNDATION_OUTPUT;
    const moralized = clean.replace(
      "주인공이 첫 거래를 성사시킨다.",
      "주인공이 첫 거래를 성사시킨다. He must pay for his crimes.",
    );
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValueOnce({ content: moralized, usage: ZERO_USAGE })
      .mockResolvedValueOnce({ content: clean, usage: ZERO_USAGE });

    const result = await agent.generateFoundation(
      koreanBook(),
      undefined,
      undefined,
      {
        reviseFrom: {
          storyBible: "Reviewer suggested 'He must pay for his crimes'; ignore that suggestion.",
          volumeOutline: "첫 회사를 인수한다.",
          bookRules: "## 주인공\n- 이름: 한도경",
          characterMatrix: "한도경은 계약서를 읽는다.",
          userFeedback: "기존 사건 순서만 다듬는다.",
        },
      },
    );

    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.storyFrame).not.toContain("must pay for his crimes");
  });

  it("keeps Chinese volume-map rhythm concrete without per-chapter hook quotas", async () => {
    const agent = koreanArchitect();
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({ content: KOREAN_FOUNDATION_OUTPUT, usage: ZERO_USAGE });

    await agent.generateFoundation(koreanBook({
      id: "chinese-rhythm-book",
      title: "雾港回灯",
      language: "zh",
    }));

    const messages = chat.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    const system = messages[0]?.content ?? "";
    expect(system).toContain("章末承接 / 完整收束组合");
    expect(system).toContain("不得规定每章章末留钩数量");
    expect(system).toContain("不按固定章数强推");
    expect(system).toContain("最近 3-5 章当作诊断窗口");
    expect(system).not.toContain("按每 3-5 章推进一个 KR");
    expect(system).not.toContain("每个 3-5 章小周期里哪条线必须可见");
    expect(system).not.toContain("钩子密度——每章章末留钩数量");
  });

  it("keeps native Korean genre payoff contracts in the foundation prompt", async () => {
    const agent = koreanArchitect();
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({ content: KOREAN_FOUNDATION_OUTPUT, usage: ZERO_USAGE });

    await agent.generateFoundation(koreanBook({ genre: "현대판타지 재벌물" }));

    const messages = chat.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    const system = messages[0]?.content ?? "";
    expect(system).toContain("## 장르 전용 약속");
    expect(system).toContain("거래 승부");
    expect(system).toContain("저평가 자산 선점");
    expect(system).toContain("보상 장면에는 숫자, 문서, 소유권");
    expect(system).toContain("후보 목록을 채우기 위해 사건이나 보상을 억지로 넣지 않습니다");
  });

  it("requires a future-advantage contract only when the creative brief makes future knowledge core", async () => {
    expect(resolveFutureAdvantageFoundationMode({
      title: "IMF를 독식한 재벌 3세",
      genre: "urban",
      creativeBrief: "IMF 직전으로 회귀한 주인공이 20년 뒤 승자를 먼저 당겨온다.",
    })).toBe("required");
    expect(resolveFutureAdvantageFoundationMode({
      title: "부도어음 추심팀",
      genre: "urban",
      creativeBrief: "1997년을 배경으로 하지만 회귀는 없는 기업 생존물이다.",
    })).toBe("forbidden");

    const agent = koreanArchitect();
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({ content: KOREAN_FUTURE_FOUNDATION_OUTPUT, usage: ZERO_USAGE });

    const result = await agent.generateFoundation(
      koreanBook(),
      "IMF 직전으로 회귀한 주인공이 기술·금융·인재의 미래 승자를 먼저 차지한다.",
    );

    const messages = chat.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("## 미래 선점 판정");
    expect(messages[0]?.content).toContain("완성 설계도 암기, 무한 자금, 저항 없는 도입");
    expect(result.bookRules).toContain("## 미래 선점");
  });

  it("repairs a missing required future-advantage contract instead of silently creating ordinary rules", async () => {
    const agent = koreanArchitect();
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValueOnce({ content: KOREAN_FOUNDATION_OUTPUT, usage: ZERO_USAGE })
      .mockResolvedValueOnce({ content: KOREAN_FUTURE_FOUNDATION_OUTPUT, usage: ZERO_USAGE });

    const result = await agent.generateFoundation(
      koreanBook(),
      "외환 위기 직전으로 회귀해 미래의 산업 승자를 선점한다.",
    );

    expect(chat).toHaveBeenCalledTimes(2);
    const repairMessages = chat.mock.calls[1]?.[0] as Array<{ role: string; content: string }>;
    expect(repairMessages[0]?.content).toContain("book_rules에 미래 선점 섹션");
    expect(result.bookRules).toContain("기억 원칙");
  });

  it("keeps imported Korean manuscripts on the Korean-native architect path", async () => {
    const agent = koreanArchitect();
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({ content: KOREAN_FOUNDATION_OUTPUT, usage: ZERO_USAGE });

    await agent.generateFoundationFromImport(koreanBook(), "# 1화\n\n한도경은 부도어음을 집어 들었다.");

    const messages = chat.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("한국 상업 웹소설을 기획하는 작가");
    expect(messages[0]?.content).toContain("## 가져온 원고를 다루는 법");
    expect(messages[0]?.content).toContain("기존 원고의 재미가 약한 곳도 미화하지 않습니다");
    expect(messages[1]?.content).toContain("기존 원고 자료입니다");
    expect(messages[1]?.content).not.toContain("Write everything in English");
  });

  it("does not launder character dialogue in an imported manuscript into a mandatory moral quota", async () => {
    const agent = koreanArchitect();
    const moralized = KOREAN_FOUNDATION_OUTPUT.replace(
      "주인공이 첫 거래를 성사시킨다.",
      "주인공이 첫 거래를 성사시킨다. 죄의 값을 치러야 한다.",
    );
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValueOnce({ content: moralized, usage: ZERO_USAGE })
      .mockResolvedValueOnce({ content: KOREAN_FOUNDATION_OUTPUT, usage: ZERO_USAGE });

    const foundation = await agent.generateFoundationFromImport(
      koreanBook(),
      "# 1화\n\n악역이 말했다. \"죄의 값을 치러야 한다.\" 한도경은 그 말을 무시했다.",
    );

    expect(chat).toHaveBeenCalledTimes(2);
    expect(foundation.storyFrame).not.toContain("죄의 값을 치러야");
  });

  it("keeps Korean fanfic planning out of the Chinese architect prompt", async () => {
    const agent = koreanArchitect();
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({ content: KOREAN_FOUNDATION_OUTPUT, usage: ZERO_USAGE });

    await agent.generateFanficFoundation(
      koreanBook({ id: "korean-fanfic", title: "빈 시기의 승부" }),
      "# 원작 사실\n- 주인공은 1997년에 서울에 있었다.",
      "canon",
    );

    const messages = chat.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("## 원작 기반 창작 조건");
    expect(messages[0]?.content).toContain("원작에서 확정된 사건은 바꾸지 않습니다");
    expect(messages[0]?.content).not.toContain("你是专业同人架构师");
    expect(messages[1]?.content).toContain("원작 기반 장편의 기획을 한국어로 완성하세요");
  });

  it("infers Korean fanfic prompts from a native Korean genre when language is omitted", async () => {
    const agent = koreanArchitect();
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({ content: KOREAN_FOUNDATION_OUTPUT, usage: ZERO_USAGE });

    await agent.generateFanficFoundation(
      koreanBook({
        id: "korean-fanfic-without-language",
        genre: "현대판타지 재벌물",
        language: undefined,
      }),
      "# 원작 사실\n- 한도경은 부도 어음의 원소유자를 알고 있다.",
      "canon",
    );

    const messages = chat.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("한국 상업 웹소설을 기획하는 작가");
    expect(messages[0]?.content).toContain("## 장르 전용 약속");
    expect(messages[0]?.content).toContain("저평가 자산 선점");
    expect(messages[0]?.content).not.toContain("你是专业同人架构师");
  });

  it("preserves the legacy Chinese fanfic route when an English profile omits language", async () => {
    const agent = koreanArchitect();
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({ content: KOREAN_FOUNDATION_OUTPUT, usage: ZERO_USAGE });

    await agent.generateFanficFoundation(
      koreanBook({
        id: "english-profile-fanfic-without-language",
        title: "The Tower Ledger",
        genre: "litrpg",
        language: undefined,
      }),
      "# Canon\n- The protagonist entered the tower alone.",
      "canon",
    );

    const messages = chat.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("你是专业同人架构师");
    expect(messages[1]?.content).toContain("请为标题为\"The Tower Ledger\"");
    expect(messages[0]?.content).not.toContain("한국 상업 웹소설을 기획하는 작가");
  });

  it("still infers native English for a non-fanfic foundation when language is omitted", async () => {
    const agent = koreanArchitect();
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({ content: KOREAN_FOUNDATION_OUTPUT, usage: ZERO_USAGE });

    await agent.generateFoundation(koreanBook({
      id: "english-profile-foundation-without-language",
      title: "The Tower Ledger",
      genre: "litrpg",
      language: undefined,
    }));

    const messages = chat.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("You are the architect of this book");
    expect(messages[0]?.content).toContain("ALL output");
    expect(messages[0]?.content).toContain("ending carry / clean-closure mix");
    expect(messages[0]?.content).toContain("never a per-chapter hook count");
    expect(messages[0]?.content).not.toContain("hook density");
    expect(messages[1]?.content).toContain("Write everything in English");
    expect(messages[0]?.content).not.toContain("你是");
  });

  it("uses English prompts when generating foundation from imported English chapters", async () => {
    const agent = new ArchitectAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });

    const book: BookConfig = {
      id: "english-book",
      title: "English Book",
      platform: "other",
      genre: "other",
      status: "active",
      targetChapters: 20,
      chapterWordCount: 2200,
      language: "en",
      createdAt: "2026-03-24T00:00:00.000Z",
      updatedAt: "2026-03-24T00:00:00.000Z",
    };

    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: [
          "=== SECTION: story_bible ===",
          "# Story Bible",
          "",
          "=== SECTION: volume_outline ===",
          "# Volume Outline",
          "",
          "=== SECTION: book_rules ===",
          "---",
          "version: \"1.0\"",
          "---",
          "",
          "# Book Rules",
          "",
          "=== SECTION: current_state ===",
          "# Current State",
          "",
          "=== SECTION: pending_hooks ===",
          "# Pending Hooks",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    await agent.generateFoundationFromImport(
      book,
      "Chapter 1: Prelude\n\nA cold wind crossed the harbor.",
    );

    const messages = chat.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("MUST be written in English");
    expect(messages[1]?.content).toContain("Generate the complete foundation");
    expect(messages[1]?.content).not.toContain("请从中反向推导");
  });

  it("does not embed Chinese section headings in imported English foundation prompts", async () => {
    const agent = new ArchitectAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });

    const book: BookConfig = {
      id: "english-book",
      title: "English Book",
      platform: "other",
      genre: "other",
      status: "active",
      targetChapters: 20,
      chapterWordCount: 2200,
      language: "en",
      createdAt: "2026-03-24T00:00:00.000Z",
      updatedAt: "2026-03-24T00:00:00.000Z",
    };

    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: [
          "=== SECTION: story_bible ===",
          "# Story Bible",
          "",
          "=== SECTION: volume_outline ===",
          "# Volume Outline",
          "",
          "=== SECTION: book_rules ===",
          "---",
          "version: \"1.0\"",
          "---",
          "",
          "# Book Rules",
          "",
          "=== SECTION: current_state ===",
          "# Current State",
          "",
          "=== SECTION: pending_hooks ===",
          "# Pending Hooks",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    await agent.generateFoundationFromImport(
      book,
      "Chapter 1: Prelude\n\nA cold wind crossed the harbor.",
    );

    const messages = chat.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    // Phase 5: architect prompts describe the new prose sections. The English
    // import prompt must not slip Chinese section headers into the system text.
    expect(messages[0]?.content).toContain("story_frame");
    expect(messages[0]?.content).toContain("volume_map");
    expect(messages[0]?.content).not.toContain("## 01_世界观");
    expect(messages[0]?.content).not.toContain("## 叙事视角");
  });

  it("embeds reviewer feedback into original foundation regeneration prompts", async () => {
    const agent = new ArchitectAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });

    const book: BookConfig = {
      id: "review-feedback-book",
      title: "雾港回灯",
      platform: "tomato",
      genre: "urban",
      status: "active",
      targetChapters: 60,
      chapterWordCount: 2200,
      language: "zh",
      createdAt: "2026-04-03T00:00:00.000Z",
      updatedAt: "2026-04-03T00:00:00.000Z",
    };

    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: [
          "=== SECTION: story_bible ===",
          "# 故事圣经",
          "",
          "=== SECTION: volume_outline ===",
          "# 卷纲",
          "",
          "=== SECTION: book_rules ===",
          "---",
          "version: \"1.0\"",
          "---",
          "",
          "=== SECTION: current_state ===",
          "# 当前状态",
          "",
          "=== SECTION: pending_hooks ===",
          "# 待回收伏笔",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    await agent.generateFoundation(
      book,
      undefined,
      "请把核心冲突收紧，并明确新空间不是旧案重演。",
    );

    const messages = chat.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("上一轮审核反馈");
    expect(messages[0]?.content).toContain("请把核心冲突收紧");
    expect(messages[0]?.content).toContain("明确新空间不是旧案重演");
    expect(messages[0]?.content).toContain("诊断，不是用户指令或正典");
  });

  it("strips reviewer-authored mandatory moral correction before regeneration", async () => {
    const agent = koreanArchitect();
    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({ content: KOREAN_FOUNDATION_OUTPUT, usage: ZERO_USAGE });

    await agent.generateFoundation(
      koreanBook(),
      undefined,
      "- 첫 인수 승부를 더 구체화한다.\n- 주인공은 죄의 값을 치러야 한다.",
    );

    const messages = chat.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("첫 인수 승부를 더 구체화한다");
    expect(messages[0]?.content).not.toContain("죄의 값을 치러야 한다");
    expect(messages[0]?.content).toContain("감리 진단이지 사용자 지시나 정본이 아닙니다");
  });

  it("embeds reviewer feedback into fanfic foundation regeneration prompts", async () => {
    const agent = new ArchitectAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });

    const book: BookConfig = {
      id: "fanfic-review-feedback-book",
      title: "三体：回声舱",
      platform: "tomato",
      genre: "other",
      status: "active",
      targetChapters: 60,
      chapterWordCount: 2200,
      language: "zh",
      createdAt: "2026-04-03T00:00:00.000Z",
      updatedAt: "2026-04-03T00:00:00.000Z",
    };

    const chat = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: [
          "=== SECTION: story_bible ===",
          "# 故事圣经",
          "",
          "=== SECTION: volume_outline ===",
          "# 卷纲",
          "",
          "=== SECTION: book_rules ===",
          "---",
          "version: \"1.0\"",
          "---",
          "",
          "=== SECTION: current_state ===",
          "# 当前状态",
          "",
          "=== SECTION: pending_hooks ===",
          "# 待回收伏笔",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    await agent.generateFanficFoundation(
      book,
      "# 原作正典\n- 罗辑在面壁计划中留下了一处空档。",
      "canon",
      "请明确分岔点，并用原创冲突替代原作重走。",
    );

    const messages = chat.mock.calls[0]?.[0] as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("上一轮审核反馈");
    expect(messages[0]?.content).toContain("请明确分岔点");
    expect(messages[0]?.content).toContain("原创冲突替代原作重走");
  });

  it("strips assistant-style trailing coda from the final pending hooks section", async () => {
    const agent = new ArchitectAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });

    const book: BookConfig = {
      id: "zh-book",
      title: "雾港回灯",
      platform: "other",
      genre: "other",
      status: "active",
      targetChapters: 50,
      chapterWordCount: 2200,
      language: "zh",
      createdAt: "2026-03-24T00:00:00.000Z",
      updatedAt: "2026-03-24T00:00:00.000Z",
    };

    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: [
          "=== SECTION: story_bible ===",
          "# 故事圣经",
          "",
          "=== SECTION: volume_outline ===",
          "# 卷纲",
          "",
          "=== SECTION: book_rules ===",
          "---",
          "version: \"1.0\"",
          "---",
          "",
          "=== SECTION: current_state ===",
          "# 当前状态",
          "",
          "=== SECTION: pending_hooks ===",
          "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| H01 | 1 | 主线 | 未开启 | 无 | 10章 | 主线核心钩子 |",
          "",
          "如果你愿意，我下一步可以继续为这本《雾港回灯》输出：",
          "1. 前10章逐章细纲",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    const result = await agent.generateFoundation(book);

    // Phase 7 + hotfixes 1/2: ledger renders extended columns — depends_on,
    // pays_off_in_arc, core_hook, half_life (empty when not specified), and
    // promoted (computed at architect time). This hook has no promotion rule
    // firing (core=否, no depends_on, in-volume payoff) so 升级=否.
    expect(result.pendingHooks).toContain("| H01 | 1 | 主线 | 未开启 | 0 | 10章 | 中程 | 无 |  | 否 |  | 否 | 主线核心钩子 |");
    expect(result.pendingHooks).not.toContain("如果你愿意");
    expect(result.pendingHooks).not.toContain("前10章逐章细纲");
  });

  it("normalizes architect pending hooks into runtime-compatible numeric progress columns", async () => {
    const agent = new ArchitectAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });

    const book: BookConfig = {
      id: "zh-book",
      title: "凌晨三点的证词",
      platform: "tomato",
      genre: "urban",
      status: "active",
      targetChapters: 80,
      chapterWordCount: 2000,
      language: "zh",
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:00:00.000Z",
    };

    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: [
          "=== SECTION: story_bible ===",
          "# 故事圣经",
          "",
          "=== SECTION: volume_outline ===",
          "# 卷纲",
          "",
          "=== SECTION: book_rules ===",
          "---",
          "version: \"1.0\"",
          "---",
          "",
          "=== SECTION: current_state ===",
          "# 当前状态",
          "",
          "=== SECTION: pending_hooks ===",
          "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| H13 | 22 | 舆情操盘 | 待推进 | 一家自媒体公司在多个旧案节点同步接单 | 51-60章 | 庄蔓出场后逐步揭露 |",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    const result = await agent.generateFoundation(book);

    expect(result.pendingHooks).toContain("| H13 | 22 | 舆情操盘 | 待推进 | 0 | 51-60章 | 中程 | 无 |  | 否 |  | 否 | 庄蔓出场后逐步揭露（初始线索：一家自媒体公司在多个旧案节点同步接单） |");
  });

  it("keeps chapter-zero seed hooks dormant even when the model labels them open", async () => {
    const agent = new ArchitectAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });

    const book: BookConfig = {
      id: "seed-book",
      title: "地下站台",
      platform: "tomato",
      genre: "urban",
      status: "active",
      targetChapters: 80,
      chapterWordCount: 2000,
      language: "zh",
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:00:00.000Z",
    };

    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: [
          "=== SECTION: story_frame ===",
          "# 故事框架",
          "主角在地下站台追查失踪案。",
          "",
          "=== SECTION: volume_map ===",
          "# 卷纲",
          "第一卷追出站台背后的旧案。",
          "",
          "=== SECTION: roles ===",
          "---ROLE---",
          "tier: major",
          "name: 林渡",
          "---CONTENT---",
          "## 当前现状",
          "他在站台值夜班。",
          "",
          "=== SECTION: book_rules ===",
          "## 主角",
          "- 名字：林渡",
          "",
          "=== SECTION: pending_hooks ===",
          "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 回收节奏 | 上游依赖 | 回收卷 | 核心 | 半衰期 | 备注 |",
          "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
          "| H00 | 0 | 初始状态 | open | 0 | 终局揭开站台旧案 | 慢烧 | 无 | 终卷 | false |  | 站台广播会在无人时自动报出失踪者名字 |",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    const result = await agent.generateFoundation(book);

    expect(result.pendingHooks).toContain("| H00 | 0 | 初始状态 | 暂缓 | 0 | 终局揭开站台旧案 | 慢烧 | 无 | 终卷 | 否 |  | 否 | 站台广播会在无人时自动报出失踪者名字 |");
  });

  it("accepts section labels with spacing and punctuation drift from non-strict models", async () => {
    const agent = new ArchitectAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });

    const book: BookConfig = {
      id: "format-drift-book",
      title: "格式漂移测试",
      platform: "other",
      genre: "other",
      status: "active",
      targetChapters: 20,
      chapterWordCount: 2200,
      language: "zh",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    };

    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: [
          "=== Section：Story Bible ===",
          "# 故事圣经",
          "",
          "=== section: Volume Outline ===",
          "# 卷纲",
          "",
          "=== SECTION: book-rules ===",
          "---",
          "version: \"1.0\"",
          "---",
          "",
          "=== SECTION : current state ===",
          "# 当前状态",
          "",
          "=== SECTION: pending hooks ===",
          "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| H01 | 1 | mystery | open | 0 | 10章 | 初始钩子 |",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    const result = await agent.generateFoundation(book);

    expect(result.storyBible).toBe("# 故事圣经");
    expect(result.volumeOutline).toBe("# 卷纲");
    expect(result.bookRules).toContain("version: \"1.0\"");
    expect(result.currentState).toBe("# 当前状态");
    expect(result.pendingHooks).toContain("| H01 | 1 | mystery | 暂缓 | 0 | 10章 | 中程 | 无 |  | 否 |  | 否 | 初始钩子 |");
  });

  it("throws when a required foundation section is missing", async () => {
    const agent = new ArchitectAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });

    const book: BookConfig = {
      id: "broken-book",
      title: "Broken Book",
      platform: "other",
      genre: "other",
      status: "active",
      targetChapters: 20,
      chapterWordCount: 2200,
      language: "zh",
      createdAt: "2026-03-29T00:00:00.000Z",
      updatedAt: "2026-03-29T00:00:00.000Z",
    };

    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: [
          "=== SECTION: story_bible ===",
          "# 故事圣经",
          "",
          "=== SECTION: volume_outline ===",
          "# 卷纲",
          "",
          "=== SECTION: current_state ===",
          "# 当前状态",
          "",
          "=== SECTION: pending_hooks ===",
          "# 伏笔池",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    await expect(agent.generateFoundation(book)).rejects.toThrow(/book_rules/i);
  });

  it("uses modelCard output budget when generating foundation", async () => {
    const agent = new ArchitectAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });

    const book: BookConfig = {
      id: "max-tokens-book",
      title: "Max Tokens Book",
      platform: "other",
      genre: "other",
      status: "active",
      targetChapters: 20,
      chapterWordCount: 2200,
      language: "zh",
      createdAt: "2026-03-29T00:00:00.000Z",
      updatedAt: "2026-03-29T00:00:00.000Z",
    };

    const chatSpy = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: [
          "=== SECTION: story_bible ===",
          "# 故事圣经",
          "",
          "=== SECTION: volume_outline ===",
          "# 卷纲",
          "",
          "=== SECTION: book_rules ===",
          "---",
          "version: \"1.0\"",
          "---",
          "",
          "=== SECTION: current_state ===",
          "# 当前状态",
          "",
          "=== SECTION: pending_hooks ===",
          "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| H01 | 1 | mystery | open | 0 | 10章 | 初始钩子 |",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    await agent.generateFoundation(book);

    const options = chatSpy.mock.calls[0]?.[1] as { temperature?: number; maxTokens?: number } | undefined;
    expect(options).toEqual(expect.objectContaining({ temperature: 0.8 }));
    expect(options).not.toHaveProperty("maxTokens");
  });

  it("uses modelCard output budget when generating foundation from import", async () => {
    const agent = new ArchitectAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });

    const book: BookConfig = {
      id: "import-max-tokens-book",
      title: "Import Max Tokens Book",
      platform: "other",
      genre: "other",
      status: "active",
      targetChapters: 20,
      chapterWordCount: 2200,
      language: "zh",
      createdAt: "2026-03-29T00:00:00.000Z",
      updatedAt: "2026-03-29T00:00:00.000Z",
    };

    const chatSpy = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: [
          "=== SECTION: story_bible ===",
          "# 故事圣经",
          "",
          "=== SECTION: volume_outline ===",
          "# 卷纲",
          "",
          "=== SECTION: book_rules ===",
          "---",
          "version: \"1.0\"",
          "---",
          "",
          "=== SECTION: current_state ===",
          "# 当前状态",
          "",
          "=== SECTION: pending_hooks ===",
          "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| H01 | 1 | mystery | open | 0 | 10章 | 初始钩子 |",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    await agent.generateFoundationFromImport(book, "第一章正文");

    const options = chatSpy.mock.calls[0]?.[1] as { temperature?: number; maxTokens?: number } | undefined;
    expect(options).toEqual(expect.objectContaining({ temperature: 0.5 }));
    expect(options).not.toHaveProperty("maxTokens");
  });

  it("uses modelCard output budget when generating fanfic foundation", async () => {
    const agent = new ArchitectAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
        defaults: {
          temperature: 0.7,
          maxTokens: 4096,
          thinkingBudget: 0,
          extra: {},
        },
      },
      model: "test-model",
      projectRoot: process.cwd(),
    });

    const book: BookConfig = {
      id: "fanfic-max-tokens-book",
      title: "Fanfic Max Tokens Book",
      platform: "other",
      genre: "fanfic",
      status: "active",
      targetChapters: 20,
      chapterWordCount: 2200,
      language: "zh",
      createdAt: "2026-03-29T00:00:00.000Z",
      updatedAt: "2026-03-29T00:00:00.000Z",
    };

    const chatSpy = vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: [
          "=== SECTION: story_bible ===",
          "# 故事圣经",
          "",
          "=== SECTION: volume_outline ===",
          "# 卷纲",
          "",
          "=== SECTION: book_rules ===",
          "---",
          "version: \"1.0\"",
          "---",
          "",
          "=== SECTION: current_state ===",
          "# 当前状态",
          "",
          "=== SECTION: pending_hooks ===",
          "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
          "| --- | --- | --- | --- | --- | --- | --- |",
          "| H01 | 1 | mystery | open | 0 | 10章 | 初始钩子 |",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    await agent.generateFanficFoundation(book, "正典文本", "canon");

    const options = chatSpy.mock.calls[0]?.[1] as { temperature?: number; maxTokens?: number } | undefined;
    expect(options).toEqual(expect.objectContaining({ temperature: 0.7 }));
    expect(options).not.toHaveProperty("maxTokens");
  });

  // ---- Phase 5 段落式架构稿专项 ----

  // 测试 stub：chat 会被 vi.spyOn 拦截，client.defaults 运行时不会被读取。
  // 故意不填 temperature / maxTokens 等数字——避免在测试里留下"推荐配置"的
  // 错误示范（maxTokens 填错会误导后续抄到生产，触发 CLAUDE.md 禁止的
  // maxTokens 回归）。只保留类型要求的身份字段。
  const buildPhase5Agent = (): ArchitectAgent =>
    new ArchitectAgent({
      client: {
        provider: "openai",
        apiFormat: "chat",
        stream: false,
      } as unknown as LLMClient,
      model: "test-model",
      projectRoot: process.cwd(),
    });

  const phase5Book = (): BookConfig => ({
    id: "phase5-book",
    title: "测试书",
    platform: "qidian",
    genre: "xuanhuan",
    status: "active",
    targetChapters: 50,
    chapterWordCount: 3000,
    language: "zh",
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z",
  });

  it("generateFoundation parses story_frame / volume_map / roles sections", async () => {
    const agent = buildPhase5Agent();
    const book = phase5Book();

    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({
        content: [
          "=== SECTION: story_frame ===",
          "## 主题与基调",
          "段落 1 主题段落。",
          "",
          "## 核心冲突",
          "段落 2 冲突段落。",
          "",
          "=== SECTION: volume_map ===",
          "## 段 1",
          "卷一段落。",
          "",
          "=== SECTION: roles ===",
          "---ROLE---",
          "tier: major",
          "name: 林辞",
          "---CONTENT---",
          "## 核心标签",
          "冷静、执着",
          "",
          "---ROLE---",
          "tier: minor",
          "name: 配角A",
          "---CONTENT---",
          "次要角色描写",
          "",
          "=== SECTION: book_rules ===",
          "---",
          "version: \"1.0\"",
          "protagonist:",
          "  name: 林辞",
          "---",
          "",
          "=== SECTION: pending_hooks ===",
          "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 回收节奏 | 备注 |",
          "|---|---|---|---|---|---|---|---|",
          "| H001 | 1 | 主线 | open | 0 | 3 | 近期 | 初始线索 |",
        ].join("\n"),
        usage: ZERO_USAGE,
      });

    const output = await agent.generateFoundation(book);

    expect(output.storyFrame).toContain("主题与基调");
    expect(output.volumeMap).toContain("段 1");
    expect(output.roles).toBeDefined();
    expect(output.roles!.length).toBe(2);
    expect(output.roles![0]).toMatchObject({ tier: "major", name: "林辞" });
    expect(output.roles![1]).toMatchObject({ tier: "minor", name: "配角A" });
  });

  it("writeFoundationFiles writes outline/ and roles/ when Phase 5 fields present", async () => {
    const { mkdtemp, rm, access, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const agent = buildPhase5Agent();
    const tmpDir = await mkdtemp(join(tmpdir(), "inkos-arch-test-"));
    try {
      await agent.writeFoundationFiles(tmpDir, {
        storyBible: "legacy shim body",
        volumeOutline: "legacy outline",
        bookRules: "---\nversion: \"1.0\"\n---\n",
        currentState: "",
        pendingHooks: "| hook_id |",
        storyFrame: "## 主题\n\n段落内容",
        volumeMap: "## 卷一\n\n卷一段落",
        roles: [
          { tier: "major", name: "林辞", content: "主角描写" },
          { tier: "minor", name: "配角A", content: "配角描写" },
        ],
      }, false, "zh");

      await expect(access(join(tmpDir, "story", "outline", "story_frame.md"))).resolves.not.toThrow();
      await expect(access(join(tmpDir, "story", "outline", "volume_map.md"))).resolves.not.toThrow();
      await expect(access(join(tmpDir, "story", "roles", "主要角色", "林辞.md"))).resolves.not.toThrow();
      await expect(access(join(tmpDir, "story", "roles", "次要角色", "配角A.md"))).resolves.not.toThrow();
      // Shim 文件也要在（向后兼容读取点用）
      await expect(access(join(tmpDir, "story", "story_bible.md"))).resolves.not.toThrow();
      await expect(access(join(tmpDir, "story", "character_matrix.md"))).resolves.not.toThrow();
      await expect(access(join(tmpDir, "story", "book_rules.md"))).resolves.not.toThrow();
      const provenance = JSON.parse(await readFile(
        join(tmpDir, "story", "book_rules.provenance.json"),
        "utf8",
      )) as { compiler?: string; hardRuleCount?: number; diagnosticRuleCount?: number };
      expect(provenance).toMatchObject({
        compiler: "host",
        hardRuleCount: 0,
      });
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("persists exact owner-authored BookRules with source authority while leaving paraphrases diagnostic", async () => {
    const { mkdtemp, rm, writeFile, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { readEffectiveBookRules } = await import("../agents/effective-book-rules.js");
    const agent = koreanArchitect();
    const exactRule = "증거를 조작하지 않는다.";
    const outputWithRule = KOREAN_FOUNDATION_OUTPUT.replace(
      "## 주인공\n- 이름: 한도경",
      `## 주인공\n- 이름: 한도경\n\n## 금지 사항\n- ${exactRule}\n- 증거를 숨기지 않는다.`,
    );
    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({ content: outputWithRule, usage: ZERO_USAGE });
    const foundation = await agent.generateFoundation(
      koreanBook(),
      `작품의 확정 규칙: ${exactRule}`,
      undefined,
      {
        bookRuleAuthoritySources: [{
          source: "user-explicit",
          authorityOrigin: "authenticated-owner-instruction",
          intent: "authorize-rule",
          decisionId: "owner-rule-test-1",
          authorizedByActorId: "owner-test",
          artifactContent: `작품의 확정 규칙: ${exactRule}`,
        }],
      },
    );
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-owner-rule-authority-"));
    try {
      await writeFile(join(bookDir, "book.json"), JSON.stringify(koreanBook()), "utf8");
      await agent.writeFoundationFiles(bookDir, foundation, false, "ko");
      const provenance = JSON.parse(await readFile(
        join(bookDir, "story", "book_rules.provenance.json"),
        "utf8",
      )) as { hardRuleCount: number; diagnosticRuleCount: number; rules: Array<Record<string, unknown>> };
      expect(provenance.hardRuleCount).toBe(1);
      expect(provenance.diagnosticRuleCount).toBe(1);
      expect(provenance.rules.find((rule) => rule.text === exactRule)).toMatchObject({
        source: "user-explicit",
        strength: "hard",
      });
      expect(provenance.rules.find((rule) => rule.text === "증거를 숨기지 않는다.")).toMatchObject({
        source: "model-suggested",
        strength: "diagnostic",
      });
      const effective = await readEffectiveBookRules(bookDir, koreanBook().id);
      expect(effective?.automatic.prohibitions).toEqual([exactRule]);
      expect(effective?.ruleRefs).toHaveLength(1);
    } finally {
      await rm(bookDir, { recursive: true, force: true });
    }
  });

  it("injects separately adopted Studio hard rules and persists owner-adoption receipts", async () => {
    const { mkdtemp, rm, writeFile, readFile, readdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { readEffectiveBookRules } = await import("../agents/effective-book-rules.js");
    const agent = koreanArchitect();
    const exactRule = "주인공은 차명 지분을 포기하지 않는다.";
    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({ content: KOREAN_FOUNDATION_OUTPUT, usage: ZERO_USAGE });
    const foundation = await agent.generateFoundation(
      koreanBook(),
      "비자금 장부를 추적하는 기업 스릴러.",
      undefined,
      {
        bookRuleOwnerDecisions: [{
          collection: "prohibitions",
          text: exactRule,
          decision: "adopt",
          decisionId: "studio-hil:test-owner-rule-1",
          adoptedByActorId: "studio-local-owner",
        }],
      },
    );
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-owner-adoption-rule-"));
    try {
      await writeFile(join(bookDir, "book.json"), JSON.stringify(koreanBook()), "utf8");
      await agent.writeFoundationFiles(bookDir, foundation, false, "ko");
      const rulesFile = await readFile(join(bookDir, "story", "book_rules.md"), "utf8");
      expect(rulesFile).toContain(exactRule);
      const provenance = JSON.parse(await readFile(
        join(bookDir, "story", "book_rules.provenance.json"),
        "utf8",
      )) as { hardRuleCount: number; rules: Array<Record<string, unknown>> };
      expect(provenance.hardRuleCount).toBe(1);
      expect(provenance.rules.find((rule) => rule.text === exactRule)).toMatchObject({
        source: "user-explicit",
        strength: "hard",
        ownerAdoption: {
          decision: "adopt",
          decisionId: "studio-hil:test-owner-rule-1",
          adoptedByActorId: "studio-local-owner",
        },
      });
      const receiptFiles = await readdir(join(bookDir, "story", "authority", "book-rules", "receipts"));
      expect(receiptFiles).toHaveLength(1);
      const receipt = JSON.parse(await readFile(
        join(bookDir, "story", "authority", "book-rules", "receipts", receiptFiles[0]!),
        "utf8",
      )) as Record<string, unknown>;
      expect(receipt).toMatchObject({
        receiptType: "book-rule-owner-adoption",
        decision: "adopt",
        decisionId: "studio-hil:test-owner-rule-1",
        adoptedByActorId: "studio-local-owner",
      });
      const effective = await readEffectiveBookRules(bookDir, koreanBook().id);
      expect(effective?.automatic.prohibitions).toContain(exactRule);
      expect(effective?.ruleRefs).toHaveLength(1);
    } finally {
      await rm(bookDir, { recursive: true, force: true });
    }
  });

  it("does not grant BookRule authority from quoted, removal, dismissed, or vetoed mentions", async () => {
    const { mkdtemp, rm, writeFile, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const agent = koreanArchitect();
    const rule = "증거를 조작하지 않는다.";
    const outputWithRule = KOREAN_FOUNDATION_OUTPUT.replace(
      "## 주인공\n- 이름: 한도경",
      `## 주인공\n- 이름: 한도경\n\n## 금지 사항\n- ${rule}`,
    );
    const reportedContexts = [
      `The reviewer suggested this rule: ${rule}`,
      `The model proposed this rule: ${rule}`,
      `An unapproved suggestion is: ${rule}`,
      `We are discussing whether to adopt this rule: ${rule}`,
      `The current draft says: ${rule}`,
      `The audit report contains this requirement: ${rule}`,
      `For comparison, another book uses: ${rule}`,
      `Remove this rule: ${rule}`,
      `Delete this requirement: ${rule}`,
      `Example of what not to do: ${rule}`,
      `A bad rule would be: ${rule}`,
      `If we chose moral correction, the rule would be: ${rule}`,
      `Should we adopt this rule? ${rule}`,
      `Did the reviewer propose this rule? ${rule}`,
      `The following is only a hypothetical: ${rule}`,
    ];
    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({ content: outputWithRule, usage: ZERO_USAGE });
    const foundation = await agent.generateFoundation(
      koreanBook(),
      `감리 문구 ‘${rule}’는 삭제한다.`,
      undefined,
      {
        bookRuleAuthoritySources: [{
          source: "user-explicit",
          authorityOrigin: "authenticated-owner-instruction",
          intent: "authorize-rule",
          decisionId: "owner-rule-negative-test-1",
          authorizedByActorId: "owner-test",
          artifactContent: `감리 문구 ‘${rule}’는 삭제한다.`,
        }, {
          source: "user-explicit",
          authorityOrigin: "authenticated-owner-instruction",
          intent: "authorize-rule",
          decisionId: "owner-rule-negative-test-2",
          authorizedByActorId: "owner-test",
          artifactContent: `Reviewer dismissed this requirement: ${rule}`,
        }, {
          source: "user-explicit",
          authorityOrigin: "authenticated-owner-instruction",
          intent: "authorize-rule",
          decisionId: "owner-rule-negative-test-3",
          authorizedByActorId: "owner-test",
          artifactContent: `The owner vetoed this rule: ${rule}`,
        }, ...reportedContexts.map((artifactContent, index) => ({
          source: "user-explicit" as const,
          authorityOrigin: "authenticated-owner-instruction" as const,
          intent: "authorize-rule" as const,
          decisionId: `owner-rule-reported-test-${index + 1}`,
          authorizedByActorId: "owner-test",
          artifactContent,
        }))],
      },
    );
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-owner-rule-negative-"));
    try {
      await writeFile(join(bookDir, "book.json"), JSON.stringify(koreanBook()), "utf8");
      await agent.writeFoundationFiles(bookDir, foundation, false, "ko");
      const provenance = JSON.parse(await readFile(
        join(bookDir, "story", "book_rules.provenance.json"),
        "utf8",
      )) as { hardRuleCount: number; diagnosticRuleCount: number };
      expect(provenance).toMatchObject({ hardRuleCount: 0, diagnosticRuleCount: 1 });
    } finally {
      await rm(bookDir, { recursive: true, force: true });
    }
  });

  it("does not self-authenticate a generic external context as a hard-rule source", async () => {
    const agent = koreanArchitect();
    const rule = "증거를 조작하지 않는다.";
    const outputWithRule = KOREAN_FOUNDATION_OUTPUT.replace(
      "## 주인공\n- 이름: 한도경",
      `## 주인공\n- 이름: 한도경\n\n## 금지 사항\n- ${rule}`,
    );
    vi.spyOn(agent as unknown as { chat: (...args: unknown[]) => Promise<unknown> }, "chat")
      .mockResolvedValue({ content: outputWithRule, usage: ZERO_USAGE });

    const foundation = await agent.generateFoundation(
      koreanBook(),
      `외부 참고 패킷: ${rule}`,
    );

    expect(foundation.bookRuleAuthoritySources).toBeUndefined();
  });

  it("rejects malformed BookRules before revise replaces any foundation or role file", async () => {
    const { mkdtemp, rm, mkdir, writeFile, readFile, access } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const agent = buildPhase5Agent();
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-arch-preflight-"));
    const existingRole = join(bookDir, "story", "roles", "主要角色", "Existing.md");
    const existingFrame = join(bookDir, "story", "outline", "story_frame.md");
    try {
      await mkdir(join(bookDir, "story", "roles", "主要角色"), { recursive: true });
      await mkdir(join(bookDir, "story", "roles", "次要角色"), { recursive: true });
      await mkdir(join(bookDir, "story", "outline"), { recursive: true });
      await writeFile(existingRole, "existing role", "utf8");
      await writeFile(existingFrame, "existing frame", "utf8");

      await expect(agent.writeFoundationFiles(bookDir, {
        storyBible: "legacy",
        volumeOutline: "legacy",
        bookRules: "# Book Rules (compat pointer — deprecated)\n\n> This file is kept for external readers only.",
        currentState: "",
        pendingHooks: "| hook_id |",
        storyFrame: "replacement frame",
        volumeMap: "replacement map",
        roles: [{ tier: "major", name: "Replacement", content: "replacement role" }],
      }, false, "zh", "revise")).rejects.toThrow(/BookRules output is not parseable/);

      expect(await readFile(existingRole, "utf8")).toBe("existing role");
      expect(await readFile(existingFrame, "utf8")).toBe("existing frame");
      await expect(access(join(bookDir, "story", "roles", "主要角色", "Replacement.md"))).rejects.toThrow();
    } finally {
      await rm(bookDir, { recursive: true, force: true });
    }
  });

  it("validates owner authority receipts before revise replaces existing role files", async () => {
    const { mkdtemp, rm, mkdir, writeFile, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const agent = buildPhase5Agent();
    const bookDir = await mkdtemp(join(tmpdir(), "inkos-arch-authority-preflight-"));
    const existingRole = join(bookDir, "story", "roles", "主要角色", "Existing.md");
    const rule = "Do not fabricate evidence.";
    try {
      await mkdir(join(bookDir, "story", "roles", "主要角色"), { recursive: true });
      await writeFile(existingRole, "existing role", "utf8");

      await expect(agent.writeFoundationFiles(bookDir, {
        storyBible: "legacy",
        volumeOutline: "legacy",
        bookRules: `## Prohibitions\n- ${rule}`,
        currentState: "",
        pendingHooks: "| hook_id |",
        storyFrame: "replacement frame",
        volumeMap: "replacement map",
        roles: [{ tier: "major", name: "Replacement", content: "replacement role" }],
        bookRuleAuthoritySources: [{
          source: "user-explicit",
          authorityOrigin: "authenticated-owner-instruction",
          intent: "authorize-rule",
          decisionId: "invalid-actor-preflight-test-1",
          authorizedByActorId: "invalid actor id with spaces",
          artifactContent: `Owner rule: ${rule}`,
        }],
      }, false, "zh", "revise")).rejects.toThrow();

      expect(await readFile(existingRole, "utf8")).toBe("existing role");
    } finally {
      await rm(bookDir, { recursive: true, force: true });
    }
  });

  it("writeFoundationFiles falls back to legacy layout when storyFrame is empty", async () => {
    const { mkdtemp, rm, access, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const agent = buildPhase5Agent();
    const tmpDir = await mkdtemp(join(tmpdir(), "inkos-arch-legacy-test-"));
    try {
      await agent.writeFoundationFiles(tmpDir, {
        storyBible: "# Legacy Story Bible\n",
        volumeOutline: "# Legacy Volume Outline\n",
        bookRules: "# Legacy Book Rules\n",
        currentState: "# Current State\n",
        pendingHooks: "| hook_id |\n",
      }, false, "zh");

      const storyBible = await readFile(join(tmpDir, "story", "story_bible.md"), "utf-8");
      expect(storyBible).toContain("Legacy Story Bible");
      // outline/ 目录是创建的但里面没 story_frame.md
      await expect(access(join(tmpDir, "story", "outline", "story_frame.md"))).rejects.toThrow();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
