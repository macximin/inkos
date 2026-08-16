import { afterEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAtomicFileSet, recoverAtomicFileSets } from "../utils/atomic-file-set.js";

describe("commitAtomicFileSet", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createBookFixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "inkos-file-set-"));
    roots.push(root);
    await Promise.all([
      mkdir(join(root, "chapters"), { recursive: true }),
      mkdir(join(root, "story"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, "chapters", "0001_old.md"), "old chapter", "utf-8"),
      writeFile(join(root, "story", "current_state.md"), "old state", "utf-8"),
      writeFile(join(root, "story", "pending_hooks.md"), "old hooks", "utf-8"),
    ]);
    return root;
  }

  it("commits the complete file set and removes superseded files", async () => {
    const root = await createBookFixture();

    await commitAtomicFileSet({
      rootDir: root,
      writes: [
        { relativePath: "chapters/0001_new.md", content: "new chapter" },
        { relativePath: "story/current_state.md", content: "new state" },
        { relativePath: "story/pending_hooks.md", content: "new hooks" },
      ],
      deletes: ["chapters/0001_old.md"],
    });

    await expect(readFile(join(root, "chapters", "0001_new.md"), "utf-8")).resolves.toBe("new chapter");
    await expect(readFile(join(root, "story", "current_state.md"), "utf-8")).resolves.toBe("new state");
    await expect(readFile(join(root, "story", "pending_hooks.md"), "utf-8")).resolves.toBe("new hooks");
    await expect(readdir(join(root, "chapters"))).resolves.toEqual(["0001_new.md"]);
  });

  it("restores every original file when commit fails after the first replacement", async () => {
    const root = await createBookFixture();
    let stagedRenameCount = 0;

    await expect(commitAtomicFileSet({
      rootDir: root,
      writes: [
        { relativePath: "chapters/0001_new.md", content: "new chapter" },
        { relativePath: "story/current_state.md", content: "new state" },
        { relativePath: "story/pending_hooks.md", content: "new hooks" },
      ],
      deletes: ["chapters/0001_old.md"],
      renameFile: async (from, to) => {
        if (from.includes("/staged/")) {
          stagedRenameCount += 1;
          if (stagedRenameCount === 2) {
            throw new Error("injected commit failure");
          }
        }
        await rename(from, to);
      },
    })).rejects.toThrow("injected commit failure");

    await expect(readFile(join(root, "chapters", "0001_old.md"), "utf-8")).resolves.toBe("old chapter");
    await expect(readFile(join(root, "story", "current_state.md"), "utf-8")).resolves.toBe("old state");
    await expect(readFile(join(root, "story", "pending_hooks.md"), "utf-8")).resolves.toBe("old hooks");
    await expect(readdir(join(root, "chapters"))).resolves.toEqual(["0001_old.md"]);
  });

  it("preserves the transaction and remaining backup when rollback is incomplete", async () => {
    const root = await createBookFixture();
    let stagedRenameCount = 0;

    await expect(commitAtomicFileSet({
      rootDir: root,
      writes: [
        { relativePath: "chapters/0001_new.md", content: "new chapter" },
        { relativePath: "story/current_state.md", content: "new state" },
        { relativePath: "story/pending_hooks.md", content: "new hooks" },
      ],
      deletes: ["chapters/0001_old.md"],
      renameFile: async (from, to) => {
        if (from.includes("/staged/")) {
          stagedRenameCount += 1;
          if (stagedRenameCount === 2) throw new Error("injected commit failure");
        }
        if (from.includes("/backup/story/current_state.md")) {
          throw new Error("injected rollback failure");
        }
        await rename(from, to);
      },
    })).rejects.toThrow(/rollback was incomplete/);

    const transactionName = (await readdir(root)).find((entry) => entry.startsWith(".inkos-file-txn-"));
    expect(transactionName).toBeDefined();
    const transactionDir = join(root, transactionName!);
    await expect(readFile(join(transactionDir, "phase"), "utf8")).resolves.toBe("prepared\n");
    await expect(readFile(join(transactionDir, "backup", "story", "current_state.md"), "utf8"))
      .resolves.toBe("old state");

    await recoverAtomicFileSets(root);

    await expect(readFile(join(root, "story", "current_state.md"), "utf8")).resolves.toBe("old state");
    expect((await readdir(root)).some((entry) => entry.startsWith(".inkos-file-txn-"))).toBe(false);
  });

  it("rolls back a synthetic abandoned prepared transaction", async () => {
    const root = await createBookFixture();
    const transactionDir = join(root, ".inkos-file-txn-abandoned-prepared");
    await Promise.all([
      mkdir(join(transactionDir, "backup", "story"), { recursive: true }),
      mkdir(join(transactionDir, "backup", "chapters"), { recursive: true }),
      mkdir(join(transactionDir, "staged", "story"), { recursive: true }),
    ]);
    await writeFile(join(transactionDir, "manifest.json"), JSON.stringify({
      version: 1,
      entries: [
        { relativePath: "story/current_state.md", operation: "write", hadOriginal: true },
        { relativePath: "chapters/created.md", operation: "write", hadOriginal: false },
        { relativePath: "chapters/0001_old.md", operation: "delete", hadOriginal: true },
      ],
    }), "utf8");
    await writeFile(join(transactionDir, "phase"), "prepared\n", "utf8");
    await rename(
      join(root, "story", "current_state.md"),
      join(transactionDir, "backup", "story", "current_state.md"),
    );
    await rename(
      join(root, "chapters", "0001_old.md"),
      join(transactionDir, "backup", "chapters", "0001_old.md"),
    );
    await Promise.all([
      writeFile(join(root, "story", "current_state.md"), "interrupted new state", "utf8"),
      writeFile(join(root, "chapters", "created.md"), "interrupted new chapter", "utf8"),
      writeFile(join(transactionDir, "staged", "story", "pending.md"), "staged residue", "utf8"),
    ]);

    await recoverAtomicFileSets(root);

    await expect(readFile(join(root, "story", "current_state.md"), "utf8")).resolves.toBe("old state");
    await expect(readFile(join(root, "chapters", "0001_old.md"), "utf8")).resolves.toBe("old chapter");
    await expect(readFile(join(root, "chapters", "created.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).some((entry) => entry.startsWith(".inkos-file-txn-"))).toBe(false);
  });

  it("keeps committed targets and cleans a synthetic committed transaction", async () => {
    const root = await createBookFixture();
    const transactionDir = join(root, ".inkos-file-txn-abandoned-committed");
    await mkdir(join(transactionDir, "backup", "story"), { recursive: true });
    await writeFile(join(transactionDir, "manifest.json"), JSON.stringify({
      version: 1,
      entries: [
        { relativePath: "story/current_state.md", operation: "write", hadOriginal: true },
      ],
    }), "utf8");
    await writeFile(join(transactionDir, "phase"), "committed\n", "utf8");
    await rename(
      join(root, "story", "current_state.md"),
      join(transactionDir, "backup", "story", "current_state.md"),
    );
    await writeFile(join(root, "story", "current_state.md"), "committed new state", "utf8");

    await recoverAtomicFileSets(root);

    await expect(readFile(join(root, "story", "current_state.md"), "utf8")).resolves.toBe("committed new state");
    expect((await readdir(root)).some((entry) => entry.startsWith(".inkos-file-txn-"))).toBe(false);
  });
});
