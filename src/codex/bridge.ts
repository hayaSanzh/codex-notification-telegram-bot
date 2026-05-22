import { existsSync, statSync } from "node:fs";
import type { Logger } from "../logger.js";
import type { StateStore, ThreadRef } from "../state/store.js";
import {
  detectActiveRollout,
  readNewRolloutEvents,
  readRolloutAnswerSnapshot,
  resolveRolloutPath,
  type RolloutEvent,
} from "./rollout-log.js";
import {
  artifactPaths,
  extractAgentText,
  formatApprovalMessage,
  formatCurrentThread,
  formatThreadList,
  formatTurnResult,
  isProbablyImage,
  shortArtifactName,
} from "./format.js";
import type { CodexRpcClient } from "./rpc-client.js";
import {
  type AgentMessageDeltaNotification,
  type CodexThread,
  type CodexTurn,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type ThreadListResponse,
  type ThreadReadResponse,
  type ThreadResumeResponse,
  type ThreadStatus,
  type TurnCompletedNotification,
  type TurnStartedNotification,
  type TurnStartResponse,
  type UserInput,
  textInput,
} from "./types.js";

export type ChatId = number | string;

export interface BridgeNotifier {
  sendText(chatId: ChatId, text: string): Promise<number | undefined>;
  updateText?(chatId: ChatId, messageId: number, text: string): Promise<void>;
  sendApprovalRequest(chatId: ChatId, text: string, token: string): Promise<void>;
  sendPhoto(chatId: ChatId, path: string, caption?: string): Promise<void>;
  sendDocument(chatId: ChatId, path: string, caption?: string): Promise<void>;
}

export interface CodexBridgeOptions {
  rpc: CodexRpcClient;
  state: StateStore;
  notifier: BridgeNotifier;
  logger: Logger;
  threadListLimit: number;
  streamUpdatesMs: number;
  streamMinChars: number;
  externalSessionStaleMs?: number;
  externalSessionTailBytes?: number;
  externalSessionWatchMs?: number;
}

interface ActiveTurn {
  chatId: ChatId;
  userId: string;
  threadId: string;
  turnId: string;
  origin: "bot" | "external";
  agentText: string;
  streamedOffset: number;
  streamMessageId?: number;
  streamTimer?: NodeJS.Timeout;
  rolloutPath?: string;
  rolloutOffset?: number;
  rolloutTimer?: NodeJS.Timeout;
  rolloutPolling?: boolean;
  startedAt: number;
}

interface ExternalTurnActivity {
  turnId: string;
  source: "thread" | "rollout";
  startedAt: number;
  rolloutPath?: string;
  rolloutOffset?: number;
}

interface PendingApproval {
  token: string;
  request: JsonRpcRequest;
  chatId: ChatId;
  createdAt: number;
}

export class CodexBridge {
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly idleRolloutOffsets = new Map<string, { path: string; offset: number }>();
  private approvalCounter = 0;
  private selectedThreadWatchTimer?: NodeJS.Timeout;
  private selectedThreadWatchRunning = false;

  constructor(private readonly options: CodexBridgeOptions) {}

  async start(): Promise<void> {
    this.options.rpc.on("notification", (notification) => {
      void this.handleNotification(notification as JsonRpcNotification).catch((error) => {
        this.options.logger.error("Failed to handle Codex notification", {
          method: (notification as JsonRpcNotification).method,
          error: String(error),
        });
      });
    });
    this.options.rpc.on("serverRequest", (request) => {
      void this.handleServerRequest(request as JsonRpcRequest).catch((error) => {
        this.options.logger.error("Failed to handle Codex server request", {
          method: (request as JsonRpcRequest).method,
          error: String(error),
        });
        this.respondSafeDeny(request as JsonRpcRequest);
      });
    });
    await this.options.rpc.start();
    this.startSelectedThreadWatcher();
  }

  async rememberChat(userId: string, chatId: ChatId): Promise<void> {
    await this.options.state.setLastChatId(userId, chatId);
  }

  async listThreads(userId: string, searchTerm?: string): Promise<string> {
    const response = await this.options.rpc.request<ThreadListResponse>("thread/list", {
      limit: this.options.threadListLimit,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false,
      searchTerm: searchTerm?.trim() || null,
    });
    const refs = await this.options.state.setLastThreads(userId, response.data);
    return formatThreadList(refs);
  }

  async selectThread(userId: string, selector: string, chatId?: ChatId): Promise<string> {
    const threadId = this.resolveThreadSelector(userId, selector);
    const response = await this.options.rpc.request<ThreadResumeResponse>("thread/resume", { threadId });
    const liveThread = await this.readThreadSafe(threadId);
    const externalActivity = await this.detectExternalActivity(threadId, response.thread, liveThread);
    const thread = externalActivity ? withStatus(response.thread, "active") : response.thread;
    const ref = await this.options.state.setSelectedThread(userId, thread);
    if (externalActivity && chatId !== undefined) {
      this.trackExternalTurn(userId, chatId, threadId, externalActivity);
    }
    const threadContext = await this.describeSelectedThreadPosition(threadId, liveThread, externalActivity);

    const suffix = externalActivity
      ? [
          "",
          externalActivity.source === "thread"
            ? "В истории этого thread последний turn еще inProgress."
            : "Rollout-файл этого thread показывает незавершенный VS Code turn.",
          externalActivity.rolloutPath
            ? "Бот будет читать новые промежуточные сообщения из rollout-файла."
            : "Если он запущен в VS Code, бот не всегда получит его stream из другого app-server, но новые prompts пока блокируются.",
          `active turn: ${externalActivity.turnId}`,
        ].join("\n")
      : "";

    return `Выбран thread.\n\n${formatCurrentThread(ref)}${suffix}${threadContext}`;
  }

