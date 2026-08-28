import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubAgentTool } from "../agent/agent-tools.js";
import {
  cleanupExpiredDetachedPayloadLeases,
  createDetachedOwnerDirectionLease,
  resolveDetachedOwnerDirectionLease,
} from "../production/detached-payload-store.js";
import {
  directionTextSha256,
  type ResolvedProductionDirectionContext,
} from "../production/direction-context.js";

describe("production direction provenance", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "inkos-direction-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("stores exact owner bytes in a private detached lease and fails closed on tamper", async () => {
    const text = "원문 예문은 이름만 지우고 그대로 전달한다.\n표면 변주는 polishing HIL에서 한다.";
    const reference = await createDetachedOwnerDirectionLease({
      projectRoot,
      receiptId: "request-1",
      text,
      now: new Date("2026-08-28T00:00:00.000Z"),
    });
    const directory = join(projectRoot, ".inkos", "private", "detached-payload-leases");
    const payload = join(directory, `${reference.sourceRef.leaseId}.payload`);
    const receipt = join(directory, `${reference.sourceRef.leaseId}.receipt.json`);

    await expect(resolveDetachedOwnerDirectionLease({
      projectRoot,
      reference,
      now: new Date("2026-08-28T01:00:00.000Z"),
    })).resolves.toMatchObject({ text, source: "owner-confirmed" });
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(payload)).mode & 0o777).toBe(0o600);
    expect((await stat(receipt)).mode & 0o777).toBe(0o600);
    expect(await readFile(receipt, "utf8")).not.toContain(text);

    await writeFile(payload, `${text}\n변조`, { mode: 0o600 });
    await expect(resolveDetachedOwnerDirectionLease({
      projectRoot,
      reference,
      now: new Date("2026-08-28T01:00:00.000Z"),
    })).rejects.toThrow("byte length mismatch");
  });

  it("cleans only expired well-formed leases", async () => {
    const now = new Date("2026-08-28T00:00:00.000Z");
    const expired = await createDetachedOwnerDirectionLease({
      projectRoot,
      receiptId: "expired",
      text: "expired owner direction",
      ttlMs: 1_000,
      now,
    });
    const active = await createDetachedOwnerDirectionLease({
      projectRoot,
      receiptId: "active",
      text: "active owner direction",
      ttlMs: 60_000,
      now,
    });

    await expect(cleanupExpiredDetachedPayloadLeases(projectRoot, {
      now: new Date(now.getTime() + 2_000),
    })).resolves.toBe(1);
    await expect(resolveDetachedOwnerDirectionLease({
      projectRoot,
      reference: active,
      now: new Date(now.getTime() + 2_000),
    })).resolves.toMatchObject({ text: "active owner direction" });
    const expiredPayload = join(
      projectRoot,
      ".inkos",
      "private",
      "detached-payload-leases",
      `${expired.sourceRef.leaseId}.payload`,
    );
    await expect(stat(expiredPayload)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("separates exact owner direction from model-mediated Writer guidance for one chapter", async () => {
    const ownerText = "주인공은 이번 화에서 인수대금 30억 원을 숫자로 확인한다.";
    const modelGuidance = "인수 장면을 긴장감 있게 전개하고 마지막에 영수증을 보여준다.";
    const ownerDirection = await createDetachedOwnerDirectionLease({
      projectRoot,
      receiptId: "request-1",
      text: ownerText,
    });
    const writeNextChapter = vi.fn(async (
      _bookId: string,
      _wordCount?: number,
      _temperatureOverride?: number,
      _directionContext?: ResolvedProductionDirectionContext,
    ) => ({
      chapterNumber: 1,
      title: "인수대금",
      wordCount: 5_000,
      status: "ready-for-review",
    }));
    const tool = createSubAgentTool({ writeNextChapter } as never, "book-a", projectRoot, {
      getProductionTurnContext: () => ({
        sessionId: "session-1",
        requestId: "request-1",
        ownerDirection,
      }),
    });

    await tool.execute("tool-1", {
      agent: "writer",
      instruction: modelGuidance,
      chapterWordCount: 5_000,
    });

    const context = writeNextChapter.mock.calls[0]![3]!;
    expect(context).toMatchObject({
      ownerDirection: {
        source: "owner-confirmed",
        receiptId: "request-1",
        text: ownerText,
        textSha256: directionTextSha256(ownerText),
      },
      taskGuidance: {
        source: "model-mediated",
        transcriptRef: {
          sessionId: "session-1",
          requestId: "request-1",
          toolCallId: "tool-1",
        },
        text: modelGuidance,
        textSha256: directionTextSha256(modelGuidance),
      },
    });
    expect(context.ownerDirection!.text).not.toBe(context.taskGuidance!.text);
  });

  it("passes the same separated authority context through a chapter batch", async () => {
    const ownerDirection = await createDetachedOwnerDirectionLease({
      projectRoot,
      receiptId: "request-batch",
      text: "두 화 모두 계약금의 실제 입금 증거를 남긴다.",
    });
    const writeChapters = vi.fn(async (
      _bookId: string,
      _chapterCount: number,
      _options: { readonly directionContext?: ResolvedProductionDirectionContext },
    ) => []);
    const tool = createSubAgentTool({ writeChapters } as never, "book-a", projectRoot, {
      getProductionTurnContext: () => ({
        sessionId: "session-batch",
        requestId: "request-batch",
        ownerDirection,
      }),
    });

    await tool.execute("tool-batch", {
      agent: "writer",
      instruction: "첫 화는 협상, 둘째 화는 입금 확인으로 배열한다.",
      chapterCount: 2,
    });

    expect(writeChapters.mock.calls[0]?.[2]?.directionContext).toMatchObject({
      ownerDirection: { source: "owner-confirmed", receiptId: "request-batch" },
      taskGuidance: {
        source: "model-mediated",
        transcriptRef: { toolCallId: "tool-batch" },
      },
    });
  });
});
