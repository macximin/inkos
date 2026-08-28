import { Command } from "commander";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  StateManager,
  PipelineRunner,
  ReferenceTransformationHilStore,
  StoryRailReflowStore,
  buildFireflyReviewPackets,
  FireflyReviewDecisionSchema,
  FireflyReviewPacketSchema,
  assertFireflyReviewPacketIdentity,
  formatLengthCount,
  readGenreProfile,
  resolveLengthCountingMode,
  rebuildApprovedFutureAdvantageCanon,
  assertChapterApprovalReady,
  type ChapterMeta,
  type StoryRailReflowPrepareResult,
} from "@actalk/inkos-core";
import { buildPipelineConfig, findProjectRoot, loadConfig, resolveBookId, log, logError } from "../utils.js";

export const reviewCommand = new Command("review")
  .description("Review and approve chapters");

reviewCommand
  .command("export-storyyard")
  .description("Export prepared chapter candidates as immutable Storyyard review packets")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--out <path>", "Output directory or .json path")
  .option("--source-revision <revision>", "Source revision label (defaults to Book updatedAt)")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const state = new StateManager(root);
      const [book, chapters, candidates] = await Promise.all([
        state.loadBookConfig(bookId),
        state.loadChapterIndex(bookId),
        new ReferenceTransformationHilStore(state.bookDir(bookId)).list(),
      ]);
      const packets = buildFireflyReviewPackets({
        book,
        chapters,
        candidates,
        sourceRevision: opts.sourceRevision?.trim() || book.updatedAt,
      });
      if (packets.length === 0) throw new Error(`Book ${JSON.stringify(bookId)} has no prepared HIL candidates.`);

      const requested = opts.out
        ? resolve(root, opts.out)
        : resolve(root, ".inkos", "exports", "storyyard", bookId);
      const relativeOutput = relative(root, requested);
      if (isAbsolute(relativeOutput) || relativeOutput === ".." || relativeOutput.startsWith(`..${sep}`)) {
        throw new Error("Storyyard review packet output must stay inside the InkOS project.");
      }
      const singleFile = packets.length === 1 && requested.endsWith(".json");
      const outputs: Array<{ path: string; sha256: string; packetId: string }> = [];
      for (const packet of packets) {
        const output = singleFile ? requested : join(requested, `${packet.packetId}.json`);
        const serialized = `${JSON.stringify(packet, null, 2)}\n`;
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, serialized, "utf8");
        outputs.push({
          path: relative(root, output).split(sep).join("/"),
          sha256: createHash("sha256").update(serialized).digest("hex"),
          packetId: packet.packetId,
        });
      }
      if (opts.json) {
        log(JSON.stringify({
          bookId,
          packets: outputs,
          artifacts: outputs.map((output) => ({
            repo: "inkos",
            path: output.path,
            sha256: output.sha256,
            role: "storyyard-review-packet",
          })),
        }));
      } else {
        for (const output of outputs) log(`Storyyard review packet ${output.packetId}: ${output.path}`);
      }
    } catch (e) {
      if (opts.json) log(JSON.stringify({ error: String(e) }));
      else logError(`Failed to export Storyyard review packet: ${e}`);
      process.exitCode = 1;
    }
  });

