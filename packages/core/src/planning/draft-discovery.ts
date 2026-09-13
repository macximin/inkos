import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { assertBookAdvisoryWritePaths } from "../utils/book-advisory-files.js";
import { ChapterMetaSchema, type ChapterMeta } from "../models/chapter.js";
import { ArcPacketSchema, type ArcPacket } from "../arc/schema.js";
import { StoryRailPlanSchema, StableRailIdSchema, type ArcRouteEntry, type StoryRailPlan } from "../arc/rail-schema.js";
import {
  StoryRailReflowApplyInputSchema, StoryRailReflowPendingSchema, StoryRailReflowCloseoutSchema,
  type StoryRailReflowApplyInput, type StoryRailReflowCloseout, type StoryRailReflowDecision, type StoryRailReflowPending,
} from "../arc/reflow-schema.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Text = z.string().trim().min(1).max(1600);
const Chapter = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const DURABLE = ["narrativeFunction", "payoffAxis", "carriedReaderDebt", "contrastRequirement"] as const;
const RevisionFields = z.object({ narrativeFunction: Text, payoffAxis: Text, carriedReaderDebt: Text, contrastRequirement: Text }).strict();
export const DraftDiscoveryKindSchema = z.enum(["new-desire", "relationship-response", "discovered-solution", "new-cost", "new-reader-debt", "plan-contradiction"]);

/** Optional existing-call output. It cannot edit an A, route order, binding or status. */
export const DraftDiscoverySuggestionSchema = z.object({
  kind: DraftDiscoveryKindSchema,
  evidence: z.string().min(1).max(1600).refine(value => value.trim().length > 0, "Evidence must not be blank"),
  observation: Text,
  implication: Text,
  futureRevisions: z.array(z.object({ bId: StableRailIdSchema, revision: RevisionFields }).strict()).min(1).max(3),
}).strict();
export type DraftDiscoverySuggestion = z.infer<typeof DraftDiscoverySuggestionSchema>;
const Suggestions = z.array(DraftDiscoverySuggestionSchema).max(3);

const BoundDiscovery = DraftDiscoverySuggestionSchema.extend({
  discoveryId: Hash,
  evidenceStart: z.number().int().min(0),
  evidenceEnd: z.number().int().min(1),
  coordinateKind: z.literal("utf16-code-units"),
}).strict();
export const DraftDiscoveryPacketSchema = z.object({
  schemaVersion: z.literal("draft-discovery/v1"),
  packetId: Hash,
  bookId: z.string().min(1),
  authority: z.literal("advisory-future-plan"),
  sourceChapter: Chapter,
  chapterTextSha256: Hash,
  basePlanSha256: Hash,
  basePlanUpdatedAt: z.string().datetime(),
  observedThroughChapter: Chapter,
  inventorySha256: Hash,
  discoveries: z.array(BoundDiscovery).min(1).max(3),
  changes: z.array(z.object({
    bId: StableRailIdSchema, discoveryId: Hash,
    before: RevisionFields, after: RevisionFields,
    changedFields: z.array(z.enum(DURABLE)).min(1).max(4),
  }).strict()).min(1).max(9),
  modelCallsAdded: z.literal(0),
  canonApplied: z.literal(false),
}).strict();
export type DraftDiscoveryPacket = z.infer<typeof DraftDiscoveryPacketSchema>;

