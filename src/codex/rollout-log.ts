import { existsSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_STALE_MS = 12 * 60 * 60 * 1000;
const DEFAULT_TAIL_BYTES = 16 * 1024 * 1024;

export interface RolloutActivity {
  path: string;
  turnId: string;
  startedAt: number;
  lastUpdatedAt: number;
  offset: number;
}

export type RolloutEvent =
  | {
      kind: "commentary" | "final";
      text: string;
      timestamp: number;
      turnId?: string;
    }
  | {
      kind: "taskStarted";
      turnId: string;
      timestamp: number;
    }
  | {
      kind: "terminal";
      turnId?: string;
      status: "completed" | "failed" | "cancelled" | "interrupted";
      timestamp: number;
    };

type TerminalStatus = Extract<RolloutEvent, { kind: "terminal" }>["status"];

interface AgentMessageEvent {
  kind: "commentary" | "final";
  text: string;
  timestamp: number;
  turnId?: string;
}

export interface RolloutReadResult {
  events: RolloutEvent[];
  nextOffset: number;
}

export interface RolloutAnswerSnapshot {
  path: string;
  turnId: string;
  text: string;
}

interface RolloutDetectionOptions {
  staleMs?: number;
  tailBytes?: number;
  now?: number;
}

interface ParsedTail {
  lastTurnActivity?: ParsedTurnMarker;
  lastTaskStart?: ParsedTurnMarker;
  lastFinalIndex: number;
  lastTimestamp?: number;
}

interface ParsedTurnMarker {
  turnId: string;
  timestamp?: number;
  index: number;
}

export async function detectActiveRollout(
  threadId: string,
  preferredPath?: string | null,
  options: RolloutDetectionOptions = {},
): Promise<RolloutActivity | undefined> {
  const path = await resolveRolloutPath(threadId, preferredPath);
  if (!path) {
    return undefined;
  }

  const fileStat = await stat(path);
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const now = options.now ?? Date.now();
  if (now - fileStat.mtimeMs > staleMs) {
    return undefined;
  }

  const tail = await readTail(path, options.tailBytes ?? DEFAULT_TAIL_BYTES);
  const parsed = parseRolloutTail(tail);
  const marker = parsed.lastTurnActivity;
  if (!marker || marker.index <= parsed.lastFinalIndex) {
    return undefined;
  }

  const lastUpdatedAt = Math.max(fileStat.mtimeMs, parsed.lastTimestamp ?? 0);
  if (now - lastUpdatedAt > staleMs) {
    return undefined;
  }

  const startedAt =
    parsed.lastTaskStart && parsed.lastTaskStart.turnId === marker.turnId
      ? parsed.lastTaskStart.timestamp ?? lastUpdatedAt
      : uuidV7TimestampMs(marker.turnId) ?? marker.timestamp ?? lastUpdatedAt;

  return {
    path,
    turnId: marker.turnId,
    startedAt,
    lastUpdatedAt,
    offset: fileStat.size,
  };
}

export async function readNewRolloutEvents(path: string, offset: number): Promise<RolloutReadResult> {
  const fileStat = await stat(path);
  if (fileStat.size <= offset) {
    return { events: [], nextOffset: fileStat.size };
  }

  const start = Math.max(0, offset);
  const length = fileStat.size - start;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const text = buffer.toString("utf8");
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline < 0) {
      return { events: [], nextOffset: start };
    }

    const completeText = text.slice(0, lastNewline + 1);
    return {
      events: parseRolloutEvents(completeText),
      nextOffset: start + Buffer.byteLength(completeText),
    };
  } finally {
    await handle.close();
  }
}

export async function readRolloutAnswerSnapshot(
  threadId: string,
  turnId: string,
  preferredPath?: string | null,
  options: Pick<RolloutDetectionOptions, "tailBytes"> = {},
): Promise<RolloutAnswerSnapshot | undefined> {
  const path = await resolveRolloutPath(threadId, preferredPath);
  if (!path) {
    return undefined;
  }

  const tail = await readTail(path, options.tailBytes ?? DEFAULT_TAIL_BYTES);
  const text = parseRolloutAnswerText(tail, turnId);
  return { path, turnId, text };
}

