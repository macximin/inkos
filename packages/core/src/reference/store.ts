import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { commitAtomicFileSet, syncDirectory } from "../utils/atomic-file-set.js";
import type { BookConfig } from "../models/book.js";
import {
  ReferenceBindingSchema,
  ReferencePackSchema,
  ReferenceStoryIndexEntrySchema,
  ReferenceStyleExampleSchema,
  ReferenceTransformationSchema,
  type ReferenceBinding,
  type ReferencePack,
  type ReferenceStoryIndexEntry,
  type ReferenceStyleExample,
  type WriterReferenceContext,
} from "./schema.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseJsonLines<T>(text: string, parse: (value: unknown) => T): T[] {
  return text.split("\n").filter((line) => line.trim()).map((line) => parse(JSON.parse(line)));
}

export interface BindReferencePackInput {
  readonly projectRoot: string;
  readonly bookDir: string;
  readonly bookId: string;
  readonly packPath: string;
  readonly storyIndexPath: string;
  readonly styleExamplesPath: string;
  readonly sourcePath: string;
  readonly spineReference?: string;
  readonly now?: () => Date;
}

export class ReferencePackStore {
  constructor(
    private readonly projectRoot: string,
    private readonly bookDir: string,
  ) {}

  get bindingPath(): string { return join(this.bookDir, "story", "reference_binding.json"); }
  get transformationPath(): string { return join(this.bookDir, "story", "reference_transformation.json"); }
  packDir(packId: string): string { return join(this.projectRoot, ".inkos", "reference-packs", packId); }
  installObjectDir(installObjectSha256: string): string {
    return join(this.projectRoot, ".inkos", "reference-packs", "objects", installObjectSha256);
  }
  installedPackDir(binding: ReferenceBinding): string {
    return binding.installObjectSha256
      ? this.installObjectDir(binding.installObjectSha256)
      : this.packDir(binding.referencePackId);
  }

  async bind(input: Omit<BindReferencePackInput, "projectRoot" | "bookDir">): Promise<ReferenceBinding> {
    const packText = await readFile(resolve(input.packPath), "utf8");
    const storyIndexText = await readFile(resolve(input.storyIndexPath), "utf8");
    const styleExamplesText = await readFile(resolve(input.styleExamplesPath), "utf8");
    const sourcePath = resolve(input.sourcePath);
    const sourceText = await readFile(sourcePath, "utf8");
    const pack = ReferencePackSchema.parse(JSON.parse(packText));
    const storyEntries = parseJsonLines(storyIndexText, (value) => ReferenceStoryIndexEntrySchema.parse(value));
    const styleExamples = parseJsonLines(styleExamplesText, (value) => ReferenceStyleExampleSchema.parse(value));
    if (sha256(storyIndexText) !== pack.privateInputs.storyIndexSha256) {
      throw new Error("Reference story index SHA-256 does not match the tracked pack.");
    }
    if (sha256(styleExamplesText) !== pack.privateInputs.styleExamplesSha256) {
      throw new Error("Reference style examples SHA-256 does not match the tracked pack.");
    }
    if (sha256(sourceText) !== pack.source.sourceSha256) {
      throw new Error("Reference raw source SHA-256 does not match the tracked pack.");
    }
    if (storyEntries.length !== pack.storyRetrieval.indexedChapterCount) {
      throw new Error("Reference story index count does not match the tracked pack.");
    }
    if (styleExamples.length !== pack.styleRetrieval.sampleCount) {
      throw new Error("Reference style example count does not match the tracked pack.");
    }
    for (const example of styleExamples) {
      if (sha256(example.prose) !== example.rawProseSha256) {
        throw new Error(`Reference style example ${JSON.stringify(example.id)} has a body SHA mismatch.`);
      }
    }

    const installObjectSha256 = sha256(JSON.stringify({
      version: 1,
      packSha256: sha256(packText),
      storyIndexSha256: sha256(storyIndexText),
      styleExamplesSha256: sha256(styleExamplesText),
      sourceSha256: sha256(sourceText),
    }));
    const installedDir = await this.installContentAddressedObject({
      installObjectSha256,
      packText,
      storyIndexText,
      styleExamplesText,
      sourceText,
    });
    const binding = ReferenceBindingSchema.parse({
      version: 1,
      kind: "reference-binding",
      bookId: input.bookId,
      referencePackId: pack.id,
      spineReference: input.spineReference ?? pack.source.workSlug,
      packSha256: sha256(packText),
      storyIndexSha256: sha256(storyIndexText),
      styleExamplesSha256: sha256(styleExamplesText),
      sourceSha256: sha256(sourceText),
      sourcePath: join(installedDir, "source.txt"),
      installObjectSha256,
      boundAt: (input.now ?? (() => new Date()))().toISOString(),
    });
    await commitAtomicFileSet({
      rootDir: this.bookDir,
      writes: [{
        relativePath: join("story", "reference_binding.json"),
        content: `${JSON.stringify(binding, null, 2)}\n`,
      }],
    });
    return binding;
  }

