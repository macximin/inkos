import { Command } from "commander";
import {
  AuthorCraftConfigSchema, AuthorCraftStageSchema, installAuthorCraftPack,
  loadAuthorCraftPack, selectAuthorCraftContext, configureBookAuthorCraft, StateManager, readAuthorCraftHistory,
} from "@actalk/inkos-core";
import { findProjectRoot, resolveBookId, log, logError } from "../utils.js";

function failed(error: unknown) {
  logError(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function selectionOptions(command: Command) {
  return command
    .option("--case <id...>", "Select explicit case IDs instead of query matching")
    .option("--max-cases <number>", "Maximum selected cases", "3")
    .option("--max-characters <number>", "Maximum rendered advisory characters", "6000");
}

function configFromOptions(options: { pack: string; case?: string[]; maxCases: string; maxCharacters: string }) {
  return AuthorCraftConfigSchema.parse({ packSha256: options.pack, ...(options.case ? { caseIds: options.case } : {}), maxCases: Number(options.maxCases), maxCharacters: Number(options.maxCharacters) });
}

export const craftCommand = new Command("craft")
  .description("Install, preview, and select advisory author-craft inputs without generating prose");

craftCommand.command("status")
  .argument("[book-id]", "Book ID")
  .description("Inspect the current selection and verify its installed pack without changing the Book")
  .action(async (bookIdArg: string | undefined) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const book = await new StateManager(root).loadBookConfig(bookId);
      const config = book.writing?.authorCraft === undefined ? undefined : AuthorCraftConfigSchema.parse(book.writing.authorCraft);
      if (!config) { log(JSON.stringify({ bookId, enabled: false, config: null }, null, 2)); return; }
      const pack = await loadAuthorCraftPack(root, config.packSha256);
      // The selector verifies explicit IDs too, even when a stage selects none.
      selectAuthorCraftContext({ pack, config, stage: "planning", query: "" });
      log(JSON.stringify({
        bookId, enabled: true, config, pack: { id: pack.id, language: pack.language, authority: pack.authority },
        selectionMode: config.caseIds === undefined ? "query" : "explicit",
        eligibleCases: pack.cases.filter((entry) => config.caseIds === undefined || config.caseIds.includes(entry.id))
          .map((entry) => ({ id: entry.id, title: entry.title, stages: entry.stages })),
      }, null, 2));
    } catch (error) { failed(error); }
  });

craftCommand.command("history")
  .argument("[book-id]", "Book ID")
  .option("--chapter <number>", "Only this chapter's recorded inputs")
  .option("--stage <stage>", "planning, writing, or revision")
  .description("Read and verify recorded selections without printing their source text")
  .action(async (bookIdArg: string | undefined, options) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const records = await readAuthorCraftHistory(new StateManager(root).bookDir(bookId), {
        ...(options.chapter === undefined ? {} : { chapterNumber: Number(options.chapter) }),
        ...(options.stage === undefined ? {} : { stage: AuthorCraftStageSchema.parse(options.stage) }),
      });
      const invalidRecords = records.filter((entry) => !entry.valid).length;
      log(JSON.stringify({ bookId, recordCount: records.length, invalidRecords, records }, null, 2));
      if (invalidRecords > 0) process.exitCode = 1;
    } catch (error) { failed(error); }
  });

craftCommand.command("import")
  .argument("<path>", "Path to an author-craft-pack/v1 JSON file")
  .description("Validate and import immutable data; does not enable any Book")
  .action(async (path: string) => {
    try { log(JSON.stringify(await installAuthorCraftPack(findProjectRoot(), path), null, 2)); }
    catch (error) { failed(error); }
  });

selectionOptions(craftCommand.command("preview")
  .requiredOption("--pack <sha256>", "Installed pack SHA-256")
  .option("--stage <stage>", "planning, writing, or revision", "writing")
  .option("--query <text>", "Current scene problem", "")
  .option("--json", "Include selection receipt with rendered input")
  .description("Preview exact selected input; no model calls or Book changes"))
  .action(async (options) => {
    try {
      const config = configFromOptions(options);
      const pack = await loadAuthorCraftPack(findProjectRoot(), config.packSha256);
      const selected = selectAuthorCraftContext({ pack, config, stage: AuthorCraftStageSchema.parse(options.stage), query: options.query });
      log(options.json ? JSON.stringify(selected, null, 2) : selected.rendered || "No matching craft cases.");
    } catch (error) { failed(error); }
  });

selectionOptions(craftCommand.command("enable")
  .argument("[book-id]", "Book ID")
  .requiredOption("--pack <sha256>", "Installed pack SHA-256")
  .description("Select advisory input for one Book; preserves review settings and canon"))
  .action(async (bookIdArg: string | undefined, options) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      log(JSON.stringify(await configureBookAuthorCraft(root, bookId, configFromOptions(options)), null, 2));
    } catch (error) { failed(error); }
  });

craftCommand.command("disable")
  .argument("[book-id]", "Book ID")
  .description("Remove the selection; keep packs, receipts, and manuscripts")
  .action(async (bookIdArg: string | undefined) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      log(JSON.stringify(await configureBookAuthorCraft(root, bookId, undefined), null, 2));
    } catch (error) { failed(error); }
  });