  async current(userId: string, chatId?: ChatId): Promise<string> {
    const selected = this.options.state.getSelectedThread(userId);
    if (!selected) {
      return formatCurrentThread(undefined);
    }

    const active = this.activeTurns.get(selected.id);
    if (active) {
      if (active.origin === "external") {
        const stillActive = await this.refreshExternalActive(active, userId);
        if (!stillActive) {
          return this.current(userId, chatId);
        }
      }
      return formatActiveCurrent(selected, active);
    }

    const fresh = await this.options.rpc.request<ThreadResumeResponse>("thread/resume", {
      threadId: selected.id,
    });
    const liveThread = await this.readThreadSafe(selected.id);
    const externalActivity = await this.detectExternalActivity(selected.id, fresh.thread, liveThread);
    const effectiveThread = externalActivity ? withStatus(fresh.thread, "active") : fresh.thread;
    const ref = await this.options.state.setSelectedThread(userId, effectiveThread);

    if (externalActivity && chatId !== undefined) {
      const tracked = this.trackExternalTurn(userId, chatId, selected.id, externalActivity);
      return formatActiveCurrent(ref, tracked);
    }

    return formatCurrentThread(ref);
  }

  getSelectedThread(userId: string): ThreadRef | undefined {
    return this.options.state.getSelectedThread(userId);
  }

  async status(userId: string, chatId?: ChatId): Promise<string> {
    const selected = this.options.state.getSelectedThread(userId);
    if (!selected) {
      return "Thread не выбран. Используй /threads, затем /use <номер>.";
    }

    const active = this.activeTurns.get(selected.id);
    if (active) {
      if (active.origin === "external") {
        const stillActive = await this.refreshExternalActive(active, userId);
        if (!stillActive) {
          return this.status(userId, chatId);
        }
      }

      const seconds = Math.round((Date.now() - active.startedAt) / 1000);
      return `Codex занят ${seconds}s.\nthread: ${active.threadId}\nturn: ${active.turnId}`;
    }

    if (!active) {
      const persisted = this.options.state.getActiveTurn(userId);
      const fresh = await this.options.rpc.request<ThreadResumeResponse>("thread/resume", {
        threadId: selected.id,
      });
      const liveThread = await this.readThreadSafe(selected.id);
      const externalActivity = await this.detectExternalActivity(selected.id, fresh.thread, liveThread);
      const effectiveThread = externalActivity ? withStatus(fresh.thread, "active") : fresh.thread;
      const ref = await this.options.state.setSelectedThread(userId, effectiveThread);

      if (externalActivity && chatId !== undefined) {
        this.trackExternalTurn(userId, chatId, selected.id, externalActivity);
      }

      if (fresh.thread.status.type === "active" || externalActivity) {
        return [
          "Codex active для выбранного thread.",
          externalActivity
            ? externalActivity.source === "thread"
              ? `Последний turn в истории еще inProgress: ${externalActivity.turnId}`
              : `Rollout-файл показывает незавершенный turn: ${externalActivity.turnId}`
            : "app-server вернул status: active.",
          externalActivity?.rolloutPath
            ? "Промежуточные сообщения читаются напрямую из rollout-файла."
            : "Если turn запущен в VS Code, бот может не получить промежуточные события из-за отдельного app-server процесса.",
          "",
          formatCurrentThread(ref),
        ].join("\n");
      }

      if (persisted?.threadId === selected.id) {
        const recovered = await this.recoverLastTurn(userId, selected.id);
        if (recovered) {
          return recovered;
        }
      }

      return `Codex idle.\n\n${formatCurrentThread(ref)}`;
    }

    return `Codex idle.\n\n${formatCurrentThread(selected)}`;
  }

  async interrupt(userId: string): Promise<string> {
    const selected = this.options.state.getSelectedThread(userId);
    if (!selected) {
      return "Thread не выбран.";
    }

    const active = this.activeTurns.get(selected.id);
    if (!active) {
      return "Нет активного turn для выбранного thread.";
    }

    await this.options.rpc.request("turn/interrupt", {
      threadId: active.threadId,
      turnId: active.turnId,
    });
    return "Отправил interrupt в Codex.";
  }

  async startTextTurn(userId: string, chatId: ChatId, text: string): Promise<string> {
    return this.startInputsTurn(userId, chatId, [textInput(text)]);
  }

