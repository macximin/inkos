/** POV-specific projections of legacy Markdown context; never edits story state. */

function plain(value: string): string {
  return value.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*`]/g, "").trim().replace(/^_+|_+$/g, "");
}

function characterName(value: string): string {
  return plain(value).replace(/^["'「『]|["'」』]$/g, "").trim();
}

function cells(line: string): string[] | null {
  const text = line.trim();
  if (!text.startsWith("|")) return null;
  const result = text.replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/);
  return result.map((value) => value.replace(/\\\|/g, "|").trim());
}

function separator(row: string[] | null): boolean {
  return Boolean(row?.length && row.every((cell) => /^:?-{3,}:?$/.test(cell.trim())));
}

function nameListIncludes(value: string, name: string): boolean {
  return value.split(/[,，、;；·/\n]+/).some((entry) => characterName(entry) === characterName(name));
}

/**
 * Resolve an explicit POV within the requested chapter. Multiple different POV
 * declarations mean a multi-viewpoint chapter, so no chapter-wide filter applies.
 * Do not match a chapter mentioned in prose or stop at a nested scene heading.
 */
export function extractPOVFromOutline(volumeOutline: string, chapterNumber: number): string | null {
  if (!Number.isInteger(chapterNumber) || chapterNumber < 1) return null;
  let inChapter = false;
  const names = new Set<string>();
  for (const raw of volumeOutline.split("\n")) {
    const line = plain(raw.replace(/^\s*(?:#{1,6}\s*|[-*+]\s+)/, ""));
    const chapter = line.match(/^(?:第\s*(\d+)\s*章|chapter\s+(\d+)\b|(?:제\s*)?(\d+)\s*(?:화|회|장)(?=\s|[:：.)-]|$))/i);
    if (chapter) {
      const number = Number(chapter[1] ?? chapter[2] ?? chapter[3]);
      if (inChapter && number !== chapterNumber) break;
      inChapter = number === chapterNumber;
    }
    if (!inChapter) continue;
    const pov = line.match(/(?:^|[\s;；|])(?:POV|视角|시점(?:\s*인물)?|관점(?:\s*인물)?)(?:\s*[:：]\s*|\s+)(.+)$/i);
    if (!pov) continue;
    // An explicit list is not a single POV; filtering it as one erases valid context.
    if (/[,，、/→↔&]|\s(?:and|및)\s/i.test(pov[1]!)) return null;
    const name = characterName(pov[1]!.replace(/\s*[（(].*$/, "").replace(/[.;。；]+$/, ""));
    if (name) names.add(name);
  }
  return names.size === 1 ? [...names][0]! : null;
}

/** Keep the named character's row, not rows merely mentioning that character. */
export function filterMatrixByPOV(characterMatrix: string, povCharacter: string): string {
  if (!characterMatrix || !povCharacter.trim()) return characterMatrix;
  const lines = characterMatrix.split("\n");
  const kept: string[] = [];
  let activeLevel = 0, noteIndex = 0, hidden = 0;
  let heading = "";
  let headers: string[] = [];
  const finishSection = () => {
    if (hidden > 0) {
    const note = /정보|인지/.test(heading)
      ? `(현재 시점: ${povCharacter}. 다른 인물의 정보 행 ${hidden}개는 이 문맥에서 숨김.)`
      : /Information/i.test(heading)
        ? `(POV: ${povCharacter}; ${hidden} other information row(s) hidden.)`
        : `（当前视角：${povCharacter}，其他 ${hidden} 个角色的信息边界已隐藏）`;
      kept.splice(noteIndex + 1, 0, note);
    }
    activeLevel = 0; hidden = 0; headers = [];
  };
  for (const [index, line] of lines.entries()) {
    const section = line.match(/^(#{1,6})\s+(.+)$/);
    if (section) {
      const level = section[1]!.length;
      if (activeLevel > 0 && level <= activeLevel) finishSection();
      if (activeLevel === 0 && /信息边界|Information\s+Boundar|정보\s*경계|인지\s*범위/i.test(section[2]!)) {
        activeLevel = level; heading = line; noteIndex = kept.length;
      }
      headers = [];
      kept.push(line);
      continue;
    }
    const row = cells(line);
    if (!activeLevel || !row) { if (!row) headers = []; kept.push(line); continue; }
    if (separator(cells(lines[index + 1] ?? ""))) { headers = row.map(plain); kept.push(line); continue; }
    if (separator(row)) { kept.push(line); continue; }
    const characterColumn = headers.findIndex((header) => /^(?:角色|人物|character|name|인물|이름|등장인물)$/i.test(header));
    if (characterName(row[characterColumn < 0 ? 0 : characterColumn] ?? "") === characterName(povCharacter)) kept.push(line);
    else hidden++;
  }
  finishSection();
  return kept.join("\n");
}

function participantChapters(chapterSummaries: string, povCharacter: string): Set<number> {
  const result = new Set<number>();
  const lines = chapterSummaries.split("\n");
  let headers: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const row = cells(lines[index]!);
    if (!row) { headers = []; continue; }
    if (separator(cells(lines[index + 1] ?? ""))) { headers = row.map(plain); continue; }
    if (separator(row)) continue;
    const chapterColumn = headers.findIndex((header) => /^(?:chapter|chapter_number|章节|章|회차|화)$/i.test(header));
    const charactersColumn = headers.findIndex((header) => /^(?:characters?|角色|人物|인물|등장인물)$/i.test(header));
    if (chapterColumn < 0 || charactersColumn < 0) continue;
    const chapter = plain(row[chapterColumn] ?? "");
    if (/^\d+$/.test(chapter) && nameListIncludes(row[charactersColumn] ?? "", povCharacter)) result.add(Number(chapter));
  }
  return result;
}

/**
 * Prefer an explicit known_by column when present. For older hook tables, a
 * source chapter's participant column is a limited fallback, not proof of
 * knowledge. A mention in a secret/summary is never proof of participation.
 * An empty projection stays empty: restoring all hooks would reveal the secrets
 * that the filter just removed. The original hook ledger remains unchanged.
 */
export function filterHooksByPOV(hooks: string, povCharacter: string, chapterSummaries: string): string {
  if (!hooks || !povCharacter.trim()) return hooks;
  const presentIn = participantChapters(chapterSummaries, povCharacter);
  const lines = hooks.split("\n");
  let headers: string[] = [];
  return lines.filter((line, index) => {
    const row = cells(line);
    if (!row) { headers = []; return true; }
    if (separator(cells(lines[index + 1] ?? ""))) { headers = row.map(plain); return true; }
    if (separator(row)) return true;
    const knownByColumn = headers.findIndex((header) => /^(?:known[_ ]by|known to|知情者|已知者|인지\s*인물|알고\s*있는\s*인물)$/i.test(header));
    if (knownByColumn >= 0) return nameListIncludes(row[knownByColumn] ?? "", povCharacter);
    const sourceColumn = headers.findIndex((header) => /^(?:start[_ ]chapter|source[_ ]chapter|chapter|起始章(?:节)?|埋设章(?:节)?|(?:시작|출처|등장)\s*회차|회차)$/i.test(header));
    if (sourceColumn < 0) return false;
    const sourceChapter = plain(row[sourceColumn] ?? "");
    return /^\d+$/.test(sourceChapter) && presentIn.has(Number(sourceChapter));
  }).join("\n");
}
