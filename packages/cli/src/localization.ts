import { formatLengthCount, resolveLengthCountingMode } from "@actalk/inkos-core";

export type CliLanguage = "zh" | "ko" | "en";

type WriteIssue = {
  readonly severity: string;
  readonly category: string;
  readonly description: string;
};

type WriteResultShape = {
  readonly chapterNumber: number;
  readonly title: string;
  readonly wordCount: number;
  readonly status: string;
  readonly revised: boolean;
  readonly issues: ReadonlyArray<WriteIssue>;
  readonly auditPassed?: boolean;
  readonly passedAudit?: boolean;
};

type ImportResultShape = {
  readonly importedCount: number;
  readonly totalWords: number;
  readonly nextChapter: number;
  readonly continueBookId: string;
};

function lengthMode(language: CliLanguage): "zh_chars" | "en_words" {
  return resolveLengthCountingMode(language === "zh" ? "zh" : "en");
}

function localize(language: CliLanguage, messages: { zh: string; ko?: string; en: string }): string {
  return language === "en" ? messages.en : language === "ko" ? messages.ko ?? messages.en : messages.zh;
}

function normalizeCliLanguageTag(value: string | undefined): CliLanguage | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized.startsWith("en")) {
    return "en";
  }
  if (normalized.startsWith("zh")) {
    return "zh";
  }
  if (normalized.startsWith("ko")) {
    return "ko";
  }
  return undefined;
}

export function resolveCliLanguage(
  language?: string,
  env: NodeJS.ProcessEnv = process.env,
): CliLanguage {
  const explicit = normalizeCliLanguageTag(language);
  if (explicit) {
    return explicit;
  }

  const requested = normalizeCliLanguageTag(env.INKOS_LOCALE);
  if (requested) {
    return requested;
  }

  const detected = normalizeCliLanguageTag(env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG);
  return detected ?? "zh";
}

export function formatBookCreateCreating(
  language: CliLanguage,
  title: string,
  genre: string,
  platform: string,
): string {
  return localize(language, {
    zh: `创建书籍 "${title}"（${genre} / ${platform}）...`,
    ko: `책 "${title}" 생성 중 (${genre} / ${platform})...`,
    en: `Creating book "${title}" (${genre} / ${platform})...`,
  });
}

export function formatBookCreateCreated(language: CliLanguage, bookId: string): string {
  return localize(language, {
    zh: `已创建书籍：${bookId}`,
    ko: `책이 생성되었습니다: ${bookId}`,
    en: `Book created: ${bookId}`,
  });
}

export function formatBookCreateLocation(language: CliLanguage, bookId: string): string {
  return localize(language, {
    zh: `  位置：books/${bookId}/`,
    ko: `  위치: books/${bookId}/`,
    en: `  Location: books/${bookId}/`,
  });
}

export function formatBookCreateFoundationReady(language: CliLanguage): string {
  return localize(language, {
    zh: "  故事圣经、大纲和书籍规则已生成。",
    ko: "  스토리 바이블, 개요, 책 규칙이 생성되었습니다.",
    en: "  Story bible, outline, book rules generated.",
  });
}

export function formatBookCreateNextStep(language: CliLanguage, bookId: string): string {
  return localize(language, {
    zh: `下一步：inkos write next ${bookId}`,
    ko: `다음 단계: inkos write next ${bookId}`,
    en: `Next: inkos write next ${bookId}`,
  });
}

export function formatWriteNextProgress(
  language: CliLanguage,
  current: number,
  total: number,
  bookId: string,
): string {
  return localize(language, {
    zh: `[${current}/${total}] 为「${bookId}」撰写章节...`,
    ko: `[${current}/${total}] "${bookId}" 챕터 작성 중...`,
    en: `[${current}/${total}] Writing chapter for "${bookId}"...`,
  });
}