  async startInputsTurn(userId: string, chatId: ChatId, input: UserInput[]): Promise<string> {
    const selected = this.options.state.getSelectedThread(userId);
    if (!selected) {
      return "Thread не выбран. Используй /threads, затем /use <номер>.";
    }

    const trackedActive = this.activeTurns.get(selected.id);
    if (trackedActive?.origin === "external") {
      const stillActive = await this.refreshExternalActive(trackedActive, userId);
      if (stillActive) {
        return "Codex занят, сообщение не отправлено.";
      }
    } else if (trackedActive) {
      return "Codex занят, сообщение не отправлено.";
    }

    const resume = await this.options.rpc.request<ThreadResumeResponse>("thread/resume", {
      threadId: selected.id,
    });
    const liveThread = await this.readThreadSafe(selected.id);
    const externalActivity = await this.detectExternalActivity(selected.id, resume.thread, liveThread);
    if (externalActivity) {
      await this.options.state.setSelectedThread(userId, withStatus(resume.thread, "active"));
      this.trackExternalTurn(userId, chatId, selected.id, externalActivity);
      return [
        "Codex занят, сообщение не отправлено.",
        `thread: ${selected.id}`,
        `active turn: ${externalActivity.turnId}`,
        externalActivity.source === "thread"
          ? "Причина: последний turn в истории еще inProgress."
          : "Причина: rollout-файл показывает незавершенный VS Code turn.",
      ].join("\n");
    }
    if (resume.thread.status.type === "active") {
      await this.options.state.setSelectedThread(userId, resume.thread);
      return "Codex занят, сообщение не отправлено.";
    }

    const active: ActiveTurn = {
      chatId,
      userId,
      threadId: selected.id,
      turnId: "pending",
      origin: "bot",
      agentText: "",
      streamedOffset: 0,
      startedAt: Date.now(),
    };
    this.activeTurns.set(selected.id, active);

    let response: TurnStartResponse;
    try {
      response = await this.options.rpc.request<TurnStartResponse>("turn/start", {
        threadId: selected.id,
        input,
      });
    } catch (error) {
      this.activeTurns.delete(selected.id);
      throw error;
    }

    active.turnId = response.turn.id;
    await this.options.state.setActiveTurn(userId, {
      chatId: String(chatId),
      threadId: selected.id,
      turnId: response.turn.id,
      startedAt: active.startedAt,
    });

    return `Отправил в Codex.\nthread: ${selected.id}\nturn: ${response.turn.id}`;
  }

  async approve(token: string, approved: boolean): Promise<string> {
    const pending = this.pendingApprovals.get(token);
    if (!pending) {
      return "Approval уже неактуален или неизвестен.";
    }

    this.pendingApprovals.delete(token);
    this.options.rpc.respond(pending.request.id, this.approvalResult(pending.request.method, pending.request.params, approved));
    return approved ? "Approved." : "Denied.";
  }

  private startSelectedThreadWatcher(): void {
    const intervalMs = this.options.externalSessionWatchMs;
    if (!intervalMs || intervalMs <= 0 || this.selectedThreadWatchTimer) {
      return;
    }

    this.selectedThreadWatchTimer = setInterval(() => {
      void this.scanSelectedThreads();
    }, intervalMs);
    this.selectedThreadWatchTimer.unref();
    void this.scanSelectedThreads();
  }

  private async scanSelectedThreads(): Promise<void> {
    if (this.selectedThreadWatchRunning) {
      return;
    }

    this.selectedThreadWatchRunning = true;
    try {
      for (const { userId, state } of this.options.state.getUsers()) {
        const selected = state.selectedThread;
        const chatId = this.options.state.getLastChatId(userId);
        if (!selected || !chatId) {
          continue;
        }

        const active = this.activeTurns.get(selected.id);
        if (active) {
          if (active.origin === "external") {
            await this.refreshExternalActive(active, userId);
          }
          continue;
        }

        await this.watchSelectedThread(userId, chatId, selected);
      }
    } catch (error) {
      this.options.logger.warn("Failed to scan selected Codex threads", { error: String(error) });
    } finally {
      this.selectedThreadWatchRunning = false;
    }
  }

  private async watchSelectedThread(userId: string, chatId: ChatId, selected: ThreadRef): Promise<void> {
    const watched = this.idleRolloutOffsets.get(this.idleRolloutKey(String(chatId), selected.id));
    const liveThread = await this.readThreadSafe(selected.id);
    const persisted = this.options.state.getActiveTurn(userId);
    if (persisted?.threadId === selected.id) {
      const persistedTurn = turnById(liveThread, persisted.turnId);
      if (persistedTurn && persistedTurn.status !== "inProgress") {
        const rolloutActivity = await this.detectMatchingActiveRollout(
          selected.id,
          persisted.turnId,
          selected.path ?? liveThread?.path ?? undefined,
        );
        if (persistedTurn.status === "interrupted" && rolloutActivity) {
          this.trackExternalTurn(userId, chatId, selected.id, rolloutActivity);
          return;
        }

        await this.completeExternalHistoryTurn(
          {
            chatId: persisted.chatId,
            userId,
            threadId: persisted.threadId,
            turnId: persisted.turnId,
            origin: "external",
            agentText: "",
            streamedOffset: 0,
            startedAt: persisted.startedAt,
          },
          userId,
          persistedTurn,
        );
        return;
      }
    }

    const externalActivity = await this.detectExternalActivity(selected.id, selected, liveThread, watched?.path ?? selected.path ?? undefined);
    if (externalActivity) {
      const active = this.trackExternalTurn(userId, chatId, selected.id, externalActivity);
      await this.options.notifier.sendText(
        chatId,
        [
          "Заметил новый VS Code turn в выбранном thread.",
          `thread: ${selected.id}`,
          `turn: ${externalActivity.turnId}`,
          externalActivity.rolloutPath ? "Промежуточные сообщения и финал буду присылать сюда." : "Финал пришлю, когда Codex завершит turn.",
        ].join("\n"),
      );
      await this.pollRollout(active);
      return;
    }

    await this.pollIdleRollout(userId, selected, chatId);
    if (selected.status === "active") {
      await this.options.state.clearActiveTurn(userId);
      await this.options.state.setSelectedThreadStatus(userId, selected.id, "idle");
    }
  }

