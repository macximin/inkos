import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ChapterMemo } from "../models/input-governance.js";
import { assertBookAdvisoryWritePaths } from "../utils/book-advisory-files.js";

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/);
const Text = z.string().trim().min(1).max(1200);
export const SceneDecisionSchema = z.object({
  readerExperience: Text,
  selectedOptionId: Id,
  selectionReason: Text,
  options: z.array(z.object({
    id: Id, action: Text, resistance: Text, experience: Text, tradeoff: Text,
  }).strict()).min(1).max(3),
}).strict().superRefine((value, context) => {
  if (new Set(value.options.map((option) => option.id)).size !== value.options.length) {
    context.addIssue({ code: "custom", path: ["options"], message: "Duplicate option ID" });
  }
  if (!value.options.some((option) => option.id === value.selectedOptionId)) {
    context.addIssue({ code: "custom", path: ["selectedOptionId"], message: "Selected option is absent" });
  }
});
export type SceneDecision = z.infer<typeof SceneDecisionSchema>;
export interface SceneDecisionRecord {
  schemaVersion: "scene-decision-record/v1";
  chapter: number;
  memoSha256: string;
  status: "missing" | "invalid" | "recorded";
  decision?: SceneDecision;
  diagnostics: string[];
  sectionRange?: { startCharacter: number; endCharacter: number; coordinateKind: "utf16-code-units" };
  authority: "advisory-plan";
  modelCallsAdded: 0;
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function decisionSections(body: string): Array<{ start: number; end: number }> {
  const visible = body.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, (block) => block.replace(/[^\n]/g, " "));
  return [...visible.matchAll(/^##\s+(?:장면 선택 기록|Scene decision|场景选择记录)\s*$/gmi)].map((heading) => {
    const start = heading.index!;
    const after = start + heading[0].length;
    const next = visible.slice(after).match(/^##\s+/m);
    return { start, end: next?.index === undefined ? body.length : after + next.index };
  });
}

/** Parse an optional decision summary. Bad optional output never forces another model call. */
export function readSceneDecision(memo: Pick<ChapterMemo, "chapter" | "body">): SceneDecisionRecord {
  if (!Number.isSafeInteger(memo.chapter) || memo.chapter < 1) throw new Error("Invalid scene decision chapter");
  const record: SceneDecisionRecord = { schemaVersion: "scene-decision-record/v1", chapter: memo.chapter,
    memoSha256: sha(memo.body), status: "missing", diagnostics: [], authority: "advisory-plan", modelCallsAdded: 0 };
  const sections = decisionSections(memo.body);
  if (sections.length === 0) return record;
  if (sections.length !== 1) return { ...record, status: "invalid", diagnostics: ["duplicate-decision-section"] };
  const { start, end } = sections[0]!;
  const block = memo.body.slice(start, end);
  const field = (labels: string) => {
    const matches = [...block.matchAll(new RegExp(`^[ \t]*(?:[-*][ \t]*)?(?:${labels})[ \t]*[:：][ \t]*(.*?)[ \t]*$`, "gmi"))];
    return matches.length === 1 ? matches[0]![1]!.trim() : "";
  };
  const options = block.split("\n").filter((line) => /^\s*\|/.test(line)).flatMap((line) => {
    const cells = line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
    if (cells.length !== 5 || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(cells[0]!)) return [];
    if (/^(?:option|id)$/i.test(cells[0]!)) return [];
    return [{ id: cells[0], action: cells[1], resistance: cells[2], experience: cells[3], tradeoff: cells[4] }];
  });
  const parsed = SceneDecisionSchema.safeParse({
    readerExperience: field("독자 경험|Reader experience|读者体验"),
    selectedOptionId: field("선택|Selected|选择"),
    selectionReason: field("근거|Reason|理由"), options,
  });
  record.sectionRange = { startCharacter: start, endCharacter: end, coordinateKind: "utf16-code-units" };
  if (!parsed.success) return { ...record, status: "invalid", diagnostics: [...new Set(parsed.error.issues.map((issue) => `invalid-${String(issue.path[0] ?? "decision")}`))] };
  return { ...record, status: "recorded", decision: parsed.data };
}

/** Keep alternatives in planning evidence; pass only the selected scene to the writer. */
export function projectSceneDecisionForWriter(memo: ChapterMemo, language: "ko" | "en" | "zh" = "ko"): ChapterMemo {
  const record = readSceneDecision(memo);
  if (record.status === "invalid") {
    // Preserve invalid planning evidence in the original memo/receipt; do not
    // let unselected alternatives become prose instructions.
    let body = memo.body;
    for (const section of decisionSections(body).reverse()) body = body.slice(0, section.start) + body.slice(section.end);
    return { ...memo, body };
  }
  if (record.status !== "recorded" || !record.decision || !record.sectionRange) return memo;
  const decision = record.decision;
  const option = decision.options.find((entry) => entry.id === decision.selectedOptionId)!;
  const labels = language === "ko"
    ? ["선택한 장면", "독자가 경험할 순간", "행동", "상대·환경의 제약", "읽는 경험", "감수할 것", "선택 근거", "기획에서 비교한 다른 후보는 이번 화에 실행할 의무가 없습니다. 이 기록도 실제로 벌어진 사건이 아닙니다."]
    : language === "en"
      ? ["Selected scene", "Reader experience", "Action", "Resistance", "Experience", "Tradeoff", "Selection reason", "Other considered options are not chapter commitments. This plan does not establish events that have occurred."]
      : ["选中的场景", "读者体验", "行动", "阻力", "体验", "取舍", "选择理由", "其他备选方案不是本章必须执行的任务；计划不代表事件已经发生。"];
  const selected = `## ${labels[0]}\n${labels[7]}\n- ${labels[1]}: ${decision.readerExperience}\n- ${labels[2]}: ${option.action}\n- ${labels[3]}: ${option.resistance}\n- ${labels[4]}: ${option.experience}\n- ${labels[5]}: ${option.tradeoff}\n- ${labels[6]}: ${decision.selectionReason}\n\n`;
  return { ...memo, body: memo.body.slice(0, record.sectionRange.startCharacter) + selected + memo.body.slice(record.sectionRange.endCharacter) };
}

export async function recordSceneDecision(bookDir: string, memo: ChapterMemo): Promise<{ path: string; record: SceneDecisionRecord }> {
  const record = readSceneDecision(memo);
  const directory = join(bookDir, "story", "runtime", "scene-decisions");
  await assertBookAdvisoryWritePaths(bookDir, [`story/runtime/scene-decisions/${memo.chapter}-${record.memoSha256}.json`]);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${memo.chapter}-${record.memoSha256}.json`);
  const text = JSON.stringify(record, null, 2) + "\n";
  try { await writeFile(path, text, { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await readFile(path, "utf8") !== text) throw new Error("Scene decision receipt conflict");
  }
  return { path, record };
}

export function sceneDecisionGuidance(language: "ko" | "en" | "zh"): string {
  if (language !== "ko") return "";
  return `## 선택을 짧게 남기기\n핵심 장면의 해법이 갈린다면 기존 메모 마지막에 아래 선택 기록을 추가하세요. 같은 결과를 말만 바꾼 후보나 항목을 채우기 위한 갈등은 만들지 않습니다. 비교가 필요 없는 결산이면 후보 하나만 적어도 됩니다. 긴 사고 과정 대신 행동·제약·독자가 느낄 차이와 선택 근거만 남깁니다. 참고의 인물이나 사건을 그대로 복사하지 않습니다.\n\n## 장면 선택 기록\n독자 경험: 이번 장면에서 독자가 구체적으로 보고 싶을 순간\n선택: A\n근거: 현재 인과와 작품의 약속에 이 행동이 맞는 이유\n| 후보 | 행동 | 상대·환경의 제약 | 읽는 경험 | 감수할 것 |\n| --- | --- | --- | --- | --- |\n| A | 이 작품의 인물이 하는 구체적 행동 | 상대가 양보하지 않는 조건 또는 실제 환경 | 독자가 확인하는 반응과 결과 | 포기하는 것 또는 없음 |\n\n후보는 1~3개이며 선택에는 존재하는 후보 ID 하나만 씁니다. 이 부분도 일반 Markdown으로 쓰고 JSON·코드 블록은 쓰지 않습니다.`;
}
