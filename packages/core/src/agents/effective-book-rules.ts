import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { BookConfigSchema } from "../models/book.js";
import { BookRulesSchema, type BookRules, type ParsedBookRules } from "../models/book-rules.js";
import {
  readBookRuleProjection,
  projectBookRules,
  rulesForAutoAction,
  type BookRuleProjection,
  type BookRuleProvenanceEntry,
} from "../models/book-rule-provenance.js";
import type { RuleStack, VerifiedBookRuleRef } from "../models/input-governance.js";
import { readBookRules } from "./rules-reader.js";

export interface EffectiveBookRules {
  /** Raw/display-compatible parser result. Never pass its body to a model. */
  readonly raw: ParsedBookRules;
  readonly projection: BookRuleProjection;
  /**
   * Runtime rules with enforcement-sensitive arrays reduced to verified hard
   * entries. `protagonist.personalityLock` remains an advisory canon fact and
   * must never be interpreted as a hard/revision rule without a ruleRef.
   */
  readonly automatic: BookRules;
  /** Compact, provenance-labelled guidance. Diagnostic/raw prose is excluded. */
  readonly guidance: string;
  readonly hardEntries: ReadonlyArray<BookRuleProvenanceEntry>;
  readonly ruleRefs: ReadonlyArray<VerifiedBookRuleRef>;
}

/**
 * Caller-provided rule refs carry only a self-hash. Intersect them with the
 * host-derived provenance projection before any agent treats them as hard Book
 * authority or renders them into a model prompt.
 */
export function projectRuleStackToVerifiedBookRules(
  ruleStack: RuleStack | undefined,
  effectiveRules: Pick<EffectiveBookRules, "ruleRefs"> | null | undefined,
): RuleStack | undefined {
  if (!ruleStack) return undefined;
  const verifiedById = new Map(
    (effectiveRules?.ruleRefs ?? []).map((ref) => [ref.ruleId, ref] as const),
  );
  const ruleRefs = (ruleStack.ruleRefs ?? []).filter((candidate) => {
    const verified = verifiedById.get(candidate.ruleId);
    return verified !== undefined
      && candidate.strength === verified.strength
      && candidate.kind === verified.kind
      && candidate.text === verified.text
      && candidate.textSha256 === verified.textSha256;
  });
  return { ...ruleStack, ruleRefs };
}

/**
 * Reads the legacy-compatible BookRules surface and then applies the host-owned
 * provenance sidecar. Missing, stale, malformed, or unverifiable sidecars keep
 * raw display intact while yielding zero automatically enforceable rules.
 */
export async function readEffectiveBookRules(
  bookDir: string,
  explicitBookId?: string,
): Promise<EffectiveBookRules | null> {
  const raw = await readBookRules(bookDir);
  if (!raw) return null;
  const bookId = explicitBookId ?? await readBookId(bookDir);
  const projection = await readBookRuleProjection({
    bookDir,
    bookId,
    rules: raw.rules,
  }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
    // Pre-sidecar legacy Books may have rules only in story_frame frontmatter.
    // They remain readable, but no legacy bytes gain automatic authority.
    return projectBookRules({
      bookId,
      rulesFileContent: "",
      rules: raw.rules,
    });
  });
  const hardEntries = rulesForAutoAction(projection);
  const hardByPath = new Map(hardEntries.map((entry) => [entry.fieldPath, entry.text]));
  const automatic = projectAutomaticRules(raw.rules, hardByPath);
  const softEntries = projection.status === "current"
    ? projection.rules.flatMap((rule) => (
        rule.effectiveStrength === "soft" && rule.provenance ? [rule.provenance] : []
      ))
    : [];
  const guidance = [
    ...hardEntries.map((entry) => `- [hard:${entry.ruleId}] ${entry.text}`),
    ...softEntries.map((entry) => `- [soft:${entry.ruleId}] ${entry.text}`),
  ].join("\n");
  return {
    raw,
    projection,
    automatic,
    guidance,
    hardEntries,
    ruleRefs: hardEntries.map((entry) => ({
      ruleId: entry.ruleId,
      strength: "hard",
      kind: entry.kind,
      text: entry.text,
      textSha256: entry.textSha256,
    })),
  };
}

function projectAutomaticRules(
  raw: BookRules,
  hardByPath: ReadonlyMap<string, string>,
): BookRules {
  const select = (collection: string, values: ReadonlyArray<string>): string[] => (
    values.flatMap((_value, index) => {
      const authorized = hardByPath.get(`${collection}[${index}]`);
      return authorized === undefined ? [] : [authorized];
    })
  );
  return BookRulesSchema.parse({
    ...raw,
    protagonist: raw.protagonist
      ? {
          ...raw.protagonist,
          behavioralConstraints: select(
            "protagonist.behavioralConstraints",
            raw.protagonist.behavioralConstraints,
          ),
        }
      : undefined,
    genreLock: raw.genreLock
      ? {
          ...raw.genreLock,
          forbidden: select("genreLock.forbidden", raw.genreLock.forbidden),
        }
      : undefined,
    prohibitions: select("prohibitions", raw.prohibitions),
    futureAdvantage: raw.futureAdvantage
      ? {
          ...raw.futureAdvantage,
          forbiddenShortcuts: select(
            "futureAdvantage.forbiddenShortcuts",
            raw.futureAdvantage.forbiddenShortcuts,
          ),
        }
      : undefined,
    // Free-form model-generated dimensions cannot become host audit gates.
    additionalAuditDimensions: [],
  });
}

async function readBookId(bookDir: string): Promise<string> {
  try {
    const config = BookConfigSchema.pick({ id: true }).parse(JSON.parse(
      await readFile(join(bookDir, "book.json"), "utf8"),
    ));
    return config.id;
  } catch {
    const fallback = basename(bookDir).trim();
    if (!fallback) throw new Error(`Cannot resolve Book id for ${bookDir}`);
    return fallback;
  }
}
