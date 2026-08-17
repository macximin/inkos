import { getAppLanguage } from "./app-language";

const KNOWN_RUNTIME_REPLACEMENTS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly zh: string;
  readonly ko: string;
}> = [
  {
    pattern: /Latest chapter (\d+) is state-degraded\. Repair state or rewrite that chapter before continuing\./g,
    zh: "最新第 $1 章处于状态降级（state-degraded）。继续写下一章前，请先修复状态，或重写这一章。",
    ko: "최신 $1화가 상태 저하(state-degraded)입니다. 다음 화를 쓰기 전에 상태를 복구하거나 해당 회차를 다시 써 주세요.",
  },
  {
    pattern: /Chapter (\d+) is not state-degraded\./g,
    zh: "第 $1 章不是状态降级（state-degraded），无需按状态修复。",
    ko: "$1화는 상태 저하(state-degraded)가 아니므로 상태 복구가 필요하지 않습니다.",
  },
  {
    pattern: /Only the latest state-degraded chapter can be repaired safely \(latest is (\d+)\)\./g,
    zh: "只能安全修复最新的状态降级（state-degraded）章节；当前最新章是第 $1 章。",
    ko: "상태 저하(state-degraded) 회차는 최신 회차만 안전하게 복구할 수 있습니다. 현재 최신 회차는 $1화입니다.",
  },
  {
    pattern: /State repair still failed for chapter (\d+)\./g,
    zh: "第 $1 章状态修复仍然失败。",
    ko: "$1화의 상태 복구가 다시 실패했습니다.",
  },
  {
    pattern: /Studio LLM API key not set\. Open Studio services and save an API key for the selected service\./g,
    zh: "Studio 模型 API Key 未设置。请打开“模型配置”，为当前服务保存 API Key。",
    ko: "Studio 모델 API 키가 없습니다. 모델 설정을 열어 선택한 서비스의 API 키를 저장해 주세요.",
  },
  {
    pattern: /INKOS_LLM_API_KEY not set\. Run 'inkos config set-global' or add it to project \.env file\./g,
    zh: "INKOS_LLM_API_KEY 未设置。请运行 `inkos config set-global`，或在项目 .env 文件中添加它。",
    ko: "INKOS_LLM_API_KEY가 없습니다. `inkos config set-global`을 실행하거나 프로젝트 .env 파일에 추가해 주세요.",
  },
  {
    pattern: /Wrote chapter (\d+)(?: \([^)]+\)| "[^"]+")? for ([^:]+): (\d+) words, but the review did not pass \(status: ([^)]+)\)\. Manual review is required before continuing\./g,
    zh: "已完成 $2 的第 $1 章，共 $3 字，但审稿未通过（状态：$4）。继续前需要人工复核。",
    ko: "$2의 $1화 집필을 마쳤습니다. 분량은 $3자이며, 검수를 통과하지 못했습니다(상태: $4). 계속하기 전에 사람이 확인해야 합니다.",
  },
  {
    pattern: /Completed chapter (\d+)(?: \([^)]+\)| "[^"]+")? for ([^:]+): (\d+) words, status ([^.]+)\./g,
    zh: "已完成 $2 的第 $1 章，共 $3 字，状态为 $4。",
    ko: "$2의 $1화 집필을 마쳤습니다. 분량은 $3자이며, 상태는 $4입니다.",
  },
  {
    pattern: /Translation export blocked: (\d+) chapter\(s\) have not passed review\./g,
    zh: "翻译导出已阻止：仍有 $1 章未通过审校。",
    ko: "번역 내보내기가 차단되었습니다. 검수를 통과하지 못한 회차가 $1개 있습니다.",
  },
];

export function localizeKnownRuntimeMessage(message: string): string {
  const language = getAppLanguage();
  // Runtime messages arrive in English; in English mode show them as-is.
  if (language === "en") return message;
  let localized = message;
  for (const entry of KNOWN_RUNTIME_REPLACEMENTS) {
    localized = localized.replace(entry.pattern, language === "ko" ? entry.ko : entry.zh);
  }
  return localized;
}
