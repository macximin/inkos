import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { BookRulesSchema, parseBookRules, type BookRules } from "../models/book-rules.js";
import {
  BOOK_RULE_PROVENANCE_COLLECTIONS,
  BOOK_RULE_PROVENANCE_PATH,
  BookRuleProvenanceReceiptSchema,
  BookRuleSourceAuthorityReceiptSchema,
  carryForwardBookRuleProvenanceEntries,
  compileBookRuleOwnerAdoptionReceipt,
  compileBookRuleProvenance,
  compileBookRuleSourceAuthorityReceipt,
  persistBookRulesPair,
  projectBookRules,
  readBookRuleProjection,
  readBookRuleProvenance,
  renderBookRuleOwnerAdoptionReceipt,
  renderBookRuleProvenance,
  renderBookRules,
  renderBookRuleSourceAuthorityReceipt,
  rulesForAutoAction,
  storeBookRuleProvenance,
  verifyBookRuleProvenance,
  type BookRuleAuthorityAssignment,
} from "../models/book-rule-provenance.js";

const RULE_TEXT = {
  behavior: "약자를 돕기 전에 자신의 이익을 계산한다.",
  genre: "갑작스러운 이세계 전생",
  prohibition: "설명만으로 경쟁사를 무너뜨리지 않는다.",
  shortcut: "미래 기억만으로 증거 없이 수사를 끝낸다.",
} as const;

function sampleRules(overrides: Partial<BookRules> = {}): BookRules {
  return BookRulesSchema.parse({
    protagonist: {
      name: "한도경",
      personalityLock: ["냉정함"],
      behavioralConstraints: [RULE_TEXT.behavior],
    },
    genreLock: {
      primary: "현대판타지 재벌물",
      forbidden: [RULE_TEXT.genre],
    },
    prohibitions: [RULE_TEXT.prohibition],
    futureAdvantage: {
      enabled: true,
      corePromise: "선점과 역전",
      forbiddenShortcuts: [RULE_TEXT.shortcut],
    },
    narrativePerson: "third",
    ...overrides,
  });
}

function sampleRulesMarkdown(extra = ""): string {
  return [
    "# 작품 규칙",
    "",
    "## 주인공",
    "- 이름: 한도경",
    "- 성격 고정점: 냉정함",
    `- 행동 제약: ${RULE_TEXT.behavior}`,
    "",
    "## 장르 고정",
    "- 장르: 현대판타지 재벌물",
    `- 금지 요소: ${RULE_TEXT.genre}`,
    "",
    "## 금지 사항",
    `- ${RULE_TEXT.prohibition}`,
    "",
    "## 미래 선점",
    "- 사용: true",
    "- 핵심 재미: 선점과 역전",
    `- 금지된 지름길: ${RULE_TEXT.shortcut}`,
    "",
    "## 해석되지 않은 메모",
    "악인은 마지막에 반드시 사과하고 처벌받아야 한다.",
    "source: user-explicit; strength: hard",
    extra,
  ].join("\n");
}

function exactSourceAssignment(
  fieldPath: BookRuleAuthorityAssignment["fieldPath"],
  text: string,
  source: BookRuleAuthorityAssignment["source"] = "user-explicit",
): BookRuleAuthorityAssignment {
  return exactSourceFixture("book-a", fieldPath, text, source).assignment;
}

interface AuthorityFixture {
  readonly assignment: BookRuleAuthorityAssignment;
  readonly files: ReadonlyArray<{ readonly relativePath: string; readonly content: string }>;
}

