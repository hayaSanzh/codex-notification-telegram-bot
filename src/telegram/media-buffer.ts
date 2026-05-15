import { textInput, type UserInput } from "../codex/types.js";
import { splitTelegramMessage } from "./message-utils.js";

export interface MediaBufferBridge {
  startInputsTurn(userId: string, chatId: number | string, input: UserInput[]): Promise<string>;
}

export interface MediaBufferSender {
  sendMessage(chatId: number | string, text: string): Promise<unknown>;
}

interface PendingMedia {
  userId: string;
  chatId: number | string;
  threadId: string;
  mediaInputs: UserInput[];
  textParts: string[];
  timer: NodeJS.Timeout;
}

export class PendingMediaBuffer {
  private readonly pending = new Map<string, PendingMedia>();

  constructor(
    private readonly bridge: MediaBufferBridge,
    private readonly sender: MediaBufferSender,
    private readonly waitMs: number,
  ) {}

  addMedia(params: {
    userId: string;
    chatId: number | string;
    threadId: string;
    mediaInput: UserInput;
    caption?: string;
  }): void {
    const key = this.key(params.userId, params.chatId, params.threadId);
    const pending = this.pending.get(key);

    if (pending) {
      clearTimeout(pending.timer);
      pending.mediaInputs.push(params.mediaInput);
      if (params.caption?.trim()) {
        pending.textParts.push(params.caption.trim());
      }
      pending.timer = this.schedule(key);
      return;
    }

    this.pending.set(key, {
      userId: params.userId,
      chatId: params.chatId,
      threadId: params.threadId,
      mediaInputs: [params.mediaInput],
      textParts: params.caption?.trim() ? [params.caption.trim()] : [],
      timer: this.schedule(key),
    });
  }

  hasPending(userId: string, chatId: number | string, threadId: string): boolean {
    return this.pending.has(this.key(userId, chatId, threadId));
  }

  async flushWithText(userId: string, chatId: number | string, threadId: string, text: string): Promise<boolean> {
    const key = this.key(userId, chatId, threadId);
    const pending = this.pending.get(key);
    if (!pending) {
      return false;
    }

    if (text.trim()) {
      pending.textParts.push(text.trim());
    }
    await this.flush(key);
    return true;
  }

  private schedule(key: string): NodeJS.Timeout {
    return setTimeout(() => {
      void this.flush(key);
    }, this.waitMs);
  }

  private async flush(key: string): Promise<void> {
    const pending = this.pending.get(key);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(key);

    const text = pending.textParts.join("\n\n").trim() || "User attached media from Telegram. Inspect the attachment(s).";
    const input = [textInput(text), ...pending.mediaInputs];
    const result = await this.bridge.startInputsTurn(pending.userId, pending.chatId, input);

    for (const chunk of splitTelegramMessage(result)) {
      await this.sender.sendMessage(pending.chatId, chunk);
    }
  }

  private key(userId: string, chatId: number | string, threadId: string): string {
    return `${userId}:${chatId}:${threadId}`;
  }
}
