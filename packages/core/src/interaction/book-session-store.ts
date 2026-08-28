import { readdir, unlink } from "node:fs/promises";
import { createBookSession } from "./session.js";
import type { BookSession, PlayMode, SessionKind } from "./session.js";
import { SessionSoulBindingSchema, type SessionSoulBinding } from "../production/soul-schema.js";
import { hashCanonical } from "../production/production-input.js";
import { loadActiveBookSoulSessionBinding } from "../production/book-soul-binding.js";
import {
  appendTranscriptEvents,
  deriveTranscriptSessionBinding,
  legacyBookSessionPath,
  readTranscriptEventsStrict,
  sessionsDir,
  transcriptPath,
} from "./session-transcript.js";
import {
  migrateLegacyBookSessionToTranscript,
  readLegacyBookSession,
} from "./session-transcript-legacy.js";
import { deriveBookSessionFromTranscript } from "./session-transcript-restore.js";

/**
 * 从 messages 数组里取第一条 user 消息，裁剪成 ≤20 字的单行字符串。
 * 用于把用户首条提问作为会话标题。
 */
export function extractFirstUserMessageTitle(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if ((message as { role?: unknown }).role !== "user") continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content !== "string") return null;
    const oneLine = content.trim().replace(/\s+/g, " ");
    if (oneLine.length === 0) return null;
    return oneLine.length > 20 ? `${oneLine.slice(0, 20)}…` : oneLine;
  }
  return null;
}

export class SessionAlreadyMigratedError extends Error {
  constructor(sessionId: string, currentBookId: string) {
    super(`Session "${sessionId}" is already bound to book "${currentBookId}"`);
    this.name = "SessionAlreadyMigratedError";
  }
}

export class SessionBindingMismatchError extends Error {
  constructor(
    sessionId: string,
    field: "bookId" | "sessionKind" | "soulBinding",
    currentValue: unknown,
    requestedValue: unknown,
  ) {
    super(
      `Session "${sessionId}" ${field} is bound to ${JSON.stringify(currentValue)}, not ${JSON.stringify(requestedValue)}`,
    );
    this.name = "SessionBindingMismatchError";
  }
}

export async function loadBookSession(
  projectRoot: string,
  sessionId: string,
): Promise<BookSession | null> {
  const transcriptSession = await deriveBookSessionFromTranscript(projectRoot, sessionId);
  if (transcriptSession) return transcriptSession;

  const legacySession = await readLegacyBookSession(projectRoot, sessionId);
  if (!legacySession) return null;

  await migrateLegacyBookSessionToTranscript(projectRoot, legacySession);
  return await deriveBookSessionFromTranscript(projectRoot, sessionId) ?? legacySession;
}

async function appendSessionCreatedEvent(
  projectRoot: string,
  session: BookSession,
): Promise<void> {
  await appendTranscriptEvents(projectRoot, session.sessionId, ({ events, nextSeq }) => {
    const binding = deriveTranscriptSessionBinding(events, session.sessionId);
    if (binding) {
      if (binding.bookId !== session.bookId) {
        throw new SessionBindingMismatchError(
          session.sessionId,
          "bookId",
          binding.bookId,
          session.bookId,
        );
      }
      if (session.sessionKind && binding.sessionKind && binding.sessionKind !== session.sessionKind) {
        throw new SessionBindingMismatchError(
          session.sessionId,
          "sessionKind",
          binding.sessionKind,
          session.sessionKind,
        );
      }
      if (hashCanonical(binding.soulBinding ?? null) !== hashCanonical(session.soulBinding ?? null)) {
        throw new SessionBindingMismatchError(
          session.sessionId,
          "soulBinding",
          binding.soulBinding,
          session.soulBinding,
        );
      }
      if (
        (session.sessionKind && !binding.sessionKind)
        || (session.playMode && binding.playMode !== session.playMode)
      ) {
        return [{
          type: "session_metadata_updated",
          version: 1,
          sessionId: session.sessionId,
          seq: nextSeq,
          timestamp: session.updatedAt,
          updatedAt: session.updatedAt,
          ...(session.sessionKind && !binding.sessionKind ? { sessionKind: session.sessionKind } : {}),
          ...(session.playMode ? { playMode: session.playMode } : {}),
        }];
      }
      return [];
    }
    return [{
      type: "session_created",
      version: 1,
      sessionId: session.sessionId,
      seq: nextSeq,
      timestamp: session.createdAt,
      bookId: session.bookId,
      ...(session.sessionKind ? { sessionKind: session.sessionKind } : {}),
      ...(session.playMode ? { playMode: session.playMode } : {}),
      ...(session.soulBinding ? { soulBinding: session.soulBinding } : {}),
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    }];
  });
}