  private async pollIdleRollout(userId: string, selected: ThreadRef, chatId: ChatId): Promise<void> {
    const path = await resolveRolloutPath(selected.id, selected.path);
    if (!path) {
      return;
    }

    const key = this.idleRolloutKey(String(chatId), selected.id);
    const watched = this.idleRolloutOffsets.get(key);
    if (!watched || watched.path !== path) {
      const baseline = await readNewRolloutEvents(path, Number.MAX_SAFE_INTEGER);
      this.idleRolloutOffsets.set(key, { path, offset: baseline.nextOffset });
      return;
    }

    const result = await readNewRolloutEvents(path, watched.offset);
    const final = [...result.events].reverse().find(isFinalRolloutEvent);
    if (!final) {
      watched.offset = result.nextOffset;
      return;
    }

    const message = ["Codex завершил внешний VS Code turn.", `thread: ${selected.id}`, "", final.text].join("\n");
    await this.options.notifier.sendText(chatId, message);
    watched.offset = result.nextOffset;
    await this.sendReferencedPaths(chatId, extractExistingLocalPaths(message));
    await this.options.state.setSelectedThreadStatus(userId, selected.id, "idle");
  }

  private resolveThreadSelector(userId: string, selector: string): string {
    const value = selector.trim();
    const index = Number.parseInt(value, 10);
    if (Number.isInteger(index) && String(index) === value && index > 0) {
      const ref = this.options.state.getLastThreads(userId)[index - 1];
      if (!ref) {
        throw new Error(`Нет thread под номером ${index}. Сначала обнови список через /threads.`);
      }
      return ref.id;
    }
    if (!value) {
      throw new Error("Укажи номер или thread_id: /use <номер|thread_id>");
    }
    return value;
  }

  private async handleNotification(notification: JsonRpcNotification): Promise<void> {
    if (notification.method === "turn/started") {
      this.handleTurnStarted(notification.params as TurnStartedNotification);
      return;
    }

    if (notification.method === "item/agentMessage/delta") {
      this.handleAgentDelta(notification.params as AgentMessageDeltaNotification);
      return;
    }

    if (notification.method === "turn/completed") {
      await this.handleTurnCompleted(notification.params as TurnCompletedNotification);
      return;
    }
  }

  private handleTurnStarted(params: TurnStartedNotification): void {
    const active = this.activeTurns.get(params.threadId);
    if (active) {
      active.turnId = params.turn.id;
      void this.options.state.setActiveTurn(active.userId, {
        chatId: String(active.chatId),
        threadId: active.threadId,
        turnId: active.turnId,
        startedAt: active.startedAt,
      }).catch((error) => this.options.logger.warn("Failed to persist started turn", { error: String(error) }));
    }
  }

  private handleAgentDelta(params: AgentMessageDeltaNotification): void {
    const active = this.activeTurns.get(params.threadId);
    if (!active) {
      this.options.logger.debug("Ignoring agent delta without tracked Telegram turn", {
        threadId: params.threadId,
        turnId: params.turnId,
      });
      return;
    }
    if (active.turnId === "pending") {
      active.turnId = params.turnId;
    }
    if (active.turnId !== params.turnId) {
      return;
    }
    active.agentText += params.delta;
    this.scheduleStreamFlush(active);
  }

  private async handleTurnCompleted(params: TurnCompletedNotification): Promise<void> {
    const active = this.activeTurns.get(params.threadId);
    if (!active) {
      return;
    }
    this.clearTrackedActive(active);
    await this.options.state.clearActiveTurn(active.userId);
    if (active.origin === "external" && active.rolloutPath && active.rolloutOffset !== undefined) {
      this.idleRolloutOffsets.set(this.idleRolloutKey(String(active.chatId), active.threadId), {
        path: active.rolloutPath,
        offset: active.rolloutOffset,
      });
    }
    if (active.origin === "external") {
      await this.options.state.setSelectedThreadStatus(active.userId, active.threadId, "idle");
    }

    const agentText = extractAgentText(params.turn) || active.agentText;
    const message = formatTurnResult(params.threadId, params.turn, agentText);
    await this.options.notifier.sendText(active.chatId, message);
    await this.sendReferencedFiles(active.chatId, params.turn, message);
  }

  private scheduleStreamFlush(active: ActiveTurn): void {
    if (active.streamTimer) {
      return;
    }

    active.streamTimer = setTimeout(() => {
      active.streamTimer = undefined;
      void this.flushStream(active, false).catch((error) => {
        this.options.logger.warn("Failed to flush Telegram stream preview", {
          threadId: active.threadId,
          turnId: active.turnId,
          error: String(error),
        });
      });
    }, this.options.streamUpdatesMs);
  }