export function formatWriteNextResultLines(
  language: CliLanguage,
  result: WriteResultShape,
): string[] {
  const auditPassed = result.auditPassed ?? result.passedAudit ?? false;
  const lengthLabel = formatLengthCount(result.wordCount, lengthMode(language));
  const lines = [
    localize(language, {
      zh: `  第${result.chapterNumber}章：${result.title}`,
      ko: `  챕터 ${result.chapterNumber}: ${result.title}`,
      en: `  Chapter ${result.chapterNumber}: ${result.title}`,
    }),
    localize(language, {
      zh: `  字数：${lengthLabel}`,
      ko: `  분량: ${lengthLabel}`,
      en: `  Length: ${lengthLabel}`,
    }),
    localize(language, {
      zh: `  审计：${auditPassed ? "通过" : "需复核"}`,
      ko: `  검수: ${auditPassed ? "통과" : "검토 필요"}`,
      en: `  Audit: ${auditPassed ? "PASSED" : "NEEDS REVIEW"}`,
    }),
  ];

  if (result.revised) {
    lines.push(localize(language, {
      zh: "  自动修正：已执行（已修复关键问题）",
      ko: "  자동 수정: 실행됨(핵심 문제가 수정됨)",
      en: "  Auto-revised: YES (critical issues were fixed)",
    }));
  }

  lines.push(localize(language, {
    zh: `  状态：${result.status}`,
    ko: `  상태: ${result.status}`,
    en: `  Status: ${result.status}`,
  }));

  if (result.issues.length > 0) {
    lines.push(localize(language, {
      zh: "  问题：",
      ko: "  문제:",
      en: "  Issues:",
    }));
    for (const issue of result.issues) {
      lines.push(`    [${issue.severity}] ${issue.category}: ${issue.description}`);
    }
  }

  return lines;
}

export function formatWriteNextComplete(language: CliLanguage): string {
  return localize(language, {
    zh: "完成。",
    ko: "완료.",
    en: "Done.",
  });
}

export function formatAutoWriteStart(
  language: CliLanguage,
  bookId: string,
  startChapter: number,
  targetChapter: number,
): string {
  return localize(language, {
    zh: `自动写作「${bookId}」：从第${startChapter}章连续写到第${targetChapter}章...`,
    ko: `"${bookId}" 자동 작성: 챕터 ${startChapter}부터 ${targetChapter}까지 연속 작성 중...`,
    en: `Auto-writing "${bookId}": chapter ${startChapter} through chapter ${targetChapter}...`,
  });
}

export function formatAutoWriteAlreadyComplete(
  language: CliLanguage,
  bookId: string,
  writtenChapters: number,
  targetChapter: number,
): string {
  return localize(language, {
    zh: `「${bookId}」已写到第${writtenChapters}章（目标第${targetChapter}章），无需继续。`,
    ko: `"${bookId}"은(는) ${writtenChapters}화까지 작성되었습니다(목표: ${targetChapter}화). 계속할 작업이 없습니다.`,
    en: `"${bookId}" already has ${writtenChapters} chapter(s) written (target: chapter ${targetChapter}). Nothing to do.`,
  });
}

export type NotifyCommandAction = "write-next" | "write-rewrite" | "revise" | "audit" | "auto";

const NOTIFY_ACTION_LABELS: Record<NotifyCommandAction, { zh: string; ko: string; en: string }> = {
  "write-next": { zh: "写作", ko: "작성", en: "Write" },
  "write-rewrite": { zh: "重写", ko: "다시 쓰기", en: "Rewrite" },
  revise: { zh: "修订", ko: "수정", en: "Revise" },
  audit: { zh: "审计", ko: "검수", en: "Audit" },
  auto: { zh: "自动连写", ko: "자동 연속 작성", en: "Auto-write" },
};