async function appendSessionMetadataUpdatedEvent(
  projectRoot: string,
  sessionId: string,
  metadata: {
    readonly bookId?: string | null;
    readonly sessionKind?: SessionKind;
    readonly playMode?: PlayMode;
    readonly soulBinding?: SessionSoulBinding;
    readonly title?: string | null;
    readonly updatedAt: number;
  },
): Promise<void> {
  await appendTranscriptEvents(projectRoot, sessionId, ({ nextSeq }) => [{
    type: "session_metadata_updated",
    version: 1,
    sessionId,
    seq: nextSeq,
    timestamp: metadata.updatedAt,
    updatedAt: metadata.updatedAt,
    ...("bookId" in metadata ? { bookId: metadata.bookId } : {}),
    ...(metadata.sessionKind ? { sessionKind: metadata.sessionKind } : {}),
    ...(metadata.playMode ? { playMode: metadata.playMode } : {}),
    ...(metadata.soulBinding ? { soulBinding: metadata.soulBinding } : {}),
    ...("title" in metadata ? { title: metadata.title } : {}),
  }]);
}

export async function persistBookSession(
  projectRoot: string,
  session: BookSession,
): Promise<void> {
  const events = await readTranscriptEventsStrict(projectRoot, session.sessionId);
  if (events.length === 0) {
    if (session.messages.length === 0) {
      await appendSessionCreatedEvent(projectRoot, session);
      return;
    }
    await migrateLegacyBookSessionToTranscript(projectRoot, session);
    return;
  }

  await appendTranscriptEvents(projectRoot, session.sessionId, ({ events: currentEvents, nextSeq }) => {
    const binding = deriveTranscriptSessionBinding(currentEvents, session.sessionId);
    if (!binding) throw new Error(`Session "${session.sessionId}" has no transcript header.`);
    if (binding.bookId !== session.bookId) {
      throw new SessionBindingMismatchError(
        session.sessionId,
        "bookId",
        binding.bookId,
        session.bookId,
      );
    }
    if (session.sessionKind && binding.sessionKind && binding.sessionKind !== session.sessionKind) {
      throw new SessionBindingMismatchError(
        session.sessionId,
        "sessionKind",
        binding.sessionKind,
        session.sessionKind,
      );
    }
    if (hashCanonical(binding.soulBinding ?? null) !== hashCanonical(session.soulBinding ?? null)) {
      throw new SessionBindingMismatchError(
        session.sessionId,
        "soulBinding",
        binding.soulBinding,
        session.soulBinding,
      );
    }
    return [{
      type: "session_metadata_updated",
      version: 1,
      sessionId: session.sessionId,
      seq: nextSeq,
      timestamp: session.updatedAt,
      updatedAt: session.updatedAt,
      ...(session.sessionKind && !binding.sessionKind ? { sessionKind: session.sessionKind } : {}),
      ...(session.playMode ? { playMode: session.playMode } : {}),
      title: session.title,
    }];
  });
}