reviewCommand
  .command("apply-storyyard")
  .description("Validate and apply one pending Storyyard decision inside InkOS authority")
  .argument("<decision-path>", "firefly_review_decision/v1 JSON file")
  .requiredOption("--packet <path>", "Matching firefly_review_packet/v1 JSON file")
  .option("--json", "Output JSON")
  .action(async (decisionPath: string, opts) => {
    try {
      const root = findProjectRoot();
      const decision = FireflyReviewDecisionSchema.parse(JSON.parse(await readFile(resolve(root, decisionPath), "utf8")));
      const packet = FireflyReviewPacketSchema.parse(JSON.parse(await readFile(resolve(root, opts.packet), "utf8")));
      assertFireflyReviewPacketIdentity(packet);
      if (decision.status !== "pending") throw new Error(`Storyyard decision is already ${decision.status}.`);
      if (decision.packetId !== packet.packetId || decision.packetSha256 !== packet.packetSha256) {
        throw new Error("Storyyard decision does not match the review packet identity.");
      }
      if (decision.workId !== packet.work.id || decision.artifactId !== packet.artifact.id) {
        throw new Error("Storyyard decision work or artifact does not match the review packet.");
      }
      const candidate = packet.candidates.find((item) => item.id === decision.candidateId);
      if (!candidate || candidate.sha256 !== decision.candidateSha256) {
        throw new Error("Storyyard decision candidate does not match the review packet.");
      }
      const state = new StateManager(root);
      const bookId = await resolveBookId(decision.workId, root);
      let result: unknown;
      if (decision.decision === "approve") {
        const config = await loadConfig();
        result = await new PipelineRunner(buildPipelineConfig(config, root)).applyReferenceHilCandidate({
          bookId,
          chapterNumber: packet.artifact.chapterNumber,
          candidateId: candidate.id,
          actorId: `storyyard:${decision.decisionId}`,
          actorRole: "owner",
          interface: "storyyard",
          expectedCurrentContentSha256: packet.artifact.currentContentSha256,
          expectedCandidateContentSha256: candidate.sha256,
        });
      } else {
        const release = await state.acquireBookLock(bookId);
        try {
          const store = new ReferenceTransformationHilStore(state.bookDir(bookId));
          const current = (await store.list()).find((view) => view.candidate.candidateId === candidate.id);
          if (!current || current.candidate.chapterNumber !== packet.artifact.chapterNumber) {
            throw new Error("Storyyard decision candidate is missing from the canonical InkOS Book.");
          }
          if (current.candidate.candidateContentSha256 !== candidate.sha256 || !current.currentChapterMatchesPreparation) {
            throw new Error("InkOS candidate or current manuscript changed after Storyyard export.");
          }
          if (decision.decision === "polish") {
            result = await store.requestPolish(packet.artifact.chapterNumber, candidate.id);
          } else if (decision.decision === "reject") {
            result = await store.reject(packet.artifact.chapterNumber, candidate.id);
          } else {
            result = { status: "held", candidateId: candidate.id };
          }
        } finally {
          await release();
        }
      }
      const receiptRelease = await state.acquireBookLock(bookId);
      try {
        const receiptPath = join("books", bookId, "story", "review-decisions", `${decision.decisionId}.json`);
        const applied = {
          ...decision,
          status: "applied" as const,
          appliedAt: new Date().toISOString(),
          applyReceiptPath: receiptPath.split(sep).join("/"),
          result,
        };
        await mkdir(dirname(join(root, receiptPath)), { recursive: true });
        await writeFile(join(root, receiptPath), `${JSON.stringify(applied, null, 2)}\n`, "utf8");
        log(JSON.stringify({ decision: applied }, null, opts.json ? 0 : 2));
      } finally {
        await receiptRelease();
      }
    } catch (error) {
      if (opts.json) log(JSON.stringify({ error: String(error) }));
      else logError(`Storyyard decision apply failed: ${String(error)}`);
      process.exitCode = 1;
    }
  });