export function formatNotifyCommandTitle(
  language: CliLanguage,
  action: NotifyCommandAction,
  bookName: string | undefined,
  succeeded: boolean,
): string {
  const label = localize(language, NOTIFY_ACTION_LABELS[action]);
  const book = bookName === undefined
    ? ""
    : localize(language, { zh: `《${bookName}》`, ko: `: ${bookName}`, en: `: ${bookName}` });
  return succeeded
    ? localize(language, { zh: `✅ ${label}完成${book}`, ko: `✅ ${label} 완료${book}`, en: `✅ ${label} complete${book}` })
    : localize(language, { zh: `❌ ${label}失败${book}`, ko: `❌ ${label} 실패${book}`, en: `❌ ${label} failed${book}` });
}

export function formatNotifyBatchWriteBody(
  language: CliLanguage,
  chapters: ReadonlyArray<{
    readonly chapterNumber: number;
    readonly title: string;
    readonly wordCount: number;
    readonly auditPassed: boolean;
  }>,
): string {
  const first = chapters[0]!;
  const last = chapters[chapters.length - 1]!;
  const lines = [
    localize(language, {
      zh: `本次完成 ${chapters.length} 章（第${first.chapterNumber}章到第${last.chapterNumber}章）`,
      ko: `이번에 ${chapters.length}개 챕터 작성 완료 (${first.chapterNumber}화~${last.chapterNumber}화)`,
      en: `${chapters.length} chapter(s) written (chapter ${first.chapterNumber} to ${last.chapterNumber})`,
    }),
    ...chapters.map((ch) => {
      const lengthLabel = formatLengthCount(ch.wordCount, lengthMode(language));
      return localize(language, {
        zh: `第${ch.chapterNumber}章 ${ch.title} | ${lengthLabel} | ${ch.auditPassed ? "审计通过" : "需复核"}`,
        ko: `챕터 ${ch.chapterNumber} ${ch.title} | ${lengthLabel} | ${ch.auditPassed ? "검수 통과" : "검토 필요"}`,
        en: `Chapter ${ch.chapterNumber} ${ch.title} | ${lengthLabel} | ${ch.auditPassed ? "audit passed" : "needs review"}`,
      });
    }),
  ];
  return lines.join("\n");
}

export function formatNotifyAuditBody(
  language: CliLanguage,
  result: {
    readonly chapterNumber: number;
    readonly passed: boolean;
    readonly issueCount: number;
    readonly summary: string;
  },
): string {
  const head = localize(language, {
    zh: `第${result.chapterNumber}章审计${result.passed ? "通过" : "未通过"}（${result.issueCount} 个问题）`,
    ko: `챕터 ${result.chapterNumber} 검수 ${result.passed ? "통과" : "실패"} (${result.issueCount}개 문제)`,
    en: `Chapter ${result.chapterNumber} audit ${result.passed ? "passed" : "failed"} (${result.issueCount} issue(s))`,
  });
  return result.summary ? `${head}\n${result.summary}` : head;
}

export function formatNotifyReviseBody(
  language: CliLanguage,
  result: {
    readonly chapterNumber: number;
    readonly applied: boolean;
    readonly wordCount: number;
    readonly fixedCount: number;
    readonly skippedReason?: string;
  },
): string {
  if (!result.applied) {
    return localize(language, {
      zh: `第${result.chapterNumber}章保留原稿${result.skippedReason ? `：${result.skippedReason}` : ""}`,
      ko: `챕터 ${result.chapterNumber} 원고 유지${result.skippedReason ? `: ${result.skippedReason}` : ""}`,
      en: `Chapter ${result.chapterNumber} kept original draft${result.skippedReason ? `: ${result.skippedReason}` : ""}`,
    });
  }
  const lengthLabel = formatLengthCount(result.wordCount, lengthMode(language));
  return localize(language, {
    zh: `第${result.chapterNumber}章已修订 | ${lengthLabel} | 修复 ${result.fixedCount} 个问题`,
    ko: `챕터 ${result.chapterNumber} 수정 완료 | ${lengthLabel} | ${result.fixedCount}개 문제 수정`,
    en: `Chapter ${result.chapterNumber} revised | ${lengthLabel} | ${result.fixedCount} issue(s) fixed`,
  });
}