  private async flushStream(active: ActiveTurn, force: boolean): Promise<void> {
    const pendingText = active.agentText.slice(active.streamedOffset).trim();
    if (!pendingText) {
      return;
    }

    if (!force && pendingText.length < this.options.streamMinChars) {
      this.scheduleStreamFlush(active);
      return;
    }

    active.streamedOffset = active.agentText.length;
    const preview = `Промежуточно, финальный ответ придет полностью:\n\n${active.agentText.trim()}`;

    if (active.streamMessageId !== undefined && this.options.notifier.updateText) {
      await this.options.notifier.updateText(active.chatId, active.streamMessageId, preview);
      return;
    }

    const messageId = await this.options.notifier.sendText(active.chatId, preview);
    if (messageId !== undefined) {
      active.streamMessageId = messageId;
    }
  }

  private async recoverLastTurn(userId: string, threadId: string): Promise<string | null> {
    const response = await this.options.rpc.request<ThreadReadResponse>("thread/read", {
      threadId,
      includeTurns: true,
    });
    const lastTurn = response.thread.turns?.at(-1);
    if (!lastTurn) {
      return null;
    }

    if (lastTurn.status === "inProgress") {
      return `Codex turn еще inProgress.\nthread: ${threadId}\nturn: ${lastTurn.id}`;
    }

    await this.options.state.clearActiveTurn(userId);
    const agentText = extractAgentText(lastTurn);
    return `Восстановил последний результат из истории.\n\n${formatTurnResult(threadId, lastTurn, agentText)}`;
  }

  private async describeSelectedThreadPosition(
    threadId: string,
    liveThread: CodexThread | undefined,
    externalActivity: ExternalTurnActivity | undefined,
  ): Promise<string> {
    if (externalActivity) {
      const activeText = await this.readActiveTurnText(threadId, liveThread, externalActivity);
      return [
        "",
        "",
        "Актуальный промежуточный текст Codex:",
        `turn: ${externalActivity.turnId}`,
        "",
        activeText || "(Codex еще не написал промежуточный текст.)",
      ].join("\n");
    }

    const lastAnswerTurn = latestTurnWithAgentText(liveThread, (turn) => turn.status !== "inProgress");
    if (!lastAnswerTurn) {
      return "";
    }

    return [
      "",
      "",
      "Последний финальный ответ Codex:",
      `turn: ${lastAnswerTurn.id}`,
      `status: ${lastAnswerTurn.status}`,
      "",
      extractAgentText(lastAnswerTurn).trim(),
    ].join("\n");
  }

  private async readActiveTurnText(
    threadId: string,
    liveThread: CodexThread | undefined,
    externalActivity: ExternalTurnActivity,
  ): Promise<string> {
    const trackedText = this.activeTurns.get(threadId)?.agentText.trim() ?? "";
    const historyTurn = turnById(liveThread, externalActivity.turnId);
    const historyText = historyTurn ? extractAgentText(historyTurn).trim() : "";

    let rolloutText = "";
    const preferredPath = externalActivity.rolloutPath ?? liveThread?.path;
    if (preferredPath) {
      const snapshot = await readRolloutAnswerSnapshot(threadId, externalActivity.turnId, preferredPath, {
        tailBytes: this.options.externalSessionTailBytes,
      });
      rolloutText = snapshot?.text.trim() ?? "";
    }

    return [trackedText, historyText, rolloutText].find((text) => text.length > 0) ?? "";
  }

  private async readThreadSafe(threadId: string): Promise<CodexThread | undefined> {
    try {
      const response = await this.options.rpc.request<ThreadReadResponse>("thread/read", {
        threadId,
        includeTurns: true,
      });
      return response.thread;
    } catch (error) {
      this.options.logger.warn("Failed to read thread details", { threadId, error: String(error) });
      return undefined;
    }
  }

  private trackExternalTurn(userId: string, chatId: ChatId, threadId: string, activity: ExternalTurnActivity): ActiveTurn {
    const existing = this.activeTurns.get(threadId);
    if (existing) {
      const turnChanged = existing.turnId !== activity.turnId;
      existing.userId = userId;
      existing.chatId = chatId;
      existing.turnId = activity.turnId;
      existing.rolloutPath = activity.rolloutPath ?? existing.rolloutPath;
      existing.rolloutOffset = turnChanged ? activity.rolloutOffset : existing.rolloutOffset ?? activity.rolloutOffset;
      if (turnChanged) {
        existing.agentText = "";
        existing.streamedOffset = 0;
        existing.streamMessageId = undefined;
        existing.startedAt = activity.startedAt;
      }
      this.startRolloutPolling(existing);
      void this.persistActiveTurn(existing);
      void this.options.state.setSelectedThreadStatus(userId, threadId, "active");
      return existing;
    }

    const active: ActiveTurn = {
      chatId,
      userId,
      threadId,
      turnId: activity.turnId,
      origin: "external",
      agentText: "",
      streamedOffset: 0,
      rolloutPath: activity.rolloutPath,
      rolloutOffset: activity.rolloutOffset,
      startedAt: activity.startedAt,
    };
    this.activeTurns.set(threadId, active);
    this.startRolloutPolling(active);
    void this.persistActiveTurn(active);
    void this.options.state.setSelectedThreadStatus(userId, threadId, "active");
    return active;
  }

  private async persistActiveTurn(active: ActiveTurn): Promise<void> {
    try {
      await this.options.state.setActiveTurn(active.userId, {
        chatId: String(active.chatId),
        threadId: active.threadId,
        turnId: active.turnId,
        startedAt: active.startedAt,
      });
    } catch (error) {
      this.options.logger.warn("Failed to persist external turn", { threadId: active.threadId, error: String(error) });
    }
  }

