import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { TranscriptEventSchema, type TranscriptEvent } from "./session-transcript-schema.js";
import type { PlayMode, SessionKind, TranscriptRole } from "./session-transcript-schema.js";

const SESSIONS_DIR = ".inkos/sessions";
const appendQueues = new Map<string, Promise<void>>();

export class TranscriptIntegrityError extends Error {
  constructor(
    readonly sessionId: string,
    readonly code: "malformed-line" | "session-mismatch" | "invalid-sequence" | "invalid-header" | "binding-drift",
    message: string,
  ) {
    super(`Transcript ${JSON.stringify(sessionId)} failed ${code}: ${message}`);
    this.name = "TranscriptIntegrityError";
  }
}

export interface TranscriptSessionBinding {
  readonly bookId: string | null;
  readonly sessionKind?: SessionKind;
  readonly playMode?: PlayMode;
}

export function sessionsDir(projectRoot: string): string {
  return join(projectRoot, SESSIONS_DIR);
}

export function transcriptPath(projectRoot: string, sessionId: string): string {
  return join(sessionsDir(projectRoot), `${sessionId}.jsonl`);
}

export function legacyBookSessionPath(projectRoot: string, sessionId: string): string {
  return join(sessionsDir(projectRoot), `${sessionId}.json`);
}

export async function readTranscriptEvents(
  projectRoot: string,
  sessionId: string,
): Promise<TranscriptEvent[]> {
  let raw: string;
  try {
    raw = await readFile(transcriptPath(projectRoot, sessionId), "utf-8");
  } catch {
    return [];
  }

  const events: TranscriptEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = TranscriptEventSchema.safeParse(JSON.parse(line));
      if (parsed.success) events.push(parsed.data);
    } catch {
      continue;
    }
  }

  return events.sort((a, b) => a.seq - b.seq);
}

export function deriveTranscriptSessionBinding(
  events: ReadonlyArray<TranscriptEvent>,
  sessionId: string,
): TranscriptSessionBinding | null {
  if (events.length === 0) return null;
  const createdEvents = events.filter((event) => event.type === "session_created");
  if (createdEvents.length !== 1 || events[0]?.type !== "session_created") {
    throw new TranscriptIntegrityError(
      sessionId,
      "invalid-header",
      `expected exactly one leading session_created event, found ${createdEvents.length}`,
    );
  }
  const created = createdEvents[0]!;
  let bookId = created.bookId;
  let sessionKind = created.sessionKind;
  let playMode = created.playMode;

  for (const event of events) {
    if (event.type !== "session_metadata_updated") continue;
    let migratedToBook = false;
    if (event.bookId !== undefined && event.bookId !== bookId) {
      if (bookId === null && event.bookId !== null) {
        bookId = event.bookId;
        migratedToBook = true;
      } else {
        throw new TranscriptIntegrityError(
          sessionId,
          "binding-drift",
          `bookId cannot transition from ${JSON.stringify(bookId)} to ${JSON.stringify(event.bookId)} at seq ${event.seq}`,
        );
      }
    }
    if (event.sessionKind !== undefined && event.sessionKind !== sessionKind) {
      const migrationKindChange = migratedToBook
        && event.sessionKind === "book"
        && (sessionKind === undefined || sessionKind === "chat" || sessionKind === "book-create");
      if (sessionKind !== undefined && !migrationKindChange) {
        throw new TranscriptIntegrityError(
          sessionId,
          "binding-drift",
          `sessionKind cannot transition from ${JSON.stringify(sessionKind)} to ${JSON.stringify(event.sessionKind)} at seq ${event.seq}`,
        );
      }
      sessionKind = event.sessionKind;
    }
    if (migratedToBook && sessionKind !== undefined && sessionKind !== "book") {
      throw new TranscriptIntegrityError(
        sessionId,
        "binding-drift",
        `null-to-Book migration must bind sessionKind=book at seq ${event.seq}`,
      );
    }
    if (event.playMode !== undefined) playMode = event.playMode;
  }
  return { bookId, ...(sessionKind ? { sessionKind } : {}), ...(playMode ? { playMode } : {}) };
}

export function validateStrictTranscriptEvents(
  events: ReadonlyArray<TranscriptEvent>,
  sessionId: string,
): TranscriptSessionBinding | null {
  let previousSeq = -1;
  for (const event of events) {
    if (event.sessionId !== sessionId) {
      throw new TranscriptIntegrityError(
        sessionId,
        "session-mismatch",
        `event at seq ${event.seq} belongs to ${JSON.stringify(event.sessionId)}`,
      );
    }
    if (event.seq <= previousSeq) {
      throw new TranscriptIntegrityError(
        sessionId,
        "invalid-sequence",
        `seq ${event.seq} is not strictly greater than ${previousSeq}`,
      );
    }
    previousSeq = event.seq;
  }
  return deriveTranscriptSessionBinding(events, sessionId);
}

export async function readTranscriptEventsStrict(
  projectRoot: string,
  sessionId: string,
): Promise<TranscriptEvent[]> {
  let raw: string;
  try {
    raw = await readFile(transcriptPath(projectRoot, sessionId), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const events: TranscriptEvent[] = [];
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw new TranscriptIntegrityError(sessionId, "malformed-line", `line ${index + 1} is not valid JSON`);
    }
    const parsed = TranscriptEventSchema.safeParse(json);
    if (!parsed.success) {
      throw new TranscriptIntegrityError(
        sessionId,
        "malformed-line",
        `line ${index + 1} does not match transcript/v1`,
      );
    }
    events.push(parsed.data);
  }
  validateStrictTranscriptEvents(events, sessionId);
  return events;
}