export interface BookSessionSummary {
  readonly sessionId: string;
  readonly bookId: string | null;
  readonly sessionKind?: SessionKind;
  readonly playMode?: PlayMode;
  readonly soulBinding?: SessionSoulBinding;
  readonly title: string | null;
  readonly messageCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export async function listBookSessions(
  projectRoot: string,
  bookId: string | null,
): Promise<ReadonlyArray<BookSessionSummary>> {
  const dir = sessionsDir(projectRoot);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const sessionIds = new Set<string>();
  for (const file of files) {
    if (file.endsWith(".jsonl")) {
      sessionIds.add(file.slice(0, -".jsonl".length));
    } else if (file.endsWith(".json")) {
      sessionIds.add(file.slice(0, -".json".length));
    }
  }

  const summaries = await Promise.all(
    [...sessionIds].map(async (sessionId): Promise<BookSessionSummary | null> => {
      try {
        const session = await loadBookSession(projectRoot, sessionId);
        if (!session || session.bookId !== bookId) return null;

        return {
          sessionId: session.sessionId,
          bookId: session.bookId,
          sessionKind: session.sessionKind,
          playMode: session.playMode,
          soulBinding: session.soulBinding,
          title: session.title,
          messageCount: session.messages.length,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        };
      } catch {
        return null;
      }
    }),
  );

  return summaries
    .filter((summary): summary is BookSessionSummary => summary !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function renameBookSession(
  projectRoot: string,
  sessionId: string,
  title: string,
): Promise<BookSession | null> {
  const session = await loadBookSession(projectRoot, sessionId);
  if (!session) return null;
  const updatedAt = Date.now();
  await appendSessionMetadataUpdatedEvent(projectRoot, sessionId, { title, updatedAt });
  return loadBookSession(projectRoot, sessionId);
}

export async function deleteBookSession(
  projectRoot: string,
  sessionId: string,
): Promise<void> {
  await Promise.all([
    unlink(transcriptPath(projectRoot, sessionId)).catch(() => undefined),
    unlink(legacyBookSessionPath(projectRoot, sessionId)).catch(() => undefined),
  ]);
}

export async function migrateBookSession(
  projectRoot: string,
  sessionId: string,
  newBookId: string,
): Promise<BookSession | null> {
  const events = await readTranscriptEventsStrict(projectRoot, sessionId);
  if (events.length === 0) {
    const legacy = await readLegacyBookSession(projectRoot, sessionId);
    if (!legacy) return null;
    await migrateLegacyBookSessionToTranscript(projectRoot, legacy);
  }
  await appendTranscriptEvents(projectRoot, sessionId, ({ events: currentEvents, nextSeq }) => {
    const binding = deriveTranscriptSessionBinding(currentEvents, sessionId);
    if (!binding) return [];
    if (binding.bookId !== null) {
      throw new SessionAlreadyMigratedError(sessionId, binding.bookId);
    }
    const updatedAt = Date.now();
    return [{
      type: "session_metadata_updated",
      version: 1,
      sessionId,
      seq: nextSeq,
      timestamp: updatedAt,
      updatedAt,
      bookId: newBookId,
      sessionKind: "book",
    }];
  });
  return loadBookSession(projectRoot, sessionId);
}

export async function createAndPersistBookSession(
  projectRoot: string,
  bookId: string | null,
  sessionId?: string,
  sessionKind?: SessionKind,
  options?: { readonly playMode?: PlayMode; readonly soulBinding?: SessionSoulBinding },
): Promise<BookSession> {
  const activeSoulBinding = bookId
    ? await loadActiveBookSoulSessionBinding(projectRoot, bookId)
    : null;
  if (
    options?.soulBinding
    && hashCanonical(options.soulBinding) !== hashCanonical(activeSoulBinding)
  ) {
    throw new SessionBindingMismatchError(
      sessionId ?? "new-session",
      "soulBinding",
      activeSoulBinding,
      options.soulBinding,
    );
  }
  const effectiveOptions = {
    ...(options?.playMode ? { playMode: options.playMode } : {}),
    ...(activeSoulBinding ? { soulBinding: activeSoulBinding } : {}),
  };
  // 如果指定了 sessionId 且对应文件已存在，视为幂等操作直接返回（支持"用户发消息时才持久化 draft"流程）
  if (sessionId) {
    const existing = await loadBookSession(projectRoot, sessionId);
    if (existing) {
      if (existing.bookId !== bookId) {
        throw new SessionBindingMismatchError(sessionId, "bookId", existing.bookId, bookId);
      }
      if (sessionKind && existing.sessionKind && existing.sessionKind !== sessionKind) {
        throw new SessionBindingMismatchError(
          sessionId,
          "sessionKind",
          existing.sessionKind,
          sessionKind,
        );
      }
      const requestedSoulBinding = activeSoulBinding
        ? SessionSoulBindingSchema.parse(activeSoulBinding)
        : undefined;
      if (hashCanonical(existing.soulBinding ?? null) !== hashCanonical(requestedSoulBinding ?? null)) {
        throw new SessionBindingMismatchError(
          sessionId,
          "soulBinding",
          existing.soulBinding,
          requestedSoulBinding,
        );
      }
      if ((sessionKind && !existing.sessionKind) || (effectiveOptions.playMode && existing.playMode !== effectiveOptions.playMode)) {
        await appendSessionMetadataUpdatedEvent(projectRoot, sessionId, {
          ...(sessionKind ? { sessionKind } : {}),
          ...(effectiveOptions.playMode ? { playMode: effectiveOptions.playMode } : {}),
          updatedAt: Date.now(),
        });
        return await loadBookSession(projectRoot, sessionId) ?? existing;
      }
      return existing;
    }
  }
  const session = createBookSession(bookId, sessionId, sessionKind, effectiveOptions);
  await appendSessionCreatedEvent(projectRoot, session);
  return await loadBookSession(projectRoot, session.sessionId) ?? session;
}