reviewCommand
  .command("list")
  .description("List chapters pending review")
  .argument("[book-id]", "Book ID (optional, lists all books if omitted)")
  .option("--json", "Output JSON")
  .action(async (bookId: string | undefined, opts) => {
    try {
      const root = findProjectRoot();
      const state = new StateManager(root);

      const bookIds = bookId ? [bookId] : await state.listBooks();
      const allPending: Array<{
        readonly bookId: string;
        readonly title: string;
        readonly chapter: number;
        readonly chapterTitle: string;
        readonly wordCount: number;
        readonly status: string;
        readonly issues: ReadonlyArray<string>;
      }> = [];

      for (const id of bookIds) {
        const index = await state.loadChapterIndex(id);
        const pending = index.filter(
          (ch) =>
            ch.status === "ready-for-review" || ch.status === "audit-failed",
        );

        if (pending.length === 0) continue;

        const book = await state.loadBookConfig(id);
        const { profile: genreProfile } = await readGenreProfile(root, book.genre);
        const countingMode = resolveLengthCountingMode(book.language ?? genreProfile.language);

        if (!opts.json) {
          log(`\n${book.title} (${id}):`);
        }
        for (const ch of pending) {
          allPending.push({
            bookId: id,
            title: book.title,
            chapter: ch.number,
            chapterTitle: ch.title,
            wordCount: ch.wordCount,
            status: ch.status,
            issues: ch.auditIssues,
          });
          if (!opts.json) {
            log(
              `  Ch.${ch.number} "${ch.title}" | ${formatLengthCount(ch.wordCount, countingMode)} | ${ch.status}`,
            );
            if (ch.auditIssues.length > 0) {
              for (const issue of ch.auditIssues) {
                log(`    - ${issue}`);
              }
            }
          }
        }
      }

      if (opts.json) {
        log(JSON.stringify({ pending: allPending }, null, 2));
      } else if (allPending.length === 0) {
        log("No chapters pending review.");
      }
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to list reviews: ${e}`);
      }
      process.exit(1);
    }
  });

/**
 * Parse "[book-id] <chapter>" style arguments from variadic args.
 * Supports: "3" (auto-detect book) or "my-book 3"
 */
function parseBookAndChapter(
  args: ReadonlyArray<string>,
): { readonly bookIdArg: string | undefined; readonly chapterNum: number } {
  if (args.length === 1) {
    const num = parseInt(args[0]!, 10);
    if (isNaN(num)) {
      throw new Error(`Expected chapter number, got "${args[0]}"`);
    }
    return { bookIdArg: undefined, chapterNum: num };
  }
  if (args.length === 2) {
    const num = parseInt(args[1]!, 10);
    if (isNaN(num)) {
      throw new Error(`Expected chapter number as second argument, got "${args[1]}"`);
    }
    return { bookIdArg: args[0], chapterNum: num };
  }
  throw new Error("Usage: inkos review approve [book-id] <chapter>");
}

async function withBookReviewLock<T>(
  state: StateManager,
  bookId: string,
  action: () => Promise<T>,
): Promise<T> {
  const releaseLock = await state.acquireBookLock(bookId);
  try {
    return await action();
  } finally {
    await releaseLock();
  }
}

interface OptionalStoryRailReflowResult {
  readonly railReflow?: StoryRailReflowPrepareResult;
  readonly railReflowWarning?: string;
}

async function prepareOptionalStoryRailReflow(
  state: StateManager,
  bookId: string,
  chapters: ReadonlyArray<ChapterMeta>,
): Promise<OptionalStoryRailReflowResult> {
  try {
    return {
      railReflow: await new StoryRailReflowStore(state.bookDir(bookId)).prepare(bookId, chapters),
    };
  } catch (error) {
    return {
      railReflowWarning: error instanceof Error ? error.message : String(error),
    };
  }
}

function logOptionalStoryRailReflow(result: OptionalStoryRailReflowResult): void {
  if (result.railReflow?.status === "pending" || result.railReflow?.status === "already-pending") {
    const pending = result.railReflow.pending;
    log(
      `Story Rail reflow ${result.railReflow.status}: ${pending.pendingId} closes `
      + `${pending.activeB.bId}/${pending.activeB.arcId} through chapter ${pending.endpointChapterNumber} `
      + `(${pending.actualEpisodeCount} chapter(s)).`,
    );
    return;
  }
  if (result.railReflow?.status === "not-eligible") {
    log(
      `Story Rail reflow not prepared (${result.railReflow.reason}): ${result.railReflow.message}`,
    );
    return;
  }
  if (result.railReflowWarning) {
    log(`[warning] Story Rail reflow preparation failed: ${result.railReflowWarning}`);
  }
}

reviewCommand
  .command("approve")
  .description("Approve a chapter and commit its state: approve [book-id] <chapter>")
  .argument("<args...>", "Book ID (optional) and chapter number")
  .option("--json", "Output JSON")
  .action(async (args: ReadonlyArray<string>, opts) => {
    try {
      const root = findProjectRoot();
      const { bookIdArg, chapterNum } = parseBookAndChapter(args);
      const bookId = await resolveBookId(bookIdArg, root);

      const state = new StateManager(root);
      await withBookReviewLock(state, bookId, async () => {
        const index = [...(await state.loadChapterIndex(bookId))];
        const idx = index.findIndex((ch) => ch.number === chapterNum);
        if (idx === -1) {
          throw new Error(`Chapter ${chapterNum} not found in "${bookId}"`);
        }

        await assertChapterApprovalReady({
          bookDir: state.bookDir(bookId),
          bookId,
          chapter: index[idx]!,
        });

        const originalIndex = index.map((chapter) => ({ ...chapter }));
        index[idx] = {
          ...index[idx]!,
          status: "approved",
          updatedAt: new Date().toISOString(),
        };
        await state.saveChapterIndex(bookId, index);
        let futureAdvantageCanon;
        try {
          futureAdvantageCanon = await rebuildApprovedFutureAdvantageCanon({
            bookDir: state.bookDir(bookId),
            chapters: index,
          });
        } catch (error) {
          await state.saveChapterIndex(bookId, originalIndex);
          throw error;
        }
        const railReflow = await prepareOptionalStoryRailReflow(state, bookId, index);

        if (opts.json) {
          log(JSON.stringify({
            bookId,
            chapter: chapterNum,
            status: "approved",
            futureAdvantageCanon,
            ...railReflow,
          }));
        } else {
          log(`Chapter ${chapterNum} approved (state committed).`);
          logOptionalStoryRailReflow(railReflow);
        }
      });
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to approve: ${e}`);
      }
      process.exit(1);
    }
  });