  private async refreshExternalActive(active: ActiveTurn, userId: string): Promise<boolean> {
    const liveThread = await this.readThreadSafe(active.threadId);
    const trackedTurn = turnById(liveThread, active.turnId);
    if (trackedTurn && trackedTurn.status !== "inProgress") {
      if (trackedTurn.status === "interrupted" && active.rolloutPath) {
        await this.pollRollout(active);
        if (!this.activeTurns.has(active.threadId)) {
          return false;
        }
        return true;
      }

      await this.completeExternalHistoryTurn(active, userId, trackedTurn);
      return false;
    }

    const latestActivity = await this.detectExternalActivity(active.threadId, liveThread, liveThread, active.rolloutPath);
    if (latestActivity) {
      active.turnId = latestActivity.turnId;
      active.rolloutPath = latestActivity.rolloutPath ?? active.rolloutPath;
      active.rolloutOffset = active.rolloutOffset ?? latestActivity.rolloutOffset;
      this.startRolloutPolling(active);
      return true;
    }

    if (active.rolloutPath) {
      const rolloutStatus = await this.pollRollout(active);
      if (!this.activeTurns.has(active.threadId)) {
        return false;
      }
      if (rolloutStatus === "failed") {
        return true;
      }
    }

    this.clearTrackedActive(active);
    await this.options.state.clearActiveTurn(userId);
    await this.options.state.setSelectedThreadStatus(userId, active.threadId, "idle");
    return false;
  }

  private async completeExternalHistoryTurn(active: ActiveTurn, userId: string, turn: CodexTurn): Promise<void> {
    this.clearTrackedActive(active);
    await this.options.state.clearActiveTurn(userId);
    await this.options.state.setSelectedThreadStatus(userId, active.threadId, "idle");
    const rolloutText = active.rolloutPath
      ? (
          await readRolloutAnswerSnapshot(active.threadId, turn.id, active.rolloutPath, {
            tailBytes: this.options.externalSessionTailBytes,
          })
        )?.text
      : "";
    const agentText = extractAgentText(turn) || active.agentText || rolloutText || "";
    const message = formatTurnResult(active.threadId, turn, agentText);
    await this.options.notifier.sendText(active.chatId, message);
    await this.sendReferencedFiles(active.chatId, turn, message);
  }

  private async detectExternalActivity(
    threadId: string,
    thread: CodexThread | ThreadRef | undefined,
    liveThread?: CodexThread,
    fallbackRolloutPath?: string,
  ): Promise<ExternalTurnActivity | undefined> {
    const latestActiveTurn = latestInProgressTurn(liveThread);
    const rollout = await detectActiveRollout(threadId, thread?.path ?? fallbackRolloutPath, {
      staleMs: this.options.externalSessionStaleMs,
      tailBytes: this.options.externalSessionTailBytes,
    });

    if (latestActiveTurn) {
      const startedAt = normalizeStartedAt(latestActiveTurn.startedAt);
      if (rollout && rollout.turnId !== latestActiveTurn.id && rollout.startedAt > startedAt + 1000) {
        return {
          turnId: rollout.turnId,
          source: "rollout",
          startedAt: rollout.startedAt,
          rolloutPath: rollout.path,
          rolloutOffset: rollout.offset,
        };
      }

      return {
        turnId: latestActiveTurn.id,
        source: "thread",
        startedAt,
        rolloutPath: rollout?.turnId === latestActiveTurn.id ? rollout.path : undefined,
        rolloutOffset: rollout?.turnId === latestActiveTurn.id ? rollout.offset : undefined,
      };
    }

    if (!rollout) {
      return undefined;
    }
    const rolloutTurn = turnById(liveThread, rollout.turnId);
    if (rolloutTurn && rolloutTurn.status !== "inProgress" && rolloutTurn.status !== "interrupted") {
      return undefined;
    }

    return {
      turnId: rollout.turnId,
      source: "rollout",
      startedAt: rollout.startedAt,
      rolloutPath: rollout.path,
      rolloutOffset: rollout.offset,
    };
  }

  private async detectMatchingActiveRollout(
    threadId: string,
    turnId: string,
    preferredPath?: string | null,
  ): Promise<ExternalTurnActivity | undefined> {
    const rollout = await detectActiveRollout(threadId, preferredPath, {
      staleMs: this.options.externalSessionStaleMs,
      tailBytes: this.options.externalSessionTailBytes,
    });
    if (!rollout || rollout.turnId !== turnId) {
      return undefined;
    }
    return {
      turnId: rollout.turnId,
      source: "rollout",
      startedAt: rollout.startedAt,
      rolloutPath: rollout.path,
      rolloutOffset: rollout.offset,
    };
  }

  private startRolloutPolling(active: ActiveTurn): void {
    if (!active.rolloutPath || active.rolloutTimer) {
      return;
    }

    active.rolloutTimer = setInterval(() => {
      void this.pollRollout(active);
    }, this.options.streamUpdatesMs);
    active.rolloutTimer.unref();
  }

