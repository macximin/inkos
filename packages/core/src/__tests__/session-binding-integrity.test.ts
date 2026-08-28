import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  migrateBookSession,
  persistBookSession,
  SessionAlreadyMigratedError,
} from "../interaction/book-session-store.js";
import { createBookSession } from "../interaction/session.js";
import {
  appendTranscriptEvents,
  readTranscriptEventsStrict,
  TranscriptIntegrityError,
  transcriptPath,
} from "../interaction/session-transcript.js";
import { restoreAgentMessagesFromTranscript } from "../interaction/session-transcript-restore.js";

describe("strict transcript session binding", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "inkos-binding-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("rejects malformed transcript bytes before history restore", async () => {
    await mkdir(join(projectRoot, ".inkos", "sessions"), { recursive: true });
    await writeFile(transcriptPath(projectRoot, "bad"), "{not-json\n", "utf8");

    await expect(restoreAgentMessagesFromTranscript(projectRoot, "bad")).rejects.toMatchObject({
      name: "TranscriptIntegrityError",
      code: "malformed-line",
    });
  });

  it("allows one null-to-Book migration but rejects Book and kind drift", async () => {
    const sessionId = "migrate-once";
    await appendTranscriptEvents(projectRoot, sessionId, () => [{
      type: "session_created",
      version: 1,
      sessionId,
      seq: 0,
      timestamp: 0,
      bookId: null,
      sessionKind: "book-create",
      title: null,
      createdAt: 0,
      updatedAt: 0,
    }]);
    await appendTranscriptEvents(projectRoot, sessionId, ({ nextSeq }) => [{
      type: "session_metadata_updated",
      version: 1,
      sessionId,
      seq: nextSeq,
      timestamp: 1,
      updatedAt: 1,
      bookId: "book-a",
      sessionKind: "book",
    }]);

    await expect(appendTranscriptEvents(projectRoot, sessionId, ({ nextSeq }) => [{
      type: "session_metadata_updated",
      version: 1,
      sessionId,
      seq: nextSeq,
      timestamp: 2,
      updatedAt: 2,
      bookId: "book-b",
    }])).rejects.toBeInstanceOf(TranscriptIntegrityError);
    await expect(appendTranscriptEvents(projectRoot, sessionId, ({ nextSeq }) => [{
      type: "session_metadata_updated",
      version: 1,
      sessionId,
      seq: nextSeq,
      timestamp: 2,
      updatedAt: 2,
      sessionKind: "edit",
    }])).rejects.toBeInstanceOf(TranscriptIntegrityError);
  });

  it("serializes concurrent migration so only one Book can win", async () => {
    const session = createBookSession(null, "migration-race", "book-create");
    await persistBookSession(projectRoot, session);

    const results = await Promise.allSettled([
      migrateBookSession(projectRoot, session.sessionId, "book-a"),
      migrateBookSession(projectRoot, session.sessionId, "book-b"),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(SessionAlreadyMigratedError);
    const events = await readTranscriptEventsStrict(projectRoot, session.sessionId);
    const bookUpdates = events.filter((event) => event.type === "session_metadata_updated" && event.bookId);
    expect(bookUpdates).toHaveLength(1);
  });

  it("rejects duplicate or non-leading session_created headers", async () => {
    const sessionId = "duplicate-header";
    await expect(appendTranscriptEvents(projectRoot, sessionId, () => [
      {
        type: "session_created",
        version: 1,
        sessionId,
        seq: 0,
        timestamp: 0,
        bookId: null,
        title: null,
        createdAt: 0,
        updatedAt: 0,
      },
      {
        type: "session_created",
        version: 1,
        sessionId,
        seq: 1,
        timestamp: 1,
        bookId: null,
        title: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ])).rejects.toMatchObject({ code: "invalid-header" });
  });
});