reviewCommand
  .command("approve-all")
  .description("Approve all pending chapters for a book")
  .argument("[book-id]", "Book ID (auto-detected if only one book)")
  .option("--json", "Output JSON")
  .action(async (bookIdArg: string | undefined, opts) => {
    try {
      const root = findProjectRoot();
      const bookId = await resolveBookId(bookIdArg, root);
      const state = new StateManager(root);
      await withBookReviewLock(state, bookId, async () => {
        const index = [...(await state.loadChapterIndex(bookId))];
        let count = 0;
        const now = new Date().toISOString();

        const updated = [...index];
        for (let chapterIndex = 0; chapterIndex < updated.length; chapterIndex += 1) {
          const chapter = updated[chapterIndex]!;
          if (chapter.status !== "ready-for-review") continue;
          await assertChapterApprovalReady({
            bookDir: state.bookDir(bookId),
            bookId,
            chapter,
          });
          count += 1;
          updated[chapterIndex] = { ...chapter, status: "approved" as const, updatedAt: now };
        }

        await state.saveChapterIndex(bookId, updated);
        let futureAdvantageCanon;
        try {
          futureAdvantageCanon = await rebuildApprovedFutureAdvantageCanon({
            bookDir: state.bookDir(bookId),
            chapters: updated,
          });
        } catch (error) {
          await state.saveChapterIndex(bookId, index);
          throw error;
        }
        const railReflow = await prepareOptionalStoryRailReflow(state, bookId, updated);

        if (opts.json) {
          log(JSON.stringify({ bookId, approvedCount: count, futureAdvantageCanon, ...railReflow }));
        } else {
          log(`${count} chapter(s) approved.`);
          logOptionalStoryRailReflow(railReflow);
        }
      });
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to approve: ${e}`);
      }
      process.exit(1);
    }
  });

reviewCommand
  .command("reject")
  .description("Reject a chapter and roll back state: reject [book-id] <chapter>")
  .argument("<args...>", "Book ID (optional) and chapter number")
  .option("--reason <reason>", "Rejection reason")
  .option("--keep-subsequent", "Only reject this chapter, do not discard subsequent chapters")
  .option("--json", "Output JSON")
  .action(async (args: ReadonlyArray<string>, opts) => {
    try {
      const root = findProjectRoot();
      const { bookIdArg, chapterNum } = parseBookAndChapter(args);
      const bookId = await resolveBookId(bookIdArg, root);

      const state = new StateManager(root);
      await withBookReviewLock(state, bookId, async () => {
        const index = await state.loadChapterIndex(bookId);
        const idx = index.findIndex((ch) => ch.number === chapterNum);
        if (idx === -1) {
          throw new Error(`Chapter ${chapterNum} not found in "${bookId}"`);
        }

        if (opts.keepSubsequent) {
          // Legacy behavior: only mark as rejected, no state rollback
          const updated = [...index];
          updated[idx] = {
            ...updated[idx]!,
            status: "rejected",
            reviewNote: opts.reason ?? "Rejected without reason",
            updatedAt: new Date().toISOString(),
          };
          await state.saveChapterIndex(bookId, updated);

          if (opts.json) {
            log(JSON.stringify({ bookId, chapter: chapterNum, status: "rejected", discarded: [] }));
          } else {
            log(`Chapter ${chapterNum} rejected (state not rolled back).`);
          }
          return;
        }

        // Default: roll back state to before the rejected chapter and discard
        // it along with all subsequent chapters that depend on its state.
        const rollbackTarget = chapterNum - 1;
        const discarded = await state.rollbackToChapter(bookId, rollbackTarget);

        if (opts.json) {
          log(JSON.stringify({
            bookId,
            chapter: chapterNum,
            status: "rejected",
            rolledBackTo: rollbackTarget,
            discarded,
          }));
        } else {
          log(`Chapter ${chapterNum} rejected. State rolled back to chapter ${rollbackTarget}.`);
          if (discarded.length > 1) {
            log(`  Also discarded ${discarded.length - 1} subsequent chapter(s): ${discarded.filter((n) => n !== chapterNum).join(", ")}`);
          }
        }
      });
    } catch (e) {
      if (opts.json) {
        log(JSON.stringify({ error: String(e) }));
      } else {
        logError(`Failed to reject: ${e}`);
      }
      process.exit(1);
    }
  });