  private async pollRollout(active: ActiveTurn): Promise<"active" | "idle" | "failed"> {
    if (!active.rolloutPath || active.rolloutPolling) {
      return "active";
    }

    active.rolloutPolling = true;
    try {
      const result = await readNewRolloutEvents(active.rolloutPath, active.rolloutOffset ?? 0);
      for (const event of result.events) {
        if (event.kind === "taskStarted") {
          if (event.turnId !== active.turnId && active.origin === "external") {
            await this.switchExternalRolloutTurn(active, event.turnId, event.timestamp);
          }
          continue;
        }

        if (event.kind === "terminal") {
          if (!event.turnId || event.turnId === active.turnId) {
            await this.completeExternalRollout(
              active,
              `(VS Code завершил turn со статусом ${event.status}, но final_answer в rollout-файле не найден.)`,
              event.status,
              result.nextOffset,
            );
            return "idle";
          }
          continue;
        }

        if (event.turnId && event.turnId !== active.turnId) {
          continue;
        }

        if (event.kind === "commentary") {
          const nextAgentText = mergeRolloutCommentary(active.agentText, event.text);
          if (nextAgentText !== active.agentText) {
            const previousAgentText = active.agentText;
            active.agentText = nextAgentText;
            try {
              await this.flushStream(active, true);
            } catch (error) {
              active.agentText = previousAgentText;
              throw error;
            }
          }
        } else {
          await this.completeExternalRollout(active, event.text, "completed", result.nextOffset);
          return "idle";
        }
      }
      active.rolloutOffset = result.nextOffset;
      return "active";
    } catch (error) {
      this.options.logger.warn("Failed to poll rollout file", {
        threadId: active.threadId,
        rolloutPath: active.rolloutPath,
        error: String(error),
      });
      return "failed";
    } finally {
      active.rolloutPolling = false;
    }
  }

  private async switchExternalRolloutTurn(active: ActiveTurn, turnId: string, startedAt: number): Promise<void> {
    active.turnId = turnId;
    active.startedAt = startedAt;
    active.agentText = "";
    active.streamedOffset = 0;
    active.streamMessageId = undefined;
    await this.persistActiveTurn(active);
    await this.options.notifier.sendText(
      active.chatId,
      ["Заметил следующий VS Code turn в выбранном thread.", `thread: ${active.threadId}`, `turn: ${turnId}`].join("\n"),
    );
  }

  private async completeExternalRollout(
    active: ActiveTurn,
    finalText: string,
    status: "completed" | "failed" | "cancelled" | "interrupted" = "completed",
    rolloutOffset?: number,
  ): Promise<void> {
    const seconds = Math.round((Date.now() - active.startedAt) / 1000);
    const message = [
      `Codex завершил внешний turn: ${status}`,
      `thread: ${active.threadId}`,
      `turn: ${active.turnId}`,
      `duration: ${seconds}s`,
      "",
      finalText,
    ].join("\n");
    await this.options.notifier.sendText(active.chatId, message);

    const completedOffset = rolloutOffset ?? active.rolloutOffset;
    if (active.rolloutPath && completedOffset !== undefined) {
      active.rolloutOffset = completedOffset;
      this.idleRolloutOffsets.set(this.idleRolloutKey(String(active.chatId), active.threadId), {
        path: active.rolloutPath,
        offset: completedOffset,
      });
    }

    this.clearTrackedActive(active);
    await this.options.state.clearActiveTurn(active.userId);
    await this.options.state.setSelectedThreadStatus(active.userId, active.threadId, "idle");
    await this.sendReferencedPaths(active.chatId, extractExistingLocalPaths(message));
  }

  private clearTrackedActive(active: ActiveTurn): void {
    this.activeTurns.delete(active.threadId);
    if (active.streamTimer) {
      clearTimeout(active.streamTimer);
      active.streamTimer = undefined;
    }
    if (active.rolloutTimer) {
      clearInterval(active.rolloutTimer);
      active.rolloutTimer = undefined;
    }
  }

  private idleRolloutKey(chatId: string, threadId: string): string {
    return `${chatId}:${threadId}`;
  }

  private async sendReferencedFiles(chatId: ChatId, turn: TurnCompletedNotification["turn"], text: string): Promise<void> {
    const paths = new Set([...artifactPaths(turn), ...extractExistingLocalPaths(text)]);
    await this.sendReferencedPaths(chatId, paths);
  }

  private async sendReferencedPaths(chatId: ChatId, paths: Iterable<string>): Promise<void> {
    for (const path of paths) {
      const caption = `Codex file: ${shortArtifactName(path)}`;
      if (isProbablyImage(path)) {
        await this.options.notifier.sendPhoto(chatId, path, caption);
      } else {
        await this.options.notifier.sendDocument(chatId, path, caption);
      }
    }
  }

  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const active = threadId ? this.activeTurns.get(threadId) : undefined;

    if (!active) {
      this.options.logger.warn("Denying Codex request without active Telegram turn", {
        method: request.method,
        threadId,
      });
      this.respondSafeDeny(request);
      return;
    }

    if (isApprovalMethod(request.method)) {
      const token = this.nextApprovalToken();
      this.pendingApprovals.set(token, {
        token,
        request,
        chatId: active.chatId,
        createdAt: Date.now(),
      });
      await this.options.notifier.sendApprovalRequest(active.chatId, formatApprovalMessage(request.method, params), token);
      return;
    }