/** Caller supplies the complete current Chapter and Arc inventory for this Book. */
export interface DraftDiscoveryContext {
  readonly bookId: string;
  readonly plan: StoryRailPlan;
  readonly chapters: ReadonlyArray<ChapterMeta>;
  readonly arcs: ReadonlyArray<ArcPacket>;
}
export interface DraftDiscoveryCreateInput extends DraftDiscoveryContext {
  readonly sourceChapter: number;
  readonly chapterText: string;
  readonly expectedChapterTextSha256: string;
  readonly expectedPlanSha256: string;
  readonly suggestions: unknown;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function hashDraftDiscoveryPlan(plan: StoryRailPlan): string { return sha(canonical(StoryRailPlanSchema.parse(plan))); }
function durable(entry: ArcRouteEntry) { return RevisionFields.parse(Object.fromEntries(DURABLE.map(key => [key, entry[key]]))); }
function checkedContext(context: DraftDiscoveryContext) {
  const plan = StoryRailPlanSchema.parse(context.plan);
  if (plan.bookId !== context.bookId) throw new Error("discovery-book-mismatch");
  const chapters = context.chapters.map(chapter => ChapterMetaSchema.parse(chapter));
  const arcs = context.arcs.map(arc => ArcPacketSchema.parse(arc));
  if (new Set(chapters.map(chapter => chapter.number)).size !== chapters.length || new Set(arcs.map(arc => arc.id)).size !== arcs.length) throw new Error("discovery-duplicate-inventory");
  if (arcs.some(arc => arc.bookId !== context.bookId) || chapters.some(chapter => chapter.arcProvenance && chapter.arcProvenance.bookId !== context.bookId)) throw new Error("discovery-inventory-book-mismatch");
  const active = plan.arcRouteRail.entries.find(entry => entry.status === "active");
  if (!active) throw new Error("discovery-active-b-missing");
  for (const entry of plan.arcRouteRail.entries) if (entry.arcId && !arcs.some(arc => arc.id === entry.arcId)) throw new Error("discovery-bound-arc-missing");
  const observedThroughChapter = Math.max(0, ...chapters.map(chapter => chapter.number));
  // Lifecycle status can change at approval without changing the protected
  // writing inventory. Bind only coordinates/provenance and Arc content.
  const inventorySha256 = sha(canonical({
    chapters: [...chapters].sort((a, b) => a.number - b.number).map(chapter => ({ number: chapter.number, arcProvenance: chapter.arcProvenance })),
    arcs: [...arcs].sort((a, b) => a.id < b.id ? -1 : 1),
  }));
  const future = plan.arcRouteRail.entries.filter(entry => entry.routeOrder > active.routeOrder && (entry.status === "provisional" || entry.status === "hypothesis"));
  const writable = future.filter(entry => {
    const arc = arcs.find(item => item.id === entry.arcId);
    if (arc?.status === "completed") return false;
    if (arc?.chapterNumbers.some(number => number <= observedThroughChapter)) return false;
    return !chapters.some(chapter => chapter.arcProvenance?.storyRail?.activeB.bId === entry.bId || (entry.arcId !== undefined && chapter.arcProvenance?.arcId === entry.arcId));
  });
  return { plan, chapters, arcs, active, future, writable, observedThroughChapter, inventorySha256 };
}

/** Pure projection; absent optional output returns null and requires no artifact. */
export function createDraftDiscoveryPacket(input: DraftDiscoveryCreateInput): DraftDiscoveryPacket | null {
  const suggestions = Suggestions.parse(input.suggestions);
  if (suggestions.length === 0) return null;
  const sourceChapter = Chapter.parse(input.sourceChapter);
  if (typeof input.chapterText !== "string" || input.chapterText.length > 500_000) throw new Error("discovery-manuscript-size");
  if (sha(input.chapterText) !== Hash.parse(input.expectedChapterTextSha256)) throw new Error("discovery-manuscript-drift");
  const context = checkedContext(input);
  if (!context.chapters.some(chapter => chapter.number === sourceChapter)) throw new Error("discovery-source-chapter-missing");
  const basePlanSha256 = hashDraftDiscoveryPlan(context.plan);
  if (basePlanSha256 !== Hash.parse(input.expectedPlanSha256)) throw new Error("discovery-plan-drift");
  const seenTargets = new Set<string>();
  const changes: DraftDiscoveryPacket["changes"] = [];
  const discoveries = suggestions.map(suggestion => {
    const evidenceStart = input.chapterText.indexOf(suggestion.evidence);
    if (evidenceStart < 0) throw new Error("discovery-quote-not-in-manuscript");
    if (input.chapterText.indexOf(suggestion.evidence, evidenceStart + 1) !== -1) throw new Error("discovery-quote-ambiguous");
    const discoveryId = sha(canonical({ sourceChapter, chapterTextSha256: input.expectedChapterTextSha256, suggestion }));
    for (const proposed of suggestion.futureRevisions) {
      if (seenTargets.has(proposed.bId)) throw new Error("discovery-conflicting-b-revisions");
      seenTargets.add(proposed.bId);
      const entry = context.writable.find(candidate => candidate.bId === proposed.bId);
      if (!entry) throw new Error(`discovery-protected-or-missing-b:${proposed.bId}`);
      const before = durable(entry), after = proposed.revision;
      const changedFields = DURABLE.filter(key => before[key] !== after[key]);
      if (changedFields.length === 0) throw new Error("discovery-unchanged-revision");
      changes.push({ bId: entry.bId, discoveryId, before, after, changedFields });
    }
    return { ...suggestion, discoveryId, evidenceStart, evidenceEnd: evidenceStart + suggestion.evidence.length, coordinateKind: "utf16-code-units" as const };
  });
  const packet = {
    schemaVersion: "draft-discovery/v1" as const, bookId: input.bookId, authority: "advisory-future-plan" as const,
    sourceChapter, chapterTextSha256: input.expectedChapterTextSha256, basePlanSha256, basePlanUpdatedAt: context.plan.updatedAt,
    observedThroughChapter: context.observedThroughChapter, inventorySha256: context.inventorySha256,
    discoveries, changes, modelCallsAdded: 0 as const, canonApplied: false as const,
  };
  return DraftDiscoveryPacketSchema.parse({ ...packet, packetId: sha(canonical(packet)) });
}

export function validateDraftDiscoveryPacket(packet: DraftDiscoveryPacket, context: DraftDiscoveryContext, chapterText: string): DraftDiscoveryPacket {
  const checked = DraftDiscoveryPacketSchema.parse(packet);
  const recreated = createDraftDiscoveryPacket({ ...context, sourceChapter: checked.sourceChapter, chapterText,
    expectedChapterTextSha256: checked.chapterTextSha256, expectedPlanSha256: checked.basePlanSha256,
    suggestions: checked.discoveries.map(({ discoveryId: _id, evidenceStart: _start, evidenceEnd: _end, coordinateKind: _coordinate, ...suggestion }) => suggestion),
  });
  if (!recreated || canonical(recreated) !== canonical(checked)) throw new Error("discovery-packet-or-inventory-drift");
  return checked;
}

/** Existing reflow consumes these decisions; this function does not apply them. */
export function projectDraftDiscoveryReflowDecisions(packet: DraftDiscoveryPacket, context: DraftDiscoveryContext, chapterText: string): StoryRailReflowDecision[] {
  const checked = validateDraftDiscoveryPacket(packet, context, chapterText);
  const { future } = checkedContext(context);
  return future.map(entry => {
    const change = checked.changes.find(item => item.bId === entry.bId);
    return change ? { bId: entry.bId, action: "revise", revision: { routeOrder: entry.routeOrder, targetAnchorId: entry.targetAnchorId, ...change.after } }
      : { bId: entry.bId, action: "keep" };
  });
}

/** Explicit caller-owned closeout choices remain mandatory. No approval inferred. */
export function buildDraftDiscoveryReflowInput(input: {
  readonly packet: DraftDiscoveryPacket; readonly context: DraftDiscoveryContext; readonly chapterText: string;
  readonly pending: StoryRailReflowPending; readonly closeout: StoryRailReflowCloseout;
  readonly nextActiveBId: string; readonly nextProvisionalBId?: string;
}): StoryRailReflowApplyInput {
  const pending = StoryRailReflowPendingSchema.parse(input.pending);
  if (pending.bookId !== input.context.bookId || pending.expectedPlanUpdatedAt !== input.packet.basePlanUpdatedAt) throw new Error("discovery-reflow-pending-mismatch");
  const source = pending.approvedChapters.find(chapter => chapter.number === input.packet.sourceChapter);
  if (!source || source.chapterContentSha256 !== input.packet.chapterTextSha256) throw new Error("discovery-reflow-source-not-attested");
  return StoryRailReflowApplyInputSchema.parse({ pendingId: pending.pendingId, expectedPlanUpdatedAt: pending.expectedPlanUpdatedAt,
    closeout: StoryRailReflowCloseoutSchema.parse(input.closeout), nextActiveBId: input.nextActiveBId,
    ...(input.nextProvisionalBId ? { nextProvisionalBId: input.nextProvisionalBId } : {}),
    decisions: projectDraftDiscoveryReflowDecisions(input.packet, input.context, input.chapterText), newEntries: [],
  });
}

export function parseDraftDiscoverySuggestions(content: string): { status: "absent" | "valid" | "invalid"; suggestions: DraftDiscoverySuggestion[]; diagnostics: string[] } {
  const headings = [...content.matchAll(/^=== DRAFT_DISCOVERIES ===\s*$/gm)];
  if (!headings.length) return { status: "absent", suggestions: [], diagnostics: [] };
  if (headings.length !== 1) return { status: "invalid", suggestions: [], diagnostics: ["duplicate-discovery-section"] };
  const start = headings[0]!.index! + headings[0]![0].length;
  let block = content.slice(start).split(/^=== [A-Z_]+ ===\s*$/m)[0]!.trim();
  if (block.length > 64_000) return { status: "invalid", suggestions: [], diagnostics: ["discovery-section-too-large"] };
  block = block.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1");
  try { return { status: "valid", suggestions: Suggestions.parse(JSON.parse(block)), diagnostics: [] }; }
  catch { return { status: "invalid", suggestions: [], diagnostics: ["invalid-discovery-json"] }; }
}

/** No sidecar is created for legacy/empty output. Record caller-validated packets. */
export async function recordDraftDiscoveryPacket(bookDir: string, packet: DraftDiscoveryPacket | null): Promise<string | null> {
  if (packet === null) return null;
  const checked = DraftDiscoveryPacketSchema.parse(packet);
  const { packetId, ...content } = checked;
  if (sha(canonical(content)) !== packetId) throw new Error("discovery-packet-hash-mismatch");
  const directory = join(bookDir, "story", "runtime", "draft-discoveries");
  await assertBookAdvisoryWritePaths(bookDir, [`story/runtime/draft-discoveries/${checked.sourceChapter}-${packetId}.json`]);
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${checked.sourceChapter}-${packetId}.json`);
  const raw = JSON.stringify(checked, null, 2) + "\n";
  try { await writeFile(file, raw, { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await readFile(file, "utf8") !== raw) throw new Error("discovery-sidecar-conflict");
  }
  return file;
}

export function renderDraftDiscoveryContext(packet: DraftDiscoveryPacket, language: "ko" | "en" | "zh" = "ko"): string {
  const checked = DraftDiscoveryPacketSchema.parse(packet);
  const title = language === "ko" ? "초고에서 발견한 미래 계획 후보" : language === "zh" ? "草稿产生的未来计划候选" : "Future plan candidates discovered in the draft";
  const boundary = language === "ko" ? "아직 일어난 사건이나 확정 계획이 아닙니다. 인용은 관찰 근거이고 제안의 옳음을 보증하지 않습니다. 기존 A, 완료/진행 B, 이미 쓴 화를 바꾸지 말고 미래 선택을 검토할 때만 사용하세요."
    : language === "zh" ? "这些不是已经发生的事件或获批计划。引文仅是观察依据，不保证建议正确。保留A轨、已完成/活动B轨和已写章节，仅用于未来选择。"
      : "These are advisory proposals, not occurred events or approved plans. A quote grounds an observation, not the correctness of its recommendation. Preserve every A, completed/active B and written chapter; use only for future choices.";
  return `## ${title}\n${boundary}\nSource chapter: ${checked.sourceChapter}; manuscript SHA-256: ${checked.chapterTextSha256}; plan SHA-256: ${checked.basePlanSha256}\n`
    + checked.discoveries.map(discovery => `\n[${discovery.kind}] ${discovery.observation}\nQuote (${discovery.evidenceStart}:${discovery.evidenceEnd} UTF-16): ${JSON.stringify(discovery.evidence)}\nImplication: ${discovery.implication}\n`
      + checked.changes.filter(change => change.discoveryId === discovery.discoveryId).map(change => `Future ${change.bId}:\n${change.changedFields.map(key => `- ${key}: ${JSON.stringify(change.before[key])} → ${JSON.stringify(change.after[key])}`).join("\n")}`).join("\n")).join("\n");
}

export async function loadDraftDiscoveryContext(bookDir: string, context: DraftDiscoveryContext, options: {
  readonly readChapterText: (chapterNumber: number) => Promise<string>;
  readonly maxCharacters?: number; readonly maxPackets?: number; readonly language?: "ko" | "en" | "zh";
  readonly throughChapter?: number;
}): Promise<{ rendered: string; packets: DraftDiscoveryPacket[]; diagnostics: Array<{ file: string; reason: string }> }> {
  const maxCharacters = options.maxCharacters ?? 6000, maxPackets = options.maxPackets ?? 2;
  if (options.throughChapter !== undefined && (!Number.isSafeInteger(options.throughChapter) || options.throughChapter < 0)) throw new Error("Invalid discovery chapter cutoff");
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 0 || maxCharacters > 24000 || !Number.isSafeInteger(maxPackets) || maxPackets < 0 || maxPackets > 6) throw new Error("Invalid discovery context budget");
  const directory = join(bookDir, "story", "runtime", "draft-discoveries");
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rendered: "", packets: [], diagnostics: [] }; throw error; }
  const diagnostics: Array<{ file: string; reason: string }> = [], packets: DraftDiscoveryPacket[] = [];
  const blocks: string[] = []; let used = 0;
  const targets = names.filter(name => /^\d+-[a-f0-9]{64}\.json$/.test(name)).sort((a, b) => Number(b.split("-")[0]) - Number(a.split("-")[0]) || (a < b ? -1 : 1));
  for (const name of targets) {
    if (options.throughChapter !== undefined && Number(name.split("-")[0]) > options.throughChapter) { diagnostics.push({ file: name, reason: "discovery-future-chapter" }); continue; }
    try {
      const file = join(directory, name), stat = await lstat(file);
      if (!stat.isFile() || stat.size > 256_000) throw new Error("discovery-invalid-sidecar-file");
      const packet = DraftDiscoveryPacketSchema.parse(JSON.parse(await readFile(file, "utf8")));
      if (name !== `${packet.sourceChapter}-${packet.packetId}.json`) throw new Error("discovery-sidecar-filename-mismatch");
      validateDraftDiscoveryPacket(packet, context, await options.readChapterText(packet.sourceChapter));
      const block = renderDraftDiscoveryContext(packet, options.language);
      if (packets.length >= maxPackets || used + block.length + (blocks.length ? 2 : 0) > maxCharacters) { diagnostics.push({ file: name, reason: "discovery-context-budget" }); continue; }
      packets.push(packet); blocks.push(block); used += block.length + (blocks.length > 1 ? 2 : 0);
    } catch (error) { diagnostics.push({ file: name, reason: error instanceof Error ? error.message : "discovery-unreadable" }); }
  }
  return { rendered: blocks.join("\n\n"), packets, diagnostics };
}

