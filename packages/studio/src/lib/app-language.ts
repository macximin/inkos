// 全局应用语言：非 React 模块（store slice、parts-builder、error-copy 等）无法用
// useI18n hook，从这里读取。App.tsx 在项目配置加载/切换语言时调用 setAppLanguage 同步。
export type AppLanguage = "zh" | "ko" | "en";

let current: AppLanguage = "zh";

export function setAppLanguage(lang: AppLanguage): void {
  current = lang;
}

export function getAppLanguage(): AppLanguage {
  return current;
}

/** 内联 UI 文구. 세 번째 인자가 없으면 한국어 UI에서는 기존 중국어 문구를 유지한다. */
export function tr(zh: string, en: string, ko = en): string {
  return current === "ko" ? ko : current === "en" ? en : zh;
}
