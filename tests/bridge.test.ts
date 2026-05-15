import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexBridge, extractExistingLocalPaths, type BridgeNotifier, type ChatId } from "../src/codex/bridge.js";
import type { JsonRpcId, JsonRpcRequest } from "../src/codex/types.js";
import { Logger } from "../src/logger.js";
import { StateStore } from "../src/state/store.js";

class MockRpc extends EventEmitter {
  responses = new Map<string, unknown>();
  requests: Array<{ method: string; params: unknown }> = [];
  responsesSent: Array<{ id: JsonRpcId; result: unknown }> = [];

  async start(): Promise<void> {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    const response = this.responses.get(method);
    if (response instanceof Error) {
      throw response;
    }
    return response as T;
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.responsesSent.push({ id, result });
  }

  respondError(id: JsonRpcId | null, code: number, message: string): void {
    this.responsesSent.push({ id: id ?? "null", result: { error: { code, message } } });
  }
}

class MockNotifier implements BridgeNotifier {
  texts: Array<{ chatId: ChatId; text: string }> = [];
  updates: Array<{ chatId: ChatId; messageId: number; text: string }> = [];
  approvals: Array<{ chatId: ChatId; text: string; token: string }> = [];
  photos: Array<{ chatId: ChatId; path: string; caption?: string }> = [];
  documents: Array<{ chatId: ChatId; path: string; caption?: string }> = [];

  async sendText(chatId: ChatId, text: string): Promise<number> {
    this.texts.push({ chatId, text });
    return this.texts.length;
  }

  async updateText(chatId: ChatId, messageId: number, text: string): Promise<void> {
    this.updates.push({ chatId, messageId, text });
  }

  async sendApprovalRequest(chatId: ChatId, text: string, token: string): Promise<void> {
    this.approvals.push({ chatId, text, token });
  }

  async sendPhoto(chatId: ChatId, path: string, caption?: string): Promise<void> {
    this.photos.push({ chatId, path, caption });
  }

  async sendDocument(chatId: ChatId, path: string, caption?: string): Promise<void> {
    this.documents.push({ chatId, path, caption });
  }
}

const thread = {
  id: "thread-1",
  preview: "Build feature",
  ephemeral: false,
  modelProvider: "openai",
  createdAt: 1,
  updatedAt: 2,
  status: { type: "notLoaded" as const },
  path: "/tmp/thread.jsonl",
  cwd: "/home/sanzh/project",
  cliVersion: "codex-cli 0.130.0-alpha.5",
  source: "vscode",
  name: "Build feature",
};

