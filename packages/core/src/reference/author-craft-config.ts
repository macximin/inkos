import { BookConfigSchema } from "../models/book.js";
import { AuthorCraftConfigSchema, type AuthorCraftConfig } from "../models/author-craft.js";
import { StateManager } from "../state/manager.js";
import { runBookMutationTransaction } from "../state/book-mutation-journal.js";
import { readGenreProfile } from "../agents/rules-reader.js";
import { loadAuthorCraftPack, resolveAuthorCraftInputReceipt, selectAuthorCraftContext } from "./author-craft.js";

/** Explicit CLI configuration, not human-review or canon promotion. */
export async function configureBookAuthorCraft(projectRoot: string, bookId: string, input: AuthorCraftConfig | undefined) {
  const state = new StateManager(projectRoot);
  const release = await state.acquireBookLock(bookId);
  try {
    const book = await state.loadBookConfig(bookId);
    const config = input === undefined ? undefined : AuthorCraftConfigSchema.parse(input);
    const language = config ? book.language ?? (await readGenreProfile(projectRoot, book.genre)).profile.language : undefined;
    const receipt = config ? await resolveAuthorCraftInputReceipt(projectRoot, config, language!) : null;
    if (config) {
      // Validate requested IDs before persisting even if they are for another stage.
      selectAuthorCraftContext({ pack: await loadAuthorCraftPack(projectRoot, config.packSha256), config, stage: "planning", query: "" });
    }
    const previous = book.writing?.authorCraft === undefined ? undefined : AuthorCraftConfigSchema.parse(book.writing.authorCraft);
    const changed = JSON.stringify(previous) !== JSON.stringify(config);
    if (changed) {
      const writing = { ...book.writing };
      if (config) writing.authorCraft = config;
      else delete writing.authorCraft;
      const updated = { ...book, writing, updatedAt: new Date().toISOString() };
      // Validate while preserving unrelated extension fields from the loaded file.
      BookConfigSchema.parse(updated);
      await runBookMutationTransaction({
        bookDir: state.bookDir(bookId), kind: "author-craft-config", relativePaths: ["book.json"],
        persist: () => state.saveBookConfig(bookId, updated),
      });
    }
    return { bookId, enabled: config !== undefined, changed, config: config ?? null, receipt: receipt ?? null };
  } finally { await release(); }
}
