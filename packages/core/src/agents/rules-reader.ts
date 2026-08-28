import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GenreProfileReadReceiptSchema,
  parseGenreProfile,
  type ParsedGenreProfile,
  type ResolvedGenreProfile,
} from "../models/genre-profile.js";
import { parseBookRules, tryParseBookRulesFrontmatter, type ParsedBookRules } from "../models/book-rules.js";
import { BookConfigSchema } from "../models/book.js";

const BUILTIN_GENRES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../genres");

const KOREAN_GENRE_ALIASES: Readonly<Record<string, string>> = {
  "재벌물": "chaebol-modern-fantasy-ko",
  "한국 재벌물": "chaebol-modern-fantasy-ko",
  "현대판타지 재벌물": "chaebol-modern-fantasy-ko",
  "현대 판타지 재벌물": "chaebol-modern-fantasy-ko",
  "현대판타지 기업물": "chaebol-modern-fantasy-ko",
  "현대 판타지 기업물": "chaebol-modern-fantasy-ko",
  "현대판타지": "modern-fantasy-ko",
  "현대 판타지": "modern-fantasy-ko",
  "현판": "modern-fantasy-ko",
  "한국 현대판타지": "modern-fantasy-ko",
  "판타지": "fantasy-ko",
  "정통 판타지": "fantasy-ko",
  "한국 판타지": "fantasy-ko",
  "무협": "murim-ko",
  "무협물": "murim-ko",
  "정통 무협": "murim-ko",
  "한국 무협": "murim-ko",
};

function hasHangul(value: string): boolean {
  return /[\u3131-\u318e\uac00-\ud7a3]/.test(value);
}

function isSafeGenreFileId(value: string): boolean {
  return value.length > 0
    && value.length <= 240
    && value !== "."
    && value !== ".."
    && !/[\\/\0]/u.test(value);
}

function resolveGenreProfileIds(genreId: string): ReadonlyArray<string> {
  const requested = genreId.trim();
  const alias = KOREAN_GENRE_ALIASES[requested];
  const candidates = isSafeGenreFileId(requested) ? [requested] : [];
  if (alias && alias !== requested) candidates.push(alias);
  if ((alias || hasHangul(requested)) && !candidates.includes("other-ko")) {
    candidates.push("other-ko");
  }
  if (!candidates.includes("other")) candidates.push("other");
  return candidates;
}

