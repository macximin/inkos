import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ForecastBranch, ForecastModelBranch, NarrativeForecast } from "../../forecast/schema.js";
import type { FutureAdvantageMove } from "../../arc/schema.js";

export function makeFutureAdvantageMove(
  overrides: Partial<FutureAdvantageMove> = {},
): FutureAdvantageMove {
  return {
    moveId: "FA-001",
    mode: "recruit",
    domain: "인재",
    target: "훗날 반도체 수율을 뒤집는 공정 엔지니어",
    rememberedOutcome: "2007년에 양산 수율의 병목을 해결한다",
    baselineQuestions: ["1997년 현재 어느 연구소에서 일하는가"],
    researchClaimIds: [],
    authorizedDivergences: ["1997년에 공정 장비 투자를 앞당긴다"],
    bridgeSteps: ["부도 위기 연구소의 장비를 인수한다", "실패 책임을 대신 진다"],
    resistance: ["현재 실적만 보는 그룹 임원들이 영입을 반대한다"],
    proof: "폐기 직전 웨이퍼의 수율이 실제로 오른다",
    reward: "경쟁 그룹보다 먼저 핵심 생산 라인을 확보한다",
    downstreamConsequences: ["반도체 투자 시계가 빨라져 미래 기억의 세부가 어긋난다"],
    memoryRisk: "경쟁사의 조기 대응으로 기억한 투자 순서가 어긋난다",
    ...overrides,
  };
}

export function makeForecastBranch(overrides: Partial<ForecastBranch> = {}): ForecastBranch {
  return {
    branchId: "branch-1",
    title: "主角接受提议",
    premise: "假设主角在第13章接受了对手的合作提议。",
    beats: [
      { chapter: 13, summary: "主角签下合作协议，盟友震怒离场。" },
      { chapter: 14, summary: "合作暴露主角软肋，对手开始渗透。" },
    ],
    characterDecisions: [
      { character: "主角", decision: "接受提议换取短期资源" },
    ],
    projectedChanges: {
      characters: ["主角信誉受损"],
      relationships: ["主角与盟友决裂"],
      world: ["东城势力平衡向对手倾斜"],
      hooks: ["hook-03 提前引爆"],
    },
    risks: [
      { kind: "character", description: "主角人设锁强调不妥协，接受提议需要强动机铺垫。" },
    ],
    uncertainties: ["盟友是否会立即反目尚不确定"],
    intentAlignment: { score: 62, rationale: "偏离作者意图中的复仇主线，但制造了新张力。" },
    ...overrides,
  };
}

export function makeModelBranch(overrides: Partial<ForecastBranch> = {}): ForecastModelBranch {
  const { branchId: _branchId, ...rest } = makeForecastBranch(overrides);
  return rest;
}

/** Minimal canonical book on disk for forecast runner tests. */
export async function writeForecastFixtureBook(bookDir: string): Promise<void> {
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await mkdir(join(bookDir, "story", "state"), { recursive: true });
  await mkdir(join(bookDir, "story", "outline"), { recursive: true });

  await writeFile(join(bookDir, "book.json"), JSON.stringify({ id: "demo-book", title: "示例书", language: "zh" }), "utf-8");
  await writeFile(join(bookDir, "chapters", "0001_开局.md"), "第一章正文", "utf-8");
  await writeFile(join(bookDir, "chapters", "0002_升级.md"), "第二章正文", "utf-8");
  await writeFile(join(bookDir, "story", "state", "current_state.json"), JSON.stringify({ facts: ["主角在东城"] }), "utf-8");
  await writeFile(join(bookDir, "story", "state", "hooks.json"), JSON.stringify({ hooks: [] }), "utf-8");
  await writeFile(join(bookDir, "story", "author_intent.md"), "# 作者意图\n复仇主线", "utf-8");
  await writeFile(join(bookDir, "story", "current_focus.md"), "# 当前聚焦\n推进证据链", "utf-8");
  await writeFile(join(bookDir, "story", "current_state.md"), "# 当前状态\n主角在东城", "utf-8");
  await writeFile(join(bookDir, "story", "pending_hooks.md"), "| hook_id | 描述 |\n| --- | --- |\n| hook-03 | 遗嘱 |", "utf-8");
  await writeFile(join(bookDir, "story", "outline", "story_frame.md"), "# 故事框架\n都市复仇", "utf-8");
}

/**
 * Snapshot every canonical file under bookDir (excluding the non-canonical
 * forecast output and editable Arc planning directories).
 */
export async function snapshotCanonicalFiles(bookDir: string): Promise<ReadonlyMap<string, string>> {
  const snapshot = new Map<string, string>();
  await walk(bookDir, bookDir, snapshot);
  return snapshot;
}

async function walk(root: string, dir: string, snapshot: Map<string, string>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    const rel = relative(root, path);
    if (rel.startsWith(join("story", "runtime", "narrative-forecasts"))) continue;
    if (rel.startsWith(join("story", "arcs"))) continue;
    if (entry.isDirectory()) {
      await walk(root, path, snapshot);
    } else {
      snapshot.set(rel, await readFile(path, "utf-8"));
    }
  }
}

export function makeForecast(overrides: Partial<NarrativeForecast> = {}): NarrativeForecast {
  return {
    version: 1,
    forecastId: "fc-20260101000000",
    bookId: "demo-book",
    createdAt: "2026-01-01T00:00:00.000Z",
    language: "zh",
    divergence: "主角是否接受对手的合作提议",
    horizon: 5,
    baseChapter: 12,
    contextFingerprint: "abc123",
    status: "active",
    branches: [
      makeForecastBranch(),
      makeForecastBranch({
        branchId: "branch-2",
        title: "主角拒绝提议",
        premise: "假设主角当场拒绝并公开对手把柄。",
        intentAlignment: { score: 88, rationale: "延续复仇主线，符合当前聚焦。" },
      }),
    ],
    ...overrides,
  };
}
