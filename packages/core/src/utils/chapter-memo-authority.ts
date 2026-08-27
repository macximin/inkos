import type { ChapterMemo } from "../models/input-governance.js";
import {
  findUnauthorizedMandatoryMoralCorrectionsInText,
  isExactTextAuthorizedBySources,
  type ArchitectMoralAuthoritySource,
} from "../agents/architect.js";

const DO_NOT_HEADINGS = ["## Do not", "## 금지", "## 不要做"] as const;

export function findUnauthorizedMemoProhibitions(
  memo: ChapterMemo,
  authoritySources: ReadonlyArray<ArchitectMoralAuthoritySource>,
): ReadonlyArray<string> {
  const section = locateDoNotSection(memo.body);
  if (!section) return [];
  return section.items.flatMap((item) => (
    isEmptyProhibition(item.text)
      || !isMandatoryMoralCorrection(item.text)
      || isExactTextAuthorizedBySources(item.text, authoritySources)
      ? []
      : [item.text]
  ));
}

export function sanitizeUnauthorizedMemoProhibitions(
  memo: ChapterMemo,
  authoritySources: ReadonlyArray<ArchitectMoralAuthoritySource>,
): { readonly memo: ChapterMemo; readonly removed: ReadonlyArray<string> } {
  const section = locateDoNotSection(memo.body);
  if (!section) return { memo, removed: [] };
  const removed = section.items.flatMap((item) => (
    isEmptyProhibition(item.text)
      || !isMandatoryMoralCorrection(item.text)
      || isExactTextAuthorizedBySources(item.text, authoritySources)
      ? []
      : [item.text]
  ));
  if (removed.length === 0) return { memo, removed };

  const keptLines = section.items.flatMap((item) => (
    isEmptyProhibition(item.text)
      || !isMandatoryMoralCorrection(item.text)
      || isExactTextAuthorizedBySources(item.text, authoritySources)
      ? [item.raw]
      : []
  ));
  const replacement = keptLines.length > 0
    ? keptLines
    : [emptyProhibitionForHeading(section.heading)];
  const lines = memo.body.split("\n");
  lines.splice(section.contentStart, section.contentEnd - section.contentStart, ...replacement);
  return {
    memo: { ...memo, body: lines.join("\n") },
    removed,
  };
}

interface LocatedDoNotSection {
  readonly heading: typeof DO_NOT_HEADINGS[number];
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly items: ReadonlyArray<{ readonly raw: string; readonly text: string }>;
}

function locateDoNotSection(body: string): LocatedDoNotSection | null {
  const lines = body.split("\n");
  const headingIndex = lines.findIndex((line) => (
    DO_NOT_HEADINGS.includes(line.trim() as typeof DO_NOT_HEADINGS[number])
  ));
  if (headingIndex < 0) return null;
  let contentEnd = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/u.test(lines[index]!.trim())) {
      contentEnd = index;
      break;
    }
  }
  const items = lines
    .slice(headingIndex + 1, contentEnd)
    .filter((line) => line.trim().length > 0)
    .map((raw) => ({
      raw,
      text: raw
        .trim()
        .replace(/^(?:[-*+]\s+|\d+[.)]\s*)/u, "")
        .trim(),
    }))
    .filter((item) => item.text.length > 0);
  return {
    heading: lines[headingIndex]!.trim() as typeof DO_NOT_HEADINGS[number],
    contentStart: headingIndex + 1,
    contentEnd,
    items,
  };
}

function isEmptyProhibition(text: string): boolean {
  return /^(?:none|n\/a|na|없음|해당\s*없음|无|無|—|-)\.?$/iu.test(text.trim());
}

function isMandatoryMoralCorrection(text: string): boolean {
  return findUnauthorizedMandatoryMoralCorrectionsInText(text).length > 0;
}

function emptyProhibitionForHeading(heading: typeof DO_NOT_HEADINGS[number]): string {
  if (heading === "## 금지") return "없음";
  if (heading === "## 不要做") return "无";
  return "none";
}
