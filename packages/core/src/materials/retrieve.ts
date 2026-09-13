import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { safeChildPath } from "../utils/path-safety.js";
import { toPosixPath } from "../utils/posix-path.js";
import type { MaterialAsset, MaterialPurpose } from "./ingest.js";
import { extractKoreanQueryTerms, stripKoreanQueryExclusions } from "../utils/korean-query.js";

export interface RetrieveMaterialsInput {
  readonly query: string;
  readonly purpose?: MaterialPurpose;
  readonly limit?: number;
}

export interface RetrievedMaterial {
  readonly id: string;
  readonly title: string;
  readonly kind: MaterialAsset["kind"];
  readonly purpose: MaterialPurpose;
  readonly source: string;
  readonly markdownPath: string;
  readonly score: number;
  readonly excerpt: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly coordinateKind: "utf16-code-units";
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly markdownSha256: string;
  readonly excerptSha256: string;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 12;
const SNIPPET_RADIUS = 700;

export async function retrieveMaterials(
  projectRoot: string,
  input: RetrieveMaterialsInput,
): Promise<RetrievedMaterial[]> {
  const queryTerms = extractTerms(input.query);
  if (input.query.trim() && !stripKoreanQueryExclusions(input.query).trim()) return [];
  const assets = await listMaterialAssets(projectRoot);
  const results: RetrievedMaterial[] = [];
  for (const asset of assets) {
    if (input.purpose && asset.purpose !== input.purpose) continue;
    let markdown = "";
    try {
      const markdownPath = safeChildPath(projectRoot, toPosixPath(asset.markdownPath));
      markdown = await readFile(markdownPath, "utf-8");
    } catch {
      continue;
    }
    const score = scoreMaterial(asset, markdown, queryTerms);
    if (queryTerms.length > 0 && score <= 0) continue;
    const snippet = buildSnippet(markdown, queryTerms);
    results.push({
      id: asset.id,
      title: asset.title,
      kind: asset.kind,
      purpose: asset.purpose,
      source: asset.source,
      // Manifests written by older Windows builds may contain "\" separators.
      markdownPath: toPosixPath(asset.markdownPath),
      score,
      excerpt: snippet.excerpt,
      charStart: snippet.charStart,
      charEnd: snippet.charEnd,
      coordinateKind: "utf16-code-units",
      byteStart: Buffer.byteLength(markdown.slice(0, snippet.charStart), "utf8"),
      byteEnd: Buffer.byteLength(markdown.slice(0, snippet.charEnd), "utf8"),
      markdownSha256: createHash("sha256").update(markdown).digest("hex"),
      excerptSha256: createHash("sha256").update(snippet.excerpt).digest("hex"),
    });
  }
  return results
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, normalizeLimit(input.limit));
}

async function listMaterialAssets(projectRoot: string): Promise<MaterialAsset[]> {
  const materialsDir = join(projectRoot, ".inkos", "materials");
  let entries: string[] = [];
  try {
    entries = await readdir(materialsDir);
  } catch {
    return [];
  }
  const assets: MaterialAsset[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(materialsDir, entry), "utf-8");
      const asset = JSON.parse(raw) as MaterialAsset;
      if (asset && [asset.id, asset.markdownPath, asset.title, asset.source].every((value) => typeof value === "string" && value.trim())
        && ["webpage", "pdf", "text"].includes(asset.kind)
        && ["reference", "worldbuilding", "script", "storyboard", "research", "general"].includes(asset.purpose)) assets.push(asset);
    } catch {
      // Ignore corrupt stale manifests; retrieval should not break the chat turn.
    }
  }
  return assets;
}

function scoreMaterial(asset: MaterialAsset, markdown: string, terms: readonly string[]): number {
  if (terms.length === 0) return 1;
  const title = asset.title.toLowerCase();
  const source = asset.source.toLowerCase();
  const body = markdown.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const normalized = term.toLowerCase();
    if (title.includes(normalized)) score += 8;
    if (source.includes(normalized)) score += 4;
    const first = body.indexOf(normalized);
    if (first >= 0) score += 2 + Math.max(0, 2 - first / 4000);
  }
  return score;
}

function buildSnippet(markdown: string, terms: readonly string[]): { excerpt: string; charStart: number; charEnd: number } {
  // Choose the passage covering the most distinct query terms. The first title
  // mention can be thousands of characters away from the useful scene evidence.
  const hits: Array<{ index: number; term: number }> = [];
  for (const [termIndex, term] of terms.entries()) {
    const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
    let count = 0;
    for (const match of markdown.matchAll(pattern)) {
      hits.push({ index: match.index, term: termIndex });
      if (++count >= 32 || hits.length >= 512) break;
    }
    if (hits.length >= 512) break;
  }
  hits.sort((a, b) => a.index - b.index || a.term - b.term);
  let center = hits[0]?.index ?? Math.min(markdown.length, 500);
  let best = -1;
  for (const hit of hits) {
    const nearby = hits.filter((item) => Math.abs(item.index - hit.index) < SNIPPET_RADIUS);
    const distinct = new Set(nearby.map((item) => item.term)).size;
    const score = distinct * 100 + Math.min(nearby.length, distinct * 2);
    if (score > best) { best = score; center = hit.index; }
  }
  let charStart = Math.max(0, center - SNIPPET_RADIUS);
  let charEnd = Math.min(markdown.length, center + SNIPPET_RADIUS);
  // Keep surrogate pairs intact, then adjust offsets to the actual trimmed slice.
  if (charStart > 0 && /[\uDC00-\uDFFF]/.test(markdown[charStart] ?? "") && /[\uD800-\uDBFF]/.test(markdown[charStart - 1] ?? "")) charStart--;
  if (charEnd < markdown.length && /[\uD800-\uDBFF]/.test(markdown[charEnd - 1] ?? "") && /[\uDC00-\uDFFF]/.test(markdown[charEnd] ?? "")) charEnd++;
  const raw = markdown.slice(charStart, charEnd);
  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  charStart += leading;
  charEnd = Math.max(charStart, charEnd - trailing);
  return {
    excerpt: markdown.slice(charStart, charEnd),
    charStart,
    charEnd,
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit ?? DEFAULT_LIMIT)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit ?? DEFAULT_LIMIT)));
}

function extractTerms(query: string): string[] {
  const raw = stripKoreanQueryExclusions(query).normalize("NFKC").trim().toLowerCase();
  if (!raw) return [];
  const terms = new Set<string>();
  for (const term of extractKoreanQueryTerms(raw)) terms.add(term);
  for (const match of raw.matchAll(/[\p{L}\p{N}]{2,}/gu)) {
    terms.add(match[0]);
  }
  return [...terms].slice(0, 24);
}
