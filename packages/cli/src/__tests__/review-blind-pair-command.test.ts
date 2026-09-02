import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  root: "",
  prepare: vi.fn(),
  materialize: vi.fn(),
  acknowledge: vi.fn(),
  log: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@actalk/inkos-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actalk/inkos-core")>();
  return {
    ...actual,
    prepareBlindPair: mocks.prepare,
    materializeBlindPair: mocks.materialize,
    acknowledgeStoryyardEvaluation: mocks.acknowledge,
  };
});

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    findProjectRoot: () => mocks.root,
    log: mocks.log,
    logError: mocks.logError,
  };
});

import { reviewCommand } from "../commands/review.js";

const roots: string[] = [];

afterEach(async () => {
  process.exitCode = undefined;
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function command(name: string) {
  const result = reviewCommand.commands.find((candidate) => candidate.name() === name);
  if (!result) throw new Error(`${name} command is missing`);
  return result;
}

describe("review blind-pair CLI", () => {
  it("exposes prepare/materialize/acknowledge with exact project-relative inputs", async () => {
    mocks.root = await mkdtemp(join(tmpdir(), "inkos-review-cli-"));
    roots.push(mocks.root);
    mocks.prepare.mockResolvedValue({
      mapping: { path: ".inkos/canaries/pair/review/private/label-assignment.json", sha256: "a".repeat(64) },
      transfer: { path: ".inkos/canaries/pair/review/public/evaluation-transfer.json", sha256: "b".repeat(64), value: {} },
      replayed: false,
    });
    await command("prepare-blind-pair").parseAsync([
      "--pair", "pair-001", "--book", "book-001",
      "--neutral-work-order", "wo-neutral", "--soul-work-order", "wo-soul",
      "--common-context", "evidence/common.md", "--round", "2", "--json",
    ], { from: "user" });
    expect(mocks.prepare).toHaveBeenCalledWith({
      projectRoot: mocks.root,
      pairId: "pair-001",
      bookId: "book-001",
      neutralWorkOrderId: "wo-neutral",
      soulWorkOrderId: "wo-soul",
      commonContextPath: "evidence/common.md",
      round: 2,
    });

    mocks.materialize.mockResolvedValue({
      packet: { packetId: "frp-111111111111111111111111" },
      artifact: { path: ".inkos/canaries/pair/review/public/frp.json", sha256: "c".repeat(64) },
      replayed: false,
    });
    await command("materialize-blind-pair").parseAsync([
      "--pair", "pair-001", "--review-input", "evidence/review-input.json", "--evaluator-input", "evidence/evaluator-input.json", "--evaluation-result", "evidence/result.json",
      "--evaluator-host-receipt", "evidence/host-receipt.json",
      "--review-receipt", "evidence/review-receipt.json",
      "--surface-a", "evidence/a.json", "--surface-b", "evidence/b.json",
      "--generated-at", "2026-09-02T12:00:00.000Z", "--json",
    ], { from: "user" });
    expect(mocks.materialize).toHaveBeenCalledWith({
      projectRoot: mocks.root,
      pairId: "pair-001",
      reviewInputPath: "evidence/review-input.json",
      evaluatorInputPath: "evidence/evaluator-input.json",
      evaluatorResultPath: "evidence/result.json",
      evaluatorHostReceiptPath: "evidence/host-receipt.json",
      reviewReceiptPath: "evidence/review-receipt.json",
      surfaceScanPaths: ["evidence/a.json", "evidence/b.json"],
      generatedAt: "2026-09-02T12:00:00.000Z",
    });

    mocks.acknowledge.mockResolvedValue({ decisionId: "decision-001", canonEffect: "none", manuscriptApply: false });
    await command("acknowledge-storyyard-evaluation").parseAsync([
      "decision.json", "--packet", "packet.json", "--pair", "pair-001", "--json",
    ], { from: "user" });
    expect(mocks.acknowledge).toHaveBeenCalledWith({
      projectRoot: mocks.root,
      pairId: "pair-001",
      packetPath: "packet.json",
      decisionPath: "decision.json",
    });
  });

  it("hard-rejects legacy v2 export and apply while leaving v1 apply command present", async () => {
    mocks.root = await mkdtemp(join(tmpdir(), "inkos-review-cli-reject-"));
    roots.push(mocks.root);
    await mkdir(mocks.root, { recursive: true });
    await writeFile(join(mocks.root, "packet.json"), JSON.stringify({ schemaVersion: "firefly_review_packet/v2" }));
    await writeFile(join(mocks.root, "decision.json"), JSON.stringify({ schemaVersion: "firefly_review_decision/v2" }));

    await command("export-storyyard-v2").parseAsync(["draft.json", "book-001", "--json"], { from: "user" });
    expect(mocks.log).toHaveBeenCalledWith(expect.stringContaining("disabled"));
    process.exitCode = undefined;
    mocks.log.mockClear();
    await command("apply-storyyard").parseAsync([
      "decision.json", "--packet", "packet.json", "--json",
    ], { from: "user" });
    expect(mocks.log).toHaveBeenCalledWith(expect.stringContaining("advisory promotion evaluation only"));
    expect(mocks.acknowledge).not.toHaveBeenCalled();
    expect(reviewCommand.commands.some((candidate) => candidate.name() === "apply-storyyard")).toBe(true);
  });
});