function exactSourceFixture(
  bookId: string,
  fieldPath: BookRuleAuthorityAssignment["fieldPath"],
  text: string,
  source: BookRuleAuthorityAssignment["source"] = "user-explicit",
): AuthorityFixture {
  const slug = fieldPath.replace(/[^A-Za-z0-9]+/g, "-");
  const artifactPath = `story/authority/source-${slug}.md`;
  const receiptPath = `story/authority/source-${slug}.receipt.json`;
  const artifactContent = `사용자 원문 지시\n${text}\n이 지시는 그대로 보존한다.`;
  const start = artifactContent.indexOf(text);
  const sourceSelector = {
    artifactPath,
    artifactContent,
    start,
    end: start + text.length,
  };
  const authoritySource = source === "premise-explicit" || source === "book-canon"
    ? source
    : "user-explicit";
  const authorityReceipt = compileBookRuleSourceAuthorityReceipt({
    bookId,
    source: authoritySource,
    authorityOrigin: authoritySource === "book-canon"
      ? "persisted-book-canon"
      : "authenticated-owner-instruction",
    intent: "authorize-rule",
    decisionId: `authorize-${slug}`,
    authorizedByActorId: "owner-1",
    fieldPath,
    text,
    sourceSelector,
    now: () => new Date("2026-08-27T10:00:00.000Z"),
  });
  const receiptContent = renderBookRuleSourceAuthorityReceipt(authorityReceipt);
  return {
    assignment: {
      fieldPath,
      text,
      source,
      strength: "hard",
      sourceSelector,
      sourceAuthorityReceipt: { receiptPath, receiptContent },
    },
    files: [
      { relativePath: artifactPath, content: artifactContent },
      { relativePath: receiptPath, content: receiptContent },
    ],
  };
}

function ownerAdoptionFixture(
  bookId: string,
  fieldPath: BookRuleAuthorityAssignment["fieldPath"],
  text: string,
): AuthorityFixture {
  const slug = fieldPath.replace(/[^A-Za-z0-9]+/g, "-");
  const receiptPath = `story/authority/owner-${slug}.receipt.json`;
  const authorityReceipt = compileBookRuleOwnerAdoptionReceipt({
    bookId,
    decisionId: `adopt-${slug}`,
    adoptedByActorId: "owner-1",
    fieldPath,
    text,
    now: () => new Date("2026-08-27T10:00:00.000Z"),
  });
  const receiptContent = renderBookRuleOwnerAdoptionReceipt(authorityReceipt);
  return {
    assignment: {
      fieldPath,
      text,
      source: "model-suggested",
      strength: "hard",
      ownerAdoptionReceipt: { receiptPath, receiptContent },
    },
    files: [{ relativePath: receiptPath, content: receiptContent }],
  };
}

async function writeAuthorityFiles(root: string, fixtures: ReadonlyArray<AuthorityFixture>): Promise<void> {
  for (const file of fixtures.flatMap((fixture) => fixture.files)) {
    const path = join(root, file.relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content, "utf8");
  }
}