export function draftDiscoveryExtractionGuidance(language: "ko" | "en" | "zh" = "ko"): string {
  if (language === "ko") return `## 초고에서 발견한 변화(선택)\n실제 본문 때문에 제공된 미래 B의 방향을 바꿀 이유가 생겼을 때만 마지막에 === DRAFT_DISCOVERIES ===와 JSON 배열을 추가하세요. 없으면 생략하거나 []를 쓰세요. 새 모델 호출이나 검토 요청은 필요 없습니다. 각 항목은 kind(new-desire/relationship-response/discovered-solution/new-cost/new-reader-debt/plan-contradiction), evidence(본문의 고유한 정확 인용), observation(실제 발견), implication(미래 선택에 주는 의미), futureRevisions([{bId, revision:{narrativeFunction,payoffAxis,carriedReaderDebt,contrastRequirement}}])입니다. 최대 3항목, 항목당 미래 B 최대 3개. 제공된 수정 가능 B만 제안하고 ID를 만들지 마세요. A·진행/완료 B·이미 쓴 화를 고치거나 routeOrder/targetAnchorId/status/arcId를 출력하지 마세요. 미래 제안은 정본 사실이 아닙니다. 항목을 채우려고 새 욕망·갈등을 만들어내지 마세요.`;
  return `Optional draft discovery: only if the actual manuscript gives a concrete reason to reconsider a supplied writable future B, append === DRAFT_DISCOVERIES === and a JSON array (otherwise omit or []). At most 3 items, each with kind (new-desire/relationship-response/discovered-solution/new-cost/new-reader-debt/plan-contradiction), evidence (unique exact manuscript quote), observation, implication, futureRevisions:[{bId,revision:{narrativeFunction,payoffAxis,carriedReaderDebt,contrastRequirement}}] (at most 3 revisions). Use only supplied writable B ids. Never modify A, active/completed B or written chapters. Do not output routeOrder, targetAnchorId, status or arcId. Proposals are not facts. Do not invent discoveries to fill the field. No extra model call or review request is required. ${language === "zh" ? "请用自然中文写观察与建议。" : ""}`;
}

export function renderDraftDiscoveryWritableTargets(context: DraftDiscoveryContext, options: { readonly maxEntries?: number; readonly maxCharacters?: number } = {}): string {
  const { writable } = checkedContext(context);
  if (!writable.length) return "";
  const maxEntries = options.maxEntries ?? 3, maxCharacters = options.maxCharacters ?? 4000;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || maxEntries > 9 || !Number.isSafeInteger(maxCharacters) || maxCharacters < 0 || maxCharacters > 24000) throw new Error("Invalid discovery target budget");
  const header = "Writable future B directions (advisory proposals only):\n";
  const lines: string[] = []; let used = header.length;
  for (const entry of writable) {
    if (lines.length >= maxEntries) break;
    const line = JSON.stringify({ bId: entry.bId, ...durable(entry) });
    if (used + line.length + (lines.length ? 1 : 0) > maxCharacters) continue;
    used += line.length + (lines.length ? 1 : 0); lines.push(line);
  }
  return lines.length ? header + lines.join("\n") : "";
}
