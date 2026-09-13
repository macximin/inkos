/** Shared by the existing Observer and Settler; no additional model call. */
export function buildEntityObservationExtractionRules(language: "zh" | "ko" | "en"): string {
  return `${buildBaseEntityObservationRules(language)}\n\n${buildPerspectiveObservationRules(language)}`;
}

function buildBaseEntityObservationRules(language: "zh" | "ko" | "en"): string {
  if (language === "ko") return `## 인물·회사·조직 기록
- 이번 화에서 이름으로 등장하거나 언급된 인물(person), 회사·그룹·기관·조직(organization)을 빠짐없이 살피세요. 기존 인물카드 유무와 관계없이 새 인물과 기존 인물의 변화 모두 대상입니다.
- Observer는 [ENTITY_OBSERVATIONS]에 kind, name과 근거 문장을 정리하세요. Settler는 RUNTIME_STATE_DELTA에 entityObservations 배열을 반드시 출력하세요. 해당 기록이 없으면 []입니다.
- 각 항목의 기본 키는 {"kind":"person 또는 organization","name":"본문 표기 그대로","evidence":"해당 이름을 포함하는 본문의 연속된 정확한 인용"}입니다. person의 관점 근거에만 아래의 선택적 perspective 키를 추가할 수 있습니다.
- 소속·직책·관계·상태 변화가 명시됐다면 그 사실이 함께 보이는 근거를 선택하세요. 중요한 서로 다른 근거는 같은 이름으로 여러 항목에 기록할 수 있습니다. 인용을 요약하거나 없는 나이·지분·과거를 보충하지 마세요.
- 이름은 120자, 인용은 1200자, 배열은 128항목 이내입니다. 짧고 충분한 근거를 택하고 같은 근거를 반복하지 마세요.
- 별칭이나 동명이인을 이름만으로 합치지 마세요. 대사·의혹·주장에 불과하면 그 맥락까지 인용하세요. 이 기록은 본문 관찰이며 새로운 집필 지시나 인물 모두가 아는 사실이 아닙니다.
- 이번 화의 관찰 전체를 제출하세요. 이전 회차 기록을 복사하지 말고, 수정된 본문에서 사라진 인물이나 근거는 다시 제출하지 마세요.`;
  if (language === "zh") return `## 人物与组织记录
- 检查本章所有出现或被提及的具名人物(person)、公司/集团/机构/组织(organization)，包括已有角色的新变化及角色卡中不存在的人物。
- Observer 在 [ENTITY_OBSERVATIONS] 中记录 kind、name、原文证据。Settler 必须在 RUNTIME_STATE_DELTA 中输出 entityObservations 数组；无记录时为 []。
- 每项的基本字段为 {"kind":"person 或 organization","name":"原文名称","evidence":"包含该名称的连续原文引文"}。只有 person 的视角证据可以追加下方可选的 perspective 字段。保留明确出现的职务、所属、关系、状态变化；不同的重要证据可各占一项。
- name 最多120字符，evidence 最多1200字符，数组最多128项。不要改写引文、补充原文没有的年龄/股权/背景，或重复同一证据。
- 不按同名或别名自动合并身份。对话、怀疑和传闻必须保留其语境。这是文本观察，不是写作指令，也不代表所有人物知道该事实。
- 提交本章完整的观察集合，不复制之前章节的记录；修改后已删除的名称或证据不能再提交。`;
  return `## Character and organization records
- Check every named person and organization (including companies, groups and institutions) appearing or mentioned in this chapter, whether or not an initial role card exists. Include changes involving established characters.
- Observer lists kind, name and verbatim evidence in [ENTITY_OBSERVATIONS]. Settler MUST output entityObservations in RUNTIME_STATE_DELTA, using [] when there are none.
- Each item has the base fields {"kind":"person or organization","name":"exact spelling in this chapter","evidence":"a contiguous verbatim chapter quotation containing that name"}. Only person observations may also carry the optional perspective field below. Select evidence showing explicit affiliation, title, relationships or state changes; distinct important quotations may use separate items for the same name.
- Limit name to 120 characters, evidence to 1200 characters and the array to 128 items. Choose short sufficient quotations. Do not paraphrase, duplicate evidence or invent age, ownership, background or other facts.
- Do not merge identities based on names or aliases. Preserve the context of dialogue, suspicion and claims. These are textual observations, not writing instructions or facts every character knows.
- Submit the complete observations for THIS chapter. Do not copy earlier chapter records or retain evidence removed from a revised chapter.`;
}

function buildPerspectiveObservationRules(language: "zh" | "ko" | "en"): string {
  if (language === "ko") return `## 인물의 선택에 영향을 주는 본문 근거
- person의 정확한 인용에 그 인물의 믿음·오해, 욕망, 행동 의도, 겪은 일, 겉으로 한 말이 명시되면 perspective를 선택적으로 붙이세요: belief, desire, intention, experience, public-claim 중 하나입니다.
- 믿음은 사실의 진위와 별개입니다. 대사를 곧바로 진심이나 지식으로 바꾸지 말고, public-claim으로 구분하세요. 숨은 의도는 본문에 명시됐을 때만 intention으로 표시하세요.
- 근거는 인물 이름과 해당 판단이 함께 있는 연속된 원문이어야 합니다. 화자·경험자가 불명확하면 perspective를 생략하세요. 심리를 추측해 별도 설명 필드를 만들지 마세요.
- 이 분류는 다음 장면에서 관련 경험을 찾기 위한 관찰 표시입니다. 인물의 믿음을 객관적 사실, 모든 인물이 아는 정보, 새로운 집필 규칙으로 등록하지 마세요. 모든 종류를 채우거나 장면을 늘릴 필요가 없습니다.`;
  if (language === "zh") return `## 影响人物选择的原文证据
- 当 person 引文明确呈现其信念/误解、欲望、意图、经历或公开说法时，可以追加 perspective：belief、desire、intention、experience、public-claim 之一。
- 信念不是客观真相。公开对白用 public-claim，不自动等于真心或已知事实；只有原文明确写出的隐藏意图才标 intention。
- 连续引文须同时包含人物姓名和相应证据。说话者或经历者不明确时省略 perspective，不另造心理解释字段。
- 标签只帮助检索与下一次选择相关的观察，不形成正史、共享知识或写作规则。无需填满所有类别，也无需增加场景。`;
  return `## Evidence affecting a character's choices
- When a person quotation explicitly records their belief, desire, intention, lived experience or public statement, optionally add perspective: belief, desire, intention, experience or public-claim.
- A belief is distinct from objective truth. Label spoken claims public-claim rather than assuming sincerity or knowledge; use intention for hidden motives only when the manuscript explicitly states them.
- The contiguous quotation must contain both the character's name and the evidence. Omit perspective when attribution is unclear. Do not invent psychological explanations or extra fields.
- Labels help retrieve observations relevant to later choices. They do not establish canon, shared knowledge or writing rules. Do not fill every category or add scenes to meet this optional classification.`;
}
