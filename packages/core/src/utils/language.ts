export type WritingLanguage = "zh" | "ko" | "en";

/**
 * Infer the writing language from a free-text brief/premise when the user did not set one explicitly.
 *
 * Conservative by design: defaults to "zh" (preserving prior behaviour for Chinese users), recognizes
 * Hangul before the broader CJK/Latin comparison, and only returns "en" when the text is clearly
 * Latin-dominant. Incidental foreign names should not override the language of the surrounding brief.
 */
export function inferLanguage(text?: string | null): WritingLanguage {
  const t = text ?? "";
  const han = (t.match(/[一-鿿]/g) ?? []).length;
  const hangul = (t.match(/[가-힣ㄱ-ㅎㅏ-ㅣ]/g) ?? []).length;
  const latin = (t.match(/[A-Za-z]/g) ?? []).length;
  if (hangul > 0 && hangul >= han && hangul * 4 >= latin) return "ko";
  if (han === 0 && hangul === 0 && latin > 0) return "en";
  if (latin > 0 && (han + hangul) * 4 < latin) return "en";
  if (hangul > han) return "ko";
  return "zh";
}
