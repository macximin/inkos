import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertCanonicalEvidenceTopology } from "../production/soul-evidence-topology.js";

const roots: string[] = [];

function git(root: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", root, ...args], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Soul evidence topology", () => {
  it("has no caller bypass and rejects a fake Git root before reading adoption artifacts", async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), "inkos-fake-evidence-root-"));
    roots.push(fakeRoot);
    await git(fakeRoot, ["init", "-q"]);

    await expect(assertCanonicalEvidenceTopology({
      hqCommit: "0".repeat(40),
      evidenceRoots: {
        inkos: fakeRoot,
        hq: fakeRoot,
        referenceLab: fakeRoot,
      },
    })).rejects.toThrow(/not the repository that loaded this InkOS runtime/u);
  });

  it("fails closed when the complete canonical repository family is not supplied", async () => {
    await expect(assertCanonicalEvidenceTopology({
      hqCommit: "0".repeat(40),
      evidenceRoots: undefined,
    })).rejects.toThrow(/requires canonical HQ, InkOS, and Reference Lab roots/u);
  });
});
