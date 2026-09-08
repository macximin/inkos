import type { FireflyEntryContract } from "./entry-contract.js";
import { z } from "zod";

/** Editorial guidance only: no new canon, admission gate, or data migration. */
export const WEBNOVEL_PLAN_FORMAT_VERSION = "webnovel-project-plan/v1";

// The same nine-section format used by source-first projectPlan documents.
export const WEBNOVEL_PLAN_SECTIONS_V1 = [
  "작품 정보와 독자 약속", "작품의 육하원칙", "장기·구간·회차 목적 연결", "등장인물과 관계", "무대·시간·우위",
  "전체 줄거리와 장기 전개", "독자 보상과 연재 지속성", "참고작 역설계·유지·변주", "기획 의도와 집필 계획",
] as const;
const planSectionTitles = [
  /작품.*정보.*독자.*약속/u, /작품.*육하원칙/u, /장기.*구간.*회차.*목적.*연결/u, /등장인물.*관계/u, /무대.*시간.*우위/u,
  /전체.*줄거리.*장기.*전개/u, /독자.*보상.*연재.*지속성/u, /참고.*역설계.*변주/u, /기획.*의도.*집필.*계획/u,
];

/** Existing v3 projectPlan shape; historical plans need not have English labels. */
export const WebnovelProjectPlanSchema = z.object({
  format: z.literal(WEBNOVEL_PLAN_FORMAT_VERSION), markdown: z.string().trim().min(600).max(30_000),
}).strict();
/** The existing format with visible completeness validation for new variations. */
export const VariationProjectPlanSchema = WebnovelProjectPlanSchema.superRefine((plan, context) => {
  // Ignore fenced examples: headings and answers must appear in the document.
  const visible = plan.markdown.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gmu, "");
  const headings = [...visible.matchAll(/^(#{1,6})\s+([1-9])[.)]\s+([^\n]+)\r?$/gmu)];
  const level = headings.find((heading) => heading[2] === "1" && planSectionTitles[0]!.test(heading[3]!))?.[1]?.length;
  const sections = headings.filter((heading) => heading[1]!.length === level);
  if (sections.length !== 9 || sections.some((section, index) => Number(section[2]) !== index + 1 || !planSectionTitles[index]!.test(section[3]!))) {
    context.addIssue({ code: "custom", path: ["markdown"], message: "Project plan requires the existing numbered sections 1 through 9 in order" });
    return;
  }
  for (const [index, section] of sections.entries()) {
    const body = visible.slice(section.index! + section[0].length, sections[index + 1]?.index ?? visible.length).trim();
    if (!body || !/[\p{L}\p{N}]/u.test(body.replace(/^#{1,6}\s+.*$/gmu, ""))) context.addIssue({ code: "custom", path: ["markdown"], message: `Project plan section ${index + 1} has no content` });
    if (index !== 1) continue;
    for (const marker of ["WHO", "WHAT", "HOW", "WHERE", "WHEN", "WHY"]) {
      const match = new RegExp(`\\b${marker}\\b`, "u").exec(body);
      if (!match) { context.addIssue({ code: "custom", path: ["markdown"], message: `Project plan section 2 is missing ${marker}` }); continue; }
      const lineStart = body.lastIndexOf("\n", match.index) + 1;
      const lineEnd = body.indexOf("\n", match.index);
      const line = body.slice(lineStart, lineEnd < 0 ? body.length : lineEnd);
      const cells = line.trim().replace(/^\||\|$/gu, "").split("|");
      if (line.trim().startsWith("|") && !/[\p{L}\p{N}]/u.test(cells.at(-1) ?? "")) context.addIssue({ code: "custom", path: ["markdown"], message: `Project plan ${marker} answer is empty` });
    }
  }
});
export type VariationProjectPlan = z.infer<typeof VariationProjectPlanSchema>;
export function validateVariationProjectPlan(plan: unknown): VariationProjectPlan { return VariationProjectPlanSchema.parse(plan); }
export function renderVariationProjectPlan(plan: VariationProjectPlan): string { return validateVariationProjectPlan(plan).markdown; }

const COMMON = `아크는 A/B레일 계열의 전개 설계이며 B레일 아크와 연결된 1~3화 상세 실행 입력은 ArcPacket으로 명시합니다. 피치의 railA/railB 성과·관계 항목을 실행 A/B레일로 등치하지 않습니다.
누가(WHO) 왜(WHY) 무엇을(WHAT) 원하는지, 지금(WHEN) 이곳(WHERE)에서 어떤 우위로 무엇을 하는지(HOW)를 연결합니다. WHY는 인물의 사적인 욕망과 자기 이득이며 작가의 주제·기획 의도와 구별합니다. HOW는 능력 이름에 그치지 않고 우위 → 선택 → 실행 → 결과로 씁니다.
출발 배경·이전 경험·현재 자원과 관계 → 개인 목적 → 선택·우위 사용의 연결을 작품별 근거로 복원합니다. 경험에서 얻은 안목, 기억, 고유 능력을 구별하고 근거 없는 연결은 발명하지 않습니다. '미공개'는 원문에서 아직 밝히지 않은 것, '제공 범위 미확인'은 받은 자료로 판별하지 못한 것, '해당 없음'은 그 작품에 적용되지 않는 것으로 구별하며 확인한 범위를 함께 남깁니다. 일부 발췌에 없다는 이유만으로 미공개나 해당 없음으로 확정하지 않습니다. 회귀·결핍·트라우마·새 능력 보완·실패를 필수 출발점으로 강요하지 않습니다. 현재형의 유복한 인물도 가진 경험과 자원으로 자기 목적을 추구할 수 있습니다.
사람 표면은 인물의 선택·행동·대우·생활로 읽히는 결과입니다. 돈·소유·권한도 적합한 목적이나 수단·보상이 될 수 있습니다. 얻은 것을 혼자 쓰거나 즐기는 장면도 유효합니다. 감정·가족 장면이나 목격자를 의무 배정하지 않습니다.
WHEN은 시대·인생의 시점·선행 사건·현재 기회를 설명합니다. 가짜 시한이나 위기를 만들지 않습니다. WHERE는 사람·물건·업종·환경이 행동을 가능하게 하는 현장입니다. 큰 행운과 압도적 승리를 허용하며 고통·실패·반성·성장을 보상의 전제로 강요하지 않습니다.
장기 목적 → 현재 기획 구간의 목적 → 이번 화의 행동 또는 성취를 즐기는 역할 → 독자가 확인하는 결과를 잇습니다. 상위 답을 반복 복사하지 말고 현재 구간에서 달라지는 것만 구체화합니다. 깨끗한 결산과 후일담도 가능하며 인물·장면·보상·훅 개수는 이 서식의 통과 조건이 아닙니다.`;

const STAGES = {
  review: `후보를 다시 쓰지 말고 인물·목적·현장·시점·실행·지급의 연결을 읽습니다. startingIdentity와 원작 복원·선택 대조·기획서에서 배경과 경험이 그 목적·수단의 근거인지 확인합니다. 원작 사실과 승인된 신작 변주를 구별하고 같은 자기 목적이라도 우위를 얻은 경력이나 조건이 날조되었는지 대조합니다. 미공개·제공 범위 미확인·해당 없음 자체는 실패가 아니며, 현재 행동을 이해하는 데 필요한 근거가 실제로 비어 있는지 따로 봅니다. 육하원칙의 영문 표지나 별도 표 유무를 새 탈락 조건으로 만들지 않습니다. 기존 entryGate 항목은 그대로 사용하며 whyNow는 현재 기회나 행동 이유로도 성립합니다. railConversion은 성취가 실제 선택·생활·대우에 쓰이는지를 봅니다. 관계 장면·목격자·새 위기 부재만으로 감점하지 않습니다. 선택된 Human Premise와 원문 골격 결속 조건이 있는 후보는 그 선택도 함께 존중합니다.`,
  pitch: `기존 출력 키 안에서 작품 수준의 육하원칙을 한 번 정리합니다. protagonist.startingIdentity에는 출발 배경·이전 경험·현재 자원과 관계 및 그것이 선택에 미치는 이유를, humanDrive.personalDesire/selfInterest에는 WHY를, purpose.seriesWhat/arcWhat/chapterWant에는 장기·구간·회차 목적을 씁니다. source-first에서는 sourceReconstruction.protagonist와 sourceChoice에 원작의 확인된 연결을, targetChoice/preservedReason과 projectPlan에는 승인된 신작에서 유지하거나 조정한 연결을 자연어로 씁니다. 보조작의 경력·능력을 주인공의 원래 과거로 가져오지 않습니다. commercialPromise.currentSituation에는 WHERE와 시대·시작 시점 및 상대의 목적을, purpose.whyNow에는 지금 움직일 수 있거나 움직이는 이유를, howAdvantage에는 실제 사용법을 담습니다. humanDrive.lackOrHumiliation도 실제 출발 조건이나 확인된 손실을 담는 기존 필드이며 결핍을 발명하라는 요구가 아닙니다. firstPayoff는 눈에 보이는 결과, payoffWitness는 실제 목격자의 행동 또는 혼자 누리는 지급, nextPaymentQuestion은 다음 기대 또는 이번 구간의 결산입니다.
openingEpisodes와 arcLadder에는 상위 목적을 진전시키는 행동과 지급을 씁니다. 레퍼런스는 실제 받은 원문 구간·취할 기능·선택 이유·유지/변경할 인과를 연결하고 조합할 때 지식·자원·관계·시점의 선행 조건을 맞춥니다. 자료가 없으면 사용했다고 꾸미지 않습니다. 이 서식은 별도 JSON 키를 요구하지 않습니다.`,
  foundation: `기존 다섯 SECTION에 나누어 담습니다. story_frame에는 작품 소개·독자 약속·대표 장면과 육하원칙, 반복 행동·보상의 변주, 완결 가능한 장기 목적을 씁니다. roles에는 인물 자신의 목적·관계 이유·정보 차이·말과 행동을 씁니다. volume_map에는 시작부터 마지막 결산까지의 인과와 현재 구간의 목적·지급·끝 상태를 쓰고, 먼 구간은 가설인 목적지로 남깁니다. 실제 시간 순서와 독자에게 공개하는 순서가 다르면 구분합니다.
book_rules에는 채택된 문체·작품의 약속과 행동 이해에 필요한 규칙만 둡니다. 참고 기능과 변경 인과는 해당 사건 설계에 반영합니다. story_frame과 roles에는 확인된 배경·경험·현재 여건 중 목적과 행동에 필요한 연결만 남깁니다. 작가의 의도·지킬 맛·다음 집필 범위·미정 사항은 관련 기존 SECTION에서 구별해 적습니다. 표 전체를 복제하거나 여섯 번째 SECTION, 새 정본 파일을 만들지 않습니다.`,
  arc: `상위 기획의 목적을 이어받아 현재 구간에서 행동할 인물, 얻을 것, 선택 이유와 우위 사용, 현장, 선행 사건과 시점을 구체화합니다. premise에는 상위 목적과 구간 목적의 연결을, 각 beat.summary에는 누가 어디서 언제 왜 어떤 행동을 하고 어떤 결과를 얻는지 사건에 필요한 내용만 씁니다. 가까운 사건은 인과·지급·끝 상태를 구체화하고 먼 것은 가설로 남깁니다.
자연스러운 큰 사건 구간과 1~3화 실행 ArcPacket은 다릅니다. Forecast에서 ArcPacket으로 옮길 첫 구간의 beat 자체에 동기·행동·결과가 읽히게 하며 먼 결말을 현재 화의 의무로 당기지 않습니다. 현재 사건에 쓰이는 배경·경험·자원과 선택의 연결만 가져오고 인물의 생애를 매번 재설명하지 않습니다. 계획은 미실현 가설이며 집필 뒤의 상태는 실제 원고에서 확정합니다.`,
  chapter: `기존 회차 메모 제목을 유지합니다. '현재 작업'에는 이번 want 또는 앞선 성취를 정착시키는 역할, 상위 B레일 아크·실행 계획의 목적과의 관계, 필요한 인물·장소·시점 변화와 WHY/HOW를 짧게 씁니다. '독자가 지금 기다리는 것'에는 중요한 정보 차이와 실제 지급 장면을 연결합니다. 필요한 장면은 사람의 행동·이유·우위·결과로 구체화합니다. 작품 기획서를 다시 출력하지 않습니다.
직전 원고와 실제 상태가 미래 계획보다 우선합니다. 메모의 예상 결과를 이미 일어난 사실로 기록하지 않습니다. 현재 사건에 쓰이는 배경·경험·자원과 선택의 연결만 가져오고 인물의 생애를 매번 재설명하지 않습니다.`,
  manuscript: `작품 설계와 활성 ArcPacket·회차 메모를 이어받아 이번 want 또는 성취를 누리는 역할을 실제 장면으로 씁니다. 인물의 이유와 우위가 선택·행동·결과로 드러나게 하고, 장소와 시점은 이번 장면에 필요한 만큼만 보여 줍니다. 현재 사건에 쓰이는 배경·경험·자원과 선택의 연결만 가져오고 인물의 생애를 매번 재설명하지 않습니다. 새 동기·갈등·감정·목격자를 칸 채우기용으로 만들지 않습니다. 원고에 WHO/WHAT/HOW/WHERE/WHEN/WHY, 기획서 표, 검수표나 이 지침을 출력하지 않습니다. 의도적인 짧은 호흡·반복·통쾌한 단정은 보존합니다.`,
} as const;

export const PITCH_VARIATION_PLANNING_GUIDANCE_V1 = "webnovel-bounded-variation/v1";
export const PITCH_VARIATION_PLANNING_GUIDANCE_V2 = "webnovel-bounded-variation/v2";
export const PITCH_VARIATION_PLANNING_GUIDANCE_VERSION = "webnovel-bounded-variation/v3";
export type VariationPlanningGuidanceVersion = typeof PITCH_VARIATION_PLANNING_GUIDANCE_V1 | typeof PITCH_VARIATION_PLANNING_GUIDANCE_V2 | typeof PITCH_VARIATION_PLANNING_GUIDANCE_VERSION;

export function requiresFullVariationPlan(version?: string): boolean {
  return version === PITCH_VARIATION_PLANNING_GUIDANCE_V2 || version === PITCH_VARIATION_PLANNING_GUIDANCE_VERSION;
}

// Immutable prompt protocol. Do not compose these strings from mutable COMMON
// or STAGES: saved variation receipts must reproduce the same prompt forever.
// Editorial changes require another explicit version and preserved old text.
const VARIATION_COMMON_V1 = `기존 전체 기획의 인물과 장기 목적을 기준으로 현재 초반 구간에서 달라지는 사건만 구체화합니다. 누가(WHO) 왜(WHY) 무엇을(WHAT) 원하는지, 어디(WHERE)에서 언제(WHEN) 어떤 우위로 어떻게(HOW) 행동하는지 연결합니다. WHY는 주인공의 사적인 목적과 자기 이득이며 작가의 주제나 남의 인정으로 대체하지 않습니다. HOW는 능력 이름이 아니라 우위 → 선택 → 실행 → 자기 몫과 상대 행동의 차이로 씁니다.
출발 배경·이전 경험·현재 자원과 관계가 선택과 수단을 설명해야 합니다. 기존 원문·기획에서 확인한 것과 신작에서 바꾸는 조건을 구별하며 미확인 경력·능력·결핍을 발명하지 않습니다. WHEN은 시대·선행 사건·현재 기회를, WHERE는 실제 행동을 가능하게 하는 사람·물건·업종·현장을 뜻합니다. 가짜 시한·위기·희생·목격자를 칸 채우기용으로 만들지 않습니다.
전체 기획의 장기 목적 → 이번 구간의 자기 목적 → 실제 행동·지급 → 다음 구간에서 쓸 자원과 목적을 잇습니다. 기존 기획과 달라지는 선행 조건·사건 배치·지식·돈·인재·관계·시점의 영향을 함께 설명합니다. 전체 9절 기획서를 다시 만들거나 육하원칙 표·새 JSON 키를 추가하지 않습니다. 현재 결과는 비교할 변주 후보이며 사람의 선택·승인이나 기존 기획으로의 통합 완료를 가정하지 않습니다.`;

const VARIATION_STAGES_V1 = {
  variation: `synopsis와 openingEpisodes에는 누가 왜 여기서 지금 어떤 행동으로 자기 이익을 얻는지가 이야기로 읽히게 씁니다. eventComparisons.prerequisiteChanges에는 기존 전체 기획에서 바뀌는 선행 조건과 그 근거를, downstreamConnection에는 얻은 것으로 다음 사건이 가능한 이유를 씁니다. chronologyChanges에는 실제 시간 순서와 달라진 배치의 후속 영향을, remainingQuestions에는 이후 사람이 선택한 뒤 전체 기획에 통합할 때 조정하거나 확인할 연결을 남깁니다. 영향이 없으면 없다고 쓰며 필드를 채우려고 새 충돌을 만들지 않습니다.`,
  "variation-review": `후보를 다시 쓰지 말고 기존 전체 기획·원문과 비교해 인물·사적 목적·행동 현장·시점·우위 사용·자기 이익이 이어지는지 읽습니다. 선행 조건 변경이 초반 사건과 다음 구간의 목적·자원에 미치는 영향을 기존 causalCoherence·variationQuality 근거와 requiredRepair에 반영합니다. 원작 사실의 정확성과 의도한 신작 변경을 구별합니다. 육하원칙 표지·표·전체 9절 기획서가 없다는 이유로 감점하지 않습니다. 필요한 다음 통합 사항을 지적할 수 있지만 사람의 선택·승격·통합을 대신 결정하지 않습니다.`,
  "variation-revision": `이번 부분수정 지시와 허용된 문자열 경로 안에서 육하원칙과 기존 전체 기획 → 초반 변경 → 다음 구간의 연결을 보완합니다. 해당 필드의 수정이 필요한 선행 조건과 이후 자기 목적·자원에 미치는 영향을 읽히게 하되, 잠긴 필드나 전체 기획·배열·키를 바꾸지 않습니다. 허용 범위 밖의 연결까지 자동으로 고치거나 사람의 선택을 가정하지 않습니다. 이 지침은 수정 범위를 넓히지 않으며 출력은 지정된 문자열 교체 목록 형식을 유지합니다.`,
} as const;
type VariationPlanStage = keyof typeof VARIATION_STAGES_V1;

// Version 2 requires the complete existing project-plan format in each candidate.
// Keep both versioned snapshots independent of mutable general planning prose.
const VARIATION_COMMON_V2 = `변주안도 하나의 작품 기획서입니다. projectPlan={"format":"webnovel-project-plan/v1","markdown":"기획서 전체 Markdown"}에 기존과 같은 9절 전체를 씁니다. baselineProjectPlan을 기준으로 이번 후보의 인물·사건·설정을 반영한 하나의 완결된 문서를 작성합니다. 독자는 이전 기획서나 수정 내역을 찾아야 내용을 이해하는 상태가 아니어야 합니다.
절 제목과 순서: ${WEBNOVEL_PLAN_SECTIONS_V1.map((title, index) => `${index + 1}. ${title}`).join(" / ")}. 각 절은 번호 있는 Markdown 제목과 실제 내용을 갖춥니다. 2절에는 WHO·WHAT·HOW·WHERE·WHEN·WHY 여섯 표지를 명시하고 각각의 답을 씁니다. WHAT은 어떤 이야기가 시작되어 어떤 사건과 확장을 거쳐 어디에 도달하려는지 작품 전체의 이야기 흐름과 도착점, 주인공 자신의 성공 목표와 현재 구간의 위치를 설명합니다. WHAT을 이번 화의 할 일이나 첫 투자 목표만으로 대신하지 않습니다.
WHO는 출발 배경·이전 경험·현재 자원과 관계를, WHY는 주인공 자신의 사적인 욕망과 이득을, WHERE는 주요 공간·업종·생활 현장을, WHEN은 시대와 인생의 시작 시점·선행 사건을 설명합니다. HOW는 주인공의 지속적인 우위가 어디서 왔고 어떤 원리와 범위로 작동하며 어떻게 자기 이익에 이용되는지를 설명합니다. 회귀·미래정보가 실제 전제라면 그 출처와 이용 원리를 명시하고 경험에서 얻은 안목이나 별개 고유 능력과 구별합니다. HOW를 첫 장면의 수법이나 유능함 시연만으로 대신하지 않습니다. 모든 작품에 회귀·초능력·실패·결핍을 강요하지 않습니다.
원문과 기준 기획에서 확인한 사실, 의도한 신작 변경, 미확인 사항을 구별합니다. 장기 목적 → 초반의 실제 행동·지급 → 다음 구간의 자원·목적을 연결하고 6절에 전체 시놉시스와 먼 구간의 가설을 포함합니다. 근거 없는 경력·능력·결말을 확정 사실로 발명하지 않습니다. 8절의 참고 근거는 작품 기획에 필요한 만큼 정리하되, 본문을 전후 비교표·패치 내역·검수 보고서로 바꾸지 않습니다. 사람의 선택·승인·Book·아크·원고 생성이 이루어졌다고 가정하지 않습니다.`;

const VARIATION_STAGES_V2 = {
  variation: `projectPlan은 600~30000자의 실제 전체 기획서이며 독자가 읽는 주 본문입니다. 출력의 synopsis·openingEpisodes·firstInvestment와 모순 없이 이번 변주안을 전 절에 반영합니다. eventComparisons·chronologyChanges는 별도의 구조화된 근거로 유지하되 그 수정 보고를 기획서 본문에 복제하지 않습니다. 원고 자체는 작성하지 않습니다.`,
  "variation-review": `후보 projectPlan의 9절을 실제 원문·기준 기획·초반 사건과 대조합니다. 특히 2절 WHAT의 작품 전체 흐름과 도착점·자기 성공 목표, HOW의 지속적인 우위 출처·작동 원리, 6절의 장기 이야기 전개가 읽히는지 봅니다. 목표 한 줄이나 첫 장면 수법만 적혀 있으면 충족했다고 보지 말고 기존 causalCoherence·variationQuality 근거와 requiredRepair에 구체적으로 남깁니다. 구조화된 변주 사건과 전체 기획서의 불일치도 확인하며 사람의 선택이나 Book·원고 생성을 대신 결정하지 않습니다.`,
  "variation-revision": `지정된 문자열 교체 범위 안에서 전체 기획서와 초반 사건의 연결을 보완합니다. projectPlan.markdown을 바꿀 때 기존 9절과 명시적인 육하원칙을 유지하며 WHAT의 이야기 전체 흐름과 HOW의 우위 원리를 회차 수준의 행동으로 축소하지 않습니다. 잠긴 필드·키·배열을 바꾸거나 허용되지 않은 내용을 자동 수정하지 않습니다. 이 지침은 수정 범위를 넓히지 않으며 출력은 지정된 문자열 교체 목록 형식을 유지합니다.`,
} as const;

// Frozen v3 supplement: preserve these bytes when introducing later guidance.
const REFERENCE_AND_CHARACTER_GUIDANCE_V3 = `차별점을 기획 항목이나 장점·심사 기준으로 요구하지 않습니다. 참고작과 다르다는 사실 자체에 가치를 부여하지 않습니다. 어떤 작품들을 참고했고 각 작품의 인물 매력·사건 구성·보상·관계·문체 중 무엇을 가져와 어디에 쓰는지 설명합니다. 작품명만 아는 상태, 시놉시스·분석 자료를 읽은 상태, 원고를 직접 읽은 상태와 참고 예정을 구별합니다. 참고작이 없거나 미확인이면 그대로 남깁니다.
전체 기획서에서는 1절에 참고한 작품과 가져올 요소를 짧게 소개하고 8절에 실제 확인한 자료·범위, 채택 이유, 반영할 인물·장면·구간과 필요한 조정을 정리합니다. 조정이 없으면 없다고 쓰며 새로움을 만들기 위해 인과를 바꾸지 않습니다. 이용 등급·작품 이력·현재 집필 분량은 확인한 경우에만 선택 항목으로 기록합니다.
주인공을 계속 보고 싶은 이유를 태도·선택·말과 행동 및 실제 장면으로 설명합니다. 자기 인식과 외부 평가의 차이는 작품에 있을 때만 다루며 착각 구도를 의무로 만들지 않습니다. 세계관 규칙은 필요한 경우 같은 문제를 일반 인물과 주인공이 어떻게 해결하는지 비교해 설명하되 별도 능력 체계를 강요하지 않습니다. 세력이 사건에 영향을 줄 때는 조직의 목적·자원·주인공과의 이해관계·실제 행동을 개인의 성격과 구별합니다.
각 구간에서 얻은 능력·재산·지위·관계가 다음 선택을 어떻게 가능하게 하는지 잇습니다. 규모 확대나 능력 성장을 매번 요구하지 않습니다. 완결에서는 최초 욕망이 어떻게 충족되거나 어떤 선택 때문에 달라졌는지, 주인공이 누구와 어디서 무엇을 하며 살아가는지 설명합니다. 미정인 결말은 미정으로 남깁니다.
인명·세력명·능력·각성 시점과 사건 순서를 문서 전체에서 대조하고 소개의 독자 약속·최초 욕망이 줄거리와 결말에 이어지는지 확인합니다. 선택 항목이나 표의 부재를 새 자동 탈락 조건으로 만들지 않습니다. 해당 경로의 기존 출력 키와 문서 구조를 유지합니다. 전체 기획서는 9절, Architect는 기존 다섯 SECTION을 사용합니다. Arc·회차·원고에서는 현재 사건에 필요한 내용만 이어받으며 전체 기획서를 반복 출력하지 않습니다. 부분수정은 기존 허용 경로만 바꾸며 이 보강 지침으로 범위를 넓히지 않습니다.`;

export function webnovelPlanGuidance(stage: keyof typeof STAGES): string;
export function webnovelPlanGuidance(stage: VariationPlanStage, version: VariationPlanningGuidanceVersion): string;
export function webnovelPlanGuidance(stage: keyof typeof STAGES | VariationPlanStage, version?: string): string {
  if (Object.hasOwn(VARIATION_STAGES_V1, stage)) {
    if (version === PITCH_VARIATION_PLANNING_GUIDANCE_V1) return `## 작품 기획서 · ${version} · ${stage}\n${VARIATION_COMMON_V1}\n${VARIATION_STAGES_V1[stage as VariationPlanStage]}`;
    if (version === PITCH_VARIATION_PLANNING_GUIDANCE_V2) return `## 작품 기획서 · ${version} · ${stage}\n${VARIATION_COMMON_V2}\n${VARIATION_STAGES_V2[stage as VariationPlanStage]}`;
    if (version === PITCH_VARIATION_PLANNING_GUIDANCE_VERSION) return `## 작품 기획서 · ${version} · ${stage}\n${VARIATION_COMMON_V2}\n${VARIATION_STAGES_V2[stage as VariationPlanStage]}\n${REFERENCE_AND_CHARACTER_GUIDANCE_V3}`;
    throw new Error("Unsupported or missing bounded variation guidance version");
  }
  if (version !== undefined) throw new Error("Guidance version does not apply to this planning stage");
  return `## 작품 기획서 v1 · ${stage}\n${COMMON}\n${STAGES[stage as keyof typeof STAGES]}\n${REFERENCE_AND_CHARACTER_GUIDANCE_V3}`;
}

/** Read-only projection of existing fields; never invent missing legacy facts. */
export function renderEntryPlan(entry: FireflyEntryContract, protagonist: string): string {
  return [
    "## 작품의 육하원칙과 목적",
    `- WHO · 인물: ${protagonist}`,
    `- WHY · 개인 욕망: ${entry.humanDrive.personalDesire}`,
    `- 자기 이득: ${entry.humanDrive.selfInterest}`,
    `- 출발 조건·확인된 손실: ${entry.humanDrive.lackOrHumiliation}`,
    `- 정서 소모 한도: ${entry.humanDrive.emotionalCostLimit}`,
    `- WHAT · Series WHAT: ${entry.purpose.seriesWhat}`,
    `- 구간 목적 (Arc what): ${entry.purpose.arcWhat}`,
    `- Chapter want: ${entry.purpose.chapterWant}`,
    `- WHERE / WHEN · 시작 상황: ${entry.commercialPromise.currentSituation}`,
    `- WHEN · Why now: ${entry.purpose.whyNow}`,
    `- HOW · 우위와 실행: ${entry.commercialPromise.howAdvantage}`,
    `- 반복 소비 판타지: ${entry.commercialPromise.repeatableReaderFantasy}`,
    `- 첫 지급: ${entry.commercialPromise.firstPayoff}`,
    `- 지급을 누리는 행동·목격: ${entry.commercialPromise.payoffWitness}`,
    `- 다음 기대·결산: ${entry.commercialPromise.nextPaymentQuestion}`,
  ].join("\n");
}