describe("Book rule provenance v1", () => {
  it("enumerates the four enforcement-sensitive collections with exact file selectors and diagnostic defaults", () => {
    const rulesFileContent = sampleRulesMarkdown();
    const receipt = compileBookRuleProvenance({
      bookId: "book-a",
      rulesFileContent,
      rules: sampleRules(),
      now: () => new Date("2026-08-27T10:00:00.000Z"),
    });

    expect(receipt).toMatchObject({
      version: 1,
      compiler: "host",
      scope: "enforcement-sensitive-v1",
      coveredCollections: BOOK_RULE_PROVENANCE_COLLECTIONS,
      unparsedMarkdownPolicy: "display-only-no-auto-action",
      bookRuleEntryCount: 4,
      provenanceRuleCount: 4,
      hardRuleCount: 0,
      softRuleCount: 0,
      diagnosticRuleCount: 4,
      authorizedHardRuleCount: 0,
      unauthorizedHardRuleCount: 0,
      coveragePassed: true,
    });
    expect(receipt.rules.map((entry) => entry.fieldPath)).toEqual([
      "protagonist.behavioralConstraints[0]",
      "genreLock.forbidden[0]",
      "prohibitions[0]",
      "futureAdvantage.forbiddenShortcuts[0]",
    ]);
    expect(receipt.rules.every((entry) => (
      entry.source === "model-suggested" && entry.strength === "diagnostic"
    ))).toBe(true);
    for (const entry of receipt.rules) {
      const selected = Buffer.from(rulesFileContent, "utf8")
        .subarray(entry.bookRulesSelector.start, entry.bookRulesSelector.end)
        .toString("utf8");
      expect(selected).toBe(entry.text);
      expect(entry.bookRulesSelector.coordinate).toBe("utf8-byte");
      expect(entry.textSha256).toBe(sha256(entry.text));
      expect(entry.bookRulesSelector.textSha256).toBe(entry.textSha256);
    }
    expect(BookRuleProvenanceReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(JSON.parse(renderBookRuleProvenance(receipt))).toEqual(receipt);
  });

  it("stores exact authority source selectors as UTF-8 byte ranges", () => {
    const fixture = exactSourceFixture(
      "book-a",
      "prohibitions[0]",
      RULE_TEXT.prohibition,
    );
    const receipt = compileBookRuleProvenance({
      bookId: "book-a",
      rulesFileContent: sampleRulesMarkdown(),
      rules: sampleRules(),
      assignments: [fixture.assignment],
    });
    const selector = receipt.rules.find(
      (entry) => entry.fieldPath === "prohibitions[0]",
    )?.sourceSelector;

    expect(selector?.rangeEncoding).toBe("utf8-byte");
    const artifact = fixture.files[0]!.content;
    expect(Buffer.from(artifact, "utf8")
      .subarray(selector!.start, selector!.end)
      .toString("utf8")).toBe(RULE_TEXT.prohibition);
    expect(selector!.start).toBeGreaterThan(artifact.indexOf(RULE_TEXT.prohibition));
  });

  it("binds every hard source authority to an authenticated origin, rule-authorizing intent, and decision", () => {
    const fixture = exactSourceFixture(
      "book-a",
      "prohibitions[0]",
      RULE_TEXT.prohibition,
    );
    const authorityReceipt = JSON.parse(fixture.files[1]!.content) as Record<string, unknown>;
    expect(authorityReceipt).toMatchObject({
      authorityOrigin: "authenticated-owner-instruction",
      intent: "authorize-rule",
      decisionId: "authorize-prohibitions-0-",
      authorizedByActorId: "owner-1",
    });

    const provenance = compileBookRuleProvenance({
      bookId: "book-a",
      rulesFileContent: sampleRulesMarkdown(),
      rules: sampleRules(),
      assignments: [fixture.assignment],
    });
    expect(provenance.rules.find((entry) => entry.fieldPath === "prohibitions[0]")?.sourceAuthority)
      .toMatchObject({
        authorityOrigin: "authenticated-owner-instruction",
        intent: "authorize-rule",
        decisionId: "authorize-prohibitions-0-",
      });

    for (const field of ["authorityOrigin", "intent", "decisionId"] as const) {
      const missing = { ...authorityReceipt };
      delete missing[field];
      expect(BookRuleSourceAuthorityReceiptSchema.safeParse(missing).success).toBe(false);
    }
    expect(BookRuleSourceAuthorityReceiptSchema.safeParse({
      ...authorityReceipt,
      decisionId: "different-decision",
    }).success).toBe(false);
  });

  it("rejects a claimed persisted-canon origin for raw owner or model text", () => {
    const fixture = exactSourceFixture(
      "book-a",
      "prohibitions[0]",
      RULE_TEXT.prohibition,
    );
    expect(() => compileBookRuleSourceAuthorityReceipt({
      bookId: "book-a",
      source: "user-explicit",
      authorityOrigin: "persisted-book-canon",
      intent: "authorize-rule",
      decisionId: "forged-canon-origin",
      authorizedByActorId: "model-agent",
      fieldPath: "prohibitions[0]",
      text: RULE_TEXT.prohibition,
      sourceSelector: fixture.assignment.sourceSelector!,
    })).toThrow(/persisted-book-canon authority may only bind/i);
  });

  it("enumerates the same strict restriction surface from legacy YAML without trusting model provenance text", () => {
    const raw = [
      "---",
      'version: "1.0"',
      "protagonist:",
      "  name: 한도경",
      "  personalityLock: [냉정함]",
      `  behavioralConstraints: [${RULE_TEXT.behavior}]`,
      "genreLock:",
      "  primary: 현대판타지 재벌물",
      `  forbidden: [${RULE_TEXT.genre}]`,
      "prohibitions:",
      `  - ${RULE_TEXT.prohibition}`,
      "futureAdvantage:",
      "  enabled: true",
      `  forbiddenShortcuts: [${RULE_TEXT.shortcut}]`,
      "---",
      "source: user-explicit; strength: hard",
    ].join("\n");
    const parsed = parseBookRules(raw);
    expect(parsed).not.toBeNull();

    const receipt = compileBookRuleProvenance({
      bookId: "yaml-book",
      rulesFileContent: raw,
      rules: parsed!.rules,
    });

    expect(receipt.rules).toHaveLength(4);
    expect(receipt.rules.every((entry) => entry.strength === "diagnostic")).toBe(true);
    expect(receipt.hardRuleCount).toBe(0);
  });

  it("stores and reads a current sidecar while exposing only authorized hard rules to auto action", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-book-rule-provenance-"));
    const rulesFileContent = sampleRulesMarkdown();
    const rules = sampleRules();
    const sourceFixture = exactSourceFixture(
      "book-a",
      "prohibitions[0]",
      RULE_TEXT.prohibition,
    );
    const adoptionFixture = ownerAdoptionFixture(
      "book-a",
      "genreLock.forbidden[0]",
      RULE_TEXT.genre,
    );
    const receipt = compileBookRuleProvenance({
      bookId: "book-a",
      rulesFileContent,
      rules,
      assignments: [sourceFixture.assignment, adoptionFixture.assignment],
      now: () => new Date("2026-08-27T10:00:00.000Z"),
    });

    try {
      await mkdir(join(root, "story"), { recursive: true });
      await writeFile(join(root, "story", "book_rules.md"), rulesFileContent, "utf8");
      await writeAuthorityFiles(root, [sourceFixture, adoptionFixture]);
      await storeBookRuleProvenance(root, receipt, rules);

      const read = await readBookRuleProvenance(root);
      expect(read.status).toBe("loaded");
      const verification = verifyBookRuleProvenance(read, {
        bookId: "book-a",
        rulesFileContent,
        rules,
      });
      expect(verification.status).toBe("current");

      const inMemoryProjection = projectBookRules({
        bookId: "book-a",
        rulesFileContent,
        rules,
        sidecar: receipt,
      });
      expect(inMemoryProjection).toMatchObject({
        status: "current",
        authorityEvidence: "unverified",
      });
      expect(rulesForAutoAction(inMemoryProjection)).toEqual([]);
      expect(inMemoryProjection.rules
        .filter((entry) => entry.provenance?.strength === "hard")
        .every((entry) => entry.effectiveStrength === "diagnostic"))
        .toBe(true);

      const projection = await readBookRuleProjection({ bookDir: root, bookId: "book-a", rules });
      expect(projection).toMatchObject({ status: "current", authorityEvidence: "verified" });
      expect(projection.canonFacts.protagonist).toEqual({
        name: "한도경",
        personalityLock: ["냉정함"],
      });
      expect(projection.canonFacts.protagonist).not.toHaveProperty("behavioralConstraints");
      expect(rulesForAutoAction(projection).map((entry) => entry.fieldPath)).toEqual([
        "genreLock.forbidden[0]",
        "prohibitions[0]",
      ]);
      const sourced = rulesForAutoAction(projection).find(
        (entry) => entry.fieldPath === "prohibitions[0]",
      );
      expect(sourced?.sourceAuthority).toMatchObject({
        authorityOrigin: "authenticated-owner-instruction",
        intent: "authorize-rule",
        decisionId: "authorize-prohibitions-0-",
        authorizedByActorId: "owner-1",
      });
      const adopted = rulesForAutoAction(projection).find(
        (entry) => entry.fieldPath === "genreLock.forbidden[0]",
      );
      expect(adopted?.ownerAdoption).toMatchObject({
        decision: "adopt",
        adoptedByActorId: "owner-1",
        receiptFileSha256: sha256(adoptionFixture.files[0]!.content),
      });
      expect(renderBookRules(projection, "auto-action")).toContain(RULE_TEXT.prohibition);
      expect(renderBookRules(projection, "auto-action")).not.toContain(RULE_TEXT.shortcut);
      expect(renderBookRules(projection, "raw-display")).toBe(rulesFileContent);
      await expect(readFile(join(root, BOOK_RULE_PROVENANCE_PATH), "utf8"))
        .resolves.toBe(renderBookRuleProvenance(receipt));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("re-reads exact source and decision files, failing the entire hard projection closed on tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-book-rule-authority-"));
    const rulesFileContent = sampleRulesMarkdown();
    const rules = sampleRules();
    const sourceFixture = exactSourceFixture(
      "book-a",
      "prohibitions[0]",
      RULE_TEXT.prohibition,
    );
    const adoptionFixture = ownerAdoptionFixture(
      "book-a",
      "genreLock.forbidden[0]",
      RULE_TEXT.genre,
    );
    const receipt = compileBookRuleProvenance({
      bookId: "book-a",
      rulesFileContent,
      rules,
      assignments: [sourceFixture.assignment, adoptionFixture.assignment],
    });

    try {
      await writeAuthorityFiles(root, [sourceFixture, adoptionFixture]);
      await persistBookRulesPair({
        bookDir: root,
        bookId: "book-a",
        rulesFileContent,
        rules,
        receipt,
      });
      await expect(readFile(join(root, "story", "book_rules.md"), "utf8"))
        .resolves.toBe(rulesFileContent);
      await expect(readFile(join(root, BOOK_RULE_PROVENANCE_PATH), "utf8"))
        .resolves.toBe(renderBookRuleProvenance(receipt));

      const sourceFile = sourceFixture.files[0]!;
      await writeFile(join(root, sourceFile.relativePath), `${sourceFile.content}\n변조`, "utf8");
      const sourceTampered = await readBookRuleProjection({
        bookDir: root,
        bookId: "book-a",
        rules,
      });
      expect(sourceTampered).toMatchObject({
        status: "invalid",
        authorityEvidence: "invalid",
      });
      expect(sourceTampered.reason).toMatch(/source artifact bytes/i);
      expect(rulesForAutoAction(sourceTampered)).toEqual([]);
      expect(sourceTampered.rules
        .filter((entry) => entry.provenance?.strength === "hard")
        .every((entry) => entry.effectiveStrength === "diagnostic"))
        .toBe(true);

      await writeFile(join(root, sourceFile.relativePath), sourceFile.content, "utf8");
      const ownerReceiptFile = adoptionFixture.files[0]!;
      await writeFile(
        join(root, ownerReceiptFile.relativePath),
        ownerReceiptFile.content.replace("owner-1", "owner-2"),
        "utf8",
      );
      const receiptTampered = await readBookRuleProjection({
        bookDir: root,
        bookId: "book-a",
        rules,
      });
      expect(receiptTampered).toMatchObject({
        status: "invalid",
        authorityEvidence: "invalid",
      });
      expect(receiptTampered.reason).toMatch(/owner adoption receipt bytes/i);
      expect(rulesForAutoAction(receiptTampered)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unrelated source selections and owner receipts bound to another Book", () => {
    const unrelated = "이 문장은 해당 규칙이 아니다.";
    expect(() => compileBookRuleSourceAuthorityReceipt({
      bookId: "book-a",
      source: "user-explicit",
      authorityOrigin: "authenticated-owner-instruction",
      intent: "authorize-rule",
      decisionId: "authorize-unrelated",
      authorizedByActorId: "owner-1",
      fieldPath: "prohibitions[0]",
      text: RULE_TEXT.prohibition,
      sourceSelector: {
        artifactPath: "story/authority/unrelated.md",
        artifactContent: unrelated,
        start: 0,
        end: unrelated.length,
      },
    })).toThrow(/selected source text must equal/i);

    const wrongBookReceipt = renderBookRuleOwnerAdoptionReceipt(
      compileBookRuleOwnerAdoptionReceipt({
        bookId: "book-b",
        decisionId: "adopt-wrong-book",
        adoptedByActorId: "owner-1",
        fieldPath: "genreLock.forbidden[0]",
        text: RULE_TEXT.genre,
      }),
    );
    expect(() => compileBookRuleProvenance({
      bookId: "book-a",
      rulesFileContent: sampleRulesMarkdown(),
      rules: sampleRules(),
      assignments: [{
        fieldPath: "genreLock.forbidden[0]",
        text: RULE_TEXT.genre,
        source: "model-suggested",
        strength: "hard",
        ownerAdoptionReceipt: {
          receiptPath: "story/authority/wrong-book.json",
          receiptContent: wrongBookReceipt,
        },
      }],
    })).toThrow(/not bound to this Book/i);
  });

  it("rejects hard promotion without exact trusted-source or owner-adoption evidence", () => {
    const base = {
      bookId: "book-a",
      rulesFileContent: sampleRulesMarkdown(),
      rules: sampleRules(),
    };
    expect(() => compileBookRuleProvenance({
      ...base,
      assignments: [{
        fieldPath: "prohibitions[0]",
        text: RULE_TEXT.prohibition,
        source: "user-explicit",
        strength: "hard",
      }],
    })).toThrow(/hard rules require/i);
    expect(() => compileBookRuleProvenance({
      ...base,
      assignments: [exactSourceAssignment(
        "prohibitions[0]",
        RULE_TEXT.prohibition,
        "model-suggested",
      )],
    })).toThrow(/cannot authorize|not bound/i);
    expect(() => compileBookRuleProvenance({
      ...base,
      assignments: [exactSourceAssignment(
        "prohibitions[0]",
        RULE_TEXT.prohibition,
        "genre",
      )],
    })).toThrow(/cannot authorize|not bound/i);
  });

  it("fails closed for missing, invalid, and stale sidecars while preserving raw display", () => {
    const rulesFileContent = sampleRulesMarkdown();
    const rules = sampleRules();
    const authorized = compileBookRuleProvenance({
      bookId: "book-a",
      rulesFileContent,
      rules,
      assignments: [exactSourceAssignment("prohibitions[0]", RULE_TEXT.prohibition)],
    });

    const missing = projectBookRules({
      bookId: "book-a",
      rulesFileContent,
      rules,
    });
    expect(missing.status).toBe("missing");
    expect(rulesForAutoAction(missing)).toEqual([]);
    expect(missing.rules.every((entry) => (
      entry.provenance === null && entry.effectiveStrength === "diagnostic"
    ))).toBe(true);
    expect(renderBookRules(missing, "raw-display")).toContain("반드시 사과하고 처벌");
    expect(renderBookRules(missing, "auto-action")).toBe("(no authorized hard book rules)");
    expect(missing.rawRules.prohibitions).toEqual([RULE_TEXT.prohibition]);

    const tampered = {
      ...authorized,
      hardRuleCount: authorized.hardRuleCount + 1,
    };
    const invalid = projectBookRules({
      bookId: "book-a",
      rulesFileContent,
      rules,
      sidecar: tampered,
    });
    expect(invalid.status).toBe("invalid");
    expect(rulesForAutoAction(invalid)).toEqual([]);
    expect(invalid.rawRules).toEqual(rules);

    const stale = projectBookRules({
      bookId: "book-a",
      rulesFileContent: `${rulesFileContent}\n`,
      rules,
      sidecar: authorized,
    });
    expect(stale).toMatchObject({ status: "stale", reason: "rules-file-changed" });
    expect(rulesForAutoAction(stale)).toEqual([]);
    expect(stale.rawRules.prohibitions).toEqual([RULE_TEXT.prohibition]);

    const changedRules = sampleRules({ prohibitions: ["문구가 바뀌었다."] });
    const structurallyStale = projectBookRules({
      bookId: "book-a",
      rulesFileContent,
      rules: changedRules,
      sidecar: authorized,
    });
    expect(structurallyStale).toMatchObject({ status: "stale", reason: "rule-surface-changed" });
    expect(rulesForAutoAction(structurallyStale)).toEqual([]);
  });

  it("rejects partial, duplicate, extra, and overlapping strict sidecars as a whole", () => {
    const rulesFileContent = sampleRulesMarkdown();
    const rules = sampleRules();
    const receipt = compileBookRuleProvenance({
      bookId: "book-a",
      rulesFileContent,
      rules,
      assignments: [exactSourceAssignment("prohibitions[0]", RULE_TEXT.prohibition)],
    });

    const partial = resignReceipt({
      ...receipt,
      rules: receipt.rules.slice(0, 3),
      bookRuleEntryCount: 3,
      provenanceRuleCount: 3,
      diagnosticRuleCount: 2,
    });
    expect(BookRuleProvenanceReceiptSchema.safeParse(partial).success).toBe(true);
    const partialProjection = projectBookRules({
      bookId: "book-a",
      rulesFileContent,
      rules,
      sidecar: partial,
    });
    expect(partialProjection).toMatchObject({ status: "stale", reason: "rule-surface-changed" });
    expect(rulesForAutoAction(partialProjection)).toEqual([]);

    const duplicate = resignReceipt({
      ...receipt,
      rules: [...receipt.rules, receipt.rules[1]!],
      bookRuleEntryCount: 5,
      provenanceRuleCount: 5,
      diagnosticRuleCount: 4,
    });
    const duplicateVerification = verifyBookRuleProvenance(duplicate, {
      bookId: "book-a",
      rulesFileContent,
      rules,
    });
    expect(duplicateVerification.status).toBe("invalid");

    const firstSelector = receipt.rules[0]!.bookRulesSelector;
    const second = receipt.rules[1]!;
    const overlapSelectorPayload = {
      path: second.bookRulesSelector.path,
      coordinate: second.bookRulesSelector.coordinate,
      start: firstSelector.start,
      end: firstSelector.end,
      textSha256: second.textSha256,
    };
    const overlapSelector = {
      ...overlapSelectorPayload,
      selectorSha256: hashCanonicalJson(overlapSelectorPayload),
    };
    const overlapping = resignReceipt({
      ...receipt,
      rules: receipt.rules.map((entry, index) => index === 1
        ? {
            ...entry,
            bookRulesSelector: overlapSelector,
            bookRulesSelectorSha256: overlapSelector.selectorSha256,
          }
        : entry),
    });
    expect(BookRuleProvenanceReceiptSchema.safeParse(overlapping).success).toBe(true);
    const overlapProjection = projectBookRules({
      bookId: "book-a",
      rulesFileContent,
      rules,
      sidecar: overlapping,
    });
    expect(overlapProjection).toMatchObject({ status: "stale", reason: "rule-surface-changed" });
    expect(rulesForAutoAction(overlapProjection)).toEqual([]);
  });

  it("carries authority forward only for an exact fieldPath and exact text match", () => {
    const rulesFileContent = sampleRulesMarkdown();
    const oldRules = sampleRules();
    const oldReceipt = compileBookRuleProvenance({
      bookId: "book-a",
      rulesFileContent,
      rules: oldRules,
      assignments: [exactSourceAssignment("prohibitions[0]", RULE_TEXT.prohibition)],
    });
    const oldVerification = verifyBookRuleProvenance(oldReceipt, {
      bookId: "book-a",
      rulesFileContent,
      rules: oldRules,
    });
    expect(oldVerification.status).toBe("current");

    const appendedText = "새 모델 제안 금지";
    const appendedRules = sampleRules({
      prohibitions: [RULE_TEXT.prohibition, appendedText],
    });
    const appendedRaw = `${rulesFileContent}\n- ${appendedText}`;
    const carried = carryForwardBookRuleProvenanceEntries(oldVerification, appendedRules);
    const nextReceipt = compileBookRuleProvenance({
      bookId: "book-a",
      rulesFileContent: appendedRaw,
      rules: appendedRules,
      carriedEntries: carried,
    });
    expect(nextReceipt.rules.find((entry) => entry.fieldPath === "prohibitions[0]")).toMatchObject({
      text: RULE_TEXT.prohibition,
      strength: "hard",
      source: "user-explicit",
    });
    expect(nextReceipt.rules.find((entry) => entry.fieldPath === "prohibitions[1]")).toMatchObject({
      text: appendedText,
      strength: "diagnostic",
      source: "model-suggested",
    });

    const prependedRules = sampleRules({
      prohibitions: [appendedText, RULE_TEXT.prohibition],
    });
    const movedCarry = carryForwardBookRuleProvenanceEntries(oldVerification, prependedRules);
    expect(movedCarry.some((entry) => entry.text === RULE_TEXT.prohibition)).toBe(false);
  });

  it("treats malformed JSON as invalid without overwriting or interpreting the sidecar", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-book-rule-provenance-invalid-"));
    try {
      await mkdir(join(root, "story"), { recursive: true });
      await writeFile(join(root, BOOK_RULE_PROVENANCE_PATH), "{not-json", "utf8");
      const read = await readBookRuleProvenance(root);
      expect(read).toMatchObject({
        status: "invalid",
        rawSidecar: "{not-json",
      });
      const projection = projectBookRules({
        bookId: "book-a",
        rulesFileContent: sampleRulesMarkdown(),
        rules: sampleRules(),
        sidecar: read,
      });
      expect(projection.status).toBe("invalid");
      expect(projection.rawSidecar).toBe("{not-json");
      expect(rulesForAutoAction(projection)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resignReceipt(value: object): unknown {
  const { receiptSha256: _receiptSha256, ...payload } = value as Record<string, unknown>;
  return { ...payload, receiptSha256: hashCanonicalJson(payload) };
}

function hashCanonicalJson(value: unknown): string {
  return sha256(JSON.stringify(sortJson(value)));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}