export function formatNotifyFailureBody(language: CliLanguage, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return localize(language, {
    zh: `错误：${detail}`,
    ko: `오류: ${detail}`,
    en: `Error: ${detail}`,
  });
}

export function formatImportChaptersDiscovery(
  language: CliLanguage,
  chapterCount: number,
  bookId: string,
): string {
  return localize(language, {
    zh: `发现 ${chapterCount} 章，准备导入到「${bookId}」。`,
    ko: `${chapterCount}개 챕터를 찾았습니다. "${bookId}"로 가져올 준비 중입니다.`,
    en: `Found ${chapterCount} chapters to import into "${bookId}".`,
  });
}

export function formatImportNoFiles(language: CliLanguage, path: string): string {
  return localize(language, {
    zh: `在 ${path} 中找不到 .md 或 .txt 文件`,
    ko: `${path}에서 .md 또는 .txt 파일을 찾지 못했습니다.`,
    en: `No .md or .txt files found in ${path}`,
  });
}

export function formatImportNoChapters(language: CliLanguage, path: string): string {
  return localize(language, {
    zh: `在 ${path} 中找不到章节。默认模式匹配“第X章”和“Chapter X”。可使用 --split 提供自定义正则。`,
    ko: `${path}에서 챕터를 찾지 못했습니다. 기본 패턴은 "第X章"과 "Chapter X"를 인식합니다. --split으로 사용자 지정 정규식을 제공할 수 있습니다.`,
    en: `No chapters found in ${path}. Default pattern matches "第X章" and "Chapter X". Use --split to provide a custom regex.`,
  });
}

export function formatImportChaptersResume(
  language: CliLanguage,
  resumeFrom: number,
): string {
  return localize(language, {
    zh: `从第 ${resumeFrom} 章继续导入。`,
    ko: `${resumeFrom}화부터 이어서 가져옵니다.`,
    en: `Resuming from chapter ${resumeFrom}.`,
  });
}

export function formatImportChaptersComplete(
  language: CliLanguage,
  result: ImportResultShape,
): string[] {
  const lengthLabel = formatLengthCount(result.totalWords, lengthMode(language));
  return [
    localize(language, {
      zh: "导入完成：",
      ko: "가져오기 완료:",
      en: "Import complete:",
    }),
    localize(language, {
      zh: `  已导入章节：${result.importedCount}`,
      ko: `  가져온 챕터: ${result.importedCount}`,
      en: `  Chapters imported: ${result.importedCount}`,
    }),
    localize(language, {
      zh: `  总长度：${lengthLabel}`,
      ko: `  총 분량: ${lengthLabel}`,
      en: `  Total length: ${lengthLabel}`,
    }),
    localize(language, {
      zh: `  下一章编号：${result.nextChapter}`,
      ko: `  다음 챕터 번호: ${result.nextChapter}`,
      en: `  Next chapter number: ${result.nextChapter}`,
    }),
    "",
    localize(language, {
      zh: `运行 "inkos write next ${result.continueBookId}" 继续写作。`,
      ko: `계속 쓰려면 "inkos write next ${result.continueBookId}"를 실행하세요.`,
      en: `Run "inkos write next ${result.continueBookId}" to continue writing.`,
    }),
  ];
}

export function formatImportCanonStart(
  language: CliLanguage,
  parentBookId: string,
  targetBookId: string,
): string {
  return localize(language, {
    zh: `把 "${parentBookId}" 的正典导入到 "${targetBookId}"...`,
    ko: `"${parentBookId}"의 정본을 "${targetBookId}"로 가져오는 중...`,
    en: `Importing canon from "${parentBookId}" into "${targetBookId}"...`,
  });
}

export function formatImportCanonComplete(language: CliLanguage): string[] {
  return [
    localize(language, {
      zh: "正典已导入：story/parent_canon.md",
      ko: "정본을 가져왔습니다: story/parent_canon.md",
      en: "Canon imported: story/parent_canon.md",
    }),
    localize(language, {
      zh: "Writer 和 auditor 会在番外模式下自动识别这个文件。",
      ko: "Writer와 auditor가 외전 모드에서 이 파일을 자동으로 인식합니다.",
      en: "Writer and auditor will auto-detect this file for spinoff mode.",
    }),
  ];
}

