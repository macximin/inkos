import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepareProductionCanaryPair: vi.fn(),
}));

vi.mock("@actalk/inkos-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actalk/inkos-core")>();
  return { ...actual, prepareProductionCanaryPair: mocks.prepareProductionCanaryPair };
});

import { productionCommand } from "../commands/production.js";

afterEach(() => {
  vi.restoreAllMocks();
  mocks.prepareProductionCanaryPair.mockReset();
});

describe("production canary-prepare CLI", () => {
  it("accepts typed evidence roots and emits the exact compact prepare projection", async () => {
    const root = process.cwd();
    const result = {
      schemaVersion: "inkos-canary-prepare-result/v1" as const,
      pairId: "pair-001",
      bookId: "book-001",
      scopeId: "canary-pair:pair-001:book-001",
      sourceProjectRootFingerprint: "1".repeat(64),
      commonSnapshotSha256: "2".repeat(64),
      isolationScopeSha256: "3".repeat(64),
      sourceBook: { files: [], manifestSha256: "4".repeat(64) },
      lanes: {
        neutral: {
          projectRoot: ".inkos/canaries/pair-001/neutral",
          preBindManifestSha256: "5".repeat(64),
          postBindManifestSha256: "5".repeat(64),
          allowedDeltaPaths: [],
          allowedDeltaManifestSha256: "6".repeat(64),
          expectedSoulBinding: null,
        },
        genreSoul: {
          projectRoot: ".inkos/canaries/pair-001/soul",
          preBindManifestSha256: "5".repeat(64),
          postBindManifestSha256: "7".repeat(64),
          allowedDeltaPaths: ["books/book-001/story/soul-bindings/current.json"],
          allowedDeltaManifestSha256: "8".repeat(64),
          expectedSoulBinding: {
            soulId: "male-modern-fantasy-ko",
            soulVersion: "v1",
            bindingSha256: "9".repeat(64),
          },
        },
      },
      receipt: {
        path: ".inkos/canaries/pair-001/common-snapshot.json",
        sha256: "a".repeat(64),
        byteLength: 1234,
        selfHash: "b".repeat(64),
      },
      replayed: false,
    };
    mocks.prepareProductionCanaryPair.mockResolvedValue(result);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const command = productionCommand.commands.find((candidate) => candidate.name() === "canary-prepare");
    if (!command) throw new Error("canary-prepare command is missing");
    await command.parseAsync([
      "--book", "book-001",
      "--pair", "pair-001",
      "--soul", "male-modern-fantasy-ko",
      "--version", "v1",
      "--soul-manifest", "packages/core/souls/male-modern-fantasy-ko/v1/manifest.json",
      "--source-registry-root", "../reference-lab",
      "--source-registry-receipt", "evidence/source-registry.json",
      "--decision-root", "../hq",
      "--decision-receipt", "adoptions/candidate.json",
      "--reference-lab-evidence-root", "../reference-lab",
      "--inkos-evidence-root", ".",
      "--hq-evidence-root", "../hq",
      "--json",
    ], { from: "user" });

    expect(mocks.prepareProductionCanaryPair).toHaveBeenCalledWith({
      projectRoot: root,
      bookId: "book-001",
      pairId: "pair-001",
      soulId: "male-modern-fantasy-ko",
      soulVersion: "v1",
      soulManifestPath: "packages/core/souls/male-modern-fantasy-ko/v1/manifest.json",
      sourceRegistryReceipt: {
        root: resolve(root, "../reference-lab"),
        path: "evidence/source-registry.json",
      },
      decisionReceipt: {
        root: resolve(root, "../hq"),
        path: "adoptions/candidate.json",
      },
      evidenceRoots: {
        referenceLab: resolve(root, "../reference-lab"),
        inkos: resolve(root, "."),
        hq: resolve(root, "../hq"),
      },
    });
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(`${JSON.stringify(result)}\n`);
  });
});
