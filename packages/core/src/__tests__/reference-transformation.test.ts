import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArcStore } from "../arc/store.js";
import { StoryRailStore } from "../arc/rail-store.js";
import { ReferenceTransformationHilStore } from "../reference/hil-store.js";
import { ensureFireflyLongformPreflight } from "../reference/firefly-preflight.js";
import { ReferencePackStore } from "../reference/store.js";
import type { BookConfig } from "../models/book.js";

const NOW = "2026-08-26T00:00:00.000Z";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("reference-derived production", () => {
  it("binds real source bytes, auto-completes transformation/Rail, and renders Writer context", async () => {
    const fixture = await createFixture();
    const store = new ReferencePackStore(fixture.root, fixture.bookDir);
    const binding = await store.bind({
      bookId: fixture.book.id,
      packPath: fixture.packPath,
      storyIndexPath: fixture.storyIndexPath,
      styleExamplesPath: fixture.styleExamplesPath,
      sourcePath: fixture.sourcePath,
      now: () => new Date(NOW),
    });
    expect(binding.referencePackId).toBe("fixture-reference-v1");

    const receipt = await ensureFireflyLongformPreflight({
      projectRoot: fixture.root,
      bookDir: fixture.bookDir,
      book: fixture.book,
      now: () => new Date(NOW),
    });
    expect(receipt.transformationCreated).toBe(true);
    expect(receipt.railCreated).toBe(true);
    expect(receipt.transformationSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.railPlanSha256).toMatch(/^[a-f0-9]{64}$/u);
    const plan = await new StoryRailStore(fixture.bookDir).load();
    expect(plan?.anchorRail.anchors).toHaveLength(6);
    expect(plan?.anchorRail.status).toBe("ready");
    expect(plan?.arcRouteRail.status).toBe("ready");
    const repeated = await ensureFireflyLongformPreflight({
      projectRoot: fixture.root,
      bookDir: fixture.bookDir,
      book: fixture.book,
      now: () => new Date(NOW),
    });
    expect(repeated.transformationCreated).toBe(false);
    expect(repeated.railCreated).toBe(false);
    expect(repeated.transformationSha256).toBe(receipt.transformationSha256);
    expect(repeated.railPlanSha256).toBe(receipt.railPlanSha256);

    const context = await store.buildWriterContext({
      book: fixture.book,
      chapterNumber: 1,
      arcId: "arc-opening",
    });
    expect(context?.storyEntries.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(context?.styleExamples).toHaveLength(3);
    expect(context?.rendered).toContain("REFERENCE STORY EXAMPLES");
    expect(context?.rendered).toContain("첫 장면 실제 원문");
    expect(context?.rendered).toContain("원작과의 거리는 품질 기준이 아닙니다");
  });

  it("prepares a comparison without overwriting and applies only on explicit command", async () => {
    const fixture = await createFixture();
    const store = new ReferencePackStore(fixture.root, fixture.bookDir);
    await store.bind({
      bookId: fixture.book.id,
      packPath: fixture.packPath,
      storyIndexPath: fixture.storyIndexPath,
      styleExamplesPath: fixture.styleExamplesPath,
      sourcePath: fixture.sourcePath,
      now: () => new Date(NOW),
    });
    await ensureFireflyLongformPreflight({
      projectRoot: fixture.root,
      bookDir: fixture.bookDir,
      book: fixture.book,
      now: () => new Date(NOW),
    });
    const transformation = await store.loadTransformation(true);
    const context = await store.buildWriterContext({
      book: fixture.book,
      chapterNumber: 1,
      arcId: "arc-opening",
    });
    if (!transformation || !context) throw new Error("fixture reference state missing");
    const targetRelative = join("chapters", "1_기존.md");
    const current = "기존 원고는 준비 상태다.\n";
    const candidate = `${context.storyEntries[0]!.prose}\n후보 결말이다.\n`;
    await mkdir(join(fixture.bookDir, "chapters"), { recursive: true });
    await writeFile(join(fixture.bookDir, targetRelative), current, "utf8");
    const hil = new ReferenceTransformationHilStore(fixture.bookDir, () => new Date(NOW));
    const prepared = await hil.prepare({
      chapterNumber: 1,
      candidateId: "candidate-a",
      currentContent: current,
      candidateContent: candidate,
      transformation,
      sourceTexts: context.storyEntries.map((entry) => entry.prose),
    });
    expect(prepared.report.automaticRewrite).toBe(false);
    expect(prepared.report.similarityPenalty).toBe(false);
    expect(await readFile(join(fixture.bookDir, targetRelative), "utf8")).toBe(current);

    await hil.apply({
      chapterNumber: 1,
      candidateId: "candidate-a",
      targetChapterRelativePath: targetRelative,
    });
    expect(await readFile(join(fixture.bookDir, targetRelative), "utf8")).toBe(candidate);
    expect(await readFile(
      join(fixture.bookDir, "chapters", ".reviews", "1", "candidate-a-pre-apply.md"),
      "utf8",
    )).toBe(current);
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "inkos-reference-"));
  const bookDir = join(root, "books", "fixture-book");
  await mkdir(join(bookDir, "story"), { recursive: true });
  const book: BookConfig = {
    id: "fixture-book",
    title: "Fixture",
    platform: "other",
    genre: "urban",
    status: "active",
    targetChapters: 20,
    chapterWordCount: 3000,
    language: "ko",
    createdAt: NOW,
    updatedAt: NOW,
    writing: {
      reviewMode: "manual",
      railPolicy: "auto-required",
      referencePolicy: "auto-required",
      referencePackId: "fixture-reference-v1",
      spineReference: "fixture-source",
    },
  };
  await writeFile(join(bookDir, "book.json"), `${JSON.stringify(book, null, 2)}\n`, "utf8");
  await new ArcStore(bookDir, { now: () => new Date(NOW) }).save({
    version: 1,
    id: "arc-opening",
    bookId: book.id,
    title: "첫 역전",
    status: "ready",
    episodeCount: 1,
    chapterNumbers: [1],
    openingState: "무시받는다",
    promise: "첫 역전",
    goal: "증명한다",
    obstacle: "상대의 거절",
    pressure: "기한",
    turn: "물증 공개",
    payoff: "권한을 얻는다",
    irreversibleChange: "주인공이 결정권자가 된다",
    nextHook: "더 큰 거래",
    episodeBeats: [{ chapterNumber: 1, role: "payoff", beats: ["물증", "지급"], endingHook: "다음 거래" }],
    characterChanges: [],
    relationshipChanges: [],
    worldChanges: [],
    hookOperations: [],
    mustKeep: [],
    mustAvoid: [],
    styleEmphasis: [],
    createdAt: NOW,
    updatedAt: NOW,
  });
  await new ArcStore(bookDir, { now: () => new Date(NOW) }).setActive("arc-opening");

  const prose = [
    "첫 장면 실제 원문 한 둘 셋 넷 다섯 여섯 일곱 여덟 아홉 열 열하나 열둘.",
    "둘째 장면 실제 원문에서 상대가 거절하고 주인공이 물증을 내민다.",
    "셋째 장면 실제 원문에서 계약과 권한이 눈앞에 지급된다.",
  ];
  const source = prose.map((body, index) => `ⓚ${index + 1}. 표본 ${index + 1}\n${body}`).join("\n");
  const sourcePath = join(root, "source.txt");
  await writeFile(sourcePath, source, "utf8");
  const markerOffsets = [...source.matchAll(/^ⓚ(?=\d)/gmu)].map((match) => match.index);
  const storyRows = prose.map((body, index) => ({
    sequence: index + 1,
    visibleLabel: `${index + 1}화`,
    title: `표본 ${index + 1}`,
    arcId: "SRC-A1",
    sourceLineRange: { start: index * 2 + 1, end: index * 2 + 2 },
    sourceCharacterRange: { start: markerOffsets[index]!, end: markerOffsets[index + 1] ?? source.length },
    marker: `ⓚ${index + 1}. 표본 ${index + 1}`,
    functions: {
      entryState: "무시받는다",
      readerPromise: "역전한다",
      protagonistGoal: "증명한다",
      action: "물증을 낸다",
      resistanceOrCost: "거절당한다",
      turnOrReveal: "증거가 확인된다",
      paidReward: "권한을 얻는다",
      stateChange: "결정권자",
      endingHook: "다음 거래",
    },
    surfaceRefs: { peopleAndPlaces: "주인공, 상대", locations: "회의실" },
    rawProseSha256: sha256(body),
  }));
  const storyIndexText = `${storyRows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const styleRows = ["entry", "escalation", "payoff"].map((sceneFunction, index) => ({
    id: `phase-1-${sceneFunction}`,
    phaseId: "phase-1",
    function: sceneFunction,
    sequence: index + 1,
    arcId: "SRC-A1",
    rawProseSha256: sha256(prose[index]!),
    prose: prose[index],
  }));
  const styleExamplesText = `${styleRows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const privateIndexText = "fixture-private-index\n";
  const pack = {
    version: 1,
    kind: "reference-transformation-pack",
    id: "fixture-reference-v1",
    language: "ko",
    source: {
      workSlug: "fixture-source",
      workTitle: "Fixture Source",
      sourceSha256: sha256(source),
      chapterCount: 3,
      naturalArcCount: 1,
      goldStatus: "approved",
    },
    privateInputs: {
      storyIndexSha256: sha256(storyIndexText),
      styleExamplesSha256: sha256(styleExamplesText),
      privateIndexSha256: sha256(privateIndexText),
    },
    storyRetrieval: { indexedChapterCount: 3, defaultMappedChapterLimit: 3, authority: ["raw_source"] },
    styleRetrieval: {
      method: "fixture",
      sampleCount: 3,
      samples: styleRows.map(({ prose: _prose, ...row }) => row),
      defaultSampleLimit: 3,
      hilRetrySampleLimit: 5,
    },
    transformationPolicy: {
      requiredSpineReference: true,
      reusableLayers: ["event-order"],
      selectableSurfaceVariation: ["people"],
      linkedConsequences: ["money"],
    },
    commercialPolicy: {
      priority: ["commerciality"],
      similarityPenalty: false,
      minimumDistanceScore: null,
      automaticRewriteForOverlap: false,
      humanPolishDecision: true,
    },
    corpusMetrics: {},
    phases: [{
      phaseId: "phase-1",
      progressRange: { start: 0, end: 1 },
      sourceChapterRange: { start: 1, end: 3 },
      metrics: {},
      styleSampleIds: styleRows.map((row) => row.id),
    }],
  };
  const packPath = join(root, "reference-pack.json");
  const storyIndexPath = join(root, "story-index.jsonl");
  const styleExamplesPath = join(root, "style-examples.jsonl");
  await Promise.all([
    writeFile(packPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8"),
    writeFile(storyIndexPath, storyIndexText, "utf8"),
    writeFile(styleExamplesPath, styleExamplesText, "utf8"),
  ]);
  return { root, bookDir, book, packPath, storyIndexPath, styleExamplesPath, sourcePath };
}