export function formatListModelsEmpty(language: CliLanguage, service: string): string {
  return localize(language, {
    zh: `${service} 没有可用模型（可能需要 --api-key 和 --base-url）`,
    ko: `${service}에 사용 가능한 모델이 없습니다(--api-key와 --base-url이 필요할 수 있습니다).`,
    en: `No models available for ${service} (you may need --api-key and --base-url)`,
  });
}

export function formatListModelsHeader(
  language: CliLanguage,
  service: string,
  count: number,
): string {
  return localize(language, {
    zh: `${service}：${count} 个模型`,
    ko: `${service}: 모델 ${count}개`,
    en: `${service}: ${count} model(s)`,
  });
}

export function formatDoctorHintQuota(language: CliLanguage): string {
  return localize(language, {
    zh: "检查 API Key 是否正确、模型是否可用，以及账号余额或配额是否足够。",
    ko: "API 키가 올바른지, 모델을 사용할 수 있는지, 계정 잔액이나 할당량이 충분한지 확인하세요.",
    en: "Check that the API key is valid, the model is available, and the account has enough balance or quota.",
  });
}

export function formatDoctorHintOpenAiProbeExhausted(language: CliLanguage): string {
  return localize(language, {
    zh: "当前已自动尝试 chat/responses 与流式开关组合；如果仍失败，问题更可能在模型名、baseUrl 路径或服务商兼容性本身。",
    ko: "chat/responses와 스트리밍 설정 조합을 모두 자동으로 시도했습니다. 계속 실패하면 모델명, baseUrl 경로 또는 제공업체 호환성 문제일 가능성이 큽니다.",
    en: "All chat/responses and stream on/off combinations were already probed; if it still fails, the problem is more likely the model name, the baseUrl path, or provider compatibility itself.",
  });
}

export function formatDoctorHintBaseUrl(language: CliLanguage): string {
  return localize(language, {
    zh: "baseUrl 可能不正确，检查 INKOS_LLM_BASE_URL 是否包含完整路径（如 /v1）",
    ko: "baseUrl이 올바르지 않을 수 있습니다. INKOS_LLM_BASE_URL에 전체 경로(예: /v1)가 포함되어 있는지 확인하세요.",
    en: "The baseUrl may be wrong. Check that INKOS_LLM_BASE_URL includes the full path (e.g. /v1).",
  });
}

export function formatDoctorHintStreamRequirement(language: CliLanguage): string {
  return localize(language, {
    zh: "检查提供方文档，确认该接口要求 stream=true、stream=false，还是根本不支持 stream",
    ko: "제공업체 문서에서 해당 엔드포인트가 stream=true, stream=false 중 무엇을 요구하는지 또는 스트리밍을 지원하지 않는지 확인하세요.",
    en: "Check the provider docs to confirm whether the endpoint requires stream=true, stream=false, or does not support streaming at all.",
  });
}

export function formatDoctorHintModelName(language: CliLanguage): string {
  return localize(language, {
    zh: "检查模型名称是否正确（INKOS_LLM_MODEL）",
    ko: "모델명이 올바른지 확인하세요(INKOS_LLM_MODEL).",
    en: "Check that the model name is correct (INKOS_LLM_MODEL).",
  });
}

export function formatDoctorHintInvalidApiKey(language: CliLanguage): string {
  return localize(language, {
    zh: "API Key 无效，检查 INKOS_LLM_API_KEY",
    ko: "API 키가 유효하지 않습니다. INKOS_LLM_API_KEY를 확인하세요.",
    en: "The API key is invalid. Check INKOS_LLM_API_KEY.",
  });
}