export async function resolveRolloutPath(threadId: string, preferredPath?: string | null): Promise<string | undefined> {
  if (preferredPath && existsSync(preferredPath)) {
    return preferredPath;
  }

  const root = join(homedir(), ".codex", "sessions");
  return findRolloutPath(root, threadId);
}

async function findRolloutPath(dir: string, threadId: string): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name.includes(threadId) && entry.name.endsWith(".jsonl")) {
      return path;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const found = await findRolloutPath(join(dir, entry.name), threadId);
    if (found) {
      return found;
    }
  }

  return undefined;
}

async function readTail(path: string, maxBytes: number): Promise<string> {
  const fileStat = await stat(path);
  const length = Math.min(fileStat.size, maxBytes);
  const start = fileStat.size - length;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return text;
  } finally {
    await handle.close();
  }
}

function parseRolloutTail(text: string): ParsedTail {
  const parsed: ParsedTail = { lastFinalIndex: -1 };
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const record = parseJsonLine(lines[index]);
    if (!record) {
      continue;
    }

    const timestamp = readTimestamp(record);
    if (timestamp !== undefined) {
      parsed.lastTimestamp = timestamp;
    }

    if (isTurnCompletionMarker(record)) {
      parsed.lastFinalIndex = index;
      continue;
    }

    const taskStartedTurnId = readTaskStartedTurnId(record);
    if (taskStartedTurnId) {
      parsed.lastTaskStart = { turnId: taskStartedTurnId, timestamp, index };
      parsed.lastTurnActivity = { turnId: taskStartedTurnId, timestamp, index };
      continue;
    }

    const turnId = readTurnId(record);
    if (turnId) {
      parsed.lastTurnActivity = { turnId, timestamp, index };
    }
  }
  return parsed;
}

function parseRolloutEvents(text: string): RolloutEvent[] {
  const events: RolloutEvent[] = [];
  let currentTurnId: string | undefined;

  for (const line of text.split("\n")) {
    const record = parseJsonLine(line);
    if (!record) {
      continue;
    }

    const timestamp = readTimestamp(record) ?? Date.now();
    const payload = asRecord(record.payload);

    if (record.type === "event_msg" && payload?.type === "task_started") {
      currentTurnId = typeof payload.turn_id === "string" ? payload.turn_id : undefined;
      if (currentTurnId) {
        events.push({ kind: "taskStarted", turnId: currentTurnId, timestamp });
      }
      continue;
    }

    if (record.type === "event_msg" && typeof payload?.type === "string") {
      const status = terminalStatus(payload.type, payload.reason);
      if (status) {
        events.push({
          kind: "terminal",
          turnId: typeof payload.turn_id === "string" ? payload.turn_id : currentTurnId,
          status,
          timestamp,
        });
        continue;
      }
    }

    const message = parseAgentMessageEvent(record, currentTurnId, timestamp);
    if (message) {
      pushMessageEvent(events, message);
    }
  }
  return events;
}

function pushMessageEvent(events: RolloutEvent[], message: AgentMessageEvent): void {
  const previous = events.at(-1);
  if (
    previous &&
    (previous.kind === "commentary" || previous.kind === "final") &&
    previous.kind === message.kind &&
    previous.turnId === message.turnId &&
    previous.text === message.text &&
    Math.abs(previous.timestamp - message.timestamp) < 1000
  ) {
    return;
  }

  events.push(message);
}