  async loadBinding(required = false): Promise<ReferenceBinding | null> {
    try {
      return ReferenceBindingSchema.parse(JSON.parse(await readFile(this.bindingPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" && !required) return null;
      throw new Error(`Reference binding cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async loadPack(binding: ReferenceBinding): Promise<ReferencePack> {
    const text = await readFile(join(this.installedPackDir(binding), "reference-pack.json"), "utf8");
    if (sha256(text) !== binding.packSha256) throw new Error("Installed reference pack SHA-256 mismatch.");
    return ReferencePackSchema.parse(JSON.parse(text));
  }

  async loadTransformation(required = false) {
    try {
      return ReferenceTransformationSchema.parse(
        JSON.parse(await readFile(this.transformationPath, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" && !required) return null;
      throw new Error(`Reference transformation cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async assertReady(book: BookConfig): Promise<{ binding: ReferenceBinding; pack: ReferencePack }> {
    const binding = await this.loadBinding(true);
    if (!binding) throw new Error("Reference binding is required.");
    if (binding.bookId !== book.id) throw new Error("Reference binding belongs to a different Book.");
    if (book.writing?.referencePackId && binding.referencePackId !== book.writing.referencePackId) {
      throw new Error("Reference binding does not match book.writing.referencePackId.");
    }
    if (book.writing?.spineReference && binding.spineReference !== book.writing.spineReference) {
      throw new Error("Reference binding does not match book.writing.spineReference.");
    }
    const pack = await this.loadPack(binding);
    const [storyIndexText, styleExamplesText, sourceText] = await Promise.all([
      readFile(join(this.installedPackDir(binding), "story-index.jsonl"), "utf8"),
      readFile(join(this.installedPackDir(binding), "style-examples.jsonl"), "utf8"),
      readFile(binding.sourcePath, "utf8"),
    ]);
    if (sha256(storyIndexText) !== binding.storyIndexSha256) throw new Error("Installed story index SHA-256 mismatch.");
    if (sha256(styleExamplesText) !== binding.styleExamplesSha256) throw new Error("Installed style examples SHA-256 mismatch.");
    if (sha256(sourceText) !== binding.sourceSha256) throw new Error("Bound source SHA-256 mismatch.");
    return { binding, pack };
  }

  async buildWriterContext(input: {
    readonly book: BookConfig;
    readonly chapterNumber: number;
    readonly arcId?: string;
  }): Promise<WriterReferenceContext | null> {
    const binding = await this.loadBinding(false);
    if (!binding) return null;
    const { pack } = await this.assertReady(input.book);
    const transformation = await this.loadTransformation(true);
    if (!transformation) throw new Error("Reference transformation is required.");
    if (transformation.bookId !== input.book.id || transformation.referencePackId !== binding.referencePackId) {
      throw new Error("Reference transformation does not match the Book binding.");
    }
    const installedDir = this.installedPackDir(binding);
    const [storyIndexText, styleExamplesText, sourceText] = await Promise.all([
      readFile(join(installedDir, "story-index.jsonl"), "utf8"),
      readFile(join(installedDir, "style-examples.jsonl"), "utf8"),
      readFile(binding.sourcePath, "utf8"),
    ]);
    const storyIndex = parseJsonLines(storyIndexText, (value) => ReferenceStoryIndexEntrySchema.parse(value));
    const allStyleExamples = parseJsonLines(styleExamplesText, (value) => ReferenceStyleExampleSchema.parse(value));
    if (!input.arcId) {
      throw new Error("Reference Writer context requires an explicit target Arc id.");
    }
    const targetArcId = input.arcId;
    const segment = transformation.sourceSegments.find((candidate) =>
      candidate.targetArcIds.includes(targetArcId),
    );
    if (!segment) {
      throw new Error(`Reference transformation has no source segment mapped to Arc ${JSON.stringify(targetArcId)}.`);
    }
    const storyEntries = segment.sourceChapterIds
      .slice(0, pack.storyRetrieval.defaultMappedChapterLimit)
      .map((sequence) => {
        const entry = storyIndex.find((candidate) => candidate.sequence === sequence);
        if (!entry) throw new Error(`Reference story index is missing chapter ${sequence}.`);
        const raw = sourceText.slice(entry.sourceCharacterRange.start, entry.sourceCharacterRange.end).trim();
        const newline = raw.indexOf("\n");
        const prose = (newline >= 0 ? raw.slice(newline + 1) : raw).trim();
        if (sha256(prose) !== entry.rawProseSha256) {
          throw new Error(`Reference source chapter ${sequence} body SHA-256 mismatch.`);
        }
        return { ...entry, prose };
      });
    const phase = Math.min(5, Math.max(1, Math.ceil((input.chapterNumber / input.book.targetChapters) * 5)));
    const styleExamples = allStyleExamples
      .filter((example) => example.phaseId === `phase-${phase}`)
      .slice(0, pack.styleRetrieval.defaultSampleLimit);
    const rendered = renderWriterReferenceContext({
      binding,
      transformation,
      segment,
      storyEntries,
      styleExamples,
    });
    return {
      packId: binding.referencePackId,
      spineReference: binding.spineReference,
      transformation,
      sourceSegment: segment,
      storyEntries,
      styleExamples,
      rendered,
    };
  }

  private async installContentAddressedObject(input: {
    readonly installObjectSha256: string;
    readonly packText: string;
    readonly storyIndexText: string;
    readonly styleExamplesText: string;
    readonly sourceText: string;
  }): Promise<string> {
    const target = this.installObjectDir(input.installObjectSha256);
    const assertExact = async (): Promise<void> => {
      const [pack, story, style, source] = await Promise.all([
        readFile(join(target, "reference-pack.json"), "utf8"),
        readFile(join(target, "story-index.jsonl"), "utf8"),
        readFile(join(target, "style-examples.jsonl"), "utf8"),
        readFile(join(target, "source.txt"), "utf8"),
      ]);
      if (
        pack !== input.packText
        || story !== input.storyIndexText
        || style !== input.styleExamplesText
        || source !== input.sourceText
      ) throw new Error(`Content-addressed reference object ${input.installObjectSha256} is corrupt.`);
    };
    try {
      await assertExact();
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
    }

    const objectsDir = join(this.projectRoot, ".inkos", "reference-packs", "objects");
    await mkdir(objectsDir, { recursive: true });
    const staging = await mkdtemp(join(objectsDir, ".install-"));
    try {
      await commitAtomicFileSet({
        rootDir: staging,
        writes: [
          { relativePath: "reference-pack.json", content: input.packText },
          { relativePath: "story-index.jsonl", content: input.storyIndexText },
          { relativePath: "style-examples.jsonl", content: input.styleExamplesText },
          { relativePath: "source.txt", content: input.sourceText },
        ],
      });
      await syncDirectory(staging);
      try {
        await rename(staging, target);
        await syncDirectory(objectsDir);
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException | undefined)?.code ?? "")) throw error;
        await rm(staging, { recursive: true, force: true });
      }
      await assertExact();
      return target;
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function renderWriterReferenceContext(input: {
  readonly binding: ReferenceBinding;
  readonly transformation: ReturnType<typeof ReferenceTransformationSchema.parse>;
  readonly segment: ReturnType<typeof ReferenceTransformationSchema.parse>["sourceSegments"][number];
  readonly storyEntries: ReadonlyArray<ReferenceStoryIndexEntry & { readonly prose: string }>;
  readonly styleExamples: ReadonlyArray<ReferenceStyleExample>;
}): string {
  const story = input.storyEntries.map((entry) => [
    `### 원천 ${entry.sequence}화 · ${entry.arcId} · ${entry.title}`,
    `- 유지 후보: ${input.segment.retain.join(", ")}`,
    `- 시작: ${entry.functions.entryState}`,
    `- 행동/저항: ${entry.functions.action} / ${entry.functions.resistanceOrCost}`,
    `- 지급/훅: ${entry.functions.paidReward} / ${entry.functions.endingHook}`,
    entry.prose,
  ].join("\n")).join("\n\n");
  const style = input.styleExamples.map((example) => [
    `### 문체 ${example.id} · ${example.sequence}화 · ${example.function}`,
    example.prose,
  ].join("\n")).join("\n\n");
  return [
    "## REFERENCE-DERIVED 제작 계약",
    `- 주축: ${input.binding.spineReference}`,
    `- 유지: ${input.segment.retain.join(", ")}`,
    `- 선택 변주: ${input.segment.varySurface.join(", ") || "없음"}`,
    `- 연동 정합화: ${input.segment.linkedConsequences.join(", ") || "없음"}`,
    "- 원작과의 거리는 품질 기준이 아닙니다. 검증된 사건 엔진·압박·지급·훅을 적극 재사용하세요.",
    "- 표면을 바꾸면 관련 돈·증거·절차·역할·결과를 함께 바꾸세요.",
    "- 출력 표면은 자동 수정하지 않습니다. 이후 변형 비교 HIL에서 사람이 결정합니다.",
    "",
    "## REFERENCE STORY EXAMPLES",
    story,
    "",
    "## REFERENCE STYLE EXAMPLES",
    style,
  ].join("\n");
}

export { sha256 as sha256ReferenceText };