async function tryReadFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function tryReadGenreFile(path: string): Promise<Buffer | null> {
  try {
    const parent = await lstat(dirname(path));
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      throw new Error(`Genre profile parent must be a real directory: ${dirname(path)}`);
    }
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Genre profile must be a real regular file: ${path}`);
    }
    return readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function decodeGenreProfile(bytes: Buffer, path: string): string {
  if (bytes.includes(0)) throw new Error(`Genre profile contains NUL bytes: ${path}`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`Genre profile is not valid UTF-8: ${path}`, { cause: error });
  }
}

/**
 * Load genre profile. Lookup order:
 * 1. Exact project/built-in profile
 * 2. Known Korean genre alias
 * 3. Korean generic fallback for an unknown Hangul genre
 * 4. Built-in other.md
 */
export async function readGenreProfile(
  projectRoot: string,
  genreId: string,
): Promise<ParsedGenreProfile> {
  const resolved = await readGenreProfileWithReceipt(projectRoot, genreId);
  return { profile: resolved.profile, body: resolved.body };
}

export async function readGenreProfileWithReceipt(
  projectRoot: string,
  genreId: string,
): Promise<ResolvedGenreProfile> {
  for (const candidateId of resolveGenreProfileIds(genreId)) {
    if (!isSafeGenreFileId(candidateId)) continue;
    const candidates = [
      { source: "project" as const, path: join(projectRoot, "genres", `${candidateId}.md`), profilePath: `genres/${candidateId}.md` },
      { source: "builtin" as const, path: join(BUILTIN_GENRES_DIR, `${candidateId}.md`), profilePath: `builtin-genres/${candidateId}.md` },
    ];
    for (const candidate of candidates) {
      const bytes = await tryReadGenreFile(candidate.path);
      if (!bytes) continue;
      const parsed = parseGenreProfile(decodeGenreProfile(bytes, candidate.path));
      if (parsed.profile.id !== candidateId) {
        throw new Error(`Genre profile ID drift: requested file ${candidateId}, parsed ${parsed.profile.id}`);
      }
      return {
        ...parsed,
        receipt: GenreProfileReadReceiptSchema.parse({
          schemaVersion: "genre-profile-read-receipt/v1",
          requestedGenre: genreId,
          resolvedProfileId: candidateId,
          source: candidate.source,
          profilePath: candidate.profilePath,
          profileSha256: createHash("sha256").update(bytes).digest("hex"),
          profileSizeBytes: bytes.byteLength,
          language: parsed.profile.language,
        }),
      };
    }
  }
  throw new Error(`Genre profile not found for "${genreId}" and fallback "other.md" is missing`);
}

/**
 * List all available genre profiles (project-level + built-in, deduped).
 * Returns array of { id, name, source }.
 */
export async function listAvailableGenres(
  projectRoot: string,
): Promise<ReadonlyArray<{ readonly id: string; readonly name: string; readonly source: "project" | "builtin" }>> {
  const results = new Map<string, { id: string; name: string; source: "project" | "builtin" }>();

  // Built-in genres first
  try {
    const builtinFiles = await readdir(BUILTIN_GENRES_DIR);
    for (const file of builtinFiles) {
      if (!file.endsWith(".md")) continue;
      const id = file.replace(/\.md$/, "");
      const raw = await tryReadFile(join(BUILTIN_GENRES_DIR, file));
      if (!raw) continue;
      const parsed = parseGenreProfile(raw);
      results.set(id, { id, name: parsed.profile.name, source: "builtin" });
    }
  } catch { /* no builtin dir */ }

  // Project-level genres override
  const projectDir = join(projectRoot, "genres");
  try {
    const projectFiles = await readdir(projectDir);
    for (const file of projectFiles) {
      if (!file.endsWith(".md")) continue;
      const id = file.replace(/\.md$/, "");
      const raw = await tryReadFile(join(projectDir, file));
      if (!raw) continue;
      const parsed = parseGenreProfile(raw);
      results.set(id, { id, name: parsed.profile.name, source: "project" });
    }
  } catch { /* no project genres dir */ }

  return [...results.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Return the path to the built-in genres directory. */
export function getBuiltinGenresDir(): string {
  return BUILTIN_GENRES_DIR;
}

/**
 * Load structured book rules.
 *
 * New books keep the authoritative rules in story/book_rules.md as ordinary
 * Markdown; parseBookRules() extracts the small structured surface the runtime
 * needs and preserves the Markdown as body. Older Phase 5 books may still have
 * YAML frontmatter on outline/story_frame.md with book_rules.md as a shim; that
 * path is legacy fallback only.
 */
export async function readBookRules(bookDir: string): Promise<ParsedBookRules | null> {
  const rulesRaw = await tryReadFile(join(bookDir, "story/book_rules.md"));
  if (rulesRaw) {
    const parsed = parseBookRules(rulesRaw);
    if (parsed) return parsed;
  }

  const storyFrameRaw = await tryReadFile(join(bookDir, "story/outline/story_frame.md"));
  if (storyFrameRaw) {
    // Extract just the leading `---\n...\n---` block. Anything after it is
    // outline prose and must NOT leak into ParsedBookRules.body.
    const frontmatterMatch = storyFrameRaw.match(/^\s*(---\s*\n[\s\S]*?\n---\s*)(?:\n|$)/);
    if (frontmatterMatch) {
      // Phase 5 hotfix 3: use the strict parser so a broken YAML block does
      // NOT silently zero out protagonist / prohibitions / genreLock. If the
      // frontmatter is malformed we log and fall through to legacy.
      const parsed = tryParseBookRulesFrontmatter(frontmatterMatch[1], (err) => {
        // eslint-disable-next-line no-console
        console.warn(
          `[rules-reader] story_frame.md frontmatter is malformed at ${bookDir}/story/outline/story_frame.md — falling back to legacy book_rules.md. Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      if (parsed) return parsed;
      // fall through to legacy fallback below
    }
  }

  if (rulesRaw) {
    // eslint-disable-next-line no-console
    console.warn(
      `[rules-reader] book_rules.md at ${bookDir}/story/book_rules.md is a compat shim and no legacy story_frame frontmatter was parseable — returning null instead of silently zeroing out rules.`,
    );
  }
  return null;
}

export async function readBookLanguage(bookDir: string): Promise<"zh" | "ko" | "en" | undefined> {
  const raw = await tryReadFile(join(bookDir, "book.json"));
  if (!raw) return undefined;

  try {
    const parsed = BookConfigSchema.pick({ language: true }).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.language : undefined;
  } catch {
    return undefined;
  }
}