// Fanfic errors are intentionally bilingual in a single string: they can surface
// through `--json` output or be rethrown before any book language is known.
export function formatFanficInvalidModeError(mode: string, language?: CliLanguage): string {
  if (language === "ko") return `동인 모드가 올바르지 않습니다: "${mode}". 사용 가능한 모드: canon, au, ooc, cp`;
  return `Invalid fanfic mode: "${mode}". Valid modes: canon, au, ooc, cp（无效的同人模式："${mode}"，可选 canon、au、ooc、cp）`;
}

export function formatFanficSourceTooShortError(length: number, language?: CliLanguage): string {
  if (language === "ko") return `원본 자료가 너무 짧습니다(${length}자). 최소 100자의 원작 자료를 제공하세요.`;
  return `Source material too short (${length} chars); provide at least 100 chars（源素材内容过短，仅 ${length} 字符，请提供至少 100 字符的原作素材）`;
}

export function formatFanficCanonMissingError(language?: CliLanguage): string {
  if (language === "ko") return "이 책에 동인 정본이 없습니다. `inkos fanfic init`으로 생성하세요.";
  return "No fanfic canon found for this book. Create one with `inkos fanfic init`（该书没有同人正典文件，用 inkos fanfic init 创建同人书）";
}

export function formatFanficSourceDirEmptyError(sourcePath: string, language?: CliLanguage): string {
  if (language === "ko") return `${sourcePath} 디렉터리에서 .txt 또는 .md 파일을 찾지 못했습니다.`;
  return `No .txt or .md files found in ${sourcePath}（目录 ${sourcePath} 中没有 .txt 或 .md 文件）`;
}

export function formatChapterSyncNoChanges(language: CliLanguage, checked: number): string {
  return localize(language, {
    zh: `已核对 ${checked} 章，index.json 字数无需修正。`,
    ko: `${checked}개 챕터를 확인했습니다. index.json 분량은 수정할 필요가 없습니다.`,
    en: `Checked ${checked} chapter(s); index.json word counts already match the files.`,
  });
}

export function formatChapterSyncChange(
  language: CliLanguage,
  change: { number: number; title: string; previousWordCount: number; wordCount: number },
  countingMode: "zh_chars" | "en_words",
): string {
  const from = formatLengthCount(change.previousWordCount, countingMode);
  const to = formatLengthCount(change.wordCount, countingMode);
  return localize(language, {
    zh: `  第${change.number}章 ${change.title}：${from} → ${to}`,
    ko: `  챕터 ${change.number} ${change.title}: ${from} → ${to}`,
    en: `  Chapter ${change.number} ${change.title}: ${from} → ${to}`,
  });
}

export function formatChapterSyncSummary(language: CliLanguage, changed: number, checked: number): string {
  return localize(language, {
    zh: `已核对 ${checked} 章，修正了 ${changed} 章的 index.json 字数。`,
    ko: `${checked}개 챕터를 확인했고 ${changed}개 챕터의 index.json 분량을 수정했습니다.`,
    en: `Checked ${checked} chapter(s); corrected ${changed} index.json word count(s).`,
  });
}

export function formatChapterSyncMissingFiles(language: CliLanguage, numbers: ReadonlyArray<number>): string {
  return localize(language, {
    zh: `警告：index.json 中的第 ${numbers.join("、")} 章找不到对应的章节文件，已跳过。`,
    ko: `경고: index.json의 챕터 ${numbers.join(", ")}에 해당하는 파일을 찾지 못해 건너뛰었습니다.`,
    en: `Warning: chapter(s) ${numbers.join(", ")} exist in index.json but have no chapter file on disk; skipped.`,
  });
}

