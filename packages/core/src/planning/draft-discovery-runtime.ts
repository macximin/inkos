import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { ChapterMetaSchema, type ChapterMeta } from "../models/chapter.js";
import { StoryRailStore } from "../arc/rail-store.js";
import { ArcStore } from "../arc/store.js";
import { estimateTextTokens } from "../llm/provider.js";
import {
  createDraftDiscoveryPacket, DraftDiscoverySuggestionSchema, draftDiscoveryExtractionGuidance,
  hashDraftDiscoveryPlan, loadDraftDiscoveryContext, recordDraftDiscoveryPacket, renderDraftDiscoveryWritableTargets,
  type DraftDiscoveryContext,
} from "./draft-discovery.js";

export const DraftDiscoveryObservationSchema = z.object({
  bookId: z.string().min(1), chapter: z.number().int().positive(),
  chapterTextSha256: z.string().regex(/^[a-f0-9]{64}$/), basePlanSha256: z.string().regex(/^[a-f0-9]{64}$/),
  suggestions: z.array(DraftDiscoverySuggestionSchema).min(1).max(3),
}).strict();
export type DraftDiscoveryObservation = z.infer<typeof DraftDiscoveryObservationSchema>;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** Read actual inventory; do not rebuild or invent missing metadata for optional guidance. */
export async function readDraftDiscoveryBookContext(bookDir: string, bookId: string): Promise<DraftDiscoveryContext | null> {
  const plan = await new StoryRailStore(bookDir).loadOptional(bookId);
  if (!plan) return null;
  let chapters: ChapterMeta[];
  try { chapters = z.array(ChapterMetaSchema).parse(JSON.parse(await readFile(join(bookDir, "chapters/index.json"), "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("discovery-inventory-unreadable");
    const files = await readdir(join(bookDir, "chapters")).catch(() => [] as string[]);
    if (files.some((file) => /^\d+_.*\.md$/.test(file))) throw new Error("discovery-inventory-missing");
    chapters = [];
  }
  return { bookId, plan, chapters, arcs: await new ArcStore(bookDir).list() };
}

/** Matches the established saved Chapter body convention while rejecting ambiguous files. */
export async function readDraftDiscoveryChapterText(bookDir: string, chapter: number): Promise<string> {
  if (!Number.isSafeInteger(chapter) || chapter < 1) throw new Error("discovery-invalid-chapter");
  const root = await realpath(bookDir), directory = join(root, "chapters");
  const files = (await readdir(directory)).filter((file) => file.startsWith(`${String(chapter).padStart(4, "0")}_`) && file.endsWith(".md"));
  if (files.length !== 1) throw new Error("discovery-source-missing-or-ambiguous");
  const path = await realpath(join(directory, files[0]!)), suffix = relative(root, path);
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error("discovery-source-outside-book");
  return readFile(path, "utf8");
}

export async function prepareDraftDiscoveryRequest(bookDir: string, bookId: string, language: "ko" | "en" | "zh", maxTokens?: number):
  Promise<{ rendered: string; basePlanSha256?: string; diagnostics: string[] }> {
  try {
    const context = await readDraftDiscoveryBookContext(bookDir, bookId);
    if (!context) return { rendered: "", diagnostics: [] };
    const targets = renderDraftDiscoveryWritableTargets(context);
    if (!targets) return { rendered: "", diagnostics: [] };
    const rendered = `${draftDiscoveryExtractionGuidance(language)}\n\n${targets}`;
    if (maxTokens !== undefined && estimateTextTokens(rendered) > maxTokens) return { rendered: "", diagnostics: ["discovery-request-budget"] };
    return { rendered, basePlanSha256: hashDraftDiscoveryPlan(context.plan), diagnostics: [] };
  } catch { return { rendered: "", diagnostics: ["discovery-context-unavailable"] }; }
}

/** Call after the Chapter transaction succeeds, while its surrounding Book write lock is still held. */
export async function persistDraftDiscoveryObservation(bookDir: string, input: DraftDiscoveryObservation | undefined):
  Promise<{ path?: string; diagnostics: string[] }> {
  if (!input) return { diagnostics: [] };
  const parsed = DraftDiscoveryObservationSchema.safeParse(input);
  if (!parsed.success) return { diagnostics: ["discovery-invalid-observation"] };
  try {
    const value = parsed.data;
    const context = await readDraftDiscoveryBookContext(bookDir, value.bookId);
    if (!context) return { diagnostics: ["discovery-plan-unavailable"] };
    const chapterText = await readDraftDiscoveryChapterText(bookDir, value.chapter);
    const lines = chapterText.split("\n");
    const start = lines.findIndex((line, index) => index > 0 && line.trim().length > 0);
    const body = start >= 0 ? lines.slice(start).join("\n") : chapterText;
    if (sha(body) !== value.chapterTextSha256) return { diagnostics: ["discovery-manuscript-changed-before-persistence"] };
    const packet = createDraftDiscoveryPacket({ ...context, sourceChapter: value.chapter, chapterText,
      expectedChapterTextSha256: sha(chapterText), expectedPlanSha256: value.basePlanSha256, suggestions: value.suggestions });
    const path = await recordDraftDiscoveryPacket(bookDir, packet);
    return { ...(path ? { path } : {}), diagnostics: [] };
  } catch { return { diagnostics: ["discovery-observation-no-longer-current"] }; }
}

export async function readDraftDiscoveryPlanningContext(bookDir: string, bookId: string, language: "ko" | "en" | "zh", maxTokens?: number, throughChapter?: number):
  Promise<{ rendered: string; diagnostics: string[] }> {
  try {
    const context = await readDraftDiscoveryBookContext(bookDir, bookId);
    if (!context) return { rendered: "", diagnostics: [] };
    const result = await loadDraftDiscoveryContext(bookDir, context, {
      readChapterText: (chapter) => readDraftDiscoveryChapterText(bookDir, chapter), language, throughChapter,
      // Every UTF-16 character costs at most one token under the current local estimator.
      maxCharacters: Math.min(6000, maxTokens ?? 6000),
    });
    return { rendered: result.rendered, diagnostics: result.diagnostics.map((entry) => `${entry.file}: excluded`) };
  } catch { return { rendered: "", diagnostics: ["discovery-context-unavailable"] }; }
}

export function bindDraftDiscoveryObservation(input: { bookId: string; chapter: number; content: string; basePlanSha256: string; suggestions: unknown }): DraftDiscoveryObservation | undefined {
  const parsed = DraftDiscoveryObservationSchema.safeParse({ bookId: input.bookId, chapter: input.chapter,
    chapterTextSha256: sha(input.content), basePlanSha256: input.basePlanSha256, suggestions: input.suggestions });
  return parsed.success ? parsed.data : undefined;
}
