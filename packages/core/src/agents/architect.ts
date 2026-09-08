import { webnovelPlanGuidance } from "../planning/webnovel-plan-format.js";
import { BaseAgent } from "./base.js";
import type { BookConfig, FanficMode } from "../models/book.js";
import type { GenreProfile } from "../models/genre-profile.js";
import { readGenreProfile } from "./rules-reader.js";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { renderHookSnapshot } from "../utils/memory-retrieval.js";
import {
  shouldPromoteHook,
  type PromotionContext,
  type VolumeBoundary,
} from "../utils/hook-promotion.js";
import { normalizeStoredHookStatus } from "../utils/hook-lifecycle.js";
import type { StoredHook } from "../state/memory-db.js";
import {
  BookRulesSchema,
  parseBookRules,
  renderBookRulesDocument,
  type BookRules,
} from "../models/book-rules.js";
import {
  carryForwardBookRuleProvenanceEntries,
  compileBookRuleProvenance,
  compileBookRuleOwnerAdoptionReceipt,
  compileBookRuleSourceAuthorityReceipt,
  BookRuleOwnerDecisionInputSchema,
  persistBookRulesPair,
  readBookRuleProvenance,
  verifyBookRuleAuthorityEvidence,
  verifyBookRuleProvenance,
  renderBookRuleOwnerAdoptionReceipt,
  renderBookRuleSourceAuthorityReceipt,
  type BookRuleAuthorityAssignment,
  type BookRuleAuthorityOrigin,
  type BookRuleFieldPath,
  type BookRuleOwnerDecisionInput,
  type BookRuleProvenanceCollection,
  type BookRuleProvenanceReceipt,
  type BookRuleProvenanceEntry,
} from "../models/book-rule-provenance.js";

// ---------------------------------------------------------------------------
// Phase 5 (v13) — Static 骨架 layer collapse
// Phase 5 consolidation — 7 sections → 5 sections (output shrinks ~25–40%).
//
// Architect now produces 2 prose outline files + one-file-per-character roles/
// folder, plus compat pointer shims. The LLM output contract is 5 blocks:
//
//   === SECTION: story_frame ===   4 散文段（主题 / 冲突 / 世界铁律+质感 / 终局）
//   === SECTION: volume_map ===    5 散文段 + 尾段「6 条节奏原则（具体化 + 通用）」
//   === SECTION: roles ===         一人一卡；主角卡承载起点与终点，代价/内在变化按作品需要可选
//   === SECTION: book_rules ===    普通 Markdown 规则卡，宿主负责结构化解析
//   === SECTION: pending_hooks ===  13-column 表；可含 startChapter=0 种子行
//
// Consolidation rules (MUST reflect in prompt):
//   - 主角弧线只写在 roles/<主角>.md，不在 story_frame 重复
//   - 世界铁律/世界质感只写在 story_frame.世界观底色，不在 book_rules 重复
//   - 节奏原则只写在 volume_map 尾段，不作为独立 section
//     （至少 3 条具体化，其余可为通用原则）
//   - 初始状态拆分：角色当前现状 → roles.当前现状；初始钩子 → pending_hooks (startChapter=0)；
//     环境/时代锚（仅历史/年代题材需要）→ 自然融入 story_frame.世界观底色
//   - 独立的 current_state section 已删除。现状只在运行时写入 current_state.md
//     （consolidator 每章追加），建书时架构师不产出结构化初始态。
//
// Budget table (4 content items — LLM sections):
//   story_frame ≤ 3000 chars / volume_map ≤ 5000 chars / roles 总 ≤ 8000 chars
//   book_rules ≤ 1000 chars (Markdown rules card) / pending_hooks ≤ 2000 chars
//
// 输出落盘 contract（未变）：
//   outline/story_frame.md      ← 4 prose sections
//   outline/volume_map.md       ← 5 prose sections + 节奏原则尾段
//   roles/主要角色/<name>.md    ← one file per major character
//   roles/次要角色/<name>.md    ← one file per minor character
//   story_bible.md              ← compat shim
//   character_matrix.md         ← compat shim
//   book_rules.md               ← authoritative Markdown rules card
//   current_state.md            ← seed 占位文件（运行时 consolidator 每章追加）
//   pending_hooks.md            ← 架构师初始伏笔池
//   emotional_arcs.md           ← runtime state
//
// 「散文密度」= 架构师 LLM 的输出密度。所有 prose 都写死在架构师 prompt 里，
// 不从模板复制。v6 灵气的起点在这里。
// ---------------------------------------------------------------------------

export interface ArchitectRole {
  readonly tier: "major" | "minor";
  readonly name: string;
  readonly content: string;
}

export interface ArchitectOutput {
  // Legacy shape — kept for back-compat with consumers that still read the
  // old file names. Filled from the new prose sections below when Phase 5
  // architect runs; external callers see the same surface.
  readonly storyBible: string;
  readonly volumeOutline: string;
  readonly bookRules: string;
  readonly currentState: string;
  readonly pendingHooks: string;
  // Phase 5 new shape. Optional in the type surface so legacy test fixtures
  // that mock only the old fields continue to compile — the architect itself
  // always fills these at runtime.
  readonly storyFrame?: string;
  readonly volumeMap?: string;
  readonly rhythmPrinciples?: string;
  readonly roles?: ReadonlyArray<ArchitectRole>;
  /** Host-only source material used to assign exact BookRule authority at persistence time. */
  readonly bookRuleAuthoritySources?: ReadonlyArray<ArchitectBookRuleAuthoritySource>;
  /** Host-only, separately confirmed owner decisions. General create confirmation cannot populate this. */
  readonly bookRuleOwnerDecisions?: ReadonlyArray<ArchitectBookRuleOwnerDecision>;
}

export interface ArchitectBookRuleAuthoritySource {
  readonly source: "user-explicit" | "premise-explicit" | "book-canon";
  readonly authorityOrigin: BookRuleAuthorityOrigin;
  readonly intent: "authorize-rule";
  readonly decisionId: string;
  readonly authorizedByActorId: string;
  readonly artifactContent: string;
}

export type ArchitectBookRuleOwnerDecision = BookRuleOwnerDecisionInput;

export interface ArchitectMoralAuthoritySource {
  /** Only owner direction and an already-persisted Book foundation may authorize a mandate. */
  readonly kind: "owner-direction" | "persisted-book-canon";
  readonly text: string;
}

interface PreparedArchitectBookRules {
  readonly bookId: string;
  readonly rulesFileContent: string;
  readonly rules: BookRules;
  readonly receipt: BookRuleProvenanceReceipt;
  readonly authorityWrites: ReadonlyMap<string, string>;
}

function appendExactRule(values: ReadonlyArray<string>, text: string): string[] {
  return values.includes(text) ? [...values] : [...values, text];
}

