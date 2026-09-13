import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestMaterial } from "../materials/ingest.js";
import { retrieveMaterials } from "../materials/retrieve.js";

describe("material retrieval", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-material-retrieve-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns traceable snippets from archived materials", async () => {
    await writeFile(join(root, "cold.md"), [
      "# 冷库旧账",
      "",
      "赔偿款在 0607 账页后被拆成三笔转出。",
      "冻品走私线索藏在入库单和司机签名里。",
    ].join("\n"), "utf-8");
    await writeFile(join(root, "romance.md"), [
      "# 恋爱线",
      "",
      "女主在海边车站归还钥匙，重点是误会后的情绪修复。",
    ].join("\n"), "utf-8");

    await ingestMaterial(root, {
      sourceKind: "file",
      filePath: "cold.md",
      purpose: "research",
    }, { now: () => new Date("2026-07-03T00:00:00.000Z") });
    await ingestMaterial(root, {
      sourceKind: "file",
      filePath: "romance.md",
      purpose: "reference",
    }, { now: () => new Date("2026-07-03T00:01:00.000Z") });

    const results = await retrieveMaterials(root, {
      query: "冷库 赔偿款 0607 账页",
      limit: 2,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("cold");
    expect(results[0]?.excerpt).toContain("赔偿款");
    expect(results[0]?.markdownPath).toMatch(/^\.inkos\/materials\//);
    expect(results[0]?.charStart).toBeGreaterThanOrEqual(0);
    expect(results[0]?.charEnd).toBeGreaterThan(results[0]?.charStart ?? 0);
  });

  it("can filter retrieval by material purpose", async () => {
    await writeFile(join(root, "research.md"), "现实冷库需要入库单、签收单和温控记录。", "utf-8");
    await writeFile(join(root, "script.md"), "分镜阶段需要镜头号、景别和动作。", "utf-8");

    await ingestMaterial(root, {
      sourceKind: "file",
      filePath: "research.md",
      purpose: "research",
    }, { now: () => new Date("2026-07-03T00:00:00.000Z") });
    await ingestMaterial(root, {
      sourceKind: "file",
      filePath: "script.md",
      purpose: "script",
    }, { now: () => new Date("2026-07-03T00:01:00.000Z") });

    const results = await retrieveMaterials(root, {
      query: "镜头 分镜 动作",
      purpose: "script",
      limit: 3,
    });

    expect(results.map((result) => result.purpose)).toEqual(["script"]);
    expect(results[0]?.excerpt).toContain("分镜");
  });

  it("finds a Korean functional passage beyond the opening title mention", async () => {
    const content = "계약에 관한 일반 소개.\n" + "관련 없는 생활 이야기. ".repeat(400)
      + "\n\n도현은 보증금을 돌려받지 못했던 일을 떠올렸다. 계약의 서명을 확인하고 선지급 요구를 거절했다.\n\n"
      + "이후 다른 날의 일상. ".repeat(80);
    await ingestMaterial(root, { sourceKind: "text", sourceLabel: "Self-written retrieval fixture", content, title: "계약 참고 자료", purpose: "reference" });
    const results = await retrieveMaterials(root, { query: "보증금을 계약으로 거절한다", purpose: "reference" });
    expect(results).toHaveLength(1);
    expect(results[0]!.excerpt).toContain("선지급 요구를 거절했다");
    expect(results[0]!.charStart).toBeGreaterThan(2000);
    expect(results[0]!.excerpt).not.toContain("일반 소개");
  });

  it("reports exact character and byte spans after trimming around Korean and emoji", async () => {
    const content = " \n" + "🌙 ".repeat(400) + "\n\n보증금 분쟁의 근거를 확인한다.\n\n" + "🪙 ".repeat(500) + " \n";
    await ingestMaterial(root, { sourceKind: "text", sourceLabel: "Self-written Unicode fixture", content, title: "증거 자료" });
    const [result] = await retrieveMaterials(root, { query: "보증금을 확인한다" });
    expect(result).toBeDefined();
    const archived = await readFile(join(root, result!.markdownPath), "utf8");
    expect(archived.slice(result!.charStart, result!.charEnd)).toBe(result!.excerpt);
    expect(Buffer.from(archived).subarray(result!.byteStart, result!.byteEnd).toString("utf8")).toBe(result!.excerpt);
    expect(result!.excerpt).toBe(result!.excerpt.trim());
    expect(result!.excerpt).not.toContain("�");
    expect(result!.coordinateKind).toBe("utf16-code-units");
    expect(result!.markdownSha256).toBe(createHash("sha256").update(archived).digest("hex"));
    expect(result!.excerptSha256).toBe(createHash("sha256").update(result!.excerpt).digest("hex"));
  });

  it("does not turn a list of excluded Korean topics into a positive retrieval query", async () => {
    await ingestMaterial(root, { sourceKind: "text", sourceLabel: "Self-written exclusion fixture", content: "공장 확장과 공급권을 다룬 자료.", title: "산업" });
    expect(await retrieveMaterials(root, { query: "금지: 공장 확장과 공급권" })).toEqual([]);
    expect(await retrieveMaterials(root, { query: "" })).toHaveLength(1);
  });

  it("reads a portable Windows manifest while ignoring broken metadata and invalid paths", async () => {
    const good = await ingestMaterial(root, { sourceKind: "text", sourceLabel: "Portable fixture", content: "보증금 반환의 조건", title: "계약 자료" });
    await writeFile(join(root, good.manifestPath), JSON.stringify({ ...good, markdownPath: good.markdownPath.replaceAll("/", "\\") }));
    await writeFile(join(root, ".inkos", "materials", "bad-metadata.json"), JSON.stringify({ ...good, id: "bad-metadata", source: null }));
    await writeFile(join(root, ".inkos", "materials", "bad-path.json"), JSON.stringify({ ...good, id: "bad-path", markdownPath: "../outside.md" }));
    const results = await retrieveMaterials(root, { query: "보증금" });
    expect(results.map((item) => item.id)).toEqual([good.id]);
    expect(results[0]!.markdownPath).toBe(good.markdownPath);
    expect(results[0]!.excerpt).toContain("보증금 반환의 조건");
  });
});
