import { dirname } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { CodexThread } from "../codex/types.js";

export interface ThreadRef {
  id: string;
  name: string | null;
  preview: string;
  cwd: string;
  source: string;
  updatedAt: number;
  status: string;
  path?: string | null;
}

export interface UserState {
  lastChatId?: string;
  selectedThreadId?: string;
  selectedThread?: ThreadRef;
  lastThreads?: ThreadRef[];
  activeTurn?: ActiveTurnRef;
}

export interface AppState {
  users: Record<string, UserState>;
}

export interface ActiveTurnRef {
  threadId: string;
  turnId: string;
  chatId: string;
  startedAt: number;
}

export class StateStore {
  private state: AppState = { users: {} };
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      this.state = JSON.parse(raw) as AppState;
      this.state.users ??= {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      this.state = { users: {} };
    }
  }

  async save(): Promise<void> {
    const nextSave = this.saveQueue.catch(() => undefined).then(() => this.writeState());
    this.saveQueue = nextSave;
    await nextSave;
  }

  private async writeState(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await rename(tmp, this.path);
  }

  getUser(userId: string): UserState {
    this.state.users[userId] ??= {};
    return this.state.users[userId];
  }

  getUsers(): Array<{ userId: string; state: UserState }> {
    return Object.entries(this.state.users).map(([userId, state]) => ({ userId, state }));
  }

  async setLastChatId(userId: string, chatId: string | number): Promise<void> {
    const user = this.getUser(userId);
    const value = String(chatId);
    if (user.lastChatId === value) {
      return;
    }
    user.lastChatId = value;
    await this.save();
  }

  getLastChatId(userId: string): string | undefined {
    const user = this.getUser(userId);
    return user.lastChatId ?? user.activeTurn?.chatId ?? userId;
  }

  async setLastThreads(userId: string, threads: CodexThread[]): Promise<ThreadRef[]> {
    const refs = threads.map(threadToRef);
    this.getUser(userId).lastThreads = refs;
    await this.save();
    return refs;
  }

  getLastThreads(userId: string): ThreadRef[] {
    return this.getUser(userId).lastThreads ?? [];
  }

  async setSelectedThread(userId: string, thread: CodexThread): Promise<ThreadRef> {
    const ref = threadToRef(thread);
    const user = this.getUser(userId);
    user.selectedThreadId = thread.id;
    user.selectedThread = ref;
    await this.save();
    return ref;
  }

  getSelectedThread(userId: string): ThreadRef | undefined {
    return this.getUser(userId).selectedThread;
  }

  async setSelectedThreadStatus(userId: string, threadId: string, status: string): Promise<void> {
    const user = this.getUser(userId);
    if (!user.selectedThread || user.selectedThread.id !== threadId || user.selectedThread.status === status) {
      return;
    }
    user.selectedThread.status = status;
    await this.save();
  }

  async setActiveTurn(userId: string, activeTurn: ActiveTurnRef): Promise<void> {
    this.getUser(userId).activeTurn = activeTurn;
    await this.save();
  }

  getActiveTurn(userId: string): ActiveTurnRef | undefined {
    return this.getUser(userId).activeTurn;
  }

  async clearActiveTurn(userId: string): Promise<void> {
    const user = this.getUser(userId);
    delete user.activeTurn;
    await this.save();
  }
}

export function threadToRef(thread: CodexThread): ThreadRef {
  return {
    id: thread.id,
    name: thread.name,
    preview: thread.preview,
    cwd: thread.cwd,
    source: thread.source,
    updatedAt: thread.updatedAt,
    status: thread.status.type,
    path: thread.path,
  };
}