describe("CodexBridge", () => {
  let dir: string;
  let state: StateStore;
  let rpc: MockRpc;
  let notifier: MockNotifier;
  let bridge: CodexBridge;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "codex-bot-test-"));
    state = new StateStore(join(dir, "state.json"));
    await state.load();
    rpc = new MockRpc();
    rpc.responses.set("thread/read", { thread: { ...thread, turns: [] } });
    notifier = new MockNotifier();
    bridge = new CodexBridge({
      rpc: rpc as never,
      state,
      notifier,
      logger: new Logger("error"),
      threadListLimit: 10,
      streamUpdatesMs: 10_000,
      streamMinChars: 120,
    });
    await bridge.start();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  it("lists existing threads and selects by list number", async () => {
    rpc.responses.set("thread/list", { data: [thread], nextCursor: null, backwardsCursor: null });
    rpc.responses.set("thread/resume", { thread, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });

    const list = await bridge.listThreads("42");
    expect(list).toContain("Build feature");

    const selected = await bridge.selectThread("42", "1");
    expect(selected).toContain("thread-1");
    expect(state.getSelectedThread("42")?.id).toBe("thread-1");
  });

  it("shows the latest final Codex answer when selecting an idle thread", async () => {
    rpc.responses.set("thread/list", { data: [thread], nextCursor: null, backwardsCursor: null });
    rpc.responses.set("thread/resume", { thread: { ...thread, status: { type: "idle" } }, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });
    rpc.responses.set("thread/read", {
      thread: {
        ...thread,
        turns: [
          {
            id: "final-turn",
            items: [{ type: "agentMessage", id: "m1", text: "We stopped after fixing auth.", phase: "final_answer", memoryCitation: null }],
            status: "completed",
            error: null,
            startedAt: 1,
            completedAt: 2,
            durationMs: 1000,
          },
        ],
      },
    });

    await bridge.listThreads("42");
    const selected = await bridge.selectThread("42", "1", 100);

    expect(selected).toContain("Последний финальный ответ Codex");
    expect(selected).toContain("turn: final-turn");
    expect(selected).toContain("We stopped after fixing auth.");
  });

  it("shows current in-progress text when selecting an active thread from history", async () => {
    rpc.responses.set("thread/list", { data: [thread], nextCursor: null, backwardsCursor: null });
    rpc.responses.set("thread/resume", { thread: { ...thread, status: { type: "idle" } }, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });
    rpc.responses.set("thread/read", {
      thread: {
        ...thread,
        turns: [
          {
            id: "external-turn",
            items: [{ type: "agentMessage", id: "m1", text: "Currently checking migrations.", phase: "commentary", memoryCitation: null }],
            status: "inProgress",
            error: null,
            startedAt: 1,
            completedAt: null,
            durationMs: null,
          },
        ],
      },
    });

    await bridge.listThreads("42");
    const selected = await bridge.selectThread("42", "1", 100);

    expect(selected).toContain("Актуальный промежуточный текст Codex");
    expect(selected).toContain("turn: external-turn");
    expect(selected).toContain("Currently checking migrations.");
  });

  it("/current reports active when runtime is tracking the selected thread", async () => {
    rpc.responses.set("thread/list", { data: [thread], nextCursor: null, backwardsCursor: null });
    rpc.responses.set("thread/resume", { thread: { ...thread, status: { type: "idle" } }, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });
    rpc.responses.set("thread/read", {
      thread: {
        ...thread,
        turns: [{ id: "external-turn", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null }],
      },
    });

    await bridge.listThreads("42");
    await bridge.selectThread("42", "1", 100);
    await state.setSelectedThreadStatus("42", thread.id, "idle");

    const current = await bridge.current("42", 100);

    expect(current).toContain("status: active");
    expect(current).toContain("active turn: external-turn");
  });

  it("blocks new prompts while a bot-started turn is active", async () => {
    await state.setSelectedThread("42", thread);
    rpc.responses.set("thread/resume", { thread: { ...thread, status: { type: "idle" } }, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });
    rpc.responses.set("turn/start", {
      turn: { id: "turn-1", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null },
    });

    await expect(bridge.startTextTurn("42", 100, "first")).resolves.toContain("Отправил");
    await expect(bridge.startTextTurn("42", 100, "second")).resolves.toBe("Codex занят, сообщение не отправлено.");
  });

  it("marks selected thread active when latest turn is still in progress", async () => {
    rpc.responses.set("thread/list", { data: [thread], nextCursor: null, backwardsCursor: null });
    rpc.responses.set("thread/resume", { thread: { ...thread, status: { type: "idle" } }, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });
    rpc.responses.set("thread/read", {
      thread: {
        ...thread,
        turns: [{ id: "external-turn", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null }],
      },
    });

    await bridge.listThreads("42");
    const selected = await bridge.selectThread("42", "1", 100);

    expect(selected).toContain("status: active");
    expect(selected).toContain("external-turn");
    await expect(bridge.startTextTurn("42", 100, "new work")).resolves.toBe("Codex занят, сообщение не отправлено.");
  });

  it("blocks prompts when thread history has an in-progress turn even if resume says idle", async () => {
    await state.setSelectedThread("42", thread);
    rpc.responses.set("thread/resume", { thread: { ...thread, status: { type: "idle" } }, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });
    rpc.responses.set("thread/read", {
      thread: {
        ...thread,
        turns: [{ id: "external-turn", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null }],
      },
    });

    await expect(bridge.startTextTurn("42", 100, "new work")).resolves.toContain("active turn: external-turn");
  });

  it("marks selected thread active when the rollout file has an unfinished VS Code turn", async () => {
    const rolloutPath = join(dir, "rollout-thread-1.jsonl");
    await writeFile(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "task_started", turn_id: "rollout-turn", started_at: Math.floor(Date.now() / 1000) },
        }),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "agent_message", message: "still working", phase: "commentary" },
        }),
        "",
      ].join("\n"),
    );
    const rolloutThread = { ...thread, path: rolloutPath };
    rpc.responses.set("thread/list", { data: [rolloutThread], nextCursor: null, backwardsCursor: null });
    rpc.responses.set("thread/resume", { thread: { ...rolloutThread, status: { type: "idle" } }, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });

    await bridge.listThreads("42");
    const selected = await bridge.selectThread("42", "1", 100);

    expect(selected).toContain("status: active");
    expect(selected).toContain("rollout-turn");
    expect(selected).toContain("Актуальный промежуточный текст Codex");
    expect(selected).toContain("still working");
    await expect(bridge.startTextTurn("42", 100, "new work")).resolves.toContain("rollout-файл");
  });

  it("does not treat rollout as active when the raw rollout has an abort marker", async () => {
    const rolloutPath = join(dir, "rollout-thread-1.jsonl");
    await writeFile(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "task_started", turn_id: "interrupted-turn", started_at: Math.floor(Date.now() / 1000) },
        }),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "agent_message", message: "last visible progress", phase: "commentary" },
        }),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "turn_aborted", turn_id: "interrupted-turn", reason: "interrupted" },
        }),
        "",
      ].join("\n"),
    );
    const rolloutThread = { ...thread, path: rolloutPath };
    rpc.responses.set("thread/list", { data: [rolloutThread], nextCursor: null, backwardsCursor: null });
    rpc.responses.set("thread/resume", { thread: { ...rolloutThread, status: { type: "idle" } }, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });
    rpc.responses.set("thread/read", {
      thread: {
        ...rolloutThread,
        turns: [
          {
            id: "interrupted-turn",
            items: [{ type: "agentMessage", id: "m1", text: "last visible progress", phase: "commentary", memoryCitation: null }],
            status: "interrupted",
            error: null,
            startedAt: 1,
            completedAt: null,
            durationMs: null,
          },
        ],
      },
    });

    await bridge.listThreads("42");
    const selected = await bridge.selectThread("42", "1", 100);

    expect(selected).toContain("status: idle");
    expect(selected).not.toContain("active turn");
    expect(selected).toContain("status: interrupted");
  });

  it("does not announce stale interrupted rollout as a new VS Code turn after restart", async () => {
    vi.useFakeTimers();
    const rolloutPath = join(dir, "rollout-thread-1.jsonl");
    await writeFile(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "task_started", turn_id: "interrupted-turn", started_at: Math.floor(Date.now() / 1000) },
        }),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "agent_message", message: "old progress", phase: "commentary" },
        }),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "turn_aborted", turn_id: "interrupted-turn", reason: "interrupted" },
        }),
        "",
      ].join("\n"),
    );
    const rolloutThread = { ...thread, path: rolloutPath, status: { type: "active" as const } };
    await state.setSelectedThread("42", rolloutThread);
    await state.setLastChatId("42", 100);
    await state.setActiveTurn("42", {
      chatId: "100",
      threadId: rolloutThread.id,
      turnId: "interrupted-turn",
      startedAt: Date.now() - 10_000,
    });
    rpc.responses.set("thread/read", {
      thread: {
        ...rolloutThread,
        status: { type: "idle" },
        turns: [
          {
            id: "interrupted-turn",
            items: [{ type: "agentMessage", id: "m1", text: "old progress", phase: "commentary", memoryCitation: null }],
            status: "interrupted",
            error: null,
            startedAt: 1,
            completedAt: null,
            durationMs: null,
          },
        ],
      },
    });

    bridge = new CodexBridge({
      rpc: rpc as never,
      state,
      notifier,
      logger: new Logger("error"),
      threadListLimit: 10,
      streamUpdatesMs: 100,
      streamMinChars: 5,
      externalSessionWatchMs: 100,
    });
    await bridge.start();
    await vi.advanceTimersByTimeAsync(150);

    await vi.waitFor(() => {
      expect(notifier.texts.some((message) => message.text.includes("Заметил новый VS Code turn"))).toBe(false);
      expect(notifier.texts.at(-1)?.text).toContain("Codex завершил turn: interrupted");
      expect(notifier.texts.at(-1)?.text).toContain("old progress");
      expect(state.getSelectedThread("42")?.status).toBe("idle");
      expect(state.getActiveTurn("42")).toBeUndefined();
    });
    vi.useRealTimers();
  });

  it("does not use unrelated normalized history as active context fallback", async () => {
    const rolloutPath = join(dir, "rollout-thread-1.jsonl");
    await writeFile(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "task_started", turn_id: "rollout-turn", started_at: Math.floor(Date.now() / 1000) },
        }),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "agent_message", message: "raw stale text", phase: "commentary" },
        }),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "agent_message", message: "raw visible text", phase: "commentary" },
        }),
        "",
      ].join("\n"),
    );
    const rolloutThread = { ...thread, path: rolloutPath };
    rpc.responses.set("thread/list", { data: [rolloutThread], nextCursor: null, backwardsCursor: null });
    rpc.responses.set("thread/resume", { thread: { ...rolloutThread, status: { type: "idle" } }, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });
    rpc.responses.set("thread/read", {
      thread: {
        ...rolloutThread,
        turns: [
          {
            id: "rollout-visible",
            items: [{ type: "agentMessage", id: "m1", text: "normalized visible text", phase: "commentary", memoryCitation: null }],
            status: "completed",
            error: null,
            startedAt: 1,
            completedAt: 2,
            durationMs: 1000,
          },
        ],
      },
    });

    await bridge.listThreads("42");
    const selected = await bridge.selectThread("42", "1", 100);

    expect(selected).toContain("raw visible text");
    expect(selected).not.toContain("normalized visible text");
  });

  it("drops rollout commentary before a final answer when building active fallback context", async () => {
    const rolloutPath = join(dir, "rollout-thread-1.jsonl");
    await writeFile(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "task_started", turn_id: "rollout-turn", started_at: Math.floor(Date.now() / 1000) },
        }),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "agent_message", message: "old pre-final text", phase: "commentary" },
        }),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "agent_message", message: "stale final from another view", phase: "final_answer" },
        }),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "agent_message", message: "current post-final text", phase: "commentary" },
        }),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "patch_apply_end", turn_id: "rollout-turn" },
        }),
        "",
      ].join("\n"),
    );
    const rolloutThread = { ...thread, path: rolloutPath };
    rpc.responses.set("thread/list", { data: [rolloutThread], nextCursor: null, backwardsCursor: null });
    rpc.responses.set("thread/resume", { thread: { ...rolloutThread, status: { type: "idle" } }, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });

    await bridge.listThreads("42");
    const selected = await bridge.selectThread("42", "1", 100);

    expect(selected).toContain("current post-final text");
    expect(selected).not.toContain("old pre-final text");
    expect(selected).not.toContain("stale final from another view");
  });

  it("does not treat task_complete after a final answer as active rollout activity", async () => {
    const rolloutPath = join(dir, "rollout-thread-1.jsonl");
    await writeFile(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: new Date(Date.now() - 10_000).toISOString(),
          type: "event_msg",
          payload: { type: "task_started", turn_id: "completed-turn", started_at: Math.floor(Date.now() / 1000) },
        }),
        JSON.stringify({
          timestamp: new Date(Date.now() - 5_000).toISOString(),
          type: "event_msg",
          payload: { type: "agent_message", message: "completed final", phase: "final_answer" },
        }),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "completed-turn" },
        }),
        "",
      ].join("\n"),
    );
    await state.setSelectedThread("42", { ...thread, path: rolloutPath });
    rpc.responses.set("thread/resume", { thread: { ...thread, path: rolloutPath, status: { type: "idle" } }, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });
    rpc.responses.set("turn/start", {
      turn: { id: "new-turn", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null },
    });

    await expect(bridge.startTextTurn("42", 100, "new work")).resolves.toContain("new-turn");
  });

  it("accepts deltas for an active turn discovered during /use", async () => {
    rpc.responses.set("thread/list", { data: [thread], nextCursor: null, backwardsCursor: null });
    rpc.responses.set("thread/resume", { thread: { ...thread, status: { type: "idle" } }, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });
    rpc.responses.set("thread/read", {
      thread: {
        ...thread,
        turns: [{ id: "external-turn", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null }],
      },
    });

    await bridge.listThreads("42");
    await bridge.selectThread("42", "1", 100);
    rpc.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: thread.id, turnId: "external-turn", itemId: "m1", delta: "external done" },
    });
    rpc.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: thread.id,
        turn: { id: "external-turn", items: [], status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1000 },
      },
    });

    await vi.waitFor(() => {
      expect(notifier.texts.at(-1)?.text).toContain("external done");
    });
  });

  it("streams external VS Code rollout messages discovered during /use", async () => {
    vi.useFakeTimers();
    bridge = new CodexBridge({
      rpc: rpc as never,
      state,
      notifier,
      logger: new Logger("error"),
      threadListLimit: 10,
      streamUpdatesMs: 100,
      streamMinChars: 5,
    });
    await bridge.start();

    const rolloutPath = join(dir, "rollout-thread-1.jsonl");
    const started = JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: { type: "task_started", turn_id: "rollout-turn", started_at: Math.floor(Date.now() / 1000) },
    });
    await writeFile(`${rolloutPath}`, `${started}\n`);
    const rolloutThread = { ...thread, path: rolloutPath };
    rpc.responses.set("thread/list", { data: [rolloutThread], nextCursor: null, backwardsCursor: null });
    rpc.responses.set("thread/resume", { thread: { ...rolloutThread, status: { type: "idle" } }, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });

    await bridge.listThreads("42");
    await bridge.selectThread("42", "1", 100);
    await writeFile(
      rolloutPath,
      [
        started,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "agent_message", message: "external progress", phase: "commentary" },
        }),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "agent_message", message: "external final", phase: "final_answer" },
        }),
        "",
      ].join("\n"),
    );

    await vi.advanceTimersByTimeAsync(150);

    await vi.waitFor(() => {
      expect(notifier.texts.some((message) => message.text.includes("external progress"))).toBe(true);
      expect(notifier.texts.at(-1)?.text).toContain("external final");
    });
    vi.useRealTimers();
  });

  it("switches external rollout tracking when a newer VS Code turn starts before the old one finalizes", async () => {
    vi.useFakeTimers();
    bridge = new CodexBridge({
      rpc: rpc as never,
      state,
      notifier,
      logger: new Logger("error"),
      threadListLimit: 10,
      streamUpdatesMs: 100,
      streamMinChars: 5,
    });
    await bridge.start();

    const rolloutPath = join(dir, "rollout-thread-1.jsonl");
    const oldStarted = JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: { type: "task_started", turn_id: "old-turn", started_at: Math.floor(Date.now() / 1000) },
    });
    await writeFile(rolloutPath, `${oldStarted}\n`);
    const rolloutThread = { ...thread, path: rolloutPath };
    rpc.responses.set("thread/list", { data: [rolloutThread], nextCursor: null, backwardsCursor: null });
    rpc.responses.set("thread/resume", { thread: { ...rolloutThread, status: { type: "idle" } }, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });

    await bridge.listThreads("42");
    await bridge.selectThread("42", "1", 100);

    const newStarted = JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: { type: "task_started", turn_id: "new-turn", started_at: Math.floor(Date.now() / 1000) },
    });
    await writeFile(
      rolloutPath,
      [
        oldStarted,
        newStarted,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "agent_message", message: "new progress", phase: "commentary" },
        }),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "agent_message", message: "new final", phase: "final_answer" },
        }),
        "",
      ].join("\n"),
    );

    await vi.advanceTimersByTimeAsync(150);

    await vi.waitFor(() => {
      expect(notifier.texts.some((message) => message.text.includes("Заметил следующий VS Code turn"))).toBe(true);
      expect(notifier.texts.at(-1)?.text).toContain("turn: new-turn");
      expect(notifier.texts.at(-1)?.text).toContain("new final");
    });
    vi.useRealTimers();
  });

  it("keeps polling a raw rollout when thread/read prematurely reports interrupted", async () => {
    vi.useFakeTimers();
    bridge = new CodexBridge({
      rpc: rpc as never,
      state,
      notifier,
      logger: new Logger("error"),
      threadListLimit: 10,
      streamUpdatesMs: 100,
      streamMinChars: 5,
      externalSessionWatchMs: 100,
    });
    await bridge.start();

    const rolloutPath = join(dir, "rollout-thread-1.jsonl");
    const started = JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: { type: "task_started", turn_id: "external-turn", started_at: Math.floor(Date.now() / 1000) },
    });
    await writeFile(rolloutPath, `${started}\n`);
    const rolloutThread = { ...thread, path: rolloutPath };
    rpc.responses.set("thread/list", { data: [rolloutThread], nextCursor: null, backwardsCursor: null });
    rpc.responses.set("thread/resume", { thread: { ...rolloutThread, status: { type: "idle" } }, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });
    rpc.responses.set("thread/read", { thread: { ...rolloutThread, turns: [] } });

    await bridge.listThreads("42");
    await bridge.selectThread("42", "1", 100);
    rpc.responses.set("thread/read", {
      thread: {
        ...rolloutThread,
        turns: [
          {
            id: "external-turn",
            items: [],
            status: "interrupted",
            error: null,
            startedAt: 1,
            completedAt: null,
            durationMs: null,
          },
        ],
      },
    });

    await vi.advanceTimersByTimeAsync(150);
    await writeFile(
      rolloutPath,
      [
        started,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "agent_message", message: "still alive progress", phase: "commentary" },
        }),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "agent_message", message: "real final from rollout", phase: "final_answer" },
        }),
        "",
      ].join("\n"),
    );

    await vi.advanceTimersByTimeAsync(150);

    await vi.waitFor(() => {
      expect(notifier.texts.some((message) => message.text.includes("Codex завершил turn: interrupted"))).toBe(false);
      expect(notifier.texts.some((message) => message.text.includes("still alive progress"))).toBe(true);
      expect(notifier.texts.at(-1)?.text).toContain("real final from rollout");
    });
    vi.useRealTimers();
  });

  it("completes a tracked external history turn when thread/read changes it to interrupted without rollout", async () => {
    vi.useFakeTimers();
    bridge = new CodexBridge({
      rpc: rpc as never,
      state,
      notifier,
      logger: new Logger("error"),
      threadListLimit: 10,
      streamUpdatesMs: 100,
      streamMinChars: 5,
      externalSessionWatchMs: 100,
    });
    await bridge.start();

    const historyThread = { ...thread, path: null };
    rpc.responses.set("thread/list", { data: [historyThread], nextCursor: null, backwardsCursor: null });
    rpc.responses.set("thread/resume", { thread: { ...historyThread, status: { type: "idle" } }, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });
    rpc.responses.set("thread/read", {
      thread: {
        ...historyThread,
        turns: [
          {
            id: "external-turn",
            items: [],
            status: "inProgress",
            error: null,
            startedAt: 1,
            completedAt: null,
            durationMs: null,
          },
        ],
      },
    });

    await bridge.listThreads("42");
    await bridge.selectThread("42", "1", 100);
    rpc.responses.set("thread/read", {
      thread: {
        ...historyThread,
        turns: [
          {
            id: "external-turn",
            items: [{ type: "agentMessage", id: "m1", text: "stopped after deploy check", phase: "commentary", memoryCitation: null }],
            status: "interrupted",
            error: null,
            startedAt: 1,
            completedAt: null,
            durationMs: null,
          },
        ],
      },
    });

    await vi.advanceTimersByTimeAsync(150);

    await vi.waitFor(() => {
      expect(notifier.texts.at(-1)?.text).toContain("Codex завершил turn: interrupted");
      expect(notifier.texts.at(-1)?.text).toContain("stopped after deploy check");
    });
    vi.useRealTimers();
  });

  it("completes a tracked external rollout when Codex writes turn_aborted", async () => {
    vi.useFakeTimers();
    bridge = new CodexBridge({
      rpc: rpc as never,
      state,
      notifier,
      logger: new Logger("error"),
      threadListLimit: 10,
      streamUpdatesMs: 100,
      streamMinChars: 5,
      externalSessionWatchMs: 100,
    });
    await bridge.start();

    const rolloutPath = join(dir, "rollout-thread-1.jsonl");
    const started = JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: { type: "task_started", turn_id: "external-turn", started_at: Math.floor(Date.now() / 1000) },
    });
    await writeFile(
      rolloutPath,
      [
        started,
        "",
      ].join("\n"),
    );
    const rolloutThread = { ...thread, path: rolloutPath };
    rpc.responses.set("thread/list", { data: [rolloutThread], nextCursor: null, backwardsCursor: null });
    rpc.responses.set("thread/resume", { thread: { ...rolloutThread, status: { type: "idle" } }, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });
    rpc.responses.set("thread/read", { thread: { ...rolloutThread, turns: [] } });

    await bridge.listThreads("42");
    await bridge.selectThread("42", "1", 100);
    await writeFile(
      rolloutPath,
      [
        started,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "agent_message", message: "last rollout progress", phase: "commentary" },
        }),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "turn_aborted", turn_id: "external-turn", reason: "interrupted" },
        }),
        "",
      ].join("\n"),
    );

    await vi.advanceTimersByTimeAsync(150);

    await vi.waitFor(() => {
      expect(notifier.texts.at(-1)?.text).toContain("Codex завершил внешний turn: interrupted");
      expect(notifier.texts.at(-1)?.text).toContain("final_answer в rollout-файле не найден");
    });
    vi.useRealTimers();
  });

  it("treats response_item final_answer as an external rollout final", async () => {
    vi.useFakeTimers();
    bridge = new CodexBridge({
      rpc: rpc as never,
      state,
      notifier,
      logger: new Logger("error"),
      threadListLimit: 10,
      streamUpdatesMs: 100,
      streamMinChars: 5,
    });
    await bridge.start();

    const rolloutPath = join(dir, "rollout-thread-1.jsonl");
    const started = JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: { type: "task_started", turn_id: "rollout-turn", started_at: Math.floor(Date.now() / 1000) },
    });
    await writeFile(rolloutPath, `${started}\n`);
    const rolloutThread = { ...thread, path: rolloutPath };
    rpc.responses.set("thread/list", { data: [rolloutThread], nextCursor: null, backwardsCursor: null });
    rpc.responses.set("thread/resume", { thread: { ...rolloutThread, status: { type: "idle" } }, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });

    await bridge.listThreads("42");
    await bridge.selectThread("42", "1", 100);
    await writeFile(
      rolloutPath,
      [
        started,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "final from normalized response item" }],
          },
        }),
        "",
      ].join("\n"),
    );

    await vi.advanceTimersByTimeAsync(150);

    await vi.waitFor(() => {
      expect(notifier.texts.at(-1)?.text).toContain("final from normalized response item");
    });
    vi.useRealTimers();
  });

  it("notices selected VS Code turns that start outside Telegram", async () => {
    vi.useFakeTimers();
    const rolloutPath = join(dir, "rollout-thread-1.jsonl");
    const imagePath = join(dir, "external-shot.png");
    await writeFile(rolloutPath, "");
    await writeFile(imagePath, "fake image");
    await state.setSelectedThread("42", { ...thread, path: rolloutPath });
    await state.setLastChatId("42", 100);

    bridge = new CodexBridge({
      rpc: rpc as never,
      state,
      notifier,
      logger: new Logger("error"),
      threadListLimit: 10,
      streamUpdatesMs: 100,
      streamMinChars: 5,
      externalSessionWatchMs: 100,
    });
    await bridge.start();
    await vi.advanceTimersByTimeAsync(150);

    const started = JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: { type: "task_started", turn_id: "rollout-turn", started_at: Math.floor(Date.now() / 1000) },
    });
    await writeFile(rolloutPath, `${started}\n`);
    await vi.advanceTimersByTimeAsync(150);

    await vi.waitFor(() => {
      expect(notifier.texts.some((message) => message.text.includes("Заметил новый VS Code turn"))).toBe(true);
    });

    await writeFile(
      rolloutPath,
      [
        started,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "agent_message", message: "watched progress", phase: "commentary" },
        }),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: { type: "agent_message", message: `watched final [external-shot.png](${imagePath})`, phase: "final_answer" },
        }),
        "",
      ].join("\n"),
    );
    await vi.advanceTimersByTimeAsync(150);

    await vi.waitFor(() => {
      expect(notifier.texts.some((message) => message.text.includes("watched progress"))).toBe(true);
      expect(notifier.texts.at(-1)?.text).toContain("watched final");
      expect(notifier.photos).toEqual([{ chatId: "100", path: imagePath, caption: "Codex file: external-shot.png" }]);
    });
    vi.useRealTimers();
  });

  it("aggregates deltas and sends final result on turn completion", async () => {
    await state.setSelectedThread("42", thread);
    rpc.responses.set("thread/resume", { thread: { ...thread, status: { type: "idle" } }, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });
    rpc.responses.set("turn/start", {
      turn: { id: "turn-1", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null },
    });

    await bridge.startTextTurn("42", 100, "work");
    rpc.emit("notification", { method: "item/agentMessage/delta", params: { threadId: thread.id, turnId: "turn-1", itemId: "m1", delta: "done" } });
    rpc.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: thread.id,
        turn: { id: "turn-1", items: [], status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1000 },
      },
    });

    await vi.waitFor(() => {
      expect(notifier.texts.at(-1)?.text).toContain("done");
    });
  });

  it("sends existing local image paths referenced in final text", async () => {
    const imagePath = join(dir, "astanait-home.png");
    await writeFile(imagePath, "fake image");
    await state.setSelectedThread("42", thread);
    rpc.responses.set("thread/resume", { thread: { ...thread, status: { type: "idle" } }, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });
    rpc.responses.set("turn/start", {
      turn: { id: "turn-1", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null },
    });

    await bridge.startTextTurn("42", 100, "make screenshot");
    rpc.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: thread.id, turnId: "turn-1", itemId: "m1", delta: `Скрин: [astanait-home.png](${imagePath})` },
    });
    rpc.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: thread.id,
        turn: { id: "turn-1", items: [], status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1000 },
      },
    });

    await vi.waitFor(() => {
      expect(notifier.photos).toEqual([{ chatId: 100, path: imagePath, caption: "Codex file: astanait-home.png" }]);
    });
  });

  it("sends existing local document paths referenced in final text", async () => {
    const documentPath = join(dir, "Admission Plan 2026.pdf");
    await writeFile(documentPath, "%PDF-1.4");
    await state.setSelectedThread("42", thread);
    rpc.responses.set("thread/resume", { thread: { ...thread, status: { type: "idle" } }, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });
    rpc.responses.set("turn/start", {
      turn: { id: "turn-1", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null },
    });

    await bridge.startTextTurn("42", 100, "make pdf");
    rpc.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: thread.id, turnId: "turn-1", itemId: "m1", delta: `Файл: [Admission Plan 2026.pdf](${documentPath})` },
    });
    rpc.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: thread.id,
        turn: { id: "turn-1", items: [], status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1000 },
      },
    });

    await vi.waitFor(() => {
      expect(notifier.documents).toEqual([{ chatId: 100, path: documentPath, caption: "Codex file: Admission Plan 2026.pdf" }]);
    });
  });

  it("sends full final text even after intermediate streaming", async () => {
    vi.useFakeTimers();
    bridge = new CodexBridge({
      rpc: rpc as never,
      state,
      notifier,
      logger: new Logger("error"),
      threadListLimit: 10,
      streamUpdatesMs: 100,
      streamMinChars: 5,
    });
    await bridge.start();
    await state.setSelectedThread("42", thread);
    rpc.responses.set("thread/resume", { thread: { ...thread, status: { type: "idle" } }, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });
    rpc.responses.set("turn/start", {
      turn: { id: "turn-1", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null },
    });

    await bridge.startTextTurn("42", 100, "work");
    rpc.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: thread.id, turnId: "turn-1", itemId: "m1", delta: "first part. " },
    });
    await vi.advanceTimersByTimeAsync(150);
    rpc.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: thread.id, turnId: "turn-1", itemId: "m1", delta: "second part." },
    });
    rpc.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: thread.id,
        turn: { id: "turn-1", items: [], status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1000 },
      },
    });

    await vi.waitFor(() => {
      const finalText = notifier.texts.at(-1)?.text ?? "";
      expect(finalText).toContain("first part. second part.");
    });
    vi.useRealTimers();
  });

  it("streams intermediate agent text on a throttle", async () => {
    vi.useFakeTimers();
    bridge = new CodexBridge({
      rpc: rpc as never,
      state,
      notifier,
      logger: new Logger("error"),
      threadListLimit: 10,
      streamUpdatesMs: 100,
      streamMinChars: 5,
    });
    await bridge.start();
    await state.setSelectedThread("42", thread);
    rpc.responses.set("thread/resume", { thread: { ...thread, status: { type: "idle" } }, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });
    rpc.responses.set("turn/start", {
      turn: { id: "turn-1", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null },
    });

    await bridge.startTextTurn("42", 100, "work");
    rpc.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: thread.id, turnId: "turn-1", itemId: "m1", delta: "partial response" },
    });
    await vi.advanceTimersByTimeAsync(150);

    expect(notifier.texts.at(-1)?.text).toContain("Промежуточно, финальный ответ придет полностью");
    expect(notifier.texts.at(-1)?.text).toContain("partial response");
    vi.useRealTimers();
  });

  it("edits the same intermediate preview instead of sending multiple previews", async () => {
    vi.useFakeTimers();
    bridge = new CodexBridge({
      rpc: rpc as never,
      state,
      notifier,
      logger: new Logger("error"),
      threadListLimit: 10,
      streamUpdatesMs: 100,
      streamMinChars: 5,
    });
    await bridge.start();
    await state.setSelectedThread("42", thread);
    rpc.responses.set("thread/resume", { thread: { ...thread, status: { type: "idle" } }, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });
    rpc.responses.set("turn/start", {
      turn: { id: "turn-1", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null },
    });

    await bridge.startTextTurn("42", 100, "work");
    rpc.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: thread.id, turnId: "turn-1", itemId: "m1", delta: "first part. " },
    });
    await vi.advanceTimersByTimeAsync(150);
    rpc.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: thread.id, turnId: "turn-1", itemId: "m1", delta: "second part." },
    });
    await vi.advanceTimersByTimeAsync(150);

    const previews = notifier.texts.filter((message) => message.text.includes("Промежуточно"));
    expect(previews).toHaveLength(1);
    expect(notifier.updates).toHaveLength(1);
    expect(notifier.updates[0]).toMatchObject({ chatId: 100, messageId: 1 });
    expect(notifier.updates[0].text).toContain("first part. second part.");
    vi.useRealTimers();
  });

  it("routes command approvals through notifier and responds to Codex", async () => {
    await state.setSelectedThread("42", thread);
    rpc.responses.set("thread/resume", { thread: { ...thread, status: { type: "idle" } }, model: "gpt", modelProvider: "openai", serviceTier: null, cwd: thread.cwd });
    rpc.responses.set("turn/start", {
      turn: { id: "turn-1", items: [], status: "inProgress", error: null, startedAt: 1, completedAt: null, durationMs: null },
    });

    await bridge.startTextTurn("42", 100, "work");
    const request: JsonRpcRequest = {
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: thread.id, turnId: "turn-1", itemId: "cmd1", command: "npm test", cwd: thread.cwd },
    };
    rpc.emit("serverRequest", request);

    expect(notifier.approvals).toHaveLength(1);
    await bridge.approve(notifier.approvals[0].token, true);
    expect(rpc.responsesSent).toEqual([{ id: "approval-1", result: { decision: "accept" } }]);
  });

  it("extracts existing absolute local paths from markdown text", async () => {
    const filePath = join(dir, "result final.docx");
    await writeFile(filePath, "ok");

    expect(extractExistingLocalPaths(`Готово: [result final.docx](${filePath}). Missing: /tmp/nope.png`)).toEqual([
      filePath,
    ]);
  });
});