    if (request.method === "item/tool/requestUserInput") {
      await this.options.notifier.sendText(active.chatId, "Codex запросил user input, но Telegram bridge пока отвечает пустым ответом.");
      this.options.rpc.respond(request.id, { answers: {} });
      return;
    }

    this.options.logger.warn("Unsupported Codex server request", { method: request.method });
    this.options.rpc.respondError(request.id, -32601, `Unsupported server request: ${request.method}`);
  }

  private approvalResult(method: string, params: unknown, approved: boolean): unknown {
    if (method === "item/commandExecution/requestApproval") {
      return { decision: approved ? "accept" : "decline" };
    }
    if (method === "item/fileChange/requestApproval") {
      return { decision: approved ? "accept" : "decline" };
    }
    if (method === "item/permissions/requestApproval") {
      if (!approved) {
        return { permissions: {}, scope: "turn", strictAutoReview: true };
      }
      const permissions = (params as { permissions?: { network?: unknown; fileSystem?: unknown } }).permissions ?? {};
      return {
        permissions: {
          ...(permissions.network ? { network: permissions.network } : {}),
          ...(permissions.fileSystem ? { fileSystem: permissions.fileSystem } : {}),
        },
        scope: "turn",
        strictAutoReview: false,
      };
    }
    if (method === "execCommandApproval" || method === "applyPatchApproval") {
      return { decision: approved ? "approved" : "denied" };
    }
    return {};
  }

  private respondSafeDeny(request: JsonRpcRequest): void {
    if (isApprovalMethod(request.method)) {
      this.options.rpc.respond(request.id, this.approvalResult(request.method, request.params, false));
      return;
    }
    if (request.method === "item/tool/requestUserInput") {
      this.options.rpc.respond(request.id, { answers: {} });
      return;
    }
    this.options.rpc.respondError(request.id, -32601, `Unsupported server request: ${request.method}`);
  }

  private nextApprovalToken(): string {
    this.approvalCounter += 1;
    return `${Date.now().toString(36)}${this.approvalCounter.toString(36)}`;
  }
}

function latestInProgressTurn(thread: CodexThread | undefined): CodexTurn | undefined {
  const latest = thread?.turns?.at(-1);
  return latest?.status === "inProgress" ? latest : undefined;
}

function formatActiveCurrent(thread: ThreadRef, active: ActiveTurn): string {
  const seconds = Math.round((Date.now() - active.startedAt) / 1000);
  return [
    formatCurrentThread({ ...thread, status: "active" }),
    `active turn: ${active.turnId}`,
    `origin: ${active.origin}`,
    `running: ${seconds}s`,
  ].join("\n");
}

function latestTurnWithAgentText(thread: CodexThread | undefined, predicate: (turn: CodexTurn) => boolean): CodexTurn | undefined {
  const turns = thread?.turns ?? [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (predicate(turn) && extractAgentText(turn).trim()) {
      return turn;
    }
  }
  return undefined;
}

function turnById(thread: CodexThread | undefined, turnId: string): CodexTurn | undefined {
  return thread?.turns?.find((turn) => turn.id === turnId);
}

function withStatus(thread: CodexThread, status: ThreadStatus["type"]): CodexThread {
  return {
    ...thread,
    status: {
      ...thread.status,
      type: status,
    },
  };
}

function normalizeStartedAt(startedAt: number | null): number {
  if (!startedAt) {
    return Date.now();
  }
  return startedAt < 10_000_000_000 ? startedAt * 1000 : startedAt;
}

function mergeRolloutCommentary(current: string, next: string): string {
  const currentText = current.trim();
  const nextText = next.trim();
  if (!nextText) {
    return current;
  }
  if (!currentText) {
    return nextText;
  }
  if (currentText === nextText || currentText.endsWith(`\n\n${nextText}`)) {
    return current;
  }
  if (nextText.startsWith(currentText)) {
    return nextText;
  }
  return `${currentText}\n\n${nextText}`;
}

function isFinalRolloutEvent(event: RolloutEvent): event is RolloutEvent & { kind: "final"; text: string } {
  return event.kind === "final";
}

export function extractExistingLocalPaths(text: string): string[] {
  const paths = new Set<string>();
  const markdownPathPattern = /\]\((\/(?:home|tmp|var|mnt|media|opt|srv|workspace)\/[^)\r\n]+)\)/g;
  const backtickPathPattern = /`(\/(?:home|tmp|var|mnt|media|opt|srv|workspace)\/[^`\r\n]+)`/g;
  const absolutePathPattern = /\/(?:home|tmp|var|mnt|media|opt|srv|workspace)\/[^\s)'"]+/g;

  for (const match of text.matchAll(markdownPathPattern)) {
    addPath(paths, match[1]);
  }
  for (const match of text.matchAll(backtickPathPattern)) {
    addPath(paths, match[1]);
  }
  for (const match of text.matchAll(absolutePathPattern)) {
    addPath(paths, match[0]);
  }
  return [...paths];
}

function addPath(paths: Set<string>, value: string): void {
  const path = cleanPathCandidate(value);
  if (path && isReadableFile(path)) {
    paths.add(path);
  }
}

function cleanPathCandidate(value: string): string {
  return value.trim().replace(/[.,;:!?]+$/g, "");
}

function isReadableFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function isApprovalMethod(method: string): boolean {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/permissions/requestApproval" ||
    method === "execCommandApproval" ||
    method === "applyPatchApproval"
  );
}
