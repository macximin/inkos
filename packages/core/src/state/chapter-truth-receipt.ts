import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ChapterMeta } from "../models/chapter.js";
import { StateManifestSchema } from "../models/runtime-state.js";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const ChapterTruthReceiptSchema = z.object({
  version: z.literal(1),
  bookId: z.string().min(1),
  chapterNumber: z.number().int().min(1),
  createdAt: z.string().datetime(),
  chapterContentSha256: Sha256Schema,
  arcProvenanceSha256: Sha256Schema,
  stateSnapshot: z.object({
    lastAppliedChapter: z.number().int().min(1),
    projectionVersion: z.number().int().min(1),
    sha256: Sha256Schema,
  }).strict(),
}).strict();
export type ChapterTruthReceipt = z.infer<typeof ChapterTruthReceiptSchema>;

export interface VerifiedChapterTruthReceipt {
  readonly receipt: ChapterTruthReceipt;
  readonly receiptSha256: string;
}

const STORY_STATE_FILES = [
  "current_state.md",
  "particle_ledger.md",
  "pending_hooks.md",
  "chapter_summaries.md",
  "subplot_board.md",
  "emotional_arcs.md",
  "character_matrix.md",
] as const;

export function chapterTruthReceiptRelativePath(chapterNumber: number): string {
  return join(
    "story",
    "runtime",
    `chapter-${String(chapterNumber).padStart(4, "0")}.truth-receipt.json`,
  );
}

export async function writeChapterTruthReceipt(
  bookDir: string,
  bookId: string,
  chapter: ChapterMeta,
  now: () => Date = () => new Date(),
): Promise<ChapterTruthReceipt> {
  if (!chapter.arcProvenance?.storyRail) {
    throw new Error(`Chapter ${chapter.number} has no Story Rail provenance to attest.`);
  }
  const snapshotDir = join(bookDir, "story", "snapshots", String(chapter.number));
  const manifest = StateManifestSchema.parse(JSON.parse(await readFile(
    join(snapshotDir, "state", "manifest.json"),
    "utf8",
  )));
  if (manifest.lastAppliedChapter !== chapter.number) {
    throw new Error(
      `Chapter ${chapter.number} snapshot state is through chapter ${manifest.lastAppliedChapter}.`,
    );
  }
  const [chapterContentSha256, stateSnapshotSha256] = await Promise.all([
    hashChapterContent(bookDir, chapter.number),
    hashStateProjectionAt(snapshotDir),
  ]);
  const receipt = ChapterTruthReceiptSchema.parse({
    version: 1,
    bookId,
    chapterNumber: chapter.number,
    createdAt: now().toISOString(),
    chapterContentSha256,
    arcProvenanceSha256: hashCanonicalJson(chapter.arcProvenance),
    stateSnapshot: {
      lastAppliedChapter: manifest.lastAppliedChapter,
      projectionVersion: manifest.projectionVersion,
      sha256: stateSnapshotSha256,
    },
  });
  await commitAtomicFileSet({
    rootDir: bookDir,
    writes: [{
      relativePath: chapterTruthReceiptRelativePath(chapter.number),
      content: `${JSON.stringify(receipt, null, 2)}\n`,
    }],
  });
  return receipt;
}

export async function verifyChapterTruthReceipt(
  bookDir: string,
  bookId: string,
  chapter: ChapterMeta,
): Promise<VerifiedChapterTruthReceipt> {
  const path = join(bookDir, chapterTruthReceiptRelativePath(chapter.number));
  const receipt = ChapterTruthReceiptSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (receipt.bookId !== bookId || receipt.chapterNumber !== chapter.number) {
    throw new Error(`Chapter ${chapter.number} truth receipt belongs to another Book or Chapter.`);
  }
  if (!chapter.arcProvenance?.storyRail) {
    throw new Error(`Chapter ${chapter.number} no longer has Story Rail provenance.`);
  }
  const snapshotDir = join(bookDir, "story", "snapshots", String(chapter.number));
  const [chapterContentSha256, stateSnapshotSha256, manifest] = await Promise.all([
    hashChapterContent(bookDir, chapter.number),
    hashStateProjectionAt(snapshotDir),
    readFile(join(snapshotDir, "state", "manifest.json"), "utf8")
      .then((raw) => StateManifestSchema.parse(JSON.parse(raw))),
  ]);
  if (
    receipt.chapterContentSha256 !== chapterContentSha256
    || receipt.arcProvenanceSha256 !== hashCanonicalJson(chapter.arcProvenance)
    || receipt.stateSnapshot.sha256 !== stateSnapshotSha256
    || receipt.stateSnapshot.lastAppliedChapter !== chapter.number
    || manifest.lastAppliedChapter !== receipt.stateSnapshot.lastAppliedChapter
    || manifest.projectionVersion !== receipt.stateSnapshot.projectionVersion
  ) {
    throw new Error(
      `Chapter ${chapter.number} content, provenance, or state snapshot changed after truth settlement.`,
    );
  }
  return { receipt, receiptSha256: hashCanonicalJson(receipt) };
}

export async function hashLiveStoryStateProjection(bookDir: string): Promise<string> {
  return hashStateProjectionAt(join(bookDir, "story"));
}

async function hashChapterContent(bookDir: string, chapterNumber: number): Promise<string> {
  const files = await readdir(join(bookDir, "chapters"));
  const matches = files.filter((file) => {
    const match = file.match(/^(\d+)[_-]?.*\.md$/);
    return match && Number.parseInt(match[1]!, 10) === chapterNumber;
  });
  if (matches.length !== 1) {
    throw new Error(
      `Chapter ${chapterNumber} needs exactly one manuscript file for a truth receipt; found ${matches.length}.`,
    );
  }
  return sha256(await readFile(join(bookDir, "chapters", matches[0]!)));
}

async function hashStateProjectionAt(root: string): Promise<string> {
  const namedContents: Array<{ readonly name: string; readonly content: Buffer }> = [];
  for (const file of STORY_STATE_FILES) {
    try {
      namedContents.push({ name: file, content: await readFile(join(root, file)) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
    }
  }
  const stateDir = join(root, "state");
  let stateFiles: string[] = [];
  try {
    stateFiles = (await readdir(stateDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
  }
  for (const file of stateFiles) {
    namedContents.push({ name: `state/${file}`, content: await readFile(join(stateDir, file)) });
  }
  if (!namedContents.some((entry) => entry.name === "state/manifest.json")) {
    throw new Error("State projection has no state/manifest.json.");
  }
  namedContents.sort((left, right) => left.name.localeCompare(right.name));
  const hash = createHash("sha256");
  for (const entry of namedContents) {
    hash.update(entry.name);
    hash.update("\0");
    hash.update(String(entry.content.byteLength));
    hash.update("\0");
    hash.update(entry.content);
    hash.update("\0");
  }
  return hash.digest("hex");
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