function parseAgentMessageEvent(
  record: Record<string, unknown>,
  currentTurnId: string | undefined,
  timestamp: number,
): AgentMessageEvent | undefined {
  const payload = asRecord(record.payload);
  if (!payload) {
    return undefined;
  }

  if (record.type === "event_msg") {
    if (payload?.type !== "agent_message") {
      return undefined;
    }

    const text = typeof payload.message === "string" ? payload.message.trim() : "";
    if (!text) {
      return undefined;
    }

    if (payload.phase === "commentary") {
      return { kind: "commentary", text, timestamp, turnId: typeof payload.turn_id === "string" ? payload.turn_id : currentTurnId };
    } else if (payload.phase === "final_answer") {
      return { kind: "final", text, timestamp, turnId: typeof payload.turn_id === "string" ? payload.turn_id : currentTurnId };
    }
    return undefined;
  }

  if (record.type !== "response_item") {
    return undefined;
  }

  if (payload.type !== "message" || payload.role !== "assistant") {
    return undefined;
  }

  const text = readResponseItemText(payload);
  if (!text) {
    return undefined;
  }

  if (payload.phase === "commentary") {
    return { kind: "commentary", text, timestamp, turnId: currentTurnId };
  }
  if (payload.phase === "final_answer") {
    return { kind: "final", text, timestamp, turnId: currentTurnId };
  }
  return undefined;
}

function readResponseItemText(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => asRecord(item))
    .map((item) => (typeof item?.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function terminalStatus(value: string, reason?: unknown): TerminalStatus | undefined {
  if (value === "task_complete") {
    return "completed";
  }
  if (value === "task_failed") {
    return "failed";
  }
  if (value === "task_cancelled") {
    return "cancelled";
  }
  if (value === "task_interrupted") {
    return "interrupted";
  }
  if (value === "turn_aborted") {
    return reason === "cancelled" ? "cancelled" : "interrupted";
  }
  return undefined;
}

function parseRolloutAnswerText(text: string, turnId: string): string {
  let currentTurnId: string | undefined;
  const messages: string[] = [];

  for (const line of text.split("\n")) {
    const record = parseJsonLine(line);
    if (!record) {
      continue;
    }

    const startedTurnId = readTaskStartedTurnId(record);
    if (startedTurnId) {
      currentTurnId = startedTurnId;
      if (currentTurnId === turnId) {
        messages.length = 0;
      }
      continue;
    }

    if (currentTurnId !== turnId || record.type !== "event_msg") {
      continue;
    }

    const payload = asRecord(record.payload);
    if (payload?.type !== "agent_message") {
      continue;
    }

    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    if (payload.phase === "final_answer") {
      messages.length = 0;
      continue;
    }
    if (payload.phase === "commentary" && message) {
      messages.push(message);
    }
  }

  return messages.join("\n\n");
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function isFinalAgentMessage(record: Record<string, unknown>): boolean {
  const payload = asRecord(record.payload);
  if (!payload) {
    return false;
  }

  if (record.type === "event_msg") {
    return payload.type === "agent_message" && payload.phase === "final_answer";
  }

  if (record.type === "response_item") {
    return payload.type === "message" && payload.role === "assistant" && payload.phase === "final_answer";
  }

  return false;
}

function isTurnCompletionMarker(record: Record<string, unknown>): boolean {
  if (isFinalAgentMessage(record)) {
    return true;
  }

  if (record.type !== "event_msg") {
    return false;
  }

  const payload = asRecord(record.payload);
  const type = payload?.type;
  return (
    type === "task_complete" ||
    type === "task_failed" ||
    type === "task_cancelled" ||
    type === "task_interrupted" ||
    type === "turn_aborted"
  );
}

function readTaskStartedTurnId(record: Record<string, unknown>): string | undefined {
  if (record.type !== "event_msg") {
    return undefined;
  }

  const payload = asRecord(record.payload);
  if (payload?.type !== "task_started") {
    return undefined;
  }
  return typeof payload.turn_id === "string" ? payload.turn_id : undefined;
}

function readTurnId(record: Record<string, unknown>): string | undefined {
  const payload = asRecord(record.payload);
  if (!payload) {
    return undefined;
  }
  return typeof payload.turn_id === "string" ? payload.turn_id : undefined;
}

function readTimestamp(record: Record<string, unknown>): number | undefined {
  if (typeof record.timestamp !== "string") {
    return undefined;
  }

  const timestamp = Date.parse(record.timestamp);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function uuidV7TimestampMs(value: string): number | undefined {
  const hex = value.replace(/-/g, "").slice(0, 12);
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) {
    return undefined;
  }

  const timestamp = Number.parseInt(hex, 16);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