export async function nextTranscriptSeq(projectRoot: string, sessionId: string): Promise<number> {
  const events = await readTranscriptEventsStrict(projectRoot, sessionId);
  return events.reduce((max, event) => Math.max(max, event.seq), 0) + 1;
}

export async function appendTranscriptEvent(
  projectRoot: string,
  event: TranscriptEvent,
): Promise<void> {
  await appendTranscriptEvents(projectRoot, event.sessionId, () => [event]);
}

export async function appendTranscriptEvents(
  projectRoot: string,
  sessionId: string,
  buildEvents: (context: {
    readonly events: ReadonlyArray<TranscriptEvent>;
    readonly nextSeq: number;
  }) => ReadonlyArray<TranscriptEvent> | Promise<ReadonlyArray<TranscriptEvent>>,
): Promise<TranscriptEvent[]> {
  const key = `${projectRoot}:${sessionId}`;
  const previous = appendQueues.get(key) ?? Promise.resolve();
  let result: TranscriptEvent[] = [];

  const next = previous.then(async () => {
    const events = await readTranscriptEventsStrict(projectRoot, sessionId);
    const nextSeq = events.reduce((max, event) => Math.max(max, event.seq), 0) + 1;
    const built = await buildEvents({ events, nextSeq });
    result = built.map((event) => TranscriptEventSchema.parse(event));
    if (result.length === 0) return;

    validateStrictTranscriptEvents([...events, ...result], sessionId);

    await mkdir(sessionsDir(projectRoot), { recursive: true });
    await appendFile(
      transcriptPath(projectRoot, sessionId),
      `${result.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf-8",
    );
  });

  appendQueues.set(key, next.catch(() => undefined));
  await next;
  return result;
}

function transcriptRoleForMessage(message: AgentMessage): TranscriptRole | null {
  if (!message || typeof message !== "object" || !("role" in message)) return null;
  const role = (message as { role?: unknown }).role;
  return role === "user" || role === "assistant" || role === "toolResult" || role === "system"
    ? role
    : null;
}

function messageTimestamp(message: AgentMessage): number {
  if (message && typeof message === "object") {
    const timestamp = (message as { timestamp?: unknown }).timestamp;
    if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp >= 0) {
      return Math.floor(timestamp);
    }
  }
  return Date.now();
}

function toolCallIdForMessage(message: AgentMessage): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  if ((message as { role?: unknown }).role === "toolResult") {
    const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
    return typeof toolCallId === "string" && toolCallId.length > 0 ? toolCallId : undefined;
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const block = content.find(
    (item): item is { type: "toolCall"; id: string } =>
      !!item &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "toolCall" &&
      typeof (item as { id?: unknown }).id === "string",
  );
  return block?.id;
}

export async function appendManualSessionMessages(
  projectRoot: string,
  sessionId: string,
  messages: ReadonlyArray<AgentMessage>,
  input = "",
  options: {
    readonly sessionKind?: SessionKind;
    readonly legacyDisplay?: {
      readonly thinking?: string;
      readonly toolExecutions?: readonly unknown[];
    };
  } = {},
): Promise<void> {
  const persistedMessages = messages
    .map((message) => ({ message, role: transcriptRoleForMessage(message) }))
    .filter((entry): entry is { message: AgentMessage; role: TranscriptRole } => entry.role !== null);
  if (persistedMessages.length === 0) return;

  const requestId = randomUUID();
  await appendTranscriptEvents(projectRoot, sessionId, ({ nextSeq }) => {
    let seq = nextSeq;
    const events: TranscriptEvent[] = [{
      type: "request_started",
      version: 1,
      sessionId,
      requestId,
      seq: seq++,
      timestamp: Date.now(),
      ...(options.sessionKind ? { sessionKind: options.sessionKind } : {}),
      input,
    }];

    let parentUuid: string | null = null;
    let lastAssistantUuid: string | null = null;
    for (const { message, role } of persistedMessages) {
      const uuid = randomUUID();
      const isToolResult = role === "toolResult";
      const toolCallId = toolCallIdForMessage(message);
      const legacyDisplay = role === "assistant" && options.legacyDisplay
        ? {
            ...(options.legacyDisplay.thinking ? { thinking: options.legacyDisplay.thinking } : {}),
            ...(options.legacyDisplay.toolExecutions?.length
              ? { toolExecutions: [...options.legacyDisplay.toolExecutions] }
              : {}),
          }
        : undefined;
      events.push({
        type: "message",
        version: 1,
        sessionId,
        requestId,
        uuid,
        parentUuid: isToolResult && lastAssistantUuid ? lastAssistantUuid : parentUuid,
        seq: seq++,
        role,
        timestamp: messageTimestamp(message),
        ...(toolCallId ? { toolCallId } : {}),
        ...(isToolResult && lastAssistantUuid
          ? { sourceToolAssistantUuid: lastAssistantUuid }
          : {}),
        ...(legacyDisplay && (legacyDisplay.thinking || legacyDisplay.toolExecutions?.length)
          ? { legacyDisplay }
          : {}),
        message,
      });
      if (role === "assistant") lastAssistantUuid = uuid;
      parentUuid = uuid;
    }

    events.push({
      type: "request_committed",
      version: 1,
      sessionId,
      requestId,
      seq,
      timestamp: Date.now(),
    });
    return events;
  });
}
