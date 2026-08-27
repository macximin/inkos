import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createProjectSession,
  loadProjectSession,
  persistProjectSession,
  resolveSessionActiveBook,
} from "../tui/session-store.js";

let projectRoot: string;

async function createCompleteBook(root: string, bookId: string): Promise<void> {
  const bookDir = join(root, "books", bookId);
  const storyDir = join(bookDir, "story");
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  await mkdir(storyDir, { recursive: true });
  await Promise.all([
    writeFile(join(bookDir, "book.json"), JSON.stringify({ id: bookId }), "utf-8"),
    writeFile(join(storyDir, "story_bible.md"), "# Story Bible\n", "utf-8"),
    writeFile(join(storyDir, "volume_outline.md"), "# Volume Outline\n", "utf-8"),
    writeFile(join(storyDir, "book_rules.md"), "# Book Rules\n", "utf-8"),
    writeFile(join(storyDir, "current_state.md"), "# Current State\n", "utf-8"),
    writeFile(join(storyDir, "pending_hooks.md"), "# Pending Hooks\n", "utf-8"),
    writeFile(join(bookDir, "chapters", "index.json"), "[]", "utf-8"),
  ]);
}

describe("tui session store", () => {
  beforeAll(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "inkos-tui-session-"));
    await mkdir(join(projectRoot, "books"), { recursive: true });
  });

  afterAll(async () => {
    // no cleanup needed, tmpdir
  });

  it("creates a default project session", () => {
    const session = createProjectSession(projectRoot);
    expect(session.projectRoot).toBe(projectRoot);
    expect(session.automationMode).toBe("semi");
    expect(session.messages).toEqual([]);
  });

  it("persists and reloads the session", async () => {
    const session = {
      ...createProjectSession(projectRoot),
      activeBookId: "night-harbor",
      automationMode: "auto" as const,
    };

    await persistProjectSession(projectRoot, session);
    const reloaded = await loadProjectSession(projectRoot);

    expect(reloaded.activeBookId).toBe("night-harbor");
    expect(reloaded.automationMode).toBe("auto");
  });

  it("resolves active book from session when it still exists", async () => {
    await createCompleteBook(projectRoot, "night-harbor");

    const session = {
      ...createProjectSession(projectRoot),
      activeBookId: "night-harbor",
    };

    expect(await resolveSessionActiveBook(projectRoot, session)).toBe("night-harbor");
  });

  it("falls back to the only book in the project", async () => {
    const singleRoot = await mkdtemp(join(tmpdir(), "inkos-tui-single-"));
    await createCompleteBook(singleRoot, "single-book");

    const session = createProjectSession(singleRoot);
    expect(await resolveSessionActiveBook(singleRoot, session)).toBe("single-book");
  });

  it("returns undefined when multiple books exist and no valid active binding is stored", async () => {
    const multiRoot = await mkdtemp(join(tmpdir(), "inkos-tui-multi-"));
    await createCompleteBook(multiRoot, "book-a");
    await createCompleteBook(multiRoot, "book-b");

    const session = createProjectSession(multiRoot);
    expect(await resolveSessionActiveBook(multiRoot, session)).toBeUndefined();
  });
});