const MANDATORY_MORAL_CORRECTION_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:반드시|무조건|마땅히|필수(?:로)?)[^.!?\n]{0,48}(?:처벌(?:받|하)|벌을\s*받|반성|사과|개심|교화|속죄|갱생|응보|도덕적\s*성장|대가를\s*치|파멸(?:해야|하|시키)|몰락(?:해야|하|시키)|정의의\s*심판(?:을\s*)?(?:받|받아))/giu,
  /(?:처벌|반성|사과|개심|교화|속죄|갱생|응보|대가)[^.!?\n]{0,32}(?:반드시|필수|해야\s*한다|필요하다)/giu,
  /(?:죄(?:의\s*)?값(?:을)?\s*(?:치르다|치러야(?:\s*한다)?|치르게\s*(?:해야\s*한다|한다)))/giu,
  /(?:대가\s*없는\s*승리(?:로)?\s*(?:끝나|마무리되)[^.!?\n]{0,16}(?:서는|면)\s*안\s*(?:된|된다|돼))/giu,
  /(?:범죄|죄|악행)[^.!?\n]{0,32}(?:주인공|범죄자|사기꾼|악인|가해자)[^.!?\n]{0,32}(?:(?:처벌|반성|속죄|응보|대가)\s*없이|무사히)[^.!?\n]{0,24}(?:승리|성공|도망|빠져나가)[^.!?\n]{0,20}(?:두지\s*않|끝나(?:서는|면)\s*안)/giu,
  /(?:주인공|범죄자|사기꾼|악인|가해자)[^.!?\n]{0,32}(?:(?:처벌|반성|속죄|응보|대가)\s*없이|무사히)[^.!?\n]{0,24}(?:승리|성공|도망|빠져나가)[^.!?\n]{0,20}(?:두지\s*않|끝나(?:서는|면)\s*안)/giu,
  /\b(?:must|has to|required to|needs to)\b[^.!?\n]{0,56}\b(?:be punished|repent|apologi[sz]e|reform|rehabilitate|redeem|atone|learn a moral lesson|pay (?:the )?price)\b/giu,
  /\b(?:punishment|remorse|apology|reform|rehabilitation|redemption|atonement|retribution)\b[^.!?\n]{0,40}\b(?:is required|is mandatory|must happen|is necessary)\b/giu,
  /\b(?:must|should|has to|needs to)\b[^.!?\n]{0,32}\bpay\s+for\s+(?:his|her|their|the)?\s*(?:crime|crimes|sin|sins|wrongdoing)\b/giu,
  /\b(?:protagonist|fraudsters?|criminals?|offenders?|wrongdoers?|he|she|they)\b[^.!?\n]{0,32}\b(?:must|should|has to|needs to|required to|is required to)\b[^.!?\n]{0,56}\banswer\s+for\s+(?:his|her|their|the)?\s*(?:crime|crimes|sin|sins|wrongdoing)\b/giu,
  /\b(?:story|plot|narrative|ending|character arc|protagonist(?:'s)? arc|his arc|her arc|their arc)\b[^.!?\n]{0,48}\b(?:must|should|has to|needs to|required to|is required to)\b(?=[^.!?\n]{0,160}\b(?:fraudsters?|criminals?|offenders?|wrongdoers?|crime|crimes|sin|sins|wrongdoing|fraud|murder|abuse|exploitation|betrayal|immorality|unethical conduct)\b)(?=[^.!?\n]{0,160}\b(?:(?:face|faces|faced|receive|receives|received)\s+justice|be\s+brought\s+to\s+justice|justice\s+for\s+(?:his|her|their|the)\s+(?:crime|crimes|sin|sins|wrongdoing))\b)[^.!?\n]{0,160}/giu,
  /\b(?:fraudsters?|criminals?|offenders?|wrongdoers?|the protagonist|he|she|they)\b[^.!?\n]{0,32}\b(?:must|should|has to|needs to|required to|is required to)\b[^.!?\n]{0,80}\b(?:(?:face|faces|faced|receive|receives|received)\s+justice|be\s+brought\s+to\s+justice)\b/giu,
  /\b(?:do\s+not|don't|never)\s+let\b[^.!?\n]{0,48}\b(?:fraudsters?|criminals?|offenders?|wrongdoers?|the protagonist|him|her|them)\b[^.!?\n]{0,48}\b(?:escape|evade|avoid)\s+(?:justice|punishment|accountability|a\s+reckoning)\b/giu,
  /\b(?:crime|crimes|sin|sins|wrongdoing)\b[^.!?\n]{0,24}\b(?:cannot|must not|should not)\s+go\s+unpunished\b/giu,
  /\b(?:victory|the ending|the story)\b[^.!?\n]{0,24}\b(?:must not|should not|cannot)\b[^.!?\n]{0,20}\b(?:without (?:a )?(?:price|cost|moral consequence)|cost[- ]free|consequence[- ]free)\b/giu,
  /(?:必须|务必|一定要|理应)[^。！？\n]{0,48}(?:受罚|惩罚|反省|道歉|改过|教化|赎罪|洗白|得到报应|付出代价|(?:接受|受到|面临)?(?:正义|公正|法律)(?:的)?(?:审判|制裁))/gu,
  /(?:受罚|惩罚|反省|道歉|改过|教化|赎罪|洗白|报应|代价)[^。！？\n]{0,32}(?:必须|不可或缺|是必要的)/gu,
  /(?:罪行|犯罪|恶行|作恶)[^。！？\n]{0,24}(?:不能|不可|不应)(?:[^。！？\n]{0,12})?(?:不受惩罚|没有代价|毫无代价|逍遥法外)/gu,
  /(?:不能|不可|不应)[^。！？\n]{0,24}(?:以|让)[^。！？\n]{0,12}(?:毫无|没有|无)代价(?:的)?胜利(?:收场|结束)/gu,
  /(?:不要|不得|禁止)[^。！？\n]{0,24}让[^。！？\n]{0,24}(?:罪犯|犯罪者|作恶者|主角)[^。！？\n]{0,32}(?:逃脱|逃避)(?:正义|法律)?(?:审判|制裁)/gu,
];

// These patterns cover explicit obligation/inevitability aliases that avoid
// the direct punishment/redemption wording above. They run on a whitespace-
// collapsed copy of each foundation surface so Markdown line wrapping cannot
// turn one mandatory sentence into two apparently unrelated fragments.
const MANDATORY_MORAL_INEVITABILITY_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:must|should|has to|needs to|required to|is required to)\b(?=[^.!?]{0,120}\b(?:accountability|reckoning|moral consequences?)\b)(?=[^.!?]{0,160}\b(?:crime|crimes|sin|sins|wrongdoing|fraud|murder|abuse|exploitation|betrayal|immorality|unethical conduct)\b)[^.!?]{0,160}/giu,
  /\b(?:story|plot|narrative|ending|chapter|character arc|protagonist(?:'s)? arc)\b[^.!?]{0,48}\b(?:must|should|has to|needs to|required to|is required to|must not|should not)\b(?=[^.!?]{0,180}\b(?:crime|crimes|criminal conduct|sin|sins|wrongdoing|fraud|murder|violence|violent|abuse|exploitation|betrayal|immorality|unethical conduct)\b)(?=[^.!?]{0,180}\b(?:condemn|denounce|make\s+clear\b[^.!?]{0,48}\bwrong|moral\s+balance|safer\s+alternative|avoid\b[^.!?]{0,48}\b(?:normaliz|glorif)|not\s+reward|withhold\s+reward)\w*)[^.!?]{0,180}/giu,
  /\b(?:story|chapter|narrative|cast)\b[^.!?]{0,48}\b(?:must|should|has to|needs to|required to|is required to)\b[^.!?]{0,120}\b(?:diverse\s+representation|representational\s+diversity|gender[- ]balanced\s+viewpoints?|balance\s+every\s+male\s+viewpoint\s+with\s+a\s+female\s+viewpoint)\b/giu,
  /(?:^|[.!?]\s+|[-*+]\s+)(?:(?:each|every)\s+chapter\s+(?:is\s+(?:obligated|required)\s+to|shall|must)\s+(?:feature|include|contain)|it\s+is\s+(?:compulsory|mandatory|required)\s+for\s+(?:each|every)\s+chapter\s+to\s+(?:feature|include|contain))[^.!?]{0,96}(?:diverse\s+representation|at\s+least\s+one\s+(?:woman|female|queer|lgbtq?|minority)\s+character|a\s+(?:queer|lgbtq?|minority)\s+character)/gimu,
  /\bensure\b[^.!?]{0,48}\b(?:cast|character\s+roster)\b[^.!?]{0,40}\b(?:is\s+)?(?:diverse|inclusive)\b/giu,
  /\binclude\b(?=[^.!?]{0,160}\bat\s+least\s+one\b)(?=[^.!?]{0,160}\b(?:woman|female|queer|lgbtq?|racial\s+minority|minority)\b)(?=[^.!?]{0,180}\bevery\s+(?:arc|chapter)\b)[^.!?]{0,180}/giu,
  /\bevery\s+chapter\b[^.!?]{0,64}\b(?:requires?|must\s+include|needs?)\b[^.!?]{0,64}\b(?:inclusive|diverse)\s+representation\b/giu,
  /\b(?:female|women|woman|queer|lgbtq?|minority|marginali[sz]ed|protected[- ]group)\s+(?:characters?|leads?|protagonists?)\b[^.!?]{0,48}\b(?:must|should|has to|needs to|required to|is required to|must not|should not)\b[^.!?]{0,120}\b(?:agency|empowered|sympathetic|positive\s+portrayal|portrayed\s+positively|portrayed\s+negatively|negative\s+portrayal)\b/giu,
  /\b(?:all|every)\s+(?:female|women|woman|queer|lgbtq?|minority|marginali[sz]ed)\s+(?:characters?|leads?|protagonists?)\b[^.!?]{0,48}\b(?:must|should|has to|needs to)\b[^.!?]{0,96}\b(?:empowered|sympathetic|positive|positive\s+portrayal)\b/giu,
  /\bno\s+(?:protected[- ]group|minority|marginali[sz]ed|queer|lgbtq?)\s+characters?\b[^.!?]{0,64}\b(?:may|can|should)\b[^.!?]{0,48}\b(?:portrayed\s+as|be)\s+(?:evil|a\s+villain|villainous)\b/giu,
  /\b(?:villain|antagonist)\b[^.!?]{0,40}\b(?:cannot|must not|should not)\b[^.!?]{0,48}\b(?:be|be\s+portrayed\s+as)\s+(?:gay|queer|lgbtq?|a\s+minority)\b/giu,
  /\b(?:story|narrative|chapter)\b[^.!?]{0,48}\b(?:may not|must not|should not|cannot)\b(?=[^.!?]{0,140}\boffensive\s+language\b)(?=[^.!?]{0,140}\b(?:harmful\s+)?stereotypes?\b)[^.!?]{0,140}/giu,
  /\bavoid\b(?=[^.!?]{0,96}\bstereotypes?\b)(?=[^.!?]{0,96}\boffensive\s+language\b)[^.!?]{0,96}/giu,
  /\b(?:villain|antagonist)\b[^.!?]{0,40}\b(?:must not|should not|cannot)\b[^.!?]{0,80}\b(?:belong\s+to|be\s+(?:a\s+member\s+of|from))\s+(?:a\s+)?protected\s+group\b/giu,
  /\b(?:protagonist|fraudsters?|criminals?|offenders?|wrongdoers?|he|she|they)\b[^.!?]{0,40}\b(?:must|should|has to|needs to|required to|is required to)\b[^.!?]{0,80}\b(?:not\s+be\s+rewarded|be\s+condemned|be\s+denounced)\b(?=[^.!?]{0,80}\b(?:crime|crimes|sin|sins|wrongdoing|fraud|abuse|violence)\b)[^.!?]{0,80}/giu,
  /\b(?:story|plot|narrative|ending|character arc|protagonist(?:'s)? arc|his arc|her arc|their arc)\b[^.!?]{0,48}\b(?:ensures?|guarantees?|requires?|culminates?\s+in)\b[^.!?]{0,96}\b(?:punishment|remorse|repentance|an? apology|reform|rehabilitation|redemption|atonement|retribution|moral growth|moral lesson)\b/giu,
  /\b(?:story|plot|narrative|ending|character arc|protagonist(?:'s)? arc|his arc|her arc|their arc)\b[^.!?]{0,48}\b(?:ensures?|guarantees?)\b(?=[^.!?]{0,140}\b(?:accountability|reckoning|moral consequences?)\b)(?=[^.!?]{0,160}\b(?:crime|crimes|sin|sins|wrongdoing|fraud|murder|abuse|exploitation|betrayal|immorality|unethical conduct)\b)[^.!?]{0,160}/giu,
  /(?:반드시|무조건|마땅히|필수(?:로)?|해야\s*한다|필요하다)[^.!?]{0,80}(?:책임(?:을\s*(?:져|지|묻|감당))|응분의\s*대가|도덕적\s*책임)/giu,
  /(?=[^.!?]{0,160}(?:범죄|죄악|악행|비윤리적?\s*행위))(?=[^.!?]{0,160}(?:책임|대가|응보|처벌))(?=[^.!?]{0,160}(?:이야기|서사|결말|인물\s*아크|주인공\s*아크))[^.!?]{0,160}(?:보장|귀결|반드시)/giu,
  /(?=[^.!?]{0,160}(?:범죄|죄악|악행|비윤리적?\s*행위))(?=[^.!?]{0,160}(?:책임|대가|응보|처벌))(?=[^.!?]{0,160}독자\s*신뢰)[^.!?]{0,160}위해/giu,
  /(?=[^.!?]{0,200}(?:이야기|서사|결말|회차|장))(?=[^.!?]{0,200}(?:반드시|무조건|마땅히|해야\s*한다|해서는\s*안\s*된다|하지\s*않아야\s*한다))(?=[^.!?]{0,200}(?:비판|규탄|잘못(?:임|이라는\s*점)|도덕적\s*균형|더\s*안전한\s*대안|미화|정상화))(?=[^.!?]{0,200}(?:범죄|죄|악행|폭력|학대|사기))[^.!?]{0,200}/giu,
  /(?:결말|이야기|서사)[^.!?]{0,48}(?:반드시|무조건|마땅히|해야\s*한다)[^.!?]{0,64}도덕적\s*균형[^.!?]{0,32}(?:회복|제공|맞춰)/giu,
  /(?=[^.!?]{0,140}(?:범죄|죄|악행|폭력|학대|사기))(?=[^.!?]{0,140}(?:미화|정상화))[^.!?]{0,140}(?:해서는|하면)\s*안\s*(?:된다|돼)/giu,
  /(?=[^.!?]{0,160}(?:이번\s*화|회차|이야기|서사))(?=[^.!?]{0,160}(?:반드시|무조건|해야\s*한다))(?=[^.!?]{0,160}(?:다양한\s*대표성|대표성\s*다양성))[^.!?]{0,160}/giu,
  /(?=[^.!?]{0,180}(?:모든\s*회차|(?:각|매)\s*(?:회차|화)(?:마다)?))(?=[^.!?]{0,180}(?:여성|퀴어|성소수자|소수자))(?=[^.!?]{0,180}(?:최소\s*한\s*명|한\s*명씩|한\s*명\s*이상|하나\s*이상))(?=[^.!?]{0,180}(?:넣|포함|배치|구성)(?:어야\s*한다|해야\s*한다|는다|한다|할\s*것))[^.!?]{0,180}/giu,
  /(?:^|[.!?]\s+|[-*+]\s+)(?:각|매)\s*화(?:마다)?[^.!?]{0,48}(?:여성|퀴어|성소수자|소수자)\s*(?:인물|캐릭터)[^.!?]{0,32}(?:최소\s*한\s*명|한\s*명\s*이상|하나\s*이상)[^.!?]{0,32}(?:넣|(?:배치|포함)하)도록\s*한다/gimu,
  /(?:등장인물|인물)\s*구성[^.!?]{0,48}(?:다양하게|포용적으로)[^.!?]{0,48}(?:유지해야\s*한다|유지한다)/giu,
  /(?:매|각)\s*회차[^.!?]{0,48}(?:포용적|다양한)\s*대표성[^.!?]{0,48}(?:확보한다|포함한다|유지한다)/giu,
  /(?=[^.!?]{0,160}(?:여성|퀴어|성소수자|소수자|보호\s*집단)\s*(?:인물|캐릭터|주연))(?=[^.!?]{0,160}(?:반드시|항상|모두|전부|해야\s*한다|해서는\s*안\s*된다|할\s*것))(?=[^.!?]{0,160}(?:주도성|주체적|긍정적?(?:으로|인)?\s*묘사|부정적?(?:으로|인)?\s*묘사))[^.!?]{0,160}/giu,
  /(?:여성|퀴어|성소수자|소수자)\s*(?:주연|인물)[^.!?]{0,48}(?:모두|전부)[^.!?]{0,48}(?:주체적|호감\s*가게|긍정적)[^.!?]{0,48}(?:묘사한다|그린다)/giu,
  /(?:소수자|성소수자|퀴어|보호\s*집단)\s*(?:인물|캐릭터|정체성)[^.!?]{0,48}(?:악인|악역|부정적)[^.!?]{0,48}(?:(?:묘사|설정|이용|연결)하지\s*않|(?:묘사|설정|이용|연결)해서는\s*안)/giu,
  /(?:^|[.!?]\s+|[-*+]\s+)(?:퀴어|성소수자|소수자|보호\s*집단)\s*(?:인물|캐릭터|정체성)[^.!?]{0,48}(?:악인|악역|반동인물)[^.!?]{0,32}(?:쓰지|이용하지|설정하지|묘사하지)\s*말\s*것/gimu,
  /(?:악역|반동인물)[^.!?]{0,48}(?:성소수자|퀴어|동성애자)[^.!?]{0,32}(?:설정하면|설정해서는)\s*안\s*(?:된다|돼)/giu,
  /(?=[^.!?]{0,120}(?:고정관념|편견))(?=[^.!?]{0,120}(?:불쾌감|불쾌한|모욕적?)[^.!?]{0,32}표현)[^.!?]{0,120}(?:피한다|피해야\s*한다|쓰지\s*않는다)/giu,
  /(?:악역|반동인물)[^.!?]{0,48}(?:소수자|보호\s*집단)[^.!?]{0,32}(?:속하면|이어서는|이면)\s*안\s*(?:된다|돼)/giu,
  /(?:必须|务必|一定要|理应|应该|需要)[^。！？]{0,80}(?:承担责任|受到追责|得到追责|接受问责|付出应有代价)/gu,
  /(?=[^。！？]{0,160}(?:罪行|犯罪|恶行|作恶))(?=[^。！？]{0,160}(?:追责|承担责任|问责|代价|报应|惩罚))(?=[^。！？]{0,160}(?:故事|叙事|结局|人物弧))[^。！？]{0,160}(?:确保|保证|必然|最终归于)/gu,
  /(?=[^。！？]{0,160}(?:罪行|犯罪|恶行|作恶))(?=[^。！？]{0,160}(?:追责|承担责任|问责|代价|报应|惩罚))(?=[^。！？]{0,160}读者信任)[^。！？]{0,160}为了/gu,
  /(?=[^。！？]{0,200}(?:故事|叙事|结局|章节|人物弧))(?=[^。！？]{0,200}(?:必须|务必|一定要|理应|应该|不得|不应))(?=[^。！？]{0,200}(?:谴责|批判|明确[^。！？]{0,32}(?:错误|不对)|道德平衡|安全替代方案|美化|正常化))(?=[^。！？]{0,200}(?:罪行|犯罪|恶行|暴力|虐待|欺诈))[^。！？]{0,200}/gu,
  /(?:结局|故事|叙事)[^。！？]{0,48}(?:必须|务必|一定要|应该)[^。！？]{0,64}(?:恢复|提供|维持)道德平衡/gu,
  /(?=[^。！？]{0,160}(?:本章|故事|叙事))(?=[^。！？]{0,160}(?:必须|务必|一定要|应该))(?=[^。！？]{0,160}(?:多元\s*代表性|代表性\s*多样化))[^。！？]{0,160}/gu,
  /(?:^|[。！？]\s*|[-*+]\s*)所有章节均应[^。！？]{0,48}(?:包含|具备|保持)(?:多元\s*代表性|代表性\s*多样化)/gmu,
  /(?=[^。！？]{0,180}每章)(?=[^。！？]{0,180}(?:女性|酷儿|少数族裔|少数群体))(?=[^。！？]{0,180}(?:至少一名|一名))[^。！？]{0,180}(?:加入|包含|安排)/gu,
  /(?:确保|必须保持)[^。！？]{0,64}(?:角色阵容|人物构成)[^。！？]{0,48}(?:多元化|多样化)/gu,
  /(?=[^。！？]{0,160}(?:女性|酷儿|少数群体|受保护群体)角色)(?=[^。！？]{0,160}(?:必须|应该|不得|不应))(?=[^。！？]{0,160}(?:能动性|正面描写|积极描写|负面描写))[^。！？]{0,160}/gu,
  /所有(?:女性|酷儿|少数群体)(?:主角|角色)[^。！？]{0,64}(?:都应当|都应该|必须)[^。！？]{0,64}(?:坚强|讨喜|正面|积极)/gu,
  /(?:不得|不应|不能)[^。！？]{0,48}把(?:少数群体|受保护群体|酷儿)角色[^。！？]{0,48}(?:描写成|塑造成)(?:恶人|反派|邪恶)/gu,
  /(?:反派|反面角色)[^。！？]{0,48}(?:不能|不得|不应)[^。！？]{0,32}(?:是|设为)(?:同性恋|酷儿|少数群体)/gu,
  /(?=[^。！？]{0,120}刻板印象)(?=[^。！？]{0,120}(?:冒犯性|侮辱性)语言)[^。！？]{0,120}(?:避免|不得使用|不应使用)/gu,
  /(?:反派|反面角色)[^。！？]{0,48}(?:不得|不应|不能)[^。！？]{0,48}(?:属于|来自)受保护群体/gu,

  // Representation / sensitivity rules are recognized by feature conjunction,
  // not an enumerated sentence list: a quota or normative trigger, a protected-
  // identity lexicon, and a casting/portrayal/language outcome must co-occur.
  /(?=[^.!?]{0,220}\b(?:cast|characters?|speaking\s+roles?|roles?)\b)(?=[^.!?]{0,220}\b(?:women|female|queer|lgbtq?|racial\s+minorities?|minority|underrepresented\s+groups?|marginali[sz]ed\s+groups?|protected\s+groups?)\b)(?=[^.!?]{0,220}\b(?:at\s+least|no\s+less\s+than|half|\d+(?:\.\d+)?\s*(?:%|percent)|percentage|quota|proportion)\b)(?=[^.!?]{0,220}\b(?:must|should|required|reserve|allocate|assign|include|comprise|make\s+up)\b)[^.!?]{0,220}/giu,
  /(?=[^.!?]{0,180}\b(?:all|every)\s+(?:villains?|antagonists?)\b)(?=[^.!?]{0,180}\b(?:must|should|required|only)\b)(?=[^.!?]{0,180}\b(?:cisgender|heterosexual|straight|able[- ]bodied|men|male)\b)[^.!?]{0,180}/giu,
  /(?=[^.!?]{0,200}\b(?:marginali[sz]ed|minority|protected[- ]group|queer|lgbtq?)\s+(?:characters?|identit(?:y|ies)|people|groups?)\b)(?=[^.!?]{0,200}\b(?:perpetrators?|villains?|evil|vice|criminals?|abusers?)\b)(?=[^.!?]{0,200}\b(?:must\s+never|must\s+not|may\s+not|cannot|can\s+never|never\s+be|no\b[^.!?]{0,48}\bmay)\b)[^.!?]{0,200}/giu,
  /(?:^|[.!?]\s+|[-*+]\s+)\b(?:use|require|mandate)\s+inclusive\s+language\b[^.!?]{0,80}/gimu,
  /(?:^|[.!?]\s+|[-*+]\s+)\bavoid\b(?=[^.!?]{0,140}\b(?:ableist|sexist|racist|homophobic|transphobic)\b)(?=[^.!?]{0,140}\b(?:tropes?|language|expressions?|stereotypes?)\b)[^.!?]{0,140}/gimu,
  /\b(?:story|book|narrative|chapter)\b[^.!?]{0,48}\b(?:must|should|has\s+to|needs\s+to|required\s+to)\b[^.!?]{0,80}\b(?:celebrate|promote|uphold|advance)\b[^.!?]{0,48}\b(?:diversity|inclusion|equity|inclusive\s+values?)\b/giu,
  /\b(?:ensure|maintain|require)\b(?=[^.!?]{0,140}\b(?:gender\s+parity|gender\s+balance|balanced\s+gender\s+representation)\b)(?=[^.!?]{0,140}\b(?:cast|characters?|speaking\s+characters?|roles?)\b)[^.!?]{0,140}/giu,
  /(?:^|[.!?]\s+|[-*+]\s+)\b(?:give|provide|assign)\b(?=[^.!?]{0,140}\b(?:every|all)\s+(?:women|woman|female|queer|lgbtq?|minority|marginali[sz]ed)\b)(?=[^.!?]{0,140}\b(?:independent\s+(?:arc|storyline)|agency)\b)[^.!?]{0,140}/gimu,
  /(?:^|[.!?]\s+|[-*+]\s+)\b(?:include|add|provide)\b(?=[^.!?]{0,120}\b(?:queer|lgbtq?\+?|minority|marginali[sz]ed)\b)(?=[^.!?]{0,120}\b(?:positive\s+)?role\s+models?\b)[^.!?]{0,120}/gimu,
  /\b(?:do\s+not|never|must\s+not|should\s+not)\s+use\b(?=[^.!?]{0,140}\b(?:marginali[sz]ed|minority|protected|queer|lgbtq?)\s+identit(?:y|ies)\b)(?=[^.!?]{0,140}\b(?:villains?|antagonists?|evil)\b)[^.!?]{0,140}/giu,
  /(?:^|[.!?]\s+|[-*+]\s+)\b(?:maintain|ensure|require)\s+cultural\s+sensitivity\b[^.!?]{0,80}/gimu,
  /(?:^|[.!?]\s+|[-*+]\s+)\buse\s+respectful\s+(?:terminology|language)\b[^.!?]{0,80}\b(?:marginali[sz]ed|minority|protected|queer|lgbtq?)\s+groups?\b/giu,
  /(?=[^.!?]{0,220}(?:등장인물|배역|발화\s*역할))(?=[^.!?]{0,220}(?:여성|퀴어|성소수자|소수자|과소대표\s*집단))(?=[^.!?]{0,220}(?:절반\s*이상|최소|\d+(?:\.\d+)?\s*(?:퍼센트|%|프로)))(?=[^.!?]{0,220}(?:구성해야\s*한다|배정한다|할당한다|포함해야\s*한다))[^.!?]{0,220}/giu,
  /(?=[^.!?]{0,180}(?:모든|전부)?\s*(?:악역|반동인물))(?=[^.!?]{0,180}(?:비장애인|이성애자|시스젠더|남성))(?=[^.!?]{0,180}(?:으로만|만\s*설정|설정해야\s*한다))[^.!?]{0,180}/giu,
  /(?=[^.!?]{0,180}(?:소수자|성소수자|퀴어|보호\s*집단)\s*인물)(?=[^.!?]{0,180}(?:가해자|악인|악역|범죄자))(?=[^.!?]{0,180}(?:묘사해서는\s*안\s*된다|묘사하지\s*않는다|설정하면\s*안\s*된다))[^.!?]{0,180}/giu,
  /(?:전반적으로|작품\s*전체에서|모든\s*문장에서)[^.!?]{0,48}포용적\s*언어[^.!?]{0,32}(?:사용한다|사용해야\s*한다)/giu,
  /(?=[^.!?]{0,160}(?:성차별적|인종차별적|동성애\s*혐오|트랜스젠더\s*혐오|장애인\s*비하))(?=[^.!?]{0,160}(?:표현|언어|고정관념|클리셰))[^.!?]{0,160}(?:피한다|피해야\s*한다|사용하지\s*않는다)/giu,
  /(?=[^.!?]{0,160}(?:모든|전부)\s*(?:발화\s*인물|등장인물))(?=[^.!?]{0,160}(?:성비|성별\s*비율))(?=[^.!?]{0,160}(?:동등하게|균형 있게|맞춘다|유지한다))[^.!?]{0,160}/giu,
  /(?=[^.!?]{0,160}(?:모든|각|매)\s*남성\s*시점)(?=[^.!?]{0,160}여성\s*시점)(?=[^.!?]{0,160}(?:균형|동등|붙인다|배치한다|맞춘다))[^.!?]{0,160}/giu,
  /(?=[^.!?]{0,160}(?:모든|각)\s*(?:여성|퀴어|성소수자|소수자)\s*인물)(?=[^.!?]{0,160}(?:독립적(?:인)?\s*아크|독자적(?:인)?\s*서사|주도성))[^.!?]{0,160}(?:부여한다|줘야\s*한다|보장한다)/giu,
  /(?=[^.!?]{0,160}(?:소수자|성소수자|퀴어|보호\s*집단)\s*정체성)(?=[^.!?]{0,160}(?:악역|반동인물))[^.!?]{0,160}(?:이용하지\s*않는다|사용해서는\s*안\s*된다|연결하지\s*않는다)/giu,
  /(?=[^。！？]{0,220}(?:角色|有台词角色|角色阵容))(?=[^。！？]{0,220}(?:女性|酷儿|少数族裔|少数群体|代表性不足群体))(?=[^。！？]{0,220}(?:至少一半|一半以上|百分之\s*(?:\d+|[零一二三四五六七八九十百]+)|\d+(?:\.\d+)?\s*%|配额|比例))(?=[^。！？]{0,220}(?:必须|应当|分配|安排|包含))[^。！？]{0,220}/gu,
  /(?=[^。！？]{0,180}(?:所有|全部)(?:反派|反面角色))(?=[^。！？]{0,180}(?:顺性别|异性恋|健全人|男性))(?=[^。！？]{0,180}(?:必须|只能|应当))[^。！？]{0,180}/gu,
  /(?=[^。！？]{0,180}(?:少数群体|少数族裔|酷儿|受保护群体)角色)(?=[^。！？]{0,180}(?:施害者|恶人|反派|罪犯))(?=[^。！？]{0,180}(?:不得|不能|不应|禁止))[^。！？]{0,180}/gu,
  /(?:全文|通篇|作品全篇)[^。！？]{0,48}(?:使用|必须使用|应当使用)包容性语言/gu,
  /(?=[^。！？]{0,160}(?:性别歧视|种族歧视|恐同|跨性别歧视|歧视残障))(?=[^。！？]{0,160}(?:表达|语言|套路|刻板印象))[^。！？]{0,160}(?:避免|不得使用|不应使用)/gu,
  /(?=[^。！？]{0,160}(?:所有|全部)有台词角色)(?=[^。！？]{0,160}(?:性别平衡|性别比例|性别对等))[^。！？]{0,160}(?:确保|实现|保持)/gu,
  /(?=[^。！？]{0,160}(?:每位|所有)(?:女性|酷儿|少数群体)角色)(?=[^。！？]{0,160}(?:独立的人物弧|独立故事线|能动性))(?=[^。！？]{0,160}(?:给|给予|赋予|保证))[^。！？]{0,160}/gu,
  /(?=[^。！？]{0,160}(?:少数|酷儿|受保护群体)身份)(?=[^。！？]{0,160}(?:反派|恶人))[^。！？]{0,160}(?:不得|不能|不应)[^。！？]{0,80}(?:用于|用来|关联)/gu,

  // Moral-duty aliases require a narrative/reader framing verb plus a moral
  // outcome. Ordinary in-story wrongdoing and causal consequences lack this
  // meta-obligation conjunction and remain untouched.
  /\b(?:story|book|narrative)\b[^.!?]{0,48}\b(?:has\s+(?:a\s+)?duty\s+to|must|should|required\s+to)\b[^.!?]{0,96}\b(?:model|promote|uphold|teach|demonstrate)\b[^.!?]{0,64}\b(?:responsible\s+behavio(?:u)?r|prosocial\s+values?|wholesome\s+values?|moral\s+values?)\b/giu,
  /\bensure\b[^.!?]{0,48}\b(?:readers?|the\s+audience)\b[^.!?]{0,80}\b(?:understand|recognize|know)\b(?=[^.!?]{0,120}\b(?:violence|fraud|abuse|crime|unethical\s+conduct)\b)(?=[^.!?]{0,120}\b(?:unacceptable|wrong|immoral|reprehensible)\b)[^.!?]{0,120}/giu,
  /(?:^|[.!?]\s+|[-*+]\s+)\b(?:frame|portray|present|depict)\b(?=[^.!?]{0,120}\b(?:fraud|violence|abuse|crime|unethical\s+conduct)\b)(?=[^.!?]{0,120}\b(?:morally\s+)?(?:reprehensible|condemnable|wrong|unacceptable)\b)[^.!?]{0,120}/gimu,
  /(?:^|[.!?]\s+|[-*+]\s+)\b(?:never|do\s+not)\s+(?:glamorize|glorify|romanticize|normalize)\b[^.!?]{0,96}\b(?:unethical\s+conduct|violence|abuse|crime|wrongdoing)\b/giu,
  /(?:^|[.!?]\s+|[-*+]\s+)\btreat\b(?=[^.!?]{0,120}\b(?:abusive|criminal|violent|fraudulent)\s+(?:protagonist|character)\b)(?=[^.!?]{0,120}\b(?:cautionary\s+(?:example|tale)|moral\s+warning)\b)[^.!?]{0,120}/gimu,
  /(?=[^.!?]{0,180}\b(?:story|narrative|book|chapter)\b)(?=[^.!?]{0,180}\b(?:must|should|has\s+to|needs\s+to|required\s+to)\b)(?=[^.!?]{0,180}\b(?:signal|show|express|make\s+clear)\b[^.!?]{0,64}\b(?:disapproval|critique|wrong|unacceptable)\b)(?=[^.!?]{0,180}\b(?:exploitation|abuse|coercion|toxic\s+behavio(?:u)?r)\b)[^.!?]{0,180}/giu,
  /(?:^|[.!?]\s+|[-*+]\s+)\b(?:never|do\s+not)\b(?:(?=[^.!?]{0,140}\bdepict\b[^.!?]{0,80}\b(?:abuse|exploitation|coercion)\b)(?=[^.!?]{0,140}\bwithout\s+(?:critique|criticism|condemnation)\b)|(?=[^.!?]{0,140}\breward\b[^.!?]{0,80}\btoxic\s+behavio(?:u)?r\b))[^.!?]{0,140}/gimu,
  /(?:^|[.!?]\s+|[-*+]\s+)\bmake\s+clear\b(?=[^.!?]{0,120}\b(?:coercion|abuse|exploitation)\b)(?=[^.!?]{0,120}\b(?:wrong|unacceptable|reprehensible)\b)[^.!?]{0,120}/gimu,
  /(?=[^.!?]{0,180}(?:서사|작품|이야기))(?=[^.!?]{0,180}(?:책임\s*있는\s*행동|건전한\s*가치|도덕적\s*가치))(?=[^.!?]{0,180}(?:본보기|모범|지켜야\s*한다|되어야\s*한다|보여줘야\s*한다))[^.!?]{0,180}/giu,
  /(?=[^.!?]{0,180}독자)(?=[^.!?]{0,180}(?:이해하게\s*한다|알게\s*한다|분명히\s*알려야\s*한다))(?=[^.!?]{0,180}(?:폭력|사기|학대|범죄))(?=[^.!?]{0,180}(?:용납될\s*수\s*없|잘못|비도덕적|비난받아\s*마땅))[^.!?]{0,180}/giu,
  /(?=[^.!?]{0,160}(?:사기|폭력|학대|범죄|비윤리적\s*행동))(?=[^.!?]{0,160}(?:도덕적으로\s*비난|비난받아\s*마땅|매력적으로\s*그리지\s*않|미화하지\s*않|정상화하지\s*않))[^.!?]{0,160}(?:묘사한다|그린다|다룬다|않는다)/giu,
  /(?=[^.!?]{0,140}(?:학대하는|범죄를\s*저지른|폭력적인)\s*주인공)(?=[^.!?]{0,140}반면교사)(?:[^.!?]{0,140})(?:다룬다|그린다|삼는다)/giu,
  /(?=[^.!?]{0,180}(?:서사|작품|이야기))(?=[^.!?]{0,180}(?:착취|학대|강압|해로운\s*행동))(?=[^.!?]{0,180}(?:비판적\s*태도|반대|잘못|용납될\s*수\s*없))(?=[^.!?]{0,180}(?:분명히\s*해야\s*한다|묘사해서는\s*안\s*된다|비판\s*없이))[^.!?]{0,180}/giu,
  /(?=[^.!?]{0,140}(?:학대|착취|강압))(?=[^.!?]{0,140}비판\s*없이)[^.!?]{0,140}묘사해서는\s*안\s*된다/giu,
  /(?=[^。！？]{0,180}(?:叙事|作品|故事))(?=[^。！？]{0,180}(?:负责任的行为|正向价值观|道德价值))(?=[^。！？]{0,180}(?:有责任|应当|必须|示范|维护|树立榜样))[^。！？]{0,180}/gu,
  /(?=[^。！？]{0,180}读者)(?=[^。！？]{0,180}(?:明白|理解|认识到))(?=[^。！？]{0,180}(?:暴力|欺诈|虐待|犯罪))(?=[^。！？]{0,180}(?:不可接受|错误|不道德|应受谴责))[^。！？]{0,180}/gu,
  /(?=[^。！？]{0,160}(?:欺诈|暴力|虐待|犯罪|不道德行为))(?=[^。！？]{0,160}(?:道德谴责|不可接受|绝不美化|不得美化|不得正常化))[^。！？]{0,160}(?:描写|塑造|呈现|美化|正常化)/gu,
  /(?=[^。！？]{0,140}(?:施虐|犯罪|暴力)的?主角)(?=[^。！？]{0,140}反面教材)[^。！？]{0,140}(?:当作|视为|塑造成)/gu,
  /(?=[^。！？]{0,180}(?:叙事|作品|故事))(?=[^。！？]{0,180}(?:剥削|虐待|强迫|有害行为))(?=[^。！？]{0,180}(?:反对|批判|错误|不可接受))(?=[^。！？]{0,180}(?:必须|应当|不得|明确))[^。！？]{0,180}/gu,
  /(?=[^。！？]{0,140}(?:虐待|剥削|强迫))(?=[^。！？]{0,140}(?:缺乏|没有|不加)批判)(?=[^。！？]{0,140}(?:不得|不能|不应))[^。！？]{0,140}描写/gu,
];

/**
 * Detect only explicit meta-obligations. Natural consequences such as an
 * arrest, loss, guilt, punishment, forgiveness, or redemption remain valid
 * when the foundation presents them as story events rather than moral quotas.
 */
export function findUnauthorizedMandatoryMoralCorrections(
  output: ArchitectOutput,
  authorizedSources: string | ReadonlyArray<ArchitectMoralAuthoritySource> = [],
): ReadonlyArray<string> {
  const candidateSurfaces = [
    output.storyFrame,
    output.storyBible,
    output.volumeMap,
    output.volumeOutline,
    ...(output.roles ?? []).map((role) => role.content),
    output.bookRules,
    output.pendingHooks,
    output.rhythmPrinciples,
  ].filter((surface): surface is string => typeof surface === "string" && surface.length > 0)
    .map((surface) => surface.normalize("NFKC"));
  const candidate = candidateSurfaces.join("\n");
  const normalizedAuthoritySources = (typeof authorizedSources === "string"
    ? [{ kind: "owner-direction" as const, text: authorizedSources }]
    : authorizedSources)
    .filter((source) => source.text.trim().length > 0)
    .map((source) => ({ ...source, text: source.text.normalize("NFKC") }));
  const findings = new Set<string>();
  for (const pattern of MANDATORY_MORAL_CORRECTION_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of candidate.matchAll(pattern)) {
      const matched = match[0].replace(/\s+/g, " ").trim();
      if (!matched) continue;
      const phrase = extractArchitectClause(
        candidate,
        match.index ?? 0,
        (match.index ?? 0) + match[0].length,
      );
      if (phrase && !isAuthorizedMandatoryMoralCorrection(
        matched,
        phrase,
        normalizedAuthoritySources,
      )) findings.add(phrase);
    }
  }
  for (const surface of candidateSurfaces) {
    const collapsedSurface = collapseUnicodeWhitespaceWithMap(surface).text;
    for (const pattern of [
      ...MANDATORY_MORAL_CORRECTION_PATTERNS,
      ...MANDATORY_MORAL_INEVITABILITY_PATTERNS,
    ]) {
      pattern.lastIndex = 0;
      for (const match of collapsedSurface.matchAll(pattern)) {
        const matched = match[0].replace(/\s+/gu, " ").trim();
        if (!matched || isAuthorizedMandatoryMoralCorrection(
          matched,
          matched,
          normalizedAuthoritySources,
        )) continue;
        findings.add(matched);
      }
    }
  }
  return [...findings];
}

/** Shared host-side gate for downstream planning and writing surfaces. */
export function findUnauthorizedMandatoryMoralCorrectionsInText(
  text: string,
  authorizedSources: string | ReadonlyArray<ArchitectMoralAuthoritySource> = [],
): ReadonlyArray<string> {
  return findUnauthorizedMandatoryMoralCorrections({
    storyBible: "",
    volumeOutline: "",
    bookRules: "",
    currentState: "",
    pendingHooks: "",
    storyFrame: text,
  }, authorizedSources);
}

/**
 * Scan manuscript evidence without mistaking clearly attributed fictional
 * speech, belief, mockery, or inscriptions for a host control instruction.
 * Unattributed meta mandates remain visible to the normal detector.
 */
export function findUnauthorizedMandatoryMoralCorrectionsInNarrativeEvidence(
  text: string,
  authorizedSources: string | ReadonlyArray<ArchitectMoralAuthoritySource> = [],
): ReadonlyArray<string> {
  const scanSurface = splitNarrativeSentences(text)
    .filter((sentence) => !isClearlyAttributedFictionalClause(sentence))
    .join("\n");
  return findUnauthorizedMandatoryMoralCorrectionsInText(scanSurface, authorizedSources);
}

function splitNarrativeSentences(text: string): ReadonlyArray<string> {
  return text.match(/[^.!?。！？\n]+(?:[.!?。！？]+["'”’」』）)]*)?|[.!?。！？]+/gu) ?? [text];
}

function isClearlyAttributedFictionalClause(sentence: string): boolean {
  return /\b(?:priest|mother|father|parent|mentor|teacher|editor|antagonist|villain|protagonist|bystander|witness|he|she|they)\b[^.!?]{0,120}\b(?:insisted|believed|whispered|mocked|sneered|said|claimed|thought|argued|muttered|shouted|told)\b/i.test(sentence)
    || /\b(?:graffiti|sign|note|letter|poster|inscription)\b[^.!?]{0,120}\b(?:read|said)\b/i.test(sentence)
    || /(?:사제|어머니|아버지|부모|스승|교사|편집자|악역|주인공|행인|목격자|그|그녀)(?:가|이|은|는)?[^.!?]{0,120}(?:말했|주장했|믿었|속삭였|비웃었|중얼거렸|외쳤|생각했|말했다|주장했다|믿었다|속삭였다|비웃었다)/u.test(sentence)
    || /(?:낙서|표지판|쪽지|편지|포스터|비문)[^.!?]{0,120}(?:적혀|쓰여|읽혔)/u.test(sentence)
    || /(?:神父|母亲|父亲|父母|导师|老师|编辑|反派|主角|路人|目击者|他|她)[^。！？]{0,120}(?:坚持|相信|低声说|嘲笑|说道|声称|认为|喊道)/u.test(sentence)
    || /(?:涂鸦|标牌|纸条|信件|海报|铭文)[^。！？]{0,120}(?:写着|写道)/u.test(sentence);
}

/** Exact-text authority check shared by BookRules and chapter-memo gates. */
export function isExactTextAuthorizedBySources(
  text: string,
  authorizedSources: string | ReadonlyArray<ArchitectMoralAuthoritySource> = [],
): boolean {
  const normalizedText = text.normalize("NFKC").trim();
  if (!normalizedText) return false;
  const normalizedSources = (typeof authorizedSources === "string"
    ? [{ kind: "owner-direction" as const, text: authorizedSources }]
    : authorizedSources)
    .filter((source) => source.text.trim().length > 0)
    .map((source) => ({ ...source, text: source.text.normalize("NFKC") }));
  return isAuthorizedMandatoryMoralCorrection(
    normalizedText,
    normalizedText,
    normalizedSources,
  );
}

function isAuthorizedMandatoryMoralCorrection(
  matched: string,
  phrase: string,
  sources: ReadonlyArray<ArchitectMoralAuthoritySource>,
): boolean {
  const needles = [...new Set([phrase, matched].filter(Boolean))];
  return sources.some((source) => needles.some((needle) => {
    const haystack = collapseUnicodeWhitespaceWithMap(source.text);
    const lowerHaystack = haystack.text.toLocaleLowerCase("en-US");
    const lowerNeedle = collapseUnicodeWhitespaceWithMap(needle).text.toLocaleLowerCase("en-US");
    let from = 0;
    while (from <= lowerHaystack.length - lowerNeedle.length) {
      const start = lowerHaystack.indexOf(lowerNeedle, from);
      if (start < 0) break;
      const end = start + lowerNeedle.length;
      const rawStart = haystack.rawStarts[start];
      const rawEnd = haystack.rawEnds[end - 1];
      if (
        rawStart !== undefined
        && rawEnd !== undefined
        && isPositiveAuthorityOccurrence(source.text, rawStart, rawEnd, {
          requireExplicitOwnerAdoption: source.kind === "owner-direction",
        })
      ) return true;
      from = Math.max(end, start + 1);
    }
    return false;
  }));
}

function isPositiveAuthorityOccurrence(
  source: string,
  start: number,
  end: number,
  options: { readonly requireExplicitOwnerAdoption?: boolean } = {},
): boolean {
  const prefix = source.slice(Math.max(0, start - 220), start);
  const suffix = source.slice(end, Math.min(source.length, end + 120));
  const normalizedPrefix = prefix.replace(/\s+/gu, " ");
  const normalizedSuffix = suffix.replace(/\s+/gu, " ");
  const lineStart = source.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const lineEnd = source.indexOf("\n", end);
  const line = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd);

  if (/^\s*>/.test(line) || isInsideQuotedSpan(source, start, end)) return false;

  const negatedBefore = /(?:do\s+not|don't|never)\s+(?:require|demand|mandate|say|write|include|add|force|use|keep)[^.!?]{0,80}$/i.test(normalizedPrefix)
    || /(?:remove|delete|drop|exclude|omit)\s+(?:(?:the|this|that)\s+)?(?:idea|claim|rule|requirement|demand|proposal|mandate)?(?:\s*(?:that|:|-))?[^.!?]{0,64}$/i.test(normalizedPrefix)
    || /(?:reject(?:ed)?|deny|denied|oppose|opposed|dismiss(?:ed)?|veto(?:ed)?|discard(?:ed)?|declin(?:e|ed)|refus(?:e|ed)|withdraw|withdrew|withdrawn|revoke(?:d)?|rescind(?:ed)?)\s+(?:(?:the|this|that)\s+)?(?:idea|claim|rule|requirement|demand|proposal|mandate)?(?:\s*(?:that|:|-))?[^.!?]{0,64}$/i.test(normalizedPrefix)
    || /(?:do|does|did)\s+not\s+(?:approve|authorize|adopt|accept|keep|require)(?:\s+(?:(?:the|this|that)\s+)?(?:idea|claim|rule|requirement|demand|proposal|mandate))?(?:\s*(?:that|:|-))?[^.!?]{0,64}$/i.test(normalizedPrefix)
    || /(?:never|not)\s+(?:approved|authorized|adopted|accepted|kept|required)(?:\s+(?:(?:the|this|that)\s+)?(?:idea|claim|rule|requirement|demand|proposal|mandate))?(?:\s*(?:that|:|-))?[^.!?]{0,64}$/i.test(normalizedPrefix)
    || /(?:said|stated|confirmed)\s+(?:that\s+)?(?:this|that|it)\s+(?:was|is)\s+not\s+(?:canon|authorized|approved|a\s+rule)(?:\s*(?:that|:|-))?[^.!?]{0,48}$/i.test(normalizedPrefix)
    || /(?:요구|강제|명시|작성|포함|추가|말)[^.!?]{0,16}(?:하지\s*마|하지\s*말|않(?:는|는다|았다)|금지)[^.!?]{0,56}$/u.test(normalizedPrefix)
    || /(?:거부|부정|반대)[^.!?]{0,56}$/u.test(normalizedPrefix)
    || /(?:기각|폐기|철회|취소|반려)(?!하지\s*않|하지\s*말)[^.!?]{0,56}$/u.test(normalizedPrefix)
    || /(?:不要|不得|禁止|无需|不必)[^。！？]{0,64}$/u.test(normalizedPrefix)
    || /(?:拒绝|否认|反对|否决|驳回|撤回|废弃|撤销)[^。！？]{0,56}$/u.test(normalizedPrefix);
  const nonAdoptiveBefore = /(?:reviewer|model|assistant|auditor|audit\s+report|review\s+report|current\s+draft|draft)[^.!?]{0,96}(?:suggest(?:ed|s)?|propos(?:ed|es)?|recommend(?:ed|s)?|generated|wrote|says?|contains?|mentions?|uses?|requires?)(?:\s+(?:(?:the|this|that)\s+)?(?:idea|claim|rule|requirement|demand|proposal|mandate))?(?:\s*(?:that|:|-))?[^.!?]{0,64}$/i.test(normalizedPrefix)
    || /\b(?:hypothetically|in\s+a\s+hypothetical|for\s+the\s+sake\s+of\s+argument)\b[\s\S]{0,180}$/i.test(normalizedPrefix)
    || /\bif\b[\s\S]{0,120}\b(?:owner|user|author)\b[\s\S]{0,64}\b(?:adopted|approved|authorized|required)\b[\s\S]{0,96}$/i.test(normalizedPrefix)
    || /\b(?:suppose|assuming)\b[\s\S]{0,180}$/i.test(normalizedPrefix)
    || /\baccording\s+to\s+(?:the\s+)?(?:reviewer|model|assistant|auditor)\b[\s\S]{0,180}$/i.test(normalizedPrefix)
    || /\b(?:draft\s+memo|draft|audit\s+report|review\s+report)\b[\s\S]{0,64}\b(?:alleges?|claims?|reports?)\b[\s\S]{0,160}$/i.test(normalizedPrefix)
    || /\b(?:owner|user|author)\b[^.!?]{0,64}\b(?:supposedly|reportedly|allegedly)\s+(?:adopted|approved|authorized|required)\b[^.!?]{0,80}$/i.test(normalizedPrefix)
    || /\b(?:owner|user|author)\b[^.!?]{0,64}\b(?:might|may|could|would)\s+(?:adopt|approve|authorize|require)\b[^.!?]{0,80}$/i.test(normalizedPrefix)
    || /\b(?:reviewer|model|assistant|auditor|someone)\b[\s\S]{0,64}\b(?:falsely\s+)?(?:claimed|wrote|said|reported)\b[\s\S]{0,96}\b(?:owner|user|author)\b[\s\S]{0,48}\b(?:adopts?|requires?|approves?|authorizes?)\b[^.!?]{0,64}$/i.test(normalizedPrefix)
    || /\b(?:asked|wondered|questioned|debated)\s+whether\b[\s\S]{0,96}\b(?:owner|user|author)\b[\s\S]{0,48}\b(?:approves?|adopts?|authorizes?|requires?)\b[\s\S]{0,64}$/i.test(normalizedPrefix)
    || /(?:priest|mother|father|parent|antagonist|villain|mentor|teacher|character|bystander|crowd|he|she|they)\s+(?:insisted|believed|said|mocked|claimed|thought|argued|muttered|shouted)(?:\s+(?:that|:|-))?[^.!?]{0,96}$/i.test(normalizedPrefix)
    || /(?:graffiti|sign|note|letter|poster|inscription)(?:\s+on\s+[^.!?]{0,48})?\s+(?:read|said)(?:\s*(?:that|:|-))?[^.!?]{0,96}$/i.test(normalizedPrefix)
    || /(?:unapproved|unadopted|unverified|hypothetical|example|sample|bad)\s+(?:suggestion|proposal|rule|requirement|mandate|example)(?:\s*(?:is|would\s+be|:|-))?[^.!?]{0,64}$/i.test(normalizedPrefix)
    || /(?:discussing|debating|considering|evaluating)\s+whether\s+to\s+(?:adopt|approve|authorize|use|require)[^.!?]{0,80}$/i.test(normalizedPrefix)
    || /(?:for\s+comparison[^.!?]{0,80}(?:another|other)\s+(?:book|story)[^.!?]{0,48}(?:uses?|has|requires?)|example\s+of\s+what\s+not\s+to\s+do|a\s+bad\s+rule\s+would\s+be|if\s+we\s+chose[^.!?]{0,64}(?:the\s+rule\s+would\s+be)?|the\s+following\s+is\s+only\s+a\s+hypothetical)[^.!?]{0,64}$/i.test(normalizedPrefix)
    || /(?:should\s+we\s+(?:adopt|approve|authorize|use|require)[^?]{0,80}\?|did\s+(?:the\s+)?(?:reviewer|model|assistant|auditor)\s+(?:suggest|propose|recommend)[^?]{0,80}\?)\s*$/i.test(normalizedPrefix)
    || /(?:리뷰어|검토자|모델|어시스턴트|감리자|감리\s*보고서|검토\s*보고서|현재\s*초안)[^.!?]{0,80}(?:제안|권고|작성|언급|포함|사용)[^.!?]{0,64}$/u.test(normalizedPrefix)
    || /(?:미승인|미채택|가정|가상의|예시|나쁜)\s*(?:제안|규칙|요구|예시)[^.!?]{0,64}$/u.test(normalizedPrefix)
    || /(?:채택|승인|사용|요구)할지\s*(?:논의|검토|고려)[^.!?]{0,64}$/u.test(normalizedPrefix)
    || /(?:비교를\s*위해|하지\s*말아야\s*할\s*예시|가정한다면)[^.!?]{0,96}$/u.test(normalizedPrefix)
    || /(?:评审|审核者|模型|助手|审计员|审计报告|评审报告|当前草稿)[^。！？]{0,80}(?:建议|提议|推荐|写道|提到|包含|使用)[^。！？]{0,64}$/u.test(normalizedPrefix)
    || /(?:未经批准|尚未采纳|假设|示例|反例|坏规则)[^。！？]{0,80}$/u.test(normalizedPrefix)
    || /(?:正在讨论|正在考虑|正在评估)[^。！？]{0,64}(?:采纳|批准|授权|使用|要求)[^。！？]{0,48}$/u.test(normalizedPrefix)
    || /(?:作为比较|不要这样做的例子|仅作假设)[^。！？]{0,96}$/u.test(normalizedPrefix);
  const negatedAfter = /^(?:[^.!?]{0,40})?(?:is|was|are|were)\s+not\s+(?:required|a\s+rule|canon|authorized)/i.test(normalizedSuffix)
    || /^[\s"'‘’“”`().!?{}:;-]*(?:was\s+)?(?:rejected|denied|dismissed|vetoed|discarded|declined|refused|withdrawn|revoked|rescinded|not\s+(?:requested|approved|authorized|adopted|accepted)|removed|deleted|must\s+be\s+removed)/i.test(normalizedSuffix)
    || /^(?:[^.!?]{0,40})?(?:was\s+)?(?:rejected|denied|dismissed|vetoed|discarded|declined|refused|withdrawn|revoked|rescinded|not\s+(?:requested|approved|authorized|adopted|accepted)|removed|deleted|must\s+be\s+removed)/i.test(normalizedSuffix)
    || /^(?:[^.!?]{0,48})?(?:do|does|did)\s+not\s+(?:approve|authorize|adopt|accept|keep|require)/i.test(normalizedSuffix)
    || /^(?:라는|한다는|해야\s*한다는)?[^.!?]{0,24}(?:요구|주장|문구|뜻|규칙)?[^.!?]{0,20}(?:이\s*아니|아니|거부|부정|금지|삭제|제거|빼|기각|폐기|철회|취소|반려)/u.test(normalizedSuffix)
    || /^[\s\S]{0,80}(?:이\s*아니|아니|거부|부정|금지|삭제|제거|빼|기각|폐기|철회|취소|반려)/u.test(normalizedSuffix)
    || /^(?:[^。！？]{0,32})?(?:说法|要求|主张|规则)?[^。！？]{0,20}(?:并非|不是|被拒绝|遭拒绝|被否决|遭否决|被驳回|撤回|废弃|撤销|不成立|删除|移除)/u.test(normalizedSuffix)
    || /^[\s\S]{0,80}(?:并非|不是|被拒绝|遭拒绝|被否决|遭否决|被驳回|撤回|废弃|撤销|不成立|删除|移除)/u.test(normalizedSuffix);
  if (negatedBefore || nonAdoptiveBefore || negatedAfter) return false;
  if (!options.requireExplicitOwnerAdoption) return true;

  const normalizedSource = collapseUnicodeWhitespaceWithMap(source.trim()).text;
  const normalizedOccurrence = collapseUnicodeWhitespaceWithMap(source.slice(start, end).trim()).text;
  if (normalizedSource.localeCompare(normalizedOccurrence, "en", { sensitivity: "base" }) === 0) {
    return true;
  }
  const singleClauseSource = normalizedSource.replace(/[.!?。！？]\s*$/u, "");
  if (
    !/[.!?。！？:：;]/u.test(singleClauseSource)
    && singleClauseSource.toLocaleLowerCase("en-US")
      .includes(normalizedOccurrence.toLocaleLowerCase("en-US"))
  ) {
    return true;
  }

  const explicitOwnerAdoption = /(?:\b(?:owner|user|author|i|we)\b[^.!?]{0,48}\b(?:explicitly\s+)?(?:adopt|adopts|adopted|require|requires|required|authorize|authorizes|authorized|approve|approves|approved|mandate|mandates|instruct|instructs|direct|directs)\b|\b(?:owner|user|author)\s+(?:instruction|requirement|rule)\b|\b(?:confirmed|approved|adopted|authorized)\s+(?:book|story)?\s*(?:rule|requirement)\b)(?:[^.!?]{0,48}(?:that|:|-))?[^.!?]{0,64}$/i.test(normalizedPrefix)
    || /(?:사용자|소유자|작가|저자)[^.!?]{0,32}(?:명시적으로\s*)?(?:채택|요구|승인|허가|지시|규칙으로\s*정)[^.!?]{0,48}$/u.test(normalizedPrefix)
    || /(?:사용자|소유자|작가|저자)\s*(?:지시|요구|승인\s*규칙)[^.!?]{0,24}$/u.test(normalizedPrefix)
    || /(?:작품의\s*)?(?:확정|승인된|채택된)\s*규칙[^.!?]{0,24}$/u.test(normalizedPrefix)
    || /(?:用户|所有者|作者)[^。！？]{0,32}(?:明确)?(?:采纳|要求|授权|批准|指示|定为规则)[^。！？]{0,48}$/u.test(normalizedPrefix)
    || /(?:本书)?(?:已确认|已批准|已采纳)的?规则[^。！？]{0,24}$/u.test(normalizedPrefix);
  return explicitOwnerAdoption;
}

function collapseUnicodeWhitespaceWithMap(source: string): {
  readonly text: string;
  readonly rawStarts: ReadonlyArray<number>;
  readonly rawEnds: ReadonlyArray<number>;
} {
  let text = "";
  const rawStarts: number[] = [];
  const rawEnds: number[] = [];
  let index = 0;
  while (index < source.length) {
    const htmlBreak = source.slice(index).match(/^<br\s*\/?\s*>/iu)?.[0];
    if (htmlBreak) {
      text += " ";
      rawStarts.push(index);
      rawEnds.push(index + htmlBreak.length);
      index += htmlBreak.length;
      continue;
    }
    const namedWhitespaceEntity = source.slice(index)
      .match(/^&(?:nbsp|ensp|emsp|thinsp);/iu)?.[0];
    const numericEntity = source.slice(index)
      .match(/^&#(x[0-9a-f]+|\d+);/iu);
    const numericWhitespaceEntity = numericEntity?.[0]
      && (() => {
        const token = numericEntity[1]!;
        const codePoint = Number.parseInt(token.startsWith("x") || token.startsWith("X")
          ? token.slice(1)
          : token, token.startsWith("x") || token.startsWith("X") ? 16 : 10);
        return Number.isFinite(codePoint)
          && codePoint <= 0x10FFFF
          && /\s/u.test(String.fromCodePoint(codePoint));
      })()
      ? numericEntity[0]
      : undefined;
    const whitespaceEntity = namedWhitespaceEntity ?? numericWhitespaceEntity;
    if (whitespaceEntity) {
      text += " ";
      rawStarts.push(index);
      rawEnds.push(index + whitespaceEntity.length);
      index += whitespaceEntity.length;
      continue;
    }
    const markdownLink = source.slice(index)
      .match(/^\[([^\]\n]{1,512})\]\((?:\\.|[^)\n]){1,2048}\)/u);
    if (markdownLink) {
      const label = markdownLink[1]!;
      const collapsedLabel = collapseUnicodeWhitespaceWithMap(label);
      text += collapsedLabel.text;
      rawStarts.push(...collapsedLabel.rawStarts.map((offset) => index + 1 + offset));
      rawEnds.push(...collapsedLabel.rawEnds.map((offset) => index + 1 + offset));
      index += markdownLink[0].length;
      continue;
    }
    if (/\s/u.test(source[index]!)) {
      const start = index;
      while (index < source.length && /\s/u.test(source[index]!)) index++;
      text += " ";
      rawStarts.push(start);
      rawEnds.push(index);
      continue;
    }
    // Inline Markdown emphasis/code markers and zero-width formatting are not
    // semantic separators. Ignore them only on the scan copy; raw offsets are
    // retained for quote/negation checks and the persisted text is untouched.
    const ignoredFormatting = source.slice(index)
      .match(/^[*_~`\u00AD\u200B\u200C\u200D\u2060\uFE00-\uFE0F\uFEFF\u{E0100}-\u{E01EF}]/u)?.[0];
    if (ignoredFormatting) {
      index += ignoredFormatting.length;
      continue;
    }
    text += source[index]!;
    rawStarts.push(index);
    rawEnds.push(index + 1);
    index++;
  }
  return { text, rawStarts, rawEnds };
}

function isInsideQuotedSpan(source: string, start: number, end: number): boolean {
  const asymmetricPairs: ReadonlyArray<readonly [string, string]> = [
    ["“", "”"], ["‘", "’"], ["「", "」"], ["『", "』"], ["《", "》"],
  ];
  for (const [open, close] of asymmetricPairs) {
    const lastOpen = source.lastIndexOf(open, start);
    const lastClose = source.lastIndexOf(close, start);
    const nextClose = source.indexOf(close, end);
    if (lastOpen > lastClose && nextClose >= end) return true;
  }
  for (const quote of ['"', "`"]) {
    let count = 0;
    for (let i = 0; i < start; i++) {
      if (source[i] === quote && source[i - 1] !== "\\") count++;
    }
    if (count % 2 === 1 && source.indexOf(quote, end) >= end) return true;
  }
  const singleOpen = source.lastIndexOf("'", start);
  const singleClose = source.indexOf("'", end);
  if (
    singleOpen >= 0
    && singleClose >= end
    && (singleOpen === 0 || !/[\p{L}\p{N}]/u.test(source[singleOpen - 1] ?? ""))
    && (singleClose === source.length - 1 || !/[\p{L}\p{N}]/u.test(source[singleClose + 1] ?? ""))
  ) {
    return true;
  }
  return false;
}

function extractArchitectClause(source: string, start: number, end: number): string {
  const boundaries = [".", "!", "?", "。", "！", "？", "\n"];
  let clauseStart = 0;
  let clauseEnd = source.length;
  for (const boundary of boundaries) {
    clauseStart = Math.max(clauseStart, source.lastIndexOf(boundary, Math.max(0, start - 1)) + 1);
    const next = source.indexOf(boundary, end);
    if (next >= 0) clauseEnd = Math.min(clauseEnd, next + boundary.length);
  }
  return source.slice(clauseStart, clauseEnd).replace(/\s+/g, " ").trim();
}

export type FutureAdvantageFoundationMode = "required" | "preserve" | "forbidden";

/**
 * Host-side gate for the optional future-advantage contract. The model may
 * design the contents, but it may not decide to turn an ordinary book into a
 * regression/precognition book by itself.
 */
export function resolveFutureAdvantageFoundationMode(input: {
  readonly title: string;
  readonly genre: string;
  readonly creativeBrief?: string;
  readonly existingBookRules?: string;
}): FutureAdvantageFoundationMode {
  if (input.existingBookRules && parseBookRules(input.existingBookRules)?.rules.futureAdvantage?.enabled) {
    return "preserve";
  }

  const premise = [input.title, input.genre, input.creativeBrief ?? ""].join("\n").normalize("NFKC");
  const explicitlyExcluded = [
    /(?:회귀|빙의|예지|미래\s*기억)(?:물)?(?:은|는|이|가)?\s*(?:아님|아니다|없다|없는|금지)/i,
    /(?:without|no)\s+(?:regression|possession|precognition|future\s+memor)/i,
    /(?:不要|没有|并非|不是)(?:回归|重生|穿越|预知|未来记忆)/i,
  ].some((pattern) => pattern.test(premise));
  if (explicitlyExcluded) return "forbidden";

  const explicitFutureKnowledge = [
    /회귀(?:물|자|했다|한|후|해서|하여|하고|한다|합니다)?/i,
    /빙의(?:물|자|했다|한|후|해서|하여|하고|한다|합니다)?/i,
    /예지|예언\s*(?:능력|기억)|미래\s*(?:기억|정보|지식|사건|결과)|과거로\s*(?:돌아|회귀)/i,
    /(?:미래|훗날|\d+\s*년\s*(?:후|뒤)).*(?:당겨\s*오|선점|미리\s*(?:차지|확보))/i,
    /\b(?:regression|regressor|reincarnat(?:ed|ion)|possess(?:ed|ion)|precognition|future\s+(?:memory|knowledge))\b/i,
    /回归|重生|穿越|预知|未来记忆|前世记忆/,
  ].some((pattern) => pattern.test(premise));
  return explicitFutureKnowledge ? "required" : "forbidden";
}

class FutureAdvantageFoundationContractError extends Error {
  readonly expectation: FutureAdvantageFoundationMode;
  readonly content: string;
  readonly issues: readonly string[];

  constructor(
    expectation: FutureAdvantageFoundationMode,
    content: string,
    issues: readonly string[] = [],
  ) {
    super(expectation === "forbidden"
      ? "ordinary foundation unexpectedly contains a future-advantage contract"
      : "future-advantage foundation is missing its required contract");
    this.name = "FutureAdvantageFoundationContractError";
    this.expectation = expectation;
    this.content = content;
    this.issues = issues;
  }
}

export class ArchitectIncompleteFoundationError extends Error {
  readonly missing: readonly string[];
  readonly partialContent: string;

  constructor(missing: readonly string[], partialContent: string, message?: string) {
    super(message ?? `Architect foundation incomplete; missing sections: ${missing.join(", ")}`);
    this.name = "ArchitectIncompleteFoundationError";
    this.missing = missing;
    this.partialContent = partialContent;
  }
}

class MissingArchitectSectionsError extends Error {
  readonly missing: readonly string[];
  readonly content: string;

  constructor(missing: readonly string[], content: string) {
    super(`Architect output missing required section${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
    this.name = "MissingArchitectSectionsError";
    this.missing = missing;
    this.content = content;
  }
}

class ArchitectContentNeutralityContractError extends Error {
  readonly findings: readonly string[];
  readonly content: string;

  constructor(findings: readonly string[], content: string) {
    super("Architect output contains an unrequested mandatory moral-correction beat");
    this.name = "ArchitectContentNeutralityContractError";
    this.findings = findings;
    this.content = content;
  }
}

export class ArchitectAgent extends BaseAgent {
  get name(): string {
    return "architect";
  }

  async generateFoundation(
    book: BookConfig,
    externalContext?: string,
    reviewFeedback?: string,
    options?: {
      reviseFrom?: {
        storyBible: string;
        volumeOutline: string;
        bookRules: string;
        characterMatrix: string;
        userFeedback: string;
      };
      /** Explicit, host-authenticated owner/canon artifacts eligible for exact BookRule authority. */
      bookRuleAuthoritySources?: ReadonlyArray<ArchitectBookRuleAuthoritySource>;
      /** Explicit, separately confirmed Studio owner-adoption decisions. */
      bookRuleOwnerDecisions?: ReadonlyArray<ArchitectBookRuleOwnerDecision>;
    },
  ): Promise<ArchitectOutput> {
    const { profile: gp, body: genreBody } =
      await readGenreProfile(this.ctx.projectRoot, book.genre);
    const resolvedLanguage = book.language ?? gp.language;
    // Keep native Korean commercial genre contracts. Only sanitize the old
    // fallback case where a Korean book resolved to a non-Korean profile.
    const shouldSanitizeKoreanFallback = resolvedLanguage === "ko" && gp.language !== "ko";
    const promptProfile = shouldSanitizeKoreanFallback
      ? {
          ...gp,
          name: book.genre.replace(/[_-]+/g, " "),
          language: "ko" as const,
          chapterTypes: ["일반 회차"],
          fatigueWords: [],
          satisfactionTypes: [],
          pacingRule: "",
        }
      : gp;
    const promptGenreBody = shouldSanitizeKoreanFallback ? "" : genreBody;

    const contextBlock = externalContext
      ? resolvedLanguage === "zh"
        ? `\n\n## 外部指令\n以下是来自外部系统的创作指令，请将其融入设定中：\n\n${externalContext}\n`
        : resolvedLanguage === "ko"
          ? `\n\n## 외부 지시\n다음 외부 창작 지시를 작품 기반에 반영하세요.\n\n${externalContext}\n`
          : `\n\n## External instruction\nIncorporate the following creative direction into the foundation.\n\n${externalContext}\n`
      : "";
    const reviewFeedbackBlock = this.buildReviewFeedbackBlock(reviewFeedback, resolvedLanguage);
    const revisePrompt = options?.reviseFrom
      ? this.buildRevisePrompt(options.reviseFrom, resolvedLanguage)
      : "";
    const futureAdvantageMode = resolveFutureAdvantageFoundationMode({
      title: book.title,
      genre: book.genre,
      creativeBrief: externalContext,
      existingBookRules: options?.reviseFrom?.bookRules,
    });
    const futureAdvantageBlock = this.buildFutureAdvantageFoundationBlock(
      futureAdvantageMode,
      resolvedLanguage,
    );

    const numericalBlock = gp.numericalSystem
      ? resolvedLanguage === "zh"
        ? "- 有明确的数值/资源体系可追踪\n- 在 book_rules 中写清核心资源、硬上限和不可突破规则"
        : resolvedLanguage === "ko"
          ? "- 돈·지분·능력치처럼 독자가 세는 자원은 획득과 지출을 추적할 수 있게 설계합니다.\n- 핵심 자원과 넘을 수 없는 한계는 book_rules에 적습니다."
          : "- Track a concrete numerical/resource system.\n- Define core resources, hard caps, and inviolable limits in book_rules."
      : resolvedLanguage === "zh"
        ? "- 本题材无数值系统，不需要资源账本"
        : resolvedLanguage === "ko"
          ? "- 별도의 수치 체계가 없는 장르입니다. 필요 없는 능력치나 자원 장부를 만들지 않습니다."
          : "- This genre has no numerical system; do not add a resource ledger.";
    const powerBlock = gp.powerScaling
      ? resolvedLanguage === "zh"
        ? "- 有明确的战力等级体系"
        : resolvedLanguage === "ko"
          ? "- 힘의 서열은 독자가 승패를 예상할 수 있을 만큼 분명하게 정합니다."
          : "- Define a clear power hierarchy."
      : "";
    const eraBlock = gp.eraResearch
      ? resolvedLanguage === "zh"
        ? "- 需要年代考据支撑（在 story_frame 中织入时代锚，在 book_rules 中写清不可违背的年代限制）"
        : resolvedLanguage === "ko"
          ? "- 실제 시대를 쓰는 작품입니다. 당시 가격·기술·제도·생활상을 사건에 넣고, 어기면 안 되는 사실은 book_rules에 적습니다."
          : "- Ground the era with research: weave period anchors into story_frame and record inviolable limits in book_rules."
      : "";

    const systemPrompt = resolvedLanguage === "ko"
      ? this.buildKoreanFoundationPrompt(book, promptProfile, promptGenreBody, contextBlock, reviewFeedbackBlock, numericalBlock, powerBlock, eraBlock, futureAdvantageBlock)
      : resolvedLanguage === "en"
        ? this.buildEnglishFoundationPrompt(book, promptProfile, promptGenreBody, contextBlock, reviewFeedbackBlock, numericalBlock, powerBlock, eraBlock, futureAdvantageBlock)
        : this.buildChineseFoundationPrompt(book, promptProfile, promptGenreBody, contextBlock, reviewFeedbackBlock, numericalBlock, powerBlock, eraBlock, futureAdvantageBlock);

    const langPrefix = resolvedLanguage === "en"
        ? `【LANGUAGE OVERRIDE】ALL output (story_frame, volume_map, roles, book_rules, pending_hooks) MUST be written in English. Character names, place names, and all prose must be in English. The === SECTION: === tags remain unchanged. Do NOT emit rhythm_principles or current_state sections — rhythm principles live inside the last paragraph of volume_map; environment/era anchors (when relevant) are woven into story_frame's world-tonal-ground paragraph.\n\n`
        : "";
    const userMessage = resolvedLanguage === "ko"
      ? `제목이 "${book.title}"인 ${promptProfile.name} 장편소설의 전체 작품 기반을 한국어로 생성하세요.`
      : resolvedLanguage === "en"
        ? `Generate the complete foundation for a ${promptProfile.name} novel titled "${book.title}". Write everything in English.`
        : `请为标题为"${book.title}"的${promptProfile.name}小说生成完整基础设定。`;

    const response = await this.chat([
      { role: "system", content: langPrefix + systemPrompt + revisePrompt },
      { role: "user", content: userMessage },
    ], { temperature: 0.8 });

    const authoritySources: ArchitectMoralAuthoritySource[] = [
      ...(options?.bookRuleAuthoritySources ?? []).map((source) => ({
        kind: source.source === "book-canon"
          ? "persisted-book-canon" as const
          : "owner-direction" as const,
        text: source.artifactContent,
      })),
      ...(options?.bookRuleOwnerDecisions ?? []).map((decision) => ({
        kind: "owner-direction" as const,
        text: `Owner explicitly adopts this Book rule: ${decision.text}`,
      })),
    ];
    const foundation = await this.parseSectionsWithRepair(
      response.content,
      resolvedLanguage,
      futureAdvantageMode,
      authoritySources,
    );
    return this.attachBookRuleAuthority(
      foundation,
      options?.bookRuleAuthoritySources ?? [],
      options?.bookRuleOwnerDecisions ?? [],
    );
  }

  private buildFutureAdvantageFoundationBlock(
    mode: FutureAdvantageFoundationMode,
    language: "zh" | "ko" | "en",
  ): string {
    if (language === "ko") {
      if (mode === "forbidden") {
        return `## 미래 선점 판정
- 이 작품에는 회귀·빙의·예지·미래 기억이 핵심 재미로 명시되지 않았습니다.
- book_rules에 "미래 선점" 항목을 만들지 마세요. 시대 배경이나 고증 필요만으로 회귀 설정을 덧붙이지 않습니다.`;
      }
      return `## 미래 선점 판정
- 이 작품은 주인공이 미래의 결과를 기억하고 현재의 실행으로 당겨오는 재미가 핵심입니다.
- book_rules의 "금지 사항" 바로 앞에 아래 형식의 "## 미래 선점"을 반드시 둡니다.
- 알고 있는 것은 훗날의 승자·실패·큰 방향이며, 현재의 정확한 구현법·날짜·타인의 선택은 모르는 것으로 나눕니다.
- 기술·금융·경영·유통·문화·인재·정책 중 작품이 실제로 쓸 분야만 적습니다.
- 완성 설계도 암기, 무한 자금, 저항 없는 도입, 바뀐 역사 뒤에도 완벽한 기억은 금지된 지름길에 넣습니다.
- 기존 계약을 고치는 중이라면 핵심 약속과 정보 경계를 보존하고, 사용자가 요구한 범위만 구체화합니다.

## 미래 선점
- 활성화: true
- 회귀 기준 시점: <미래 기억이 시작되는 과거의 시점>
- 핵심 재미: <미래의 결과를 현재의 어떤 행동과 보상으로 당겨오는가>
- 허용 분야: <쉼표로 구분>
- 알고 있는 것: <결과와 큰 방향, 쉼표로 구분>
- 모르는 것: <현재의 구현법·정확한 날짜·타인의 선택, 쉼표로 구분>
- 금지된 지름길: <대가와 저항을 없애는 편의, 쉼표로 구분>
- 기억 원칙: <역사가 달라질수록 기억의 신뢰도가 어떻게 변하는가>
- 검색 정책: <끄기 | 필요할 때 | 핵심 주장 필수 중 하나>`;
    }
    if (language === "en") {
      if (mode === "forbidden") {
        return "## Future-advantage decision\n- The premise does not explicitly make regression, possession, precognition, or future memory its core appeal. Omit the entire `## Future Advantage` section from book_rules.";
      }
      return `## Future-advantage decision
- The core appeal is pulling remembered future outcomes forward through present-day execution.
- Add a required \`## Future Advantage\` section to book_rules with: Enabled, Origin moment, Core promise, Allowed domains, Known, Unknown, Forbidden shortcuts, Memory policy, Research policy.
- Separate remembered outcomes from unknown implementation details. Ban perfect blueprint recall, unlimited capital, resistance-free adoption, and flawless memory after history changes.${mode === "preserve" ? " Preserve the existing contract and only refine what the user requested." : ""}`;
    }
    if (mode === "forbidden") {
      return "## 未来先机判定\n- 本书未明确把回归、穿越、预知或未来记忆作为核心乐趣。book_rules 中不得生成 `## 未来先机`。";
    }
    return `## 未来先机判定
- 本书的核心乐趣是把记忆中的未来结果通过当下执行提前兑现。
- book_rules 必须包含 \`## 未来先机\`，依次写：启用、回归基准时点、核心乐趣、允许领域、已知、未知、禁止捷径、记忆规则、检索策略。
- 必须区分已知结果与未知实现方法；禁止完整图纸记忆、无限资金、无阻力落地、历史改变后记忆仍绝对准确。${mode === "preserve" ? "保留既有契约，只按用户要求细化。" : ""}`;
  }

  private buildRevisePrompt(reviseFrom: {
    storyBible: string;
    volumeOutline: string;
    bookRules: string;
    characterMatrix: string;
    userFeedback: string;
  }, language: "zh" | "ko" | "en"): string {
    if (language === "ko") {
      return `\n\n## 기존 기획 다시 쓰기
아래 자료는 이미 확정된 내용입니다. 인물·사건·세계 규칙·미회수 단서를 버리거나 초기화하지 마세요. 사용자의 수정 요구를 반영해 story_frame, volume_map, roles, book_rules, pending_hooks 다섯 블록으로 다시 정리합니다.

표현만 고치지 말고 재미가 약한 대목의 사건 선택과 보상 순서까지 손봅니다. 기존 사실이 여러 방향을 허용한다면 주인공이 먼저 움직이고, 상대가 맞받아치며, 독자가 결과를 확인할 수 있는 방향을 고릅니다.

[기존 이야기 기반]
${reviseFrom.storyBible || "(없음)"}

[기존 권 구성]
${reviseFrom.volumeOutline || "(없음)"}

[기존 작품 규칙]
${reviseFrom.bookRules || "(없음)"}

[기존 인물]
${reviseFrom.characterMatrix || "(없음)"}

[사용자 수정 요구]
${reviseFrom.userFeedback || "(없음)"}
`;
    }
    if (language === "en") {
      return `\n\n## Existing-foundation revision mode
 Reorganize the authoritative material below into the current five SECTION blocks: story_frame, volume_map, roles, book_rules, and pending_hooks. Preserve all established world, character, plot, hook, and tone facts. Keep one card per character, keep unresolved hooks, and never reset chapter runtime facts. Write every natural-language field in English.

[story_bible / story_frame]
${reviseFrom.storyBible || "(none)"}

[volume_outline / volume_map]
${reviseFrom.volumeOutline || "(none)"}

[book_rules]
${reviseFrom.bookRules || "(none)"}

[character_matrix / roles]
${reviseFrom.characterMatrix || "(none)"}

[User feedback]
${reviseFrom.userFeedback || "(none)"}
`;
    }
    return `\n\n## 既有架构稿修订模式
你在把一本已有书的架构稿从条目式升级为当前的段落式架构稿 + 一人一卡角色目录；如果它已经是 Phase 5 结构，则按用户反馈二次重写。

原书信息（这是权威内容，必须完整保留其中的世界观、角色、主线、伏笔和语气）：

【story_bible / story_frame 全文】
${reviseFrom.storyBible || "（无）"}

【volume_outline / volume_map 全文】
${reviseFrom.volumeOutline || "（无）"}

【book_rules 全文】
${reviseFrom.bookRules || "（无）"}

【character_matrix / roles 全文】
${reviseFrom.characterMatrix || "（无）"}

你的任务：
1. 把现有内容重新组织成当前 5 段 SECTION：story_frame / volume_map / roles / book_rules / pending_hooks
2. story_frame 使用段落式世界观与核心冲突，不要退回条目表格
3. volume_map 使用段落式卷/章级方向，并把节奏原则放进末段
4. roles 必须按一人一卡输出，主要/次要角色判断沿用原内容，缺失才按主线重要性推断
5. pending_hooks 必须保留原有未回收伏笔，不要因为重写架构稿而清空
6. 不要改动已写章节的运行时事实，不要重置 current_state / pending_hooks 之外的运行时日志

用户额外要求：
${reviseFrom.userFeedback || "（无）"}
`;
  }

  // -------------------------------------------------------------------------
  // 한국 상업 웹소설용 기획 프롬프트
  // -------------------------------------------------------------------------
  private buildKoreanFoundationPrompt(
    book: BookConfig,
    gp: GenreProfile,
    genreBody: string,
    contextBlock: string,
    reviewFeedbackBlock: string,
    numericalBlock: string,
    powerBlock: string,
    eraBlock: string,
    futureAdvantageBlock: string,
  ): string {
    const genreContract = [
      gp.pacingRule ? `- 기본 지급 리듬 참고(통과 할당량 아님): ${gp.pacingRule}` : "",
      gp.chapterTypes.length > 0 ? `- 회차 전개 후보: ${gp.chapterTypes.join(" / ")}` : "",
      gp.satisfactionTypes.length > 0 ? `- 반복 보상 후보: ${gp.satisfactionTypes.join(" / ")}` : "",
      genreBody,
    ].filter(Boolean).join("\n");

    return `당신은 한국 상업 웹소설을 기획하는 작가입니다. 설정집을 만드는 사람이 아니라, 독자가 다음 화를 누르게 할 사건과 보상을 고르는 사람입니다. 기계가 읽는 표지는 영어로 남기되 사람이 읽는 문장은 처음부터 자연스러운 한국어로 씁니다.${contextBlock}${reviewFeedbackBlock}

## 작품 정보
- 제목: ${book.title}
- 장르: ${gp.name} (${book.genre})
- 연재처: ${book.platform}
- 목표 분량: ${book.targetChapters}화
- 회차당 목표 분량: ${book.chapterWordCount}자

${webnovelPlanGuidance("foundation")}

## 판단 순서
1. 사용자가 정한 제목, 장르, 시대, 주인공, 핵심 욕망을 지킵니다.
2. 주인공이 직접 선택하고 행동하게 합니다. 우연이나 설명이 주인공의 몫을 빼앗으면 다시 고릅니다.
3. 사건은 주인공의 행동과 상대의 대응 뒤 눈에 보이는 보상을 먼저 지급합니다. 그 뒤에는 결과에서 자연스럽게 생기는 선택·후과·압력 또는 완결된 결산 가운데 맞는 흐름을 두며, 이미 얻은 보상을 억지로 감추지 않습니다.
4. 독자는 주인공이 무엇을 얻었고 상대가 무엇을 잃었는지 알아야 합니다. 돈, 자리, 정보, 평판, 관계처럼 장면으로 확인되는 결과를 줍니다.
5. 사실관계와 인과관계를 지키면서도 더 보고 싶은 선택지를 고릅니다. 설명을 붙여야만 성립하는 사건보다 장면으로 이해되는 사건을 우선합니다.

## 재미적 정합성
- 첫 3화 안에 주인공의 결핍, 첫 행동, 첫 성과를 눈에 보이게 먼저 보여 줍니다. 그 뒤에는 결과에서 자연스럽게 생기는 선택·후과·압력 또는 완결된 결산 가운데 맞는 흐름을 둡니다.
- 각 권에는 독자가 기다릴 대표 승부와 대표 보상이 있어야 합니다. 같은 종류의 승리만 반복하지 않습니다.
- 주인공의 실력은 결정과 실행에서 드러나야 합니다. 주변 인물이 감탄하거나 해설하는 것으로 대신하지 않습니다.
- 적은 주인공의 계획을 망칠 수단과 이유를 가집니다. 적이 무능해서 이기는 전개를 연속으로 쓰지 않습니다.
- 큰 보상은 얻은 것과 바뀐 상태를 눈에 보이게 먼저 확인시킵니다. 그 뒤에는 결과에서 자연스럽게 생기는 선택·후과·압력 또는 완결된 결산 가운데 맞는 흐름을 둡니다.
- 관계 변화는 말보다 행동으로 확인합니다. 편을 들고, 정보를 넘기고, 자리를 내주고, 배신의 대가를 치르는 장면을 정합니다.
- 고증은 사건의 제약과 기회로 씁니다. 시대 정보를 전시하기 위해 사건을 멈추지 않습니다.

## 한국어 문장 규칙
- 사람과 조직을 문장의 주어로 둡니다. 신뢰, 관계, 구조, 승부 같은 추상어가 스스로 움직이게 쓰지 않습니다.
- "책임자로 이동한다", "관계가 전진한다", "구조가 결정을 내린다" 같은 번역형 동사를 쓰지 않습니다. 누가 자리를 차지하고, 누구 편에 서고, 누가 결재했는지 적습니다.
- "A가 아니라 B", "X를 넘어 Y", "단순한 X가 아닌 Y" 같은 대조 틀은 꼭 필요할 때만 쓰며 한 SECTION에서 한 번을 넘기지 않습니다.
- 작품 안에서 실제로 부르지 않을 개념명을 만들지 않습니다. "독립 지배축", "구조조정 연합", "가시적 적수" 같은 보고서식 이름 대신 인물·회사·사건의 이름을 씁니다.
- 의미가 깊어 보이게 만드는 문장보다 작가가 바로 회차를 쓸 수 있는 문장을 씁니다. 고유명사, 금액, 지분, 장소, 행동, 손해를 적습니다.
- 같은 뜻을 항목마다 되풀이하지 않습니다. 문장 길이와 호흡을 섞고, 짧은 단정문을 연달아 쌓아 강조하지 않습니다.
- 영어 항목명을 한국어 제목에 병기하지 않습니다. 아래에 지정한 한국어 제목을 그대로 씁니다.

## 장르 조건
${numericalBlock}
${powerBlock}
${eraBlock}
${futureAdvantageBlock}
${genreContract ? `\n## 장르 전용 약속\n${genreContract}\n- 후보 목록을 채우기 위해 사건이나 보상을 억지로 넣지 않습니다. 작품과 이번 구간에 맞는 것만 고릅니다.` : ""}

## 출력 계약
아래 다섯 SECTION을 순서대로 모두 출력합니다. SECTION 표지, ---ROLE---, ---CONTENT---, tier, name과 pending_hooks의 열 이름은 기계 계약이므로 그대로 둡니다. 별도의 rhythm_principles나 current_state SECTION은 만들지 않습니다.

=== SECTION: story_frame ===

표나 글머리표 대신 네 개의 읽히는 문단으로 씁니다. 문단마다 아래 제목을 붙입니다. 주인공의 전체 변화는 roles의 주인공 카드에만 둡니다.

## 01_독자가_기대할_재미
제목을 보고 들어온 독자가 어떤 장면과 보상을 계속 받는지 적습니다. 초반의 상황과 기회, 주인공의 첫 수, 눈에 보이는 첫 성과를 먼저 구체적으로 잡고, 그 뒤에는 결과에서 자연스럽게 생기는 선택·후과·압력 또는 완결된 결산 가운데 맞는 흐름을 둡니다. 작품의 분위기는 장면의 온도와 속도로 설명합니다.

## 02_주인공의_승부와_적
주인공이 당장 원하는 것, 그것을 막는 사람, 양쪽이 맞붙는 사건을 적습니다. 주요 적은 이름과 욕망, 가진 수단이 보여야 합니다. 장기 비밀이 필요하다면 매 권의 사건과 어떻게 이어지는지 적되 "전경 이야기"나 "배경 이야기"라는 말을 쓰지 않습니다.

## 03_배경과_사건_규칙
작가가 사건을 만들 때 지켜야 할 세계의 규칙을 설명합니다. 시대·인생의 시점과 지금 움직일 수 있는 계기를 적고, 현장의 사람·물건·돈·기술·정보가 선택을 가능하게 하거나 제한하는 조건을 설명합니다. 감각 묘사는 필요한 현장에 붙입니다.

## 04_끝까지_갈_목표
마지막에 주인공이 어디서 무엇을 하고 있는지, 누가 곁에 남는지 적습니다. 사건의 인과상 실제 대가가 생기는 작품이면 그 대가도 적되, 대가·벌·반성·속죄·내적 성장을 완결 조건으로 만들지 않습니다. 변화나 대가가 없는 결말도 작품의 약속과 인과에 맞으면 유효합니다. 끝에는 "전권 목표:"로 시작하는 한 문장을 둡니다. 외부 사람이 달성 여부를 판정할 수 있는 상태여야 합니다.

=== SECTION: volume_map ===

권 단위로 씁니다. 구체적인 회차 번호를 배정하지 않습니다. 각 권의 승부와 관계 변화가 눈에 보이는 독자 보상으로 먼저 이어지게 설명하고, 그 뒤에는 결과에서 자연스럽게 생기는 선택·후과·압력 또는 완결된 결산 가운데 맞는 권말 흐름을 둡니다.

## 01_권별_승부와_감정
각 권에서 주인공이 누구와 무엇을 놓고 싸우는지 적습니다. 압박이 커지는 구간과 독자가 숨을 돌리는 구간, 가장 큰 보상이 터지는 지점을 설명합니다.

## 02_심을_것과_거둘_때
어떤 정보나 약속을 어느 권에 보여 주고 언제 결과로 돌려주는지 적습니다. 단서의 이름과 그것을 발견하는 사건을 씁니다. 장기 단서도 당장의 승부에 쓸모가 있어야 합니다.

## 03_권별_목표와_독자_보상
각 권의 목적이 장기 목적을 어떻게 진전시키는지 적고 달성 여부를 확인할 결과를 정합니다. 주인공이 얻거나 즐기는 것, 정보·자원·관계·생활의 변화 중 작품에 맞는 결과를 고릅니다. 결과의 개수와 상대의 손해를 의무화하지 않습니다. 독자가 권말에 손에 쥐었다고 느낄 대표 보상을 함께 적습니다.

## 04_권말에_뒤집히는_것
각 권 마지막에 되돌릴 수 없게 바뀌는 사건을 적습니다. 회사의 주인이 바뀌거나, 가족이 갈라서거나, 비밀이 공개되는 식으로 다음 권의 출발점을 실제로 바꿉니다.

## 05_연재_호흡
이 작품에 맞는 대형 보상과 소형 보상의 흐름, 숨 고르는 회차의 역할, 장기 단서의 회수 시점, 관계 변화의 계기를 정합니다. 구체적인 권·사건·독자 약속으로 설명하되 "몇 화마다 훅 하나" 같은 통과 할당량은 만들지 않습니다. 화말은 완전한 수습, 보상의 후과, 다음 선택이나 압력을 작품에 맞게 섞고, 이미 얻은 결과를 감춰 인공적인 절벽을 만들지 않습니다.

=== SECTION: roles ===

인물마다 한 장씩 씁니다. 주요 인물과 보조 인물은 사건에 필요한 만큼만 만듭니다. 성격표보다 이 사람이 실제로 무엇을 하고 어떤 선택에서 흔들리는지가 중요합니다.

---ROLE---
tier: major
name: <인물 이름>
---CONTENT---
## 첫인상과 버릇
독자가 첫 등장 장면에서 확인할 태도와 버릇을 적습니다.

## 욕망과 약점
지금 원하는 것, 그것을 원하는 이유, 원하는 것을 위해 어디까지 행동할 의향이 있는지 적습니다. 손해를 감수하지 않으려는 인물도 그대로 적으며, 모든 욕망에 대가를 붙이지 않습니다.

## 과거
현재의 선택에 영향을 주는 사건만 짧게 적습니다.

## 처음과 끝
주인공에게 필수입니다. 시작할 때의 처지와 판단 버릇, 마지막에 차지할 자리를 적습니다. 과정에서 실제로 잃거나 바뀌는 것이 있을 때만 대가나 내적 변화를 덧붙입니다. 변화 없음과 대가 없음도 합법이며, 도덕적 교정·벌·속죄를 자동으로 만들지 않습니다.

## 첫 등장 때 처지
첫 등장 직전 무슨 일을 겪었고 무엇이 급한지 적습니다.

## 인간관계
상대의 이름을 쓰고, 현재 무엇을 주고받으며 어떤 사건에서 편이 갈릴지 적습니다.

## 선택의 기준
이 인물이 포기하지 않는 것과 궁지에서 먼저 버리는 것을 적습니다.

## 변하게 되는 계기
변화가 예정된 인물만 생각이나 행동이 달라지는 사건을 적습니다. 변화가 없는 인물은 "변화 없음"이라고 적을 수 있습니다. 범죄·비도덕적 선택을 했다는 이유만으로 반성·개심·속죄를 만들지 않습니다.

보조 인물은 같은 구분자를 쓰고 "첫인상과 버릇 / 욕망과 약점 / 첫 등장 때 처지 / 주인공과 얽히는 일" 네 항목만 씁니다.

=== SECTION: book_rules ===

일반 Markdown 규칙 카드로 씁니다. YAML, JSON, 코드 블록을 쓰지 않습니다.

## 주인공
- 이름: <이름>
- 끝까지 지킬 성격: <구체적인 행동 기준>
- 하지 않을 행동: <사용자 지시나 기존 Book 정본에 실제로 있는 경우만 적고, 없으면 이 줄을 생략>

## 장르 약속
- 주 장르: ${book.genre}
- 반복해서 줄 재미: <이 작품의 대표 사건과 보상>
- 섞지 않을 요소: <장르를 흐리는 요소>

## 서술 시점
사용자가 지정했을 때만 1인칭 또는 3인칭을 적고, 지정하지 않았으면 "미지정"이라고 씁니다.

${gp.numericalSystem ? `## 숫자와 자원
- 독자가 추적할 것: <돈, 지분, 능력치 등>
- 넘을 수 없는 한계: <편의상 무시하면 안 되는 제한>` : ""}

${gp.eraResearch ? `## 시대 고증
- <가격, 법, 기술, 사회상에서 사건을 제한하는 사실 2~3개>` : ""}

## 금지 사항
- <사용자 지시나 기존 Book 정본에서 확인되는 금지만 적습니다. 모델이 도덕·안전·성별 규칙을 새로 만들지 않으며, 확인된 금지가 없으면 "없음" 한 줄만 씁니다.>

=== SECTION: pending_hooks ===

아래 열을 가진 Markdown 표로 씁니다.
| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | payoff_timing | depends_on | pays_off_in_arc | core_hook | half_life | notes |

- 생성 시 last_advanced_chapter는 모두 0입니다.
- status는 일반 단서에 deferred를 쓰고, 작품 전체를 끌고 갈 핵심 단서만 open을 쓸 수 있습니다.
- payoff_timing은 immediate / near-term / mid-arc / slow-burn / endgame 중 하나를 씁니다.
- depends_on은 먼저 풀려야 할 hook_id 배열이며 없으면 none입니다.
- pays_off_in_arc에는 "2권 중반의 채권단 회의"처럼 회수 사건과 위치를 한국어로 적습니다.
- core_hook은 true 또는 false입니다. 핵심 단서는 3~7개만 둡니다.
- notes에는 독자가 처음 보게 될 물건, 말, 행동을 적습니다.

## 제출 전 검산
- 다섯 SECTION이 모두 있는지 확인합니다.
- 첫 3화에 주인공의 행동과 첫 성과가 있는지 확인합니다.
- 각 권에 승부 상대와 눈에 보이는 보상이 있는지 확인합니다.
- 사건이 주인공의 행동과 상대의 대응 뒤 눈에 보이는 보상을 먼저 지급하고, 그 뒤 결과에서 자연스럽게 생기는 선택·후과·압력 또는 완결된 결산 가운데 맞는 흐름으로 이어지는지 확인합니다.
- 추상 명사가 사람 대신 행동하거나 보고서식 개념명이 생기지 않았는지 확인합니다.
- "A가 아니라 B" 구조가 반복되지 않았는지 확인합니다.
- pending_hooks 표의 열을 빼먹지 않았는지 확인합니다.`;
  }

  // -------------------------------------------------------------------------
  // Prose prompt — zh (primary)
  // -------------------------------------------------------------------------
  private buildChineseFoundationPrompt(
    book: BookConfig,
    gp: GenreProfile,
    genreBody: string,
    contextBlock: string,
    reviewFeedbackBlock: string,
    numericalBlock: string,
    powerBlock: string,
    eraBlock: string,
    futureAdvantageBlock: string,
  ): string {
    return `你是这本书的总架构师。你的唯一输出是**散文密度的基础设定**——不是表格、不是 schema、不是条目化 bullet。v6 以后这本书的"灵气"从哪里来？从你这里来。你的散文密度决定了后面 planner 能不能读出"稀疏 memo"，writer 能不能写出活人，reviewer 能不能校准硬伤。${contextBlock}${reviewFeedbackBlock}

## 书籍元信息
- 平台：${book.platform}
- 题材：${gp.name}（${book.genre}）
- 目标章数：${book.targetChapters}章
- 每章字数：${book.chapterWordCount}字
- 标题：${book.title}

## 题材底色
${genreBody}

## 产出约束（硬性）
${numericalBlock}
${powerBlock}
${eraBlock}
${futureAdvantageBlock}

## 输出结构（5 个 SECTION，严格按 === SECTION: === 分块，不要漏任何一块）

## 去重铁律（必读）
禁止在多段里重复同一事实。主角弧线只写在 roles；世界铁律只写在 story_frame.世界观底色；节奏原则只写在 volume_map 最后一段；角色当前现状只写在 roles.当前现状；初始钩子只写在 pending_hooks（startChapter=0 行）。**如果本书是年代文/历史同人/都市重生等需要年份、季节、重大历史事件作为锚点的题材**，把环境/时代锚自然织进 story_frame.世界观底色（"1985 年 7 月，非典刚过"这类）；**修仙/玄幻/系统等没有真实年份的题材直接省略**，不要硬凑。如果一个段落写了另一段的内容，删掉。

## 预算（超预算必删）
- story_frame ≤ 3000 chars
- volume_map ≤ 5000 chars
- roles 总 ≤ 8000 chars
- book_rules ≤ 1000 chars（普通 Markdown 规则卡）
- pending_hooks ≤ 2000 chars

=== SECTION: story_frame ===

这是散文骨架。**4 段**，每段约 600-900 字，不要写表格，不要写 bullet list，写成能被人读下去的段落。段落标题用 \`## \` 开头，段落内部是正经段落。**主角弧线不写在本 section；它的权威来源是 roles/主要角色/<主角>.md。** 本段只需一句指针："本书主角是 X，完整弧线详见 roles/主要角色/X.md"。

### 段 1：主题与基调
写这本书到底讲的是什么——不是"讲主角如何从弱到强"这种空话，而是具体的命题（"一个被时代按在泥里的人，如何选择不被改写"、"当所有人都在撒谎时，坚持记录真相要付出什么代价"）。主题下面跟着基调——温情冷冽悲壮肃杀，哪一种？为什么是这种而不是另一种？结尾用一句话指向主角并引向 roles（例："本书主角是林辞，完整弧线详见 roles/主要角色/林辞.md"）。

### 段 2：核心冲突、对手定性、前台/后台双层故事
这本书的主要矛盾是什么？不是"正邪对抗"，而是"因为 A 相信 X、B 相信 Y，所以他们一定会在某件事上对撞"。主要对手是谁（至少 2 个：一个显性对手 + 一个结构性对手/体制），他们的动机从哪里长出来。对手不是工具，对手有自己的逻辑。

**本段必须显式写出"前台故事 / 后台故事"两条线**：
- **前台故事**：读者每章看得到的表层冲突（查案、打怪、升级、谈恋爱、搞事业等），每个卷/arc 有独立的显性目标和完结点
- **后台故事**：贯穿全书的暗线——藏在所有前台事件背后的那台"机器"（幕后黑手、阴谋、身世秘密、体制压迫、命运诅咒等），读者只能通过碎片拼出来，大结局时才整体兑现

两条线必须有因果关联，不能是平行宇宙——每一段前台冲突的背后都应该能追溯到后台故事的某个齿轮在转。**如果只有前台没有后台，故事会散成"独立事件集"，没有往前拉的引力；如果只有后台没有前台，故事会憋闷、看不到爽感**。本段用散文明确写出：本书前台是什么、后台是什么、两者怎么咬合。

### 段 3：世界观底色（铁律 + 质感 + 本书专属规则）
这个世界的运行规则是什么？写 3-5 条关于法律、金钱、技术、身份、组织权限或超自然机制的因果铁律——以 prose 写出，不要 bullet。不要把道德评价、赎罪、惩罚或人物必须改过写成世界铁律。这个世界的质感是什么——湿的还是干的、快的还是慢的、噪的还是静的？给 writer 一个明确的感官锚（这是原来 particle_ledger 承载的基调部分）。**这一段同时承担原先 book_rules 正文里写的"叙事视角 / 本书专属规则 / 核心冲突驱动"等 prose 内容**——全部合并到这里写一次就够，不要再去 book_rules 重复。

### 段 4：终局方向 + 全书 Objective（OKR 大纲的根）
这本书最后一章大概是什么感觉——不是"主角登顶"、"大结局"这种套话，而是**最后一个镜头**大致长什么样。主角最后在哪、做什么、身边有谁、心里想什么。这是给全书所有后面的规划一个远方靶子。

**本段末尾必须明确写出全书 Objective 一句话**：这本书讲完时，主角必须达成一个**可验证的终局状态**（例："从一个杂役修士成为宗门长老并公开父辈冤案的真相"、"从黑户打工妹成为掌控三家皮草公司的老板娘并亲手送前夫进监狱"）。不要写"变强"、"复仇"这类抽象词，要写**一个能被外部观察者判定"达成 / 未达成"的具体状态**。这个 Objective 是全书递归大纲的根——下面 volume_map 的每一卷会分解出这个 O 对应的 Key Results。

=== SECTION: volume_map ===

这是分卷散文地图，**5 段主体 + 1 段节奏原则尾段**。**关键要求：只写到卷级 prose**——写清楚每卷的主题、情绪曲线、卷间钩子、角色阶段目标、卷尾不可逆事件。**禁止指定具体章号任务**（不要写"第 17 章让他回家"这种章级布局）。章级规划是 Phase 3 planner 的职责，架构师只搭骨架、不编章目。

### 段 1：各卷主题与情绪曲线
有几卷？每卷的主题一句话，每卷的情绪曲线一段（哪里压、哪里爽、哪里冷、哪里暖）。不要机械的"第一卷打小怪第二卷打大怪"，写情绪的流动。

### 段 2：卷间钩子与回收承诺（前台/后台双层都要覆盖）
第 1 卷埋什么钩子、在哪一卷回收；第 2 卷埋什么、在哪一卷回收。散文写，不要表格。**只写卷级**（如"第 1 卷埋的身世之谜在第 3 卷回收"），不要写具体章号。

**钩子必须覆盖前台 + 后台两层**（对应 story_frame.段 2 建立的双层故事）：
- 前台钩子：当前卷内 arc 层面的短期钩子（查案谜题、对手身份、资源争夺等），预期在 1-2 卷内回收
- 后台钩子：贯穿全书的主线钩子（幕后真相、身世、体制秘密等），预期在终卷前后回收，核心的 3-7 条属于 core_hook=true

**如果本段只写前台钩子、没有后台钩子暗桩，说明你漏了整本书的引力轴，必须补上。**

### 段 3：各卷 OKR（Objective + Key Results）
用 OKR 递归大纲法分解全书 Objective（story_frame.段 4 末尾定的根 O）：每一卷都必须明确给出：
- **Objective（卷级目标）**：本卷结束时主角必须达成的**可验证状态**，一句话，与全书 Objective 逻辑递进相连（例：全书 O = "成为宗门长老并公开冤案"；卷 1 O = "从杂役转入正式弟子籍并拿到第一份能指向真相的线索"）
- **Key Results（3 条，可量化/可观察）**：支撑该 O 达成的三个关键子成果，每条必须是外部观察者能判定是否完成的状态变更（例 KR1 = "拿下药园执事位置"、KR2 = "与灵安峰结成稳定盟约"、KR3 = "发现父辈案卷的第一半页残片"）。不要写"变强"、"成长"这类模糊 KR

次要角色的阶段性变化也要点到（师父在第 2 卷会死、对手在第 3 卷会黑化等），写在 KR 条目下作为附注。写阶段性，不写完整弧线（完整弧线在 roles）。**每一卷 3 个 KR 是下游 planner 分解章节任务的直接依据。planner 把最近 3-5 章当作诊断窗口，按 KR 的事件重量、必要因果和后效决定推进速度；这不是“每 3-5 章推进一个 KR”的固定周期。**

### 段 4：卷尾必须发生的改变
每一卷最后一章必须发生什么不可逆的事——权力结构改变、关系破裂、秘密暴露、主角身份重定位。写散文，一卷一段。**只写"必须发生什么"，不指定是第几章**。

### 段 5：节奏原则（具体化 + 通用）
**这是节奏原则的唯一归宿，不再有独立 rhythm_principles section。** 本段输出 6 条节奏原则。**至少 3 条必须具体到本书的卷、事件或读者承诺**，但不必强行换算成“每几章一次”的通过配额；其余可保留通用原则（例："拒绝机械降神"、"高潮之前让必要因果先被读者看见"）。具体化 + 通用混合是合法的。反面例子："节奏要张弛有度"（废话）。正面例子："第一卷以债权争夺作为主兑现，小周期先让读者看见所有权变化，再决定完整收束还是从结果里生出下一道压力"。6 条各写 2-3 句，覆盖（顺序不强制、可替换同权重议题）：
1. 高潮与兑现——本书的大兑现由哪些卷级事件触发，读者会看见什么结果？
2. 喘息功能——高压事件之后，哪些情绪、关系、信息或后果需要在安静段落落地？
3. 章末承接 / 完整收束组合——哪些阶段允许完整收束，哪些卷级承诺需要继续承接，主钩最晚在哪一卷回收？不得规定每章章末留钩数量
4. 信息释放节奏——主线信息在哪些卷级里程碑释放，各阶段保留什么未知？
5. 爽点节奏——每个小周期的主兑现是什么类型，如何避免为了密度塞入孤立爽点？
6. 情感节点递进——哪些事件会让关系发生可观察的变化，不按固定章数强推？

如果外部指令给了内容比例（例如权谋线/感情线各半、事业线/恋爱线的权重），必须在本段写成全书节奏承诺：哪些卷偏哪条线、以最近 3-5 章为诊断窗口时如何发现某条线长期失踪、高潮后哪条线承担后效。不要只写"保持平衡"，也不要把每个窗口变成逐线打卡配额。

=== SECTION: roles ===

一人一卡 prose。**主角卡是本书角色弧线的唯一权威来源**——story_frame 不再写主角弧线，writer/planner 都从这里读。用以下格式分隔：

---ROLE---
tier: major
name: <角色名>
---CONTENT---
（这里写散文角色卡，下面的小标题必须全部出现，每段至少 3 行正经散文，不要写表格）

## 核心标签
（3-5 个关键词 + 一句话为什么是这些词）

## 反差细节
（1-2 个与核心标签反差的具体细节——"冷酷杀手但会给流浪猫留鱼骨"。反差细节是人物立体化的公式，必须有。）

## 人物小传（过往经历）
（一段散文，说这个人怎么变成现在这样。童年/重大事件/塑造性格的那件事。只写关键过往，简版。）

## 主角弧线（起点 → 终点；代价与内在变化可选）
**只有主角必须写本段；其他 major 角色如果弧线分量重也可以写，否则略过。**写清主角从哪里出发（身份、处境、一开始最想要什么），到哪里落脚（最终处境、拿到/失去什么）。只有事件因果实际产生不可逆损失时才写代价；只有作品确实安排了内在位移时才写变化。"无额外代价"和"内在立场不变"都是合法结果。不要因为犯罪、不道德或令人不适就自动添加惩罚、反省、改过或赎罪。本段是之前 story_frame.段 2 迁移过来的权威位置，写足写实。

## 当前现状（第 0 章初始状态）
（第 0 章时他在哪、做什么、处境如何、最近最烦心的事。**只写角色个人处境**——初始钩子写在 pending_hooks 的 startChapter=0 行；环境/时代锚（如果是需要年份的题材）织进 story_frame.世界观底色。不再有独立的 current_state section。）

## 关系网络
（与主角、与其他重要角色的关系——一句话一条，关系不是标签是动态。）

## 内在驱动
（他想要什么、为什么想要、愿意做到哪一步；如果他不愿承担损失，也照实写，不给每个欲望强加代价。）

## 成长弧光
（只有确有内在位移时才写；也可明确写"无内在变化"。变化可以变好、变坏或更复杂，不以道德改善为默认。）

---ROLE---
tier: major
name: <下一个主要角色>
---CONTENT---
...

（主要角色至少 3 个：主角 + 主要对手 + 主要协作者。建议 2-3 主 + 2-3 辅，不要灌水。质量 > 数量。）

---ROLE---
tier: minor
name: <次要角色名>
---CONTENT---
（次要角色简化版，只需要 4 个小标题：核心标签 / 反差细节 / 当前现状 / 与主角关系，每段 1-2 行即可）

（次要角色 3-5 个，按出场密度给。）

=== SECTION: book_rules ===

输出普通 Markdown，不要 YAML frontmatter，不要 JSON，不要代码块。这里只写给运行时和写手都能读懂的规则卡，不写长篇散文；叙事视角、核心冲突驱动等长说明已经在 story_frame.世界观底色里写过，这里只保留可执行规则。

## 主角
- 名字：<主角名>
- 性格锁：<3-5 个性格关键词，用顿号分隔>
- 行为约束：<只写用户明确要求或既有 Book 正典已经确认的边界；没有则省略本行>

## 题材锁
- 主类型：${book.genre}
- 禁止混入：<只写用户或既有 Book 正典确认的禁区；不得自行添加道德、安全或性别规范，没有则省略本行>

## 叙事人称
<只有当用户明确指定第一人称或第三人称时才写；没指定就写"无">

${gp.numericalSystem ? `## 数值/资源规则
- 核心资源：<核心资源类型>
- 硬上限：<根据设定确定，不能随剧情突破>` : ""}

${gp.eraResearch ? `## 年代限制
- <2-3 条必须符合年代/政策/物价/社会环境的约束>` : ""}

## 禁止事项
- <3-5 条本书禁忌>

=== SECTION: pending_hooks ===

初始伏笔池（Markdown表格），Phase 7 扩展列：
| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 回收节奏 | 上游依赖 | 回收卷 | 核心 | 半衰期 | 备注 |

伏笔表规则：
- 第5列必须是纯数字章节号，不能写自然语言描述
- 建书阶段所有伏笔都还没正式推进，所以第5列统一填 0
- 普通种子行不要写 open；尚未被正文真正推进的普通伏笔状态写「暂缓」。只有主线承重、依赖链或跨卷结构需要系统预升级时，运行时才会把它视为活跃伏笔
- 第7列必须填写：立即 / 近期 / 中程 / 慢烧 / 终局 之一
- 第8列「上游依赖」：列出必须在本伏笔之前种下/回收的上游 hook_id，格式如 [H003, H007]；若无依赖填「无」
- 第9列「回收卷」：用自然语言写该伏笔计划在哪一卷哪一段回收（例："第2卷中段"、"终卷终章前"）。不强制解析为章号
- 第10列「核心」：是否主线承重伏笔 true / false。主线承重伏笔一本书最多 3-7 条（主谜团、身世、核心承诺），其余次要伏笔填 false
- 第11列「半衰期」：可选，整数章数。若不填自动按回收节奏推导（立即/近期 = 10、中程 = 30、慢烧/终局 = 80）
- 初始线索放备注列，不放第5列
- **初始世界状态 / 初始敌我关系** 如果有关键信息（例如"主角身上带着父亲的笔记本"、"体制已经开始监视码头"），可以作为 startChapter=0 的种子行录入，备注列说明其"初始状态"属性。

## 最后强调
- 符合${book.platform}平台口味、${gp.name}题材特征
- 主角人设鲜明、行为边界清晰
- 伏笔前后呼应、配角有独立动机不是工具人
- **story_frame / volume_map / roles 必须是散文密度，不要退化成 bullet**
- **book_rules 用普通 Markdown 规则卡，不要 YAML/JSON/代码块，也不要写成长篇散文**
- **不要输出 rhythm_principles 或 current_state 独立 section**——节奏原则合并进 volume_map 尾段；角色初始状态写在 roles.当前现状，初始钩子写在 pending_hooks（startChapter=0 行），环境/时代锚（仅历史/年代/都市重生等需要年份的题材）织进 story_frame.世界观底色，不要硬凑
- **pending_hooks 表必须包含 Phase 7 扩展列——depends_on 标出因果链、pays_off_in_arc 锁定回收大致位置、core_hook 标记主线承重伏笔（3-7 条）、half_life 仅给重点伏笔设置**

## 硬性完结检查（生成前读一遍）
必须依次输出全部 **5 个 SECTION 块**：story_frame → volume_map → roles → book_rules → pending_hooks，不允许因为 story_frame 或 volume_map 写长了就不写后 3 段。哪怕 roles 只列 3 个角色、book_rules 只有 Markdown 小块、pending_hooks 只有 3 行，也要完整输出。只有写完 pending_hooks 最后一行才算交付。`;
  }

  private buildEnglishFoundationPrompt(
    book: BookConfig,
    gp: GenreProfile,
    genreBody: string,
    contextBlock: string,
    reviewFeedbackBlock: string,
    numericalBlock: string,
    powerBlock: string,
    eraBlock: string,
    futureAdvantageBlock: string,
  ): string {
    return `You are the architect of this book. Your only job is to produce **prose-density foundation design** — not tables, not schema, not bullet lists. The book's aura comes from your prose density: Phase 3 planner reads sparse memos out of your volume_map only if it was written to chapter-level prose; the writer only produces living characters because your role sheets carry contrast details; the reviewer only catches hard errors because your story_frame set the tonal anchors.${contextBlock}${reviewFeedbackBlock}

## Book metadata
- Platform: ${book.platform}
- Genre: ${gp.name} (${book.genre})
- Target chapters: ${book.targetChapters}
- Chapter length: ${book.chapterWordCount}
- Title: ${book.title}

## Genre body
${genreBody}

## Output constraints
${numericalBlock}
${powerBlock}
${eraBlock}
${futureAdvantageBlock}

## Output contract (5 === SECTION: === blocks)

## Deduplication rule (MANDATORY)
Do not duplicate the same fact across sections. The protagonist's arc lives only in roles; world hard-rules live only in story_frame; rhythm principles live only in the last paragraph of volume_map; character initial status lives only in roles.Current_State; initial hooks live only in pending_hooks (start_chapter=0 rows). **When the book is period fiction / historical fanfic / urban reincarnation** — anything pinned to a real year, season, or historic marker — weave the environment/era anchor into story_frame's world-tonal-ground paragraph (e.g. "July 1985, just after the SARS wave"). **For cultivation / high-fantasy / system genres that have no real-world year, skip it entirely** — do not fabricate an era anchor. If a section repeats content that belongs elsewhere, delete it.

## Output budget (over-budget means cut)
- story_frame ≤ 3000 chars
- volume_map ≤ 5000 chars
- roles ≤ 8000 chars total
- book_rules ≤ 1000 chars (ordinary Markdown rules card)
- pending_hooks ≤ 2000 chars

=== SECTION: story_frame ===

Four prose sections, ~600-900 chars each. No tables. No bullet lists. Real paragraphs. **Do NOT write the protagonist's full arc here** — that is owned by roles/主要角色/<protagonist>.md. Use a single-line pointer inside this block (e.g. "The protagonist is X; full arc lives in roles/主要角色/X.md").

## 01_Theme_and_Tonal_Ground
What is this book actually about — not "hero grows from weak to strong" (empty), but a concrete proposition. Then the tonal ground: warm / cold / fierce / severe — which, and why this and not another. End with a one-line pointer to the protagonist role file.

## 02_Core_Conflict_and_Foreground_Background_Story_Layers
The book's main tension — not "good vs evil" but "because A believes X and B believes Y, they will inevitably collide on Z". At least two opponents: one visible, one structural/systemic. Opponents have their own logic.

**This section must explicitly write out the foreground story / background story layers**:
- **Foreground story**: the surface conflict the reader sees every chapter (cases, combat, leveling up, romance, business moves). Each volume / arc has its own visible goal and closure point.
- **Background story**: the hidden machine running through the whole book — the puppet master, conspiracy, origin secret, systemic oppression, fated curse. The reader assembles it from fragments; full payoff lands near the finale.

The two layers must be causally linked, not parallel universes — every foreground conflict should trace back to some gear of the background machine turning. **Foreground-only story collapses into a set of disconnected episodes with no forward pull; background-only story is suffocating and never delivers. Write both in prose here, and name how they interlock.**

## 03_World_Tonal_Ground (hard rules + sensory tone + book-specific rules)
The world's operating rules: 3-5 causal constraints grounded in law, money, technology, status, institutional authority, or supernatural mechanics, written as prose rather than bullets. Do not turn moral approval, punishment, redemption, or compulsory character reform into world law. Sensory texture: wet or dry, fast or slow, noisy or quiet — give the writer an anchor. **This paragraph also absorbs the narrative prose that used to live in book_rules (narrative perspective, core conflict driver, book-specific rules).** Write them all here once. Do not repeat them in book_rules.

## 04_Endgame_Direction_and_Book_Objective
What the last chapter roughly feels like. The final shot: where, doing what, around whom, thinking what. A distant target for every planner call downstream.

**End this paragraph with a one-sentence Book Objective** (the root of the recursive OKR outline): when this book is done, the protagonist must reach a **verifiable end-state** (e.g., "rise from errand disciple to sect elder and publicly vindicate the parental case", "go from undocumented migrant worker to running three fur-trade companies and personally putting the ex-husband in prison"). Do NOT use vague words like "grow stronger" or "take revenge" — write a concrete state an outside observer can check "achieved / not achieved". This Book Objective is the root of the full-book OKR outline; volume_map will decompose it per volume below.

=== SECTION: volume_map ===

Prose volume map, **5 sections + 1 closing rhythm paragraph**. **Critical requirement: stay at volume-level prose only** — specify each volume's theme, emotional curve, cross-volume hooks, character stage goals, and volume-end irreversible changes. **Do NOT prescribe chapter-level tasks** (no "chapter 17 sends him home"). Chapter planning is the Phase 3 planner's job; the architect builds the skeleton, not the chapter list.

## 01_Volume_Themes_and_Emotional_Curves
How many volumes? Each volume's theme in one sentence; each volume's emotional curve as a paragraph (where pressured, where rewarding, where cold, where warm). Not mechanical rotation.

## 02_Cross_Volume_Hooks_and_Payoff_Promises (cover BOTH foreground and background layers)
Volume 1 plants hook A, paid off in volume N; volume 2 plants hook B, paid off in volume M. Prose, not tables. **Stay at volume-level** (e.g., "the origin mystery planted in volume 1 pays off in volume 3"); do not specify chapter numbers.

**Hooks must cover BOTH foreground and background layers** (matching the two-layer story established in story_frame.02):
- Foreground hooks: short-range arc-level hooks (case mystery, opponent identity, resource grab), paid off within 1-2 volumes
- Background hooks: full-book main-line hooks (ultimate truth, origin, systemic secret), paid off near the finale. The 3-7 load-bearing ones are core_hook=true

**If this paragraph only carries foreground hooks with no background seeds, you have lost the book's forward pull axis. Add them.**

## 03_Per_Volume_OKRs (Objective + 3 Key Results)
Recursive OKR outline that decomposes the Book Objective (root O set at the end of story_frame.04): every volume must explicitly state:
- **Objective (volume-level goal)**: a **verifiable state** the protagonist must reach by volume end, one sentence, logically chained to the Book Objective (e.g., if Book O = "become sect elder and vindicate the parental case", then Vol 1 O = "move from errand disciple into the registered disciple roster and recover the first lead pointing to the truth")
- **Key Results (3 items, quantifiable / observable)**: three concrete sub-achievements whose completion can be checked by an outside observer (e.g., KR1 = "take over the pharmacy garden steward seat", KR2 = "lock in a stable alliance with Lingan Peak", KR3 = "uncover the first half-page fragment of the parental case file"). No vague KRs like "gets stronger" / "matures".

Supporting characters' stage changes (master dies end of vol 2, opponent breaks bad in vol 3) go as notes under the relevant KR. Stage only — full arc lives in roles. **The 3 KRs per volume are direct input for the planner. It uses the recent 3-5 chapters as a diagnostic window and advances each KR according to event weight, required causality, and aftermath; this is not a fixed one-KR-per-window cadence.**

## 04_Volume_End_Mandatory_Changes
Each volume's last chapter must contain an irreversible event. Prose, one paragraph per volume. **Write what must happen, not which chapter**.

## 05_Rhythm_Principles (concrete + universal)
**This is the single home for rhythm principles — no separate rhythm_principles section exists.** Output 6 rhythm principles. **At least 3 must be concrete to this book's volumes, events, or reader promises**, but do not turn them into pass/fail quotas such as one hook every N chapters. The rest may stay universal (e.g., "no deus ex machina", "make necessary causality visible before a climax"). A concrete + universal mix is valid. Bad: "rhythm must balance tension and release". Good: "volume 1 uses the debt-ownership fight as its primary payoff; each mini-cycle first makes the ownership change visible, then chooses either clean settlement or pressure that grows from the result". Cover, in any order: (1) climax and payoff triggers, (2) the present function of breathing room, (3) ending carry / clean-closure mix and the volume-level deadline for core promises — never a per-chapter hook count, (4) information-release milestones, (5) dominant payoff types without density stuffing, and (6) event-driven relationship advancement rather than fixed chapter intervals. Give each 2-3 sentences.

If the external instructions specify content proportions (for example politics/romance 50/50 or career/relationship weighting), this paragraph must turn that into a full-book rhythm promise: which volumes lean toward which line, how a recent 3-5 chapter diagnostic window reveals a line that has genuinely disappeared, and which line carries fallout after climaxes. Do not merely say "keep it balanced," and do not turn every window into a per-line checklist.

=== SECTION: roles ===

One-file-per-character prose. **The protagonist card is the single source of truth for the protagonist's arc** — story_frame no longer carries it, and writer/planner both read it here.

---ROLE---
tier: major
name: <character name>
---CONTENT---
## Core_Tags
(3-5 tags + one sentence on why those tags)

## Contrast_Detail
(1-2 concrete details that contradict the core tags — "ice-cold killer but leaves fish bones for stray cats". Contrast detail is the formula for character dimensionality.)

## Back_Story
(Prose paragraph — how this person became who they are. Key past only, keep it lean.)

## Protagonist_Arc (start → end; cost and internal change optional)
**Mandatory for the protagonist; optional for other majors with substantial arcs.** State where they start and the concrete end-state they reach. Add an irreversible cost only when the planned events causally produce one, and add internal displacement only when this book actually calls for it. "No extra cost" and "no internal change" are valid. Never invent punishment, remorse, reform, or redemption merely because the character commits crimes or acts immorally. This section absorbs what used to live in story_frame.02_Protagonist_Arc.

## Current_State (initial state at chapter 0)
(Where they are at chapter 0, what's on their mind, most recent worry. **Character-only**: initial hooks go in pending_hooks start_chapter=0 rows; environment / era anchors (when the genre has a real year) are woven into story_frame's world-tonal-ground paragraph. No separate current_state section is produced.)

## Relationship_Network
(With protagonist, with other major characters. One line each. Relationships are dynamic, not labels.)

## Inner_Driver
(What they want, why, and how far they are willing to act. If they refuse loss, state that honestly; do not force a cost onto every desire.)

## Growth_Arc
(Write this only when the character has an internal displacement; "no internal change" is valid. Change may be better, worse, or more complex and is not synonymous with moral improvement.)

---ROLE---
tier: major
name: <next major>
---CONTENT---
...

(Aim for 2-3 majors + 2-3 supporting majors. Quality over quantity — do not pad.)

---ROLE---
tier: minor
name: <minor name>
---CONTENT---
(Simplified: only 4 sections — Core_Tags / Contrast_Detail / Current_State / Relationship_to_Protagonist, 1-2 lines each.)

(3-5 minors.)

=== SECTION: book_rules ===

Output ordinary Markdown. Do NOT output YAML frontmatter, JSON, or code fences. This is a compact rules card readable by both runtime and writers; long narrative guidance already lives in story_frame.03_World_Tonal_Ground.

## Protagonist
- Name: <protagonist name>
- Personality lock: <3-5 personality keywords, comma-separated>
- Behavioral constraints: <only boundaries explicitly supplied by the user or confirmed existing Book canon; omit this line when none exist>

## Genre Lock
- Primary: ${book.genre}
- Forbidden: <only exclusions confirmed by the user or existing Book canon; do not invent moral, safety, or demographic rules; omit this line when none exist>

## Narrative Person
<Write first person or third person ONLY if the user explicitly requested it; otherwise write "none".>

${gp.numericalSystem ? `## Numerical / Resource Rules
- Core resources: <core resource types>
- Hard cap: <setting-specific cap that cannot be broken by plot convenience>` : ""}

${gp.eraResearch ? `## Era Constraints
- <2-3 constraints tied to policy, prices, technology, or social environment>` : ""}

## Prohibitions
- <only prohibitions confirmed by the user or existing Book canon; write "none" when there are none, and do not invent moral correction>

=== SECTION: pending_hooks ===

Initial hook pool (Markdown table), Phase 7 extended columns:
| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | payoff_timing | depends_on | pays_off_in_arc | core_hook | half_life | notes |

Rules:
- Column 5 is a pure chapter number, not narrative description
- At book creation all planned hooks have last_advanced_chapter = 0
- Ordinary seed rows must not use status "open"; use "deferred" until prose actually advances them. Only load-bearing core / dependency / cross-volume hooks may be pre-promoted by the runtime into active hook debt
- Column 7 must be: immediate / near-term / mid-arc / slow-burn / endgame
- Column 8 (depends_on): upstream hook ids that must be planted / paid off before this one fires, formatted [H003, H007]; write "none" if no upstream
- Column 9 (pays_off_in_arc): free-form prose on where this hook is scheduled to pay off (e.g. "mid of volume 2", "right before the finale"). NOT parsed into chapter numbers
- Column 10 (core_hook): true / false. Core hooks are main-line load-bearing (central mystery, identity, key promise). A book typically has 3-7 cores; everything else is false
- Column 11 (half_life): optional integer chapters. If blank, derived from payoff_timing (immediate/near-term = 10, mid-arc = 30, slow-burn/endgame = 80)
- Put initial signal text in notes, not column 5
- **Initial world / alliance state**: any load-bearing initial condition ("protagonist carries the father's notebook", "the regime already watches the harbor") can be seeded as a start_chapter=0 row with a note-column tag indicating its initial-state nature.

## Final emphasis
- Fit ${book.platform} platform taste and ${gp.name} genre traits
- Protagonist persona clear with sharp behavioral boundaries
- Hooks planted with payoff promises; supporting characters have independent motivation
- **story_frame / volume_map / roles must be prose density — no bullet-list degradation**
- **book_rules is an ordinary Markdown rules card — no YAML, JSON, code fence, or long prose**
- **Do NOT emit rhythm_principles or current_state as separate sections** — rhythm principles live in the last paragraph of volume_map; character initial status goes in roles.Current_State; initial hooks go in pending_hooks (start_chapter=0 rows); environment / era anchors (only when the genre has a real year) are woven into story_frame's world-tonal-ground paragraph
- **pending_hooks table MUST carry Phase 7 extended columns — depends_on spells out the causal chain, pays_off_in_arc locks the approximate payoff location, core_hook marks main-line load-bearing hooks (3-7 per book), half_life only on priority hooks**

## Hard completeness check (read before generating)
You MUST emit all **5 SECTION blocks in order**: story_frame → volume_map → roles → book_rules → pending_hooks. Do NOT stop after story_frame or volume_map just because they ran long. Even if roles lists only 3 characters, book_rules is a small Markdown block, and pending_hooks has only 3 rows, all five must appear. The output is only considered delivered after the last row of pending_hooks is written.`;
  }

  // -------------------------------------------------------------------------
  // Parsing
  // -------------------------------------------------------------------------
  private async parseSectionsWithRepair(
    content: string,
    language: "zh" | "ko" | "en",
    futureAdvantageMode: FutureAdvantageFoundationMode = "forbidden",
    authorizedSources: ReadonlyArray<ArchitectMoralAuthoritySource> = [],
  ): Promise<ArchitectOutput> {
    try {
      const parsed = this.parseSections(content, language);
      this.validateFutureAdvantageFoundation(parsed, futureAdvantageMode, content);
      this.validateArchitectContentNeutrality(parsed, content, authorizedSources);
      return parsed;
    } catch (error) {
      if (!(error instanceof MissingArchitectSectionsError)
        && !(error instanceof FutureAdvantageFoundationContractError)
        && !(error instanceof ArchitectContentNeutralityContractError)) {
        throw error;
      }

      const repaired = error instanceof ArchitectContentNeutralityContractError
        ? await this.repairContentNeutrality(error, language)
        : await this.repairMissingSections(error, language);
      try {
        const parsed = this.parseSections(repaired, language);
        this.validateFutureAdvantageFoundation(parsed, futureAdvantageMode, repaired);
        this.validateArchitectContentNeutrality(parsed, repaired, authorizedSources);
        return parsed;
      } catch (repairError) {
        if (repairError instanceof ArchitectContentNeutralityContractError) {
          throw new ArchitectIncompleteFoundationError(
            ["unauthorized_mandatory_moral_correction"],
            repairError.content,
            language === "ko"
              ? "작품 기획에 사용자가 요청하지 않은 의무적 처벌·반성·속죄가 남아 있어 저장하지 않았습니다. 다시 생성해 주세요."
              : language === "en"
                ? "The foundation still contains an unrequested mandatory punishment, remorse, or redemption beat, so it was not saved. Regenerate it."
                : "基础设定仍包含用户未要求的强制惩罚、反省或赎罪，因此未保存。请重新生成。",
          );
        }
        if (repairError instanceof MissingArchitectSectionsError
          || repairError instanceof FutureAdvantageFoundationContractError) {
          const missingItems = repairError instanceof MissingArchitectSectionsError
            ? repairError.missing
            : repairError.expectation === "forbidden"
              ? ["book_rules_without_future_advantage"]
              : repairError.issues.length > 0
                ? repairError.issues.map((issue) => `book_rules.future_advantage.${issue}`)
                : ["book_rules.future_advantage"];
          const missing = missingItems.join("、");
          const message = language === "ko"
            ? `작품 기획이 완성되지 않았습니다(계약 문제: ${missingItems.join(", ")}). `
              + "입력 문제가 아니라 모델이 한 번에 모든 구역을 쓰지 못한 경우가 많습니다. "
              + "다시 시도하거나 더 강한 모델로 바꿔 생성해 주세요."
            : language === "en"
              ? `The story foundation came back incomplete (contract issue: ${missingItems.join(", ")}). `
              + "This usually means the model didn't write every section in one pass — it's not a problem with your input. "
              + "Try again, or switch to a stronger model (e.g. deepseek-v4-pro / gpt-5.5) and regenerate."
              : `基础设定没有生成完整(缺少:${missing})。`
                + "这通常是模型一次没把所有部分写全,不是你的输入有问题。"
                + "点重试,或换更强的模型(如 deepseek-v4-pro / gpt-5.5)再生成一次,通常就能解决。";
          throw new ArchitectIncompleteFoundationError(
            missingItems,
            repairError.content,
            message,
          );
        }
        throw repairError;
      }
    }
  }

  private validateArchitectContentNeutrality(
    output: ArchitectOutput,
    content: string,
    authorizedSources: ReadonlyArray<ArchitectMoralAuthoritySource>,
  ): void {
    const findings = findUnauthorizedMandatoryMoralCorrections(output, authorizedSources);
    if (findings.length > 0) {
      throw new ArchitectContentNeutralityContractError(findings, content);
    }
  }

  private async repairContentNeutrality(
    error: ArchitectContentNeutralityContractError,
    language: "zh" | "ko" | "en",
  ): Promise<string> {
    const system = language === "ko"
      ? [
          "InkOS 작품 기획의 콘텐츠 중립 계약을 복구합니다.",
          "인물·사건·승부·보상·캐논은 그대로 보존합니다.",
          "사용자나 기존 정본이 요구하지 않은 의무적 처벌, 반성, 사과, 개심, 교화, 속죄, 응보, 도덕적 성장만 제거하거나 선택값으로 바꿉니다.",
          "사건 인과에서 실제로 생기는 체포, 손실, 죄책감, 복수, 처벌, 용서, 구원은 지우지 않습니다.",
          "story_frame, volume_map, roles, book_rules, pending_hooks 다섯 SECTION 전체를 같은 순서로 반환하고 복구 과정은 설명하지 않습니다.",
        ].join("\n")
      : language === "en"
        ? [
            "Repair this InkOS foundation under its fiction-content-neutral contract.",
            "Preserve characters, events, conflict, payoff, and canon.",
            "Remove or make optional only mandatory punishment, remorse, apology, reform, rehabilitation, redemption, retribution, or moral growth that the user and existing canon did not request.",
            "Do not remove arrest, loss, guilt, revenge, punishment, forgiveness, or redemption that already follows from established scene causality.",
            "Return all five SECTION blocks in the same order and do not explain the repair.",
          ].join("\n")
        : [
            "按 InkOS 的虚构内容中立契约修复本书基础设定。",
            "保留人物、事件、冲突、兑现与正典。",
            "只删除或改为可选：用户与既有正典未要求的强制惩罚、反省、道歉、改过、教化、赎罪、报应或道德成长。",
            "不要删除由既有场景因果自然产生的逮捕、损失、内疚、复仇、惩罚、宽恕或救赎。",
            "按原顺序返回全部五个 SECTION，不解释修复过程。",
          ].join("\n");
    const user = `${language === "ko" ? "문제 구절" : language === "en" ? "Flagged phrases" : "问题语句"}:\n`
      + `${error.findings.map((finding) => `- ${finding}`).join("\n")}\n\n${error.content}`;
    const response = await this.chat([
      { role: "system", content: system },
      { role: "user", content: user },
    ], { temperature: 0.2 });
    return response.content;
  }

  private async repairMissingSections(
    error: MissingArchitectSectionsError | FutureAdvantageFoundationContractError,
    language: "zh" | "ko" | "en",
  ): Promise<string> {
    const missingList = error instanceof MissingArchitectSectionsError
      ? error.missing.join(", ")
      : error.expectation === "forbidden"
        ? "book_rules에서 미래 선점/Future Advantage/未来先机 섹션 제거"
        : error.issues.length > 0
          ? error.issues.map((issue) => `book_rules.future_advantage.${issue}`).join(", ")
          : "book_rules.future_advantage";
    const futureRepairRule = error instanceof FutureAdvantageFoundationContractError
      ? error.expectation === "forbidden"
        ? (language === "ko"
            ? "이 작품은 미래 지식물이 아닙니다. book_rules에서 미래 선점 섹션 전체를 제거합니다."
            : language === "en"
              ? "This is not a future-knowledge story. Remove the entire Future Advantage section from book_rules."
              : "本书不是未来知识题材。删除 book_rules 中整个未来先机段落。")
        : (language === "ko"
            ? "book_rules에 미래 선점 섹션과 회귀 기준 시점, 핵심 재미, 허용 분야, 알고 있는 것, 모르는 것, 금지된 지름길, 기억 원칙, 검색 정책을 모두 채웁니다."
            : language === "en"
              ? "Add the required Future Advantage section and all nine contract fields to book_rules."
              : "在 book_rules 中补齐未来先机段落及全部九个契约字段。")
      : "";
    const system = language === "ko"
      ? [
          "InkOS 한국어 기획 출력의 형식을 복구합니다.",
          "앞선 초안에서 쓸 수 있는 인물과 사건은 유지하고, 빠진 SECTION을 채웁니다.",
          "새 작품으로 바꾸거나 추상적인 설명을 덧붙이지 않습니다.",
          "story_frame, volume_map, roles, book_rules, pending_hooks 다섯 SECTION을 이 순서로 모두 반환합니다.",
          "book_rules는 일반 Markdown이고 pending_hooks는 Markdown 표입니다.",
          futureRepairRule,
          "복구 과정은 설명하지 않습니다.",
        ].join("\n")
      : language === "en"
        ? [
          "You repair InkOS architect output formatting.",
          "The previous draft is partially useful but is missing required SECTION blocks.",
          "Do not invent a new book. Preserve usable existing content and add the missing parts.",
          "Return the complete output with exactly these 5 SECTION blocks in order: story_frame, volume_map, roles, book_rules, pending_hooks.",
          "book_rules must be ordinary Markdown, not YAML. pending_hooks must be a Markdown table.",
          futureRepairRule,
          "Do not explain the repair.",
        ].join("\n")
        : [
          "你负责修复 InkOS architect 的输出格式。",
          "上一轮草稿有可用内容，但缺少必需的 SECTION 块。",
          "不要重新发明一本书；保留已有可用内容，只补齐缺失部分并整理成完整输出。",
          "必须按顺序返回完整 5 段 SECTION：story_frame、volume_map、roles、book_rules、pending_hooks。",
          "book_rules 必须是普通 Markdown，不要 YAML；pending_hooks 必须是 Markdown 表格。",
          futureRepairRule,
          "不要解释修复过程。",
        ].join("\n");
    const user = language === "ko"
      ? `빠진 SECTION: ${missingList}\n\n기존 불완전 출력:\n\n${error.content}`
      : language === "en"
        ? `Missing sections: ${missingList}\n\nOriginal partial output:\n\n${error.content}`
        : `缺失 section：${missingList}\n\n原始不完整输出如下：\n\n${error.content}`;

    const response = await this.chat([
      { role: "system", content: system },
      { role: "user", content: user },
    ], { temperature: 0.2 });
    return response.content;
  }

  private validateFutureAdvantageFoundation(
    output: ArchitectOutput,
    mode: FutureAdvantageFoundationMode,
    content: string,
  ): void {
    const contract = parseBookRules(output.bookRules)?.rules.futureAdvantage;
    if (mode === "forbidden") {
      if (contract !== undefined) {
        throw new FutureAdvantageFoundationContractError(mode, content);
      }
      return;
    }
    const missing = [
      !contract?.enabled ? "enabled" : "",
      !contract?.originMoment?.trim() ? "originMoment" : "",
      !contract?.corePromise?.trim() ? "corePromise" : "",
      !contract?.allowedDomains.length ? "allowedDomains" : "",
      !contract?.known.length ? "known" : "",
      !contract?.unknown.length ? "unknown" : "",
      !contract?.forbiddenShortcuts.length ? "forbiddenShortcuts" : "",
      !contract?.memoryPolicy?.trim() ? "memoryPolicy" : "",
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new FutureAdvantageFoundationContractError(mode, content, missing);
    }
  }

  private parseSections(content: string, language: "zh" | "ko" | "en"): ArchitectOutput {
    const parsedSections = this.parseArchitectSectionMap(content);

    // Phase 5 new sections take precedence.
    const storyFrame = parsedSections.get("story_frame") ?? "";
    const volumeMap = parsedSections.get("volume_map") ?? "";
    const rhythmPrinciples = parsedSections.get("rhythm_principles") ?? "";
    const rolesRaw = parsedSections.get("roles") ?? "";

    // Legacy sections (still produced for back-compat where needed).
    // If the model used old section names we still accept them.
    const legacyStoryBible = parsedSections.get("story_bible") ?? "";
    const legacyVolumeOutline = parsedSections.get("volume_outline") ?? "";
    const bookRules = parsedSections.get("book_rules");
    // Phase 5 consolidation: current_state is no longer a required section.
    // Legacy books (v12 / Phase 5 initial / pre-revert) and import/fanfic
    // regenerations may still produce it — accept the value when present,
    // fall through to empty seed when absent (consolidator will populate at
    // runtime). Era/setting anchors that used to motivate a separate
    // current_state block now live naturally inside story_frame.世界观底色
    // for genres that have a real-world year anchor; other genres (修仙/玄幻/
    // 系统文) omit them entirely.
    const currentStateLegacy = parsedSections.get("current_state") ?? "";
    const pendingHooksRaw = parsedSections.get("pending_hooks");

    // 5-section required contract: story_frame (or legacy story_bible),
    // volume_map (or legacy volume_outline), roles, book_rules, pending_hooks.
    //
    // Backward compat: v12 outputs used story_bible/volume_outline and
    // embedded character data inside story_bible — they had no roles block.
    // When the model uses ONLY legacy section names, we accept an empty roles
    // list (consolidator/readers fall back to the character_matrix shim).
    // When the new story_frame / volume_map names are used we require roles.
    const usingLegacyOutlineNames = !storyFrame && !volumeMap
      && (legacyStoryBible.length > 0 || legacyVolumeOutline.length > 0);

    const missing: string[] = [];
    const effectiveStoryFrame = storyFrame || legacyStoryBible;
    const effectiveVolumeMap = volumeMap || legacyVolumeOutline;
    if (!effectiveStoryFrame) missing.push("story_frame");
    if (!effectiveVolumeMap) missing.push("volume_map");
    if (!rolesRaw.trim() && !usingLegacyOutlineNames) missing.push("roles");
    if (!bookRules) missing.push("book_rules");
    if (!pendingHooksRaw) missing.push("pending_hooks");
    if (missing.length > 0) {
      throw new MissingArchitectSectionsError(missing, content);
    }

    const roles = this.parseRoles(rolesRaw);
    const pendingHooks = this.normalizePendingHooksSection(
      this.stripTrailingAssistantCoda(pendingHooksRaw!),
      effectiveVolumeMap,
    );

    // Synthesize legacy-facing content from new prose (so back-compat callers
    // still receive real content instead of empty strings).
    const storyBible = legacyStoryBible || this.buildStoryBibleShim(effectiveStoryFrame, language);
    const volumeOutline = legacyVolumeOutline || effectiveVolumeMap;

    return {
      storyBible,
      volumeOutline,
      bookRules: bookRules!,
      // currentState: empty string when architect no longer emits the section;
      // writeFoundationFiles seeds current_state.md with a placeholder so
      // consolidator / state-bootstrap readers find a valid file on first boot.
      currentState: currentStateLegacy,
      pendingHooks,
      storyFrame: effectiveStoryFrame,
      volumeMap: effectiveVolumeMap,
      rhythmPrinciples,
      roles,
    };
  }

  private parseArchitectSectionMap(content: string): Map<string, string> {
    const sectionPattern = /^\s{0,3}(?:#{1,6}\s*)?===\s*SECTION\s*[：:]\s*([^\n=]+?)\s*===\s*(?:#+\s*)?$/gim;
    const markerMatches = [...content.matchAll(sectionPattern)].map((match) => ({
      name: this.normalizeSectionName(match[1] ?? ""),
      index: match.index ?? 0,
      markerLength: match[0].length,
    }));
    if (markerMatches.length > 0) {
      return this.sliceArchitectSections(content, markerMatches);
    }

    const headingPattern = /^\s{0,3}#{1,3}\s+(.+?)\s*$/gim;
    const headingMatches = [...content.matchAll(headingPattern)]
      .map((match) => ({
        name: this.canonicalSectionNameFromHeading(match[1] ?? ""),
        index: match.index ?? 0,
        markerLength: match[0].length,
      }))
      .filter((match): match is { readonly name: string; readonly index: number; readonly markerLength: number } =>
        Boolean(match.name),
      );
    return this.sliceArchitectSections(content, headingMatches);
  }

  private sliceArchitectSections(
    content: string,
    matches: ReadonlyArray<{ readonly name: string; readonly index: number; readonly markerLength: number }>,
  ): Map<string, string> {
    const parsedSections = new Map<string, string>();
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i]!;
      const start = match.index + match.markerLength;
      const end = matches[i + 1]?.index ?? content.length;
      parsedSections.set(match.name, content.slice(start, end).trim());
    }
    return parsedSections;
  }

  /**
   * Parse ---ROLE---...---CONTENT---... blocks from the roles section.
   * Drops malformed entries silently — this is prose the LLM produced,
   * not machine input.
   */
  private parseRoles(raw: string): ReadonlyArray<ArchitectRole> {
    if (!raw.trim()) return [];

    const blocks = raw.split(/^---ROLE---$/m).map((chunk) => chunk.trim()).filter(Boolean);
    const roles: ArchitectRole[] = [];

    for (const block of blocks) {
      const contentSplit = block.split(/^---CONTENT---$/m);
      if (contentSplit.length < 2) continue;

      const headerRaw = contentSplit[0]!.trim();
      const content = contentSplit.slice(1).join("\n---CONTENT---\n").trim();

      const tierMatch = headerRaw.match(/tier\s*[:：]\s*(major|minor|主要|次要)/i);
      const nameMatch = headerRaw.match(/name\s*[:：]\s*(.+)/i);
      if (!tierMatch || !nameMatch) continue;

      const tierValue = tierMatch[1]!.toLowerCase();
      const tier: "major" | "minor" = (tierValue === "major" || tierValue === "主要") ? "major" : "minor";
      const name = nameMatch[1]!.trim();
      if (!name || !content) continue;

      roles.push({ tier, name, content });
    }

    return roles;
  }

  private buildStoryBibleShim(storyFrame: string, language: "zh" | "ko" | "en"): string {
    if (language === "ko") {
      return `# 스토리 바이블 (호환 포인터 — 사용 중단)\n\n> 외부 리더 호환을 위해 남긴 파일입니다. 현재 정본은 다음과 같습니다.\n> - outline/story_frame.md (주제 / 분위기 / 핵심 갈등 / 세계 규칙 / 결말)\n> - outline/volume_map.md (회차 단위 장거리 지도)\n> - roles/ 디렉터리 (인물별 역할 카드)\n\n## story_frame 발췌\n\n${storyFrame.slice(0, 2000)}\n`;
    }
    if (language !== "zh") {
      return `# Story Bible (compat pointer — deprecated)\n\n> This file is kept for external readers only. The authoritative source is now:\n> - outline/story_frame.md (theme / tonal ground / core conflict / world rules / endgame)\n> - outline/volume_map.md (chapter-granular plot map)\n> - roles/ directory (one-file-per-character sheets)\n\n## Excerpt from story_frame\n\n${storyFrame.slice(0, 2000)}\n`;
    }
    return `# 故事圣经（兼容指针——已废弃）\n\n> 本文件仅为外部读取保留。权威来源已迁移至：\n> - outline/story_frame.md（主题 / 基调 / 核心冲突 / 世界铁律 / 终局）\n> - outline/volume_map.md（章级别的分卷地图）\n> - roles/ 文件夹（一人一卡角色档案）\n\n## story_frame 摘录\n\n${storyFrame.slice(0, 2000)}\n`;
  }

  private buildCharacterMatrixShim(roles: ReadonlyArray<ArchitectRole>, language: "zh" | "ko" | "en"): string {
    const majorDir = language === "ko" ? "major" : "主要角色";
    const minorDir = language === "ko" ? "minor" : "次要角色";
    const majorLines = roles.filter((role) => role.tier === "major")
      .map((role) => `- roles/${majorDir}/${role.name}.md`);
    const minorLines = roles.filter((role) => role.tier === "minor")
      .map((role) => `- roles/${minorDir}/${role.name}.md`);

    if (language === "ko") {
      return `# 인물 매트릭스 (호환 포인터 — 사용 중단)\n\n> 외부 리더 호환을 위해 남긴 파일입니다. 인물별 정본은 roles/ 디렉터리에 있습니다.\n\n## 주요 인물\n\n${majorLines.join("\n") || "(없음)"}\n\n## 보조 인물\n\n${minorLines.join("\n") || "(없음)"}\n`;
    }

    if (language !== "zh") {
      return `# Character Matrix (compat pointer — deprecated)\n\n> This file is kept for external readers only. Authoritative source is now the roles/ directory (one-file-per-character).\n\n## Major characters\n\n${majorLines.join("\n") || "(none)"}\n\n## Minor characters\n\n${minorLines.join("\n") || "(none)"}\n`;
    }
    return `# 角色矩阵（兼容指针——已废弃）\n\n> 本文件仅为外部读取保留。权威来源已迁移至 roles/ 文件夹（一人一卡）。\n\n## 主要角色\n\n${majorLines.join("\n") || "（无）"}\n\n## 次要角色\n\n${minorLines.join("\n") || "（无）"}\n`;
  }

  // -------------------------------------------------------------------------
  // File writing
  // -------------------------------------------------------------------------
  async writeFoundationFiles(
    bookDir: string,
    output: ArchitectOutput,
    _numericalSystem: boolean = true,
    language: "zh" | "ko" | "en" = "zh",
    mode: "init" | "revise" = "init",
  ): Promise<void> {
    const isPhase5Output = Boolean(output.storyFrame?.trim());
    if (mode === "revise" && !isPhase5Output) {
      throw new Error(
        "Architect revise mode produced legacy-format output (storyFrame empty). " +
        "The book's architecture files have NOT been modified.",
      );
    }

    // Fully validate rules, exact selectors, carried authority, and new source
    // receipts before creating directories, replacing role cards, or writing
    // any foundation surface. Authority artifacts are prepared in memory here
    // and are persisted only after the remaining foundation writes succeed.
    const rulesFileContent = isPhase5Output
      ? `${output.bookRules.trim()}\n`
      : output.bookRules;
    const preparedBookRules = await this.prepareHostProvenancedBookRules(
      bookDir,
      rulesFileContent,
      mode,
      output.bookRuleAuthoritySources,
      output.bookRuleOwnerDecisions,
    );

    const storyDir = join(bookDir, "story");
    const outlineDir = join(storyDir, "outline");
    const rolesDir = join(storyDir, "roles");
    const rolesMajorDir = join(rolesDir, language === "ko" ? "major" : "主要角色");
    const rolesMinorDir = join(rolesDir, language === "ko" ? "minor" : "次要角色");

    await Promise.all([
      mkdir(storyDir, { recursive: true }),
      mkdir(outlineDir, { recursive: true }),
      mkdir(rolesMajorDir, { recursive: true }),
      mkdir(rolesMinorDir, { recursive: true }),
    ]);

    const writes: Array<Promise<void>> = [];

    const storyFrameBody = output.storyFrame ?? output.storyBible;
    const volumeMap = output.volumeMap ?? output.volumeOutline;
    const rhythmPrinciples = output.rhythmPrinciples ?? "";
    const roles = output.roles ?? [];

    if (mode === "revise") {
      await rm(rolesMajorDir, { recursive: true, force: true });
      await rm(rolesMinorDir, { recursive: true, force: true });
      await mkdir(rolesMajorDir, { recursive: true });
      await mkdir(rolesMinorDir, { recursive: true });
    }

    if (!isPhase5Output) {
      writes.push(writeFile(join(storyDir, "story_bible.md"), output.storyBible, "utf-8"));
      writes.push(writeFile(join(storyDir, "volume_outline.md"), output.volumeOutline, "utf-8"));
      writes.push(writeFile(
        join(storyDir, "character_matrix.md"),
        language === "ko"
          ? "# 인물 매트릭스\n\n<!-- 인물마다 ## 구획을 하나씩 사용하고 새 인물은 새 구획으로 추가하세요. -->\n"
          : language !== "zh"
          ? "# Character Matrix\n\n<!-- One ## section per character. Add new characters as new ## blocks. -->\n"
          : "# 角色矩阵\n\n<!-- 每个角色一个 ## 块，新角色追加新 ## 即可。 -->\n",
        "utf-8",
      ));

      if (mode === "init") {
        const currentStateSeed = output.currentState?.trim()
          ? output.currentState
          : (language === "ko"
              ? "# 현재 상태\n\n> 작품 생성 시 만든 초기 자리표시자입니다. 각 회차가 끝나면 정리기가 최신 상태를 덧붙입니다.\n"
              : language !== "zh"
              ? "# Current State\n\n> Seeded at book creation. Runtime state is appended by the consolidator after each chapter.\n"
              : "# 当前状态\n\n> 建书时占位。运行时每章之后由 consolidator 追加最新状态。\n");
        writes.push(writeFile(join(storyDir, "current_state.md"), currentStateSeed, "utf-8"));
        writes.push(writeFile(join(storyDir, "pending_hooks.md"), output.pendingHooks, "utf-8"));
        writes.push(writeFile(
        join(storyDir, "emotional_arcs.md"),
          language === "ko"
          ? "# 감정선\n\n| 인물 | 회차 | 감정 상태 | 촉발 사건 | 강도 (1-10) | 변화 방향 |\n| --- | --- | --- | --- | --- | --- |\n"
          : language !== "zh"
          ? "# Emotional Arcs\n\n| Character | Chapter | Emotional State | Trigger Event | Intensity (1-10) | Arc Direction |\n| --- | --- | --- | --- | --- | --- |\n"
            : "# 情感弧线\n\n| 角色 | 章节 | 情绪状态 | 触发事件 | 强度(1-10) | 弧线方向 |\n|------|------|----------|----------|------------|----------|\n",
          "utf-8",
        ));
      }

      await Promise.all(writes);
      await this.persistPreparedHostProvenancedBookRules(bookDir, preparedBookRules);
      return;
    }

    const storyFrame = storyFrameBody.trim();

    // Phase 5 primary prose files
    writes.push(writeFile(join(outlineDir, "story_frame.md"), storyFrame, "utf-8"));
    writes.push(writeFile(join(outlineDir, "volume_map.md"), volumeMap, "utf-8"));
    // Phase 5 consolidation: rhythm principles live inside the last paragraph
    // of volume_map. A separate 节奏原则.md / rhythm_principles.md file is only
    // written when the architect happened to produce a standalone block (legacy
    // 7-section output / foundation-reviewer round-trips that still split it
    // out). Skipping the empty write avoids 0-byte files that mislead the UI
    // and fight against the "no duplication" rule — readers who need the rhythm
    // content already pull it from volume_map's closing paragraph.
    if (rhythmPrinciples.trim()) {
      const rhythmFileName = language !== "zh" ? "rhythm_principles.md" : "节奏原则.md";
      writes.push(writeFile(join(outlineDir, rhythmFileName), rhythmPrinciples, "utf-8"));
    }

    // Roles — one file per character
    for (const role of roles) {
      const targetDir = role.tier === "major" ? rolesMajorDir : rolesMinorDir;
      const safeName = role.name.replace(/[/\\:*?"<>|]/g, "_").trim();
      if (!safeName) continue;
      writes.push(writeFile(join(targetDir, `${safeName}.md`), role.content, "utf-8"));
    }

    // Compat shims — these are pointer files, not authoritative content.
    writes.push(writeFile(
      join(storyDir, "story_bible.md"),
      this.buildStoryBibleShim(storyFrame, language),
      "utf-8",
    ));
    writes.push(writeFile(
      join(storyDir, "character_matrix.md"),
      this.buildCharacterMatrixShim(roles, language),
      "utf-8",
    ));

    // Cleanup #1: volume_outline.md mirror removed. All readers now resolve
    // through readVolumeMap() in utils/outline-paths.ts, which prefers
    // outline/volume_map.md and falls back to legacy volume_outline.md for
    // books initialized before Phase 5.

    // Runtime state files.
    // Phase 5 consolidation: the architect no longer emits a current_state
    // section (only 3 genres — 港综同人/年代文/都市重生 — benefit from a
    // separate era anchor, and those fold naturally into story_frame.世界观底色).
    // We still write current_state.md with a seed placeholder so
    // isCompleteBookDirectory() sees it on first boot and the runtime
    // consolidator has a file to append each chapter's state into.
    // Per-character state lives in roles/*.Current_State; initial hook rows
    // live in pending_hooks with start_chapter=0. Legacy books / imports that
    // still produced the section keep their content as-is.
    if (mode === "init") {
      const currentStateSeed = output.currentState?.trim()
        ? output.currentState
        : (language === "ko"
            ? "# 현재 상태\n\n> 작품 생성 시 만든 초기 자리표시자입니다. 각 회차가 끝나면 정리기가 최신 상태를 덧붙입니다. 인물별 초기 상태는 roles/* 역할 카드에 있고, 중요한 초기 세계 사실은 pending_hooks의 start_chapter=0 행에 있습니다.\n"
            : language !== "zh"
            ? "# Current State\n\n> Seeded at book creation. Runtime state is appended by the consolidator after each chapter. Initial per-character state lives in roles/*.Current_State; load-bearing initial world facts live in pending_hooks rows with start_chapter=0.\n"
            : "# 当前状态\n\n> 建书时占位。运行时每章之后由 consolidator 追加最新状态。每个角色的初始状态详见 roles/*.当前现状；承重的初始世界设定见 pending_hooks 里 startChapter=0 的行。\n");
      writes.push(writeFile(join(storyDir, "current_state.md"), currentStateSeed, "utf-8"));
      writes.push(writeFile(join(storyDir, "pending_hooks.md"), output.pendingHooks, "utf-8"));
      writes.push(writeFile(
        join(storyDir, "emotional_arcs.md"),
        language === "ko"
          ? "# 감정선\n\n| 인물 | 회차 | 감정 상태 | 촉발 사건 | 강도 (1-10) | 변화 방향 |\n| --- | --- | --- | --- | --- | --- |\n"
          : language !== "zh"
          ? "# Emotional Arcs\n\n| Character | Chapter | Emotional State | Trigger Event | Intensity (1-10) | Arc Direction |\n| --- | --- | --- | --- | --- | --- |\n"
          : "# 情感弧线\n\n| 角色 | 章节 | 情绪状态 | 触发事件 | 强度(1-10) | 弧线方向 |\n|------|------|----------|----------|------------|----------|\n",
        "utf-8",
      ));
    }

    // Cleanup #2 (Option B): particle_ledger.md / subplot_board.md /
    // chapter_summaries.md are pure runtime logs appended by the writer's
    // settlement phase. The architect no longer seeds them here — mixing a
    // static "setting" seed with a runtime "append log" was the dual-purpose
    // mess that prompted the cleanup. If they don't exist yet, downstream
    // readers see the placeholder and the first chapter settlement creates
    // them naturally. The `_numericalSystem` parameter is kept for API
    // compatibility with existing callers.

    await Promise.all(writes);
    await this.persistPreparedHostProvenancedBookRules(bookDir, preparedBookRules);
  }

  private async prepareHostProvenancedBookRules(
    bookDir: string,
    rulesFileContent: string,
    mode: "init" | "revise",
    authoritySources: ReadonlyArray<ArchitectBookRuleAuthoritySource> = [],
    ownerDecisionValues: ReadonlyArray<ArchitectBookRuleOwnerDecision> = [],
  ): Promise<PreparedArchitectBookRules> {
    const parsed = parseBookRules(rulesFileContent);
    if (!parsed) {
      throw new Error("Architect BookRules output is not parseable; refusing an unpaired rules write.");
    }
    const ownerDecisions = ownerDecisionValues.map((decision) => (
      BookRuleOwnerDecisionInputSchema.parse(decision)
    ));
    const rules = this.applyOwnerDecisionsToRules(parsed.rules, ownerDecisions);
    const normalizedRulesFileContent = ownerDecisions.length > 0
      ? renderBookRulesDocument(rules, parsed.body)
      : rulesFileContent;
    const bookId = await readFile(join(bookDir, "book.json"), "utf8")
      .then((raw) => {
        const value = JSON.parse(raw) as { id?: unknown };
        return typeof value.id === "string" && value.id.trim() ? value.id : basename(bookDir);
      })
      .catch(() => basename(bookDir));
    let carriedEntries: ReadonlyArray<BookRuleProvenanceEntry> = [];
    if (mode === "revise") {
      const previousRaw = await readFile(join(bookDir, "story", "book_rules.md"), "utf8")
        .catch(() => "");
      const previousParsed = previousRaw ? parseBookRules(previousRaw) : null;
      if (previousParsed) {
        const verification = verifyBookRuleProvenance(
          await readBookRuleProvenance(bookDir),
          {
            bookId,
            rulesFileContent: previousRaw,
            rules: previousParsed.rules,
          },
        );
        if (verification.status === "current") {
          const authority = await verifyBookRuleAuthorityEvidence(verification.receipt, bookDir);
          if (authority.status === "verified") {
            carriedEntries = carryForwardBookRuleProvenanceEntries(
              verification,
              rules,
            );
          }
        }
      }
    }
    const preparedAuthority = this.prepareExactBookRuleAuthorityAssignments({
      bookId,
      rules,
      authoritySources,
      ownerDecisions,
    });
    const receipt = compileBookRuleProvenance({
      bookId,
      rulesFileContent: normalizedRulesFileContent,
      rules,
      assignments: preparedAuthority.assignments,
      carriedEntries,
    });
    return {
      bookId,
      rulesFileContent: normalizedRulesFileContent,
      rules,
      receipt,
      authorityWrites: preparedAuthority.writes,
    };
  }

  private async persistPreparedHostProvenancedBookRules(
    bookDir: string,
    prepared: PreparedArchitectBookRules,
  ): Promise<void> {
    if (prepared.authorityWrites.size > 0) {
      await Promise.all([...prepared.authorityWrites.entries()].map(async ([relativePath, content]) => {
        const target = join(bookDir, relativePath);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
      }));
    }
    await persistBookRulesPair({
      bookDir,
      bookId: prepared.bookId,
      rulesFileContent: prepared.rulesFileContent,
      rules: prepared.rules,
      receipt: prepared.receipt,
    });
  }

  private prepareExactBookRuleAuthorityAssignments(input: {
    readonly bookId: string;
    readonly rules: BookRules;
    readonly authoritySources: ReadonlyArray<ArchitectBookRuleAuthoritySource>;
    readonly ownerDecisions: ReadonlyArray<ArchitectBookRuleOwnerDecision>;
  }): {
    readonly assignments: ReadonlyArray<BookRuleAuthorityAssignment>;
    readonly writes: ReadonlyMap<string, string>;
  } {
    if (input.authoritySources.length === 0 && input.ownerDecisions.length === 0) {
      return { assignments: [], writes: new Map() };
    }
    const rules = this.enumerateArchitectEnforcementRules(input.rules);
    const assignments: BookRuleAuthorityAssignment[] = [];
    const writes = new Map<string, string>();
    const ownerDecisionByKey = new Map(input.ownerDecisions.map((decision) => [
      `${decision.collection}\u0000${decision.text}`,
      decision,
    ]));

    for (const rule of rules) {
      const collection = rule.fieldPath.slice(0, rule.fieldPath.lastIndexOf("[")) as BookRuleProvenanceCollection;
      const ownerDecision = ownerDecisionByKey.get(`${collection}\u0000${rule.text}`);
      if (ownerDecision) {
        const receipt = compileBookRuleOwnerAdoptionReceipt({
          bookId: input.bookId,
          decisionId: ownerDecision.decisionId,
          adoptedByActorId: ownerDecision.adoptedByActorId,
          fieldPath: rule.fieldPath,
          text: rule.text,
        });
        const receiptContent = renderBookRuleOwnerAdoptionReceipt(receipt);
        const receiptHash = createHash("sha256").update(receiptContent, "utf8").digest("hex");
        const receiptPath = `story/authority/book-rules/receipts/${receiptHash}.json`;
        writes.set(receiptPath, receiptContent);
        assignments.push({
          fieldPath: rule.fieldPath,
          text: rule.text,
          source: "user-explicit",
          strength: "hard",
          ownerAdoptionReceipt: { receiptPath, receiptContent },
        });
        continue;
      }
      let selected: {
        readonly source: ArchitectBookRuleAuthoritySource;
        readonly start: number;
      } | undefined;
      for (const source of input.authoritySources) {
        let from = 0;
        while (from <= source.artifactContent.length - rule.text.length) {
          const start = source.artifactContent.indexOf(rule.text, from);
          if (start < 0) break;
          if (isPositiveAuthorityOccurrence(
            source.artifactContent,
            start,
            start + rule.text.length,
            { requireExplicitOwnerAdoption: source.source !== "book-canon" },
          )) {
            selected = { source, start };
            break;
          }
          from = Math.max(start + rule.text.length, start + 1);
        }
        if (selected) break;
      }
      if (!selected) continue;

      const artifactHash = createHash("sha256")
        .update(selected.source.artifactContent, "utf8")
        .digest("hex");
      const artifactPath = `story/authority/book-rules/sources/${artifactHash}.txt`;
      const sourceSelector = {
        artifactPath,
        artifactContent: selected.source.artifactContent,
        start: selected.start,
        end: selected.start + rule.text.length,
      };
      const receipt = compileBookRuleSourceAuthorityReceipt({
        bookId: input.bookId,
        source: selected.source.source,
        authorityOrigin: selected.source.authorityOrigin,
        intent: selected.source.intent,
        decisionId: selected.source.decisionId,
        authorizedByActorId: selected.source.authorizedByActorId,
        fieldPath: rule.fieldPath,
        text: rule.text,
        sourceSelector,
      });
      const receiptContent = renderBookRuleSourceAuthorityReceipt(receipt);
      const receiptHash = createHash("sha256").update(receiptContent, "utf8").digest("hex");
      const receiptPath = `story/authority/book-rules/receipts/${receiptHash}.json`;
      writes.set(artifactPath, selected.source.artifactContent);
      writes.set(receiptPath, receiptContent);
      assignments.push({
        fieldPath: rule.fieldPath,
        text: rule.text,
        source: selected.source.source,
        strength: "hard",
        sourceSelector,
        sourceAuthorityReceipt: { receiptPath, receiptContent },
      });
    }

    return { assignments, writes };
  }

  private applyOwnerDecisionsToRules(
    rulesValue: BookRules,
    ownerDecisions: ReadonlyArray<ArchitectBookRuleOwnerDecision>,
  ): BookRules {
    if (ownerDecisions.length === 0) return rulesValue;
    const seen = new Set<string>();
    let rules = BookRulesSchema.parse(rulesValue);
    for (const decision of ownerDecisions) {
      const key = `${decision.collection}\u0000${decision.text}`;
      if (seen.has(key)) {
        throw new Error(`Duplicate owner hard-rule decision: ${decision.collection}`);
      }
      seen.add(key);
      if (decision.collection === "prohibitions") {
        rules = {
          ...rules,
          prohibitions: appendExactRule(rules.prohibitions, decision.text),
        };
        continue;
      }
      if (decision.collection === "protagonist.behavioralConstraints") {
        if (!rules.protagonist) {
          throw new Error("Cannot adopt a protagonist behavioral constraint before the foundation names a protagonist");
        }
        rules = {
          ...rules,
          protagonist: {
            ...rules.protagonist,
            behavioralConstraints: appendExactRule(
              rules.protagonist.behavioralConstraints,
              decision.text,
            ),
          },
        };
        continue;
      }
      if (decision.collection === "genreLock.forbidden") {
        if (!rules.genreLock) {
          throw new Error("Cannot adopt a genre-lock rule before the foundation defines its primary genre");
        }
        rules = {
          ...rules,
          genreLock: {
            ...rules.genreLock,
            forbidden: appendExactRule(rules.genreLock.forbidden, decision.text),
          },
        };
        continue;
      }
      if (!rules.futureAdvantage) {
        throw new Error("Cannot adopt a future-advantage shortcut rule when future advantage is not configured");
      }
      rules = {
        ...rules,
        futureAdvantage: {
          ...rules.futureAdvantage,
          forbiddenShortcuts: appendExactRule(
            rules.futureAdvantage.forbiddenShortcuts,
            decision.text,
          ),
        },
      };
    }
    return BookRulesSchema.parse(rules);
  }

  private enumerateArchitectEnforcementRules(
    rules: BookRules,
  ): ReadonlyArray<{ readonly fieldPath: BookRuleFieldPath; readonly text: string }> {
    const entries: Array<{ fieldPath: BookRuleFieldPath; text: string }> = [];
    const push = (
      collection: "protagonist.behavioralConstraints" | "genreLock.forbidden" | "prohibitions" | "futureAdvantage.forbiddenShortcuts",
      values: ReadonlyArray<string>,
    ): void => {
      values.forEach((text, index) => entries.push({
        fieldPath: `${collection}[${index}]`,
        text,
      }));
    };
    push("protagonist.behavioralConstraints", rules.protagonist?.behavioralConstraints ?? []);
    push("genreLock.forbidden", rules.genreLock?.forbidden ?? []);
    push("prohibitions", rules.prohibitions);
    push("futureAdvantage.forbiddenShortcuts", rules.futureAdvantage?.forbiddenShortcuts ?? []);
    return entries;
  }

  /**
   * Reverse-engineer foundation from existing chapters.
   */
  async generateFoundationFromImport(
    book: BookConfig,
    chaptersText: string,
    externalContext?: string,
    reviewFeedback?: string,
    options?: { readonly importMode?: "continuation" | "series" },
  ): Promise<ArchitectOutput> {
    const { profile: gp, body: genreBody } =
      await readGenreProfile(this.ctx.projectRoot, book.genre);
    const resolvedLanguage = book.language ?? gp.language;
    const reviewFeedbackBlock = this.buildReviewFeedbackBlock(reviewFeedback, resolvedLanguage);
    const shouldSanitizeKoreanFallback = resolvedLanguage === "ko" && gp.language !== "ko";
    const promptProfile = shouldSanitizeKoreanFallback
      ? {
          ...gp,
          name: book.genre.replace(/[_-]+/g, " "),
          language: "ko" as const,
          chapterTypes: ["일반 회차"],
          fatigueWords: [],
          satisfactionTypes: [],
          pacingRule: "",
        }
      : gp;
    const promptGenreBody = shouldSanitizeKoreanFallback ? "" : genreBody;

    const contextBlock = externalContext
      ? (resolvedLanguage === "ko"
          ? `\n\n## 외부 지시\n다음 지시를 가져온 원고의 사실과 함께 반영하세요.\n\n${externalContext}\n`
          : resolvedLanguage === "en"
            ? `\n\n## External Instructions\n${externalContext}\n`
            : `\n\n## 外部指令\n${externalContext}\n`)
      : "";
    const futureAdvantageMode = resolveFutureAdvantageFoundationMode({
      title: book.title,
      genre: book.genre,
      creativeBrief: [externalContext ?? "", chaptersText.slice(0, 12_000)].filter(Boolean).join("\n"),
    });
    const futureAdvantageBlock = this.buildFutureAdvantageFoundationBlock(
      futureAdvantageMode,
      resolvedLanguage,
    );

    const numericalBlock = gp.numericalSystem
      ? (resolvedLanguage === "ko"
          ? "- 원고에 나온 돈·지분·능력치 같은 자원의 획득과 지출을 추적합니다."
          : resolvedLanguage === "en"
            ? "- The story uses a trackable numerical/resource system"
            : "- 有明确的数值/资源体系可追踪")
      : (resolvedLanguage === "ko"
          ? "- 원고에 없는 수치 체계를 새로 만들지 않습니다."
          : resolvedLanguage === "en"
            ? "- No explicit numerical system"
            : "- 本题材无数值系统");

    const isSeries = options?.importMode === "series";

    const continuationDirective = resolvedLanguage === "ko"
      ? (isSeries
          ? `## 후속부 방향
후속부는 새 갈등, 새 장소, 달라진 시간 조건 가운데 둘 이상을 엽니다. 이미 벌어진 사건의 필요한 후과를 먼저 착지시킨 뒤 초반부터 새 승부를 가동하되, 5화 같은 고정 기한을 만들거나 기존 사건의 이름만 바꿔 반복하지 않습니다.`
          : `## 이어쓰기 방향
기존 인물의 선택과 미회수 단서에서 다음 사건을 시작합니다. 이미 해결된 승부를 되풀이하지 말고, 주인공이 얻은 것을 눈에 보이게 먼저 확인시킨 뒤 그 결과에서 자연스럽게 생기는 선택·후과·압력 또는 완결된 결산 가운데 맞는 흐름을 둡니다.`)
      : resolvedLanguage === "en"
        ? (isSeries
          ? `## Continuation Direction Requirements
The continuation portion must open new narrative space — a new conflict vector, location, or time horizon. After landing necessary fallout, activate the new contest early without a fixed five-chapter deadline; the continuation should be predominantly fresh scenes rather than a renamed replay.`
          : `## Continuation Direction
Naturally extend the existing arc. Advance existing conflicts, pay off planted hooks, introduce new complications organically.`)
        : (isSeries
          ? `## 续写方向要求
续写必须引入新叙事空间——新冲突、新地点或新的时间条件。先让既有事件的必要后果落地，再尽早启动新的胜负，但不要设置固定五章期限；以原创场景为主，不按新鲜度百分比凑数。`
          : `## 续写方向
自然延续已有叙事弧线。推进现有冲突、兑现已埋伏笔、引入有机新变数。`);

    const systemPrompt = resolvedLanguage === "ko"
      ? `${this.buildKoreanFoundationPrompt(
          book,
          promptProfile,
          promptGenreBody,
          contextBlock,
          reviewFeedbackBlock,
          numericalBlock,
          gp.powerScaling ? "- 원고에서 확인되는 힘의 서열과 승패 조건을 유지합니다." : "",
          gp.eraResearch ? "- 원고의 시대 정보와 실제 연표가 충돌하지 않게 확인합니다." : "",
          futureAdvantageBlock,
        )}

## 가져온 원고를 다루는 법
- 이미 원고에 나온 인물, 사건, 관계, 숫자는 추측으로 바꾸지 않습니다.
- 기존 구간은 핵심 승부와 결과를 한 문단으로 정리하고, 후속부는 권 단위로 설계합니다.
- 원고에 근거가 없는 과거사를 확정하지 않습니다. 새로 만들 필요가 있으면 후속부의 계획이라고 밝힙니다.
- 원고가 압축 자료라면 목차와 발췌문에서 확인되는 범위까지만 사실로 씁니다.
- 기존 원고의 재미가 약한 곳도 미화하지 않습니다. 어떤 행동 뒤에 보상이 없었는지 확인하고 후속부에서 갚습니다.

${continuationDirective}`
      : resolvedLanguage === "en"
        ? `You are a professional novel architect. Reverse-engineer a prose-density foundation from the source chapters and write the continuation path.${contextBlock}${reviewFeedbackBlock}

## Book metadata
- Title: ${book.title}
- Platform: ${book.platform}
- Genre: ${gp.name} (${book.genre})
- Target chapters: ${book.targetChapters}
- Chapter length: ${book.chapterWordCount}

## Genre body
${genreBody}

${numericalBlock}
${futureAdvantageBlock}

${continuationDirective}

## Output contract
Follow the consolidated 5-section === SECTION: === layout: story_frame, volume_map, roles, book_rules, pending_hooks. Do NOT emit rhythm_principles or current_state — rhythm principles live in the last paragraph of volume_map; character initial status lives in roles.Current_State; initial hooks live in pending_hooks start_chapter=0 rows; era / setting anchors (only when the genre pins to a real year) are woven into story_frame's world-tonal-ground paragraph.

All prose must be derived from the source package. Do not invent settings. If the package says it is compressed, treat chapter catalog + excerpts as evidence for the foundation; the full chapters will be replayed later for detailed truth files. For volume_map, treat existing chapters as "review" (one paragraph) and continuation as prose chapter-level planning. Hook extraction must be complete for the evidence provided.

All output MUST be written in English.`
        : `你是专业的网络小说架构师。从已有章节中反向推导散文密度的基础设定，同时设计续写路径。${contextBlock}${reviewFeedbackBlock}

## 书籍元信息
- 标题：${book.title}
- 平台：${book.platform}
- 题材：${gp.name}（${book.genre}）
- 目标章数：${book.targetChapters}章

## 题材底色
${genreBody}

${numericalBlock}
${futureAdvantageBlock}

${continuationDirective}

## 输出契约
合并后的 5 段 === SECTION: === 结构：story_frame / volume_map / roles / book_rules / pending_hooks。**不要输出 rhythm_principles 或 current_state 两个 section**——节奏原则合并进 volume_map 尾段，角色初始状态合并进 roles.当前现状，初始钩子写在 pending_hooks startChapter=0 行；环境/时代锚（只有年代文 / 历史同人 / 都市重生等真实年份题材需要）织进 story_frame.世界观底色，其他题材直接省略。

所有 prose 必须从资料包中推导，不得臆造。若资料包声明为压缩包，把章节目录和正文摘录当作基础设定证据；完整章节会在后续回放阶段逐章进入 truth files。volume_map 中，已有章节作为"回顾段"（一段散文），续写部分写到章级 prose。伏笔识别以资料包提供的证据为准，尽量完整。`;

    const userMessage = resolvedLanguage === "ko"
      ? `아래는 《${book.title}》의 기존 원고 자료입니다. 확인되는 사실을 지키면서 한국 상업 웹소설 작가가 바로 이어 쓸 수 있는 기획을 완성하세요.\n\n${chaptersText}`
      : resolvedLanguage === "en"
        ? `Generate the complete foundation for an imported ${gp.name} novel titled "${book.title}". Write everything in English.\n\n${chaptersText}`
        : `以下是《${book.title}》的已有正文资料包，请从中反向推导完整基础设定：\n\n${chaptersText}`;

    const response = await this.chat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ], { temperature: 0.5 });

    const foundation = await this.parseSectionsWithRepair(
      response.content,
      resolvedLanguage,
      futureAdvantageMode,
      [],
    );
    return foundation;
  }

  async generateFanficFoundation(
    book: BookConfig,
    fanficCanon: string,
    fanficMode: FanficMode,
    reviewFeedback?: string,
  ): Promise<ArchitectOutput> {
    const { profile: gp, body: genreBody } =
      await readGenreProfile(this.ctx.projectRoot, book.genre);
    // Fanfic prompts currently have native Korean and legacy Chinese routes.
    // Infer Korean from a Korean profile, but preserve the established Chinese
    // compatibility route for omitted-language English profiles until a native
    // English fanfic prompt is implemented end to end.
    const resolvedLanguage = book.language ?? (gp.language === "ko" ? "ko" : "zh");
    const shouldSanitizeKoreanFallback = resolvedLanguage === "ko" && gp.language !== "ko";
    const promptProfile = shouldSanitizeKoreanFallback
      ? {
          ...gp,
          name: book.genre.replace(/[_-]+/g, " "),
          language: "ko" as const,
          chapterTypes: ["일반 회차"],
          fatigueWords: [],
          satisfactionTypes: [],
          pacingRule: "",
        }
      : gp;
    const promptGenreBody = shouldSanitizeKoreanFallback ? "" : genreBody;
    const reviewFeedbackBlock = this.buildReviewFeedbackBlock(reviewFeedback, resolvedLanguage);
    const futureAdvantageMode = resolveFutureAdvantageFoundationMode({
      title: book.title,
      genre: book.genre,
    });
    const futureAdvantageBlock = this.buildFutureAdvantageFoundationBlock(
      futureAdvantageMode,
      resolvedLanguage,
    );

    const MODE_INSTRUCTIONS: Record<FanficMode, string> = {
      canon: "剧情发生在原作空白期或未详述的角度。不可改变原作已确立的事实。",
      au: "标注AU设定与原作的关键分歧点，分歧后的世界线自由发展。保留角色核心性格。",
      ooc: "标注角色性格偏离的起点和驱动事件。偏离必须有逻辑驱动。",
      cp: "以配对角色的关系线为主线规划卷纲。每卷必须有关系推进节点。",
    };
    const KO_MODE_INSTRUCTIONS: Record<FanficMode, string> = {
      canon: "원작의 빈 시기나 원작이 보여 주지 않은 인물의 시점을 씁니다. 원작에서 확정된 사건은 바꾸지 않습니다.",
      au: "원작과 갈라지는 사건을 하나 정하고, 그 사건 뒤의 결과를 끝까지 따릅니다. 인물의 핵심 성격은 유지합니다.",
      ooc: "인물이 원작과 다른 선택을 하게 된 사건과 동기를 먼저 정합니다. 인과 없이 성격을 바꾸지 않으며, 대가·벌·개심은 실제 사건이 요구할 때만 둡니다.",
      cp: "두 인물이 함께 행동해야만 풀리는 사건을 중심에 둡니다. 각 권에서 말이 아닌 선택으로 관계가 달라져야 합니다.",
    };

    const systemPrompt = resolvedLanguage === "ko"
      ? `${this.buildKoreanFoundationPrompt(
          book,
          promptProfile,
          promptGenreBody,
          "",
          reviewFeedbackBlock,
          gp.numericalSystem
            ? "- 원작의 수치와 자원 한계를 유지하며 새 수치를 편의상 만들지 않습니다."
            : "- 원작에 없는 수치 체계를 새로 만들지 않습니다.",
          gp.powerScaling ? "- 원작의 힘의 서열을 지킵니다. 이를 뒤집을 때는 원작 안의 수단과 인과가 필요하며, 대가는 실제 사건이 만들 때만 둡니다." : "",
          gp.eraResearch ? "- 원작과 실제 시대의 연표를 함께 지킵니다." : "",
          futureAdvantageBlock,
        )}

## 원작 기반 창작 조건
- 방식: ${fanficMode}
- ${KO_MODE_INSTRUCTIONS[fanficMode]}
- 원작에서 확인되는 사실과 인물의 기억을 우선합니다.
- 원작 사건을 다시 요약하는 데 분량을 쓰지 않습니다. 필요한 후과를 건너뛰지 않으면서 초반부터 이 작품만의 승부를 가동하되, 5화 같은 고정 기한은 두지 않습니다.
- 주요 인물은 원작 인물을 사용합니다. 새 인물을 만들면 이름 옆에 "오리지널 인물"이라고 적습니다.
- book_rules의 장르 약속 아래에 "원작 기반 방식: ${fanficMode}"를 적습니다.

## 원작 자료
${fanficCanon}`
      : `你是专业同人架构师。基于原作正典为同人生成散文密度的基础设定。

## 同人模式：${fanficMode}
${MODE_INSTRUCTIONS[fanficMode]}

## 新时空要求
必须为这本同人设计原创叙事空间，不是复述原作剧情：
1. 明确分岔点——story_frame 必须标注本作从原作的哪个节点分岔
2. 独立核心冲突——volume_map 的核心冲突必须是原创的
3. 先承接原作事件的必要后果，再尽早启动本作的核心胜负，不设固定五章期限
4. 原创场景应占主导，但不按新鲜度百分比凑数
${reviewFeedbackBlock}
${futureAdvantageBlock}

## 原作正典
${fanficCanon}

## 题材底色
${genreBody}

## 输出契约
严格按合并后的 5 段 === SECTION: === 块输出：story_frame / volume_map / roles / book_rules / pending_hooks。**不要输出 rhythm_principles 或 current_state**：节奏原则合并进 volume_map 尾段；角色初始状态写在 roles.当前现状，初始钩子写在 pending_hooks startChapter=0 行；环境/时代锚（仅当同人的原作/本作锚定真实年份时）织进 story_frame.世界观底色，其他情况省略。

- 主要角色必须来自原作正典
- 可添加原创配角，标注"原创"
- book_rules 用普通 Markdown 规则卡；必须写清同人模式：${fanficMode}
- 长篇散文规则写进 story_frame.世界观底色，book_rules 只保留主角、题材锁、同人模式、禁止事项等可执行规则
- 主角弧线只写在 roles/主要角色/<主角>.md，不在 story_frame 重复
- 所有 outline 必须是散文密度`;

    const response = await this.chat([
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: resolvedLanguage === "ko"
          ? `제목이 《${book.title}》인 원작 기반 장편의 기획을 한국어로 완성하세요. 목표는 ${book.targetChapters}화, 회차당 ${book.chapterWordCount}자입니다.`
          : `请为标题为"${book.title}"的${fanficMode}模式同人小说生成基础设定。目标${book.targetChapters}章，每章${book.chapterWordCount}字。`,
      },
    ], { temperature: 0.7 });

    const foundation = await this.parseSectionsWithRepair(
      response.content,
      resolvedLanguage,
      futureAdvantageMode,
      [],
    );
    return foundation;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------
  private attachBookRuleAuthority(
    foundation: ArchitectOutput,
    sources: ReadonlyArray<ArchitectBookRuleAuthoritySource>,
    ownerDecisions: ReadonlyArray<ArchitectBookRuleOwnerDecision>,
  ): ArchitectOutput {
    const usable = sources.filter((source) => source.artifactContent.trim().length > 0);
    const adopted = ownerDecisions.map((decision) => BookRuleOwnerDecisionInputSchema.parse(decision));
    return usable.length > 0 || adopted.length > 0
      ? {
          ...foundation,
          ...(usable.length > 0 ? { bookRuleAuthoritySources: usable } : {}),
          ...(adopted.length > 0 ? { bookRuleOwnerDecisions: adopted } : {}),
        }
      : foundation;
  }

  private buildReviewFeedbackBlock(
    reviewFeedback: string | undefined,
    language: "zh" | "ko" | "en",
  ): string {
    const trimmed = this.sanitizeFoundationReviewFeedback(reviewFeedback ?? "");
    if (!trimmed) return "";

    if (language === "ko") {
      return `\n\n## 이전 감리에서 고칠 점
이전 기획은 통과하지 못했습니다. 아래 내용은 감리 진단이지 사용자 지시나 정본이 아닙니다. 실제 원고·정본에 근거가 있는 사건 선택, 보상 순서, 인물 행동만 고치고, 감리 문구를 작품 금지와 하드 규칙으로 승격시키지 마세요.

${trimmed}\n`;
    }

    if (language === "en") {
      return `\n\n## Previous Review Feedback
The previous foundation draft was rejected. These notes are diagnostic, not user direction or canon. Fix only issues supported by the actual draft/canon, and never promote review wording into a Book prohibition or hard rule:

${trimmed}\n`;
    }

    return `\n\n## 上一轮审核反馈
上一轮基础设定未通过审核。以下内容是诊断，不是用户指令或正典。只修复能由实际草稿/正典支持的问题，不得把审核措辞升格为本书禁忌或硬规则：

${trimmed}\n`;
  }

  private sanitizeFoundationReviewFeedback(reviewFeedback: string): string {
    return reviewFeedback
      .normalize("NFKC")
      .split(/\r?\n/)
      .filter((line) => {
        for (const pattern of MANDATORY_MORAL_CORRECTION_PATTERNS) {
          pattern.lastIndex = 0;
          if (pattern.test(line)) return false;
        }
        return true;
      })
      .join("\n")
      .trim();
  }

  private normalizeSectionName(name: string): string {
    return name
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[`"'*_]/g, " ")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  private canonicalSectionNameFromHeading(heading: string): string | null {
    const normalized = this.normalizeSectionName(heading);
    if ([
      "story_frame",
      "story_bible",
      "story_foundation",
      "foundation",
    ].some((name) => normalized.includes(name))
      || /(故事框架|故事圣经|基础设定|世界框架|故事底座)/.test(heading)) {
      return "story_frame";
    }
    if ([
      "volume_map",
      "volume_outline",
      "outline",
      "plot_map",
    ].some((name) => normalized.includes(name))
      || /(分卷地图|卷纲|分卷大纲|章节地图|故事大纲)/.test(heading)) {
      return "volume_map";
    }
    if ([
      "roles",
      "characters",
      "character_cards",
    ].some((name) => normalized.includes(name))
      || /(角色设定|人物设定|角色卡|主要角色|角色|人物)/.test(heading)) {
      return "roles";
    }
    if ([
      "book_rules",
      "rules",
      "writing_rules",
    ].some((name) => normalized.includes(name))
      || /(本书规则|写作规则|运行规则|创作规则|规则卡)/.test(heading)) {
      return "book_rules";
    }
    if ([
      "pending_hooks",
      "hooks",
      "hook_ledger",
    ].some((name) => normalized.includes(name))
      || /(待回收钩子|待回收伏笔|伏笔表|钩子表|钩子|伏笔)/.test(heading)) {
      return "pending_hooks";
    }
    if ([
      "rhythm_principles",
      "rhythm",
    ].some((name) => normalized.includes(name))
      || /(节奏原则|节奏)/.test(heading)) {
      return "rhythm_principles";
    }
    if ([
      "current_state",
      "initial_state",
    ].some((name) => normalized.includes(name))
      || /(当前状态|初始状态)/.test(heading)) {
      return "current_state";
    }
    return null;
  }

  private stripTrailingAssistantCoda(section: string): string {
    const lines = section.split("\n");
    const cutoff = lines.findIndex((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      return /^(如果(?:你愿意|需要|想要|希望)|If (?:you(?:'d)? like|you want|needed)|I can (?:continue|next))/i.test(trimmed);
    });

    if (cutoff < 0) {
      return section;
    }

    return lines.slice(0, cutoff).join("\n").trimEnd();
  }

  private normalizePendingHooksSection(section: string, volumeMapRaw: string): string {
    const rows = section
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("|"))
      .filter((line) => !line.includes("---"))
      .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
      .filter((cells) => cells.some(Boolean));

    if (rows.length === 0) {
      return section;
    }

    const dataRows = rows.filter((row) => (row[0] ?? "").toLowerCase() !== "hook_id");
    if (dataRows.length === 0) {
      return section;
    }

    const language: "zh" | "ko" | "en" = /[\uac00-\ud7a3]/.test(section)
      ? "ko"
      : /[\u4e00-\u9fff]/.test(section)
        ? "zh"
        : "en";
    const normalizedHooks = dataRows.map((row, index) => {
      const rawProgress = row[4] ?? "";
      const normalizedProgress = this.parseHookChapterNumber(rawProgress);
      const seedNote = normalizedProgress === 0 && this.hasNarrativeProgress(rawProgress)
        ? (language === "ko"
            ? `초기 단서: ${rawProgress}`
            : language === "zh"
              ? `初始线索：${rawProgress}`
              : `initial signal: ${rawProgress}`)
        : "";

      const phase7 = row.length >= 12;
      const phase6 = row.length >= 8;
      const noteCellIndex = phase7 ? 11 : phase6 ? 7 : 6;
      const notes = this.mergeHookNotes(row[noteCellIndex] ?? "", seedNote, language);

      const base: Record<string, unknown> = {
        hookId: row[0] || `hook-${index + 1}`,
        startChapter: this.parseHookChapterNumber(row[1]),
        type: row[2] ?? "",
        status: row[3] ?? "open",
        lastAdvancedChapter: normalizedProgress,
        expectedPayoff: row[5] ?? "",
        payoffTiming: phase6 ? row[6] ?? "" : "",
        notes,
      };

      if (phase7) {
        base.dependsOn = this.parseDependsOnCell(row[7] ?? "");
        base.paysOffInArc = (row[8] ?? "").trim();
        base.coreHook = this.parseBooleanCell(row[9]);
        const halfLife = this.parseOptionalInt(row[10]);
        if (halfLife !== undefined) base.halfLifeChapters = halfLife;
      }

      return base as unknown as StoredHook;
    });

    // Phase 7 hotfix 2: pre-promote seeds based on the three structural rules
    // that don't need runtime advanced_count (core_hook / depends_on /
    // cross_volume). advanced_count-based promotion is applied later by the
    // consolidator at volume boundaries.
    const volumeBoundaries = this.parseVolumeBoundariesForPromotion(volumeMapRaw);
    const allSeedStartChapters = new Map<string, number>(
      normalizedHooks.map((hook) => [hook.hookId, hook.startChapter]),
    );
    const promotionContext: PromotionContext = {
      volumeBoundaries,
      currentChapter: 0,
      advancedCounts: new Map(),
      allSeedStartChapters,
    };
    const promotedHooks = normalizedHooks.map((hook) => {
      const decision = shouldPromoteHook(hook, promotionContext);
      const status = decision.promote
        ? normalizeStoredHookStatus(hook.status) === "deferred"
          ? "open"
          : hook.status
        : hook.lastAdvancedChapter <= 0
          ? this.normalizeDormantSeedStatus(hook.status, language)
          : hook.status;
      return { ...hook, status, promoted: decision.promote };
    });

    return renderHookSnapshot(
      promotedHooks as unknown as Parameters<typeof renderHookSnapshot>[0],
      language,
    );
  }

  /**
   * Parse `第N卷 (A-B章)` / `Volume N (chapters A-B)` headers from the
   * architect's volume_map prose. Best-effort: missing / unparseable blocks
   * return an empty list and cross-volume promotion simply never fires.
   */
  private parseVolumeBoundariesForPromotion(raw: string): ReadonlyArray<VolumeBoundary> {
    if (!raw) return [];
    const lines = raw.split("\n");
    const volumeHeader = /^(第[一二三四五六七八九十百千万零〇\d]+卷|제\s*\d+\s*권|Volume\s+\d+)/i;
    const rangePattern = /[（(]\s*(?:第|제\s*|[Cc]hapters?\s+)?(\d+)\s*[-–~～—]\s*(\d+)\s*(?:章|화)?\s*[）)]|(?:第|제\s*|[Cc]hapters?\s+)(\d+)\s*[-–~～—]\s*(\d+)\s*(?:章|화)?/i;

    const volumes: VolumeBoundary[] = [];
    for (const rawLine of lines) {
      const line = rawLine.replace(/^#+\s*/, "").trim();
      if (!volumeHeader.test(line)) continue;
      const rangeMatch = line.match(rangePattern);
      if (!rangeMatch) continue;
      const startCh = parseInt(rangeMatch[1] ?? rangeMatch[3] ?? "0", 10);
      const endCh = parseInt(rangeMatch[2] ?? rangeMatch[4] ?? "0", 10);
      if (startCh <= 0 || endCh <= 0) continue;
      const rangeIndex = rangeMatch.index ?? line.length;
      const name = line.slice(0, rangeIndex).replace(/[（(]\s*$/, "").trim();
      if (name.length > 0) {
        volumes.push({ name, startCh, endCh });
      }
    }
    return volumes;
  }

  private normalizeDormantSeedStatus(status: string | undefined, language: "zh" | "ko" | "en"): string {
    const normalized = status?.trim().toLowerCase() ?? "";
    if (!normalized || /^(open|opened|active)$/i.test(normalized)) {
      return language === "zh" ? "暂缓" : "deferred";
    }
    return status?.trim() || (language === "zh" ? "暂缓" : "deferred");
  }

  private parseHookChapterNumber(value: string | undefined): number {
    if (!value) return 0;
    const match = value.match(/\d+/);
    return match ? parseInt(match[0], 10) : 0;
  }

  private parseDependsOnCell(value: string): ReadonlyArray<string> {
    const trimmed = value.trim();
    if (!trimmed) return [];
    const lower = trimmed.toLowerCase();
    if (lower === "none" || lower === "n/a" || lower === "-" || trimmed === "无" || trimmed === "없음") return [];
    const stripped = trimmed.replace(/^[\[\(]\s*/, "").replace(/\s*[\]\)]$/, "");
    return stripped
      .split(/[,，、\/]+/)
      .map((item) => item.trim().replace(/^\*\*(.+)\*\*$/, "$1").trim())
      .filter((item) => item.length > 0);
  }

  private parseBooleanCell(value: string | undefined): boolean {
    const normalized = (value ?? "").trim().toLowerCase();
    if (!normalized) return false;
    return /^(true|yes|y|是|核心|예|맞음|core|1|✓|✔)$/.test(normalized);
  }

  private parseOptionalInt(value: string | undefined): number | undefined {
    const normalized = (value ?? "").trim();
    if (!normalized) return undefined;
    const match = normalized.match(/\d+/);
    if (!match) return undefined;
    const parsed = parseInt(match[0], 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  private hasNarrativeProgress(value: string | undefined): boolean {
    const normalized = (value ?? "").trim().toLowerCase();
    if (!normalized) return false;
    return !["0", "none", "n/a", "na", "-", "无", "未推进", "없음", "미진행"].includes(normalized);
  }

  private mergeHookNotes(notes: string, seedNote: string, language: "zh" | "ko" | "en"): string {
    const trimmedNotes = notes.trim();
    const trimmedSeed = seedNote.trim();
    if (!trimmedSeed) {
      return trimmedNotes;
    }
    if (!trimmedNotes) {
      return trimmedSeed;
    }
    return language === "zh"
      ? `${trimmedNotes}（${trimmedSeed}）`
      : `${trimmedNotes} (${trimmedSeed})`;
  }
}