export function formatChapterDeleteConfirm(
  language: CliLanguage,
  params: { bookTitle: string; bookId: string; number: number; title: string },
): string {
  return localize(language, {
    zh: `将删除《${params.bookTitle}》(${params.bookId}) 的最新章：第${params.number}章 ${params.title}。`
      + `章节文件会移入 chapters/.trash/，索引和故事状态回滚到第${params.number - 1}章。确认删除？(y/N) `,
    ko: `《${params.bookTitle}》(${params.bookId})의 최신 챕터 ${params.number} ${params.title}을(를) 삭제합니다.`
      + ` 챕터 파일은 chapters/.trash/로 이동하고 색인과 스토리 상태는 ${params.number - 1}화로 되돌아갑니다. 삭제할까요? (y/N) `,
    en: `Delete the latest chapter of "${params.bookTitle}" (${params.bookId}): chapter ${params.number} ${params.title}? `
      + `The chapter file moves to chapters/.trash/ and the index and story state roll back to chapter ${params.number - 1}. (y/N) `,
  });
}

export function formatChapterDeleteCancelled(language: CliLanguage): string {
  return localize(language, {
    zh: "已取消。",
    ko: "취소되었습니다.",
    en: "Cancelled.",
  });
}

export function formatChapterDeleteDone(
  language: CliLanguage,
  params: { number: number; title: string; trashedFiles: ReadonlyArray<string>; rolledBackTo: number },
): string {
  const trashNote = params.trashedFiles.length > 0
    ? params.trashedFiles.join(", ")
    : localize(language, { zh: "（章节文件已不存在，未移动）", ko: "(챕터 파일이 이미 없어 이동하지 않음)", en: "(chapter file was already gone; nothing moved)" });
  return localize(language, {
    zh: `已删除第${params.number}章 ${params.title}：章节文件保留在 ${trashNote}，索引和故事状态已回滚到第${params.rolledBackTo}章。`,
    ko: `챕터 ${params.number} ${params.title}을(를) 삭제했습니다. 파일은 ${trashNote}에 보관되며 색인과 스토리 상태는 ${params.rolledBackTo}화로 되돌아갔습니다.`,
    en: `Deleted chapter ${params.number} ${params.title}: chapter file kept at ${trashNote}; index and story state rolled back to chapter ${params.rolledBackTo}.`,
  });
}

export function formatBookBackupCreated(language: CliLanguage, bookId: string, backupId: string): string {
  return localize(language, {
    zh: `已备份 ${bookId} → .inkos/backups/${bookId}/${backupId}/`,
    ko: `${bookId} 백업 완료 → .inkos/backups/${bookId}/${backupId}/`,
    en: `Backed up ${bookId} → .inkos/backups/${bookId}/${backupId}/`,
  });
}

export function formatBookBackupListEmpty(language: CliLanguage, bookId: string): string {
  return localize(language, {
    zh: `${bookId} 还没有备份。用 inkos book backup ${bookId} 创建一份。`,
    ko: `${bookId}에는 아직 백업이 없습니다. inkos book backup ${bookId}로 생성하세요.`,
    en: `No backups for ${bookId} yet. Create one with: inkos book backup ${bookId}`,
  });
}

export function formatBookRestoreDone(
  language: CliLanguage,
  params: { bookId: string; backupId: string; preRestoreBackupId: string | null },
): string {
  const preNote = params.preRestoreBackupId
    ? localize(language, {
        zh: `恢复前的状态已自动备份为 ${params.preRestoreBackupId}。`,
        ko: `복원 전 상태를 ${params.preRestoreBackupId}(으)로 자동 백업했습니다.`,
        en: `The pre-restore state was automatically backed up as ${params.preRestoreBackupId}.`,
      })
    : localize(language, {
        zh: "书目录当时不存在，未创建恢复前备份。",
        ko: "당시 책 디렉터리가 없어 복원 전 백업을 만들지 않았습니다.",
        en: "The book directory did not exist, so no pre-restore backup was created.",
      });
  return localize(language, {
    zh: `已把 ${params.bookId} 恢复到备份 ${params.backupId}。${preNote}`,
    ko: `${params.bookId}을(를) 백업 ${params.backupId}(으)로 복원했습니다. ${preNote}`,
    en: `Restored ${params.bookId} to backup ${params.backupId}. ${preNote}`,
  });
}
