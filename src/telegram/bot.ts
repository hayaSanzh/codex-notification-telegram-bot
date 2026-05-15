import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { BridgeNotifier, ChatId, CodexBridge } from "../codex/bridge.js";
import { textInput, type UserInput } from "../codex/types.js";
import { downloadTelegramFile } from "./media.js";
import { PendingMediaBuffer } from "./media-buffer.js";
import { splitTelegramMessage, stripCommand } from "./message-utils.js";

export class TelegramNotifier implements BridgeNotifier {
  constructor(private readonly bot: Bot, private readonly logger: Logger) {}

  async sendText(chatId: ChatId, text: string): Promise<number | undefined> {
    let firstMessageId: number | undefined;
    for (const chunk of splitTelegramMessage(text)) {
      const message = await this.bot.api.sendMessage(chatId, chunk);
      firstMessageId ??= message.message_id;
    }
    return firstMessageId;
  }

  async updateText(chatId: ChatId, messageId: number, text: string): Promise<void> {
    const [firstChunk] = splitTelegramMessage(text);
    try {
      await this.bot.api.editMessageText(chatId, messageId, firstChunk);
    } catch (error) {
      if (isMessageNotModifiedError(error)) {
        this.logger.debug("Skipping unchanged Telegram message edit", { chatId, messageId });
        return;
      }
      throw error;
    }
  }

  async sendApprovalRequest(chatId: ChatId, text: string, token: string): Promise<void> {
    const keyboard = new InlineKeyboard()
      .text("Approve", `approval:yes:${token}`)
      .text("Deny", `approval:no:${token}`);
    await this.bot.api.sendMessage(chatId, text, { reply_markup: keyboard });
  }

  async sendPhoto(chatId: ChatId, path: string, caption?: string): Promise<void> {
    try {
      await this.bot.api.sendPhoto(chatId, new InputFile(path), { caption });
    } catch (error) {
      this.logger.warn("Failed to send photo; falling back to document", { path, error: String(error) });
      await this.sendDocument(chatId, path, caption);
    }
  }

  async sendDocument(chatId: ChatId, path: string, caption?: string): Promise<void> {
    await this.bot.api.sendDocument(chatId, new InputFile(path), { caption });
  }
}

function isMessageNotModifiedError(error: unknown): boolean {
  const description =
    error && typeof error === "object" && "description" in error
      ? String((error as { description?: unknown }).description)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return description.includes("message is not modified") || message.includes("message is not modified");
}

export function createTelegramBot(config: AppConfig, bridge: CodexBridge, logger: Logger): Bot {
  const bot = new Bot(config.telegramBotToken);
  return registerTelegramHandlers(bot, config, bridge, logger);
}

export function registerTelegramHandlers(bot: Bot, config: AppConfig, bridge: CodexBridge, logger: Logger): Bot {
  const pendingMedia = new PendingMediaBuffer(bridge, bot.api, config.mediaTextWaitMs);

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id.toString();
    if (!userId || !config.allowedUserIds.has(userId)) {
      logger.warn("Rejected Telegram update from unauthorized user", { userId });
      if (ctx.chat?.id) {
        await ctx.reply("Access denied.");
      }
      return;
    }
    if (ctx.chat?.id !== undefined) {
      await bridge.rememberChat(userId, ctx.chat.id);
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(helpText());
  });

  bot.command("threads", async (ctx) => {
    await replySafely(ctx, async () => bridge.listThreads(ctx.from!.id.toString(), ctx.match?.toString()));
  });

  bot.command("use", async (ctx) => {
    const selector = ctx.match?.toString().trim() ?? "";
    await replySafely(ctx, async () => bridge.selectThread(ctx.from!.id.toString(), selector, ctx.chat!.id));
  });

  bot.command("current", async (ctx) => {
    await replySafely(ctx, async () => bridge.current(ctx.from!.id.toString(), ctx.chat!.id));
  });

  bot.command("status", async (ctx) => {
    await replySafely(ctx, async () => bridge.status(ctx.from!.id.toString(), ctx.chat!.id));
  });

  bot.command("interrupt", async (ctx) => {
    await replySafely(ctx, async () => bridge.interrupt(ctx.from!.id.toString()));
  });

  bot.callbackQuery(/^approval:(yes|no):(.+)$/, async (ctx) => {
    const match = ctx.match;
    const approved = match[1] === "yes";
    const token = match[2];
    const result = await bridge.approve(token, approved);
    await ctx.answerCallbackQuery({ text: result });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    await ctx.reply(result);
  });

  bot.on("message:photo", async (ctx) => {
    await handlePhoto(ctx, config, bridge, pendingMedia);
  });

  bot.on("message:document", async (ctx) => {
    await handleDocument(ctx, config, bridge, pendingMedia);
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) {
      await ctx.reply("Неизвестная команда. Используй /start.");
      return;
    }

    const selected = bridge.getSelectedThread(ctx.from.id.toString());
    if (selected && pendingMedia.hasPending(ctx.from.id.toString(), ctx.chat.id, selected.id)) {
      try {
        await pendingMedia.flushWithText(ctx.from!.id.toString(), ctx.chat!.id, selected.id, text);
      } catch (error) {
        await ctx.reply(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    await replySafely(ctx, async () => bridge.startTextTurn(ctx.from.id.toString(), ctx.chat.id, text));
  });

  bot.catch((error) => {
    logger.error("Telegram bot error", { error: error.message });
  });

  return bot;
}

async function handlePhoto(
  ctx: Context,
  config: AppConfig,
  bridge: CodexBridge,
  pendingMedia: PendingMediaBuffer,
): Promise<void> {
  if (!ctx.message?.photo || !ctx.chat || !ctx.from) {
    return;
  }

  const selected = bridge.getSelectedThread(ctx.from.id.toString());
  if (!selected) {
    await ctx.reply("Thread не выбран. Используй /threads, затем /use <номер>.");
    return;
  }

  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const path = await downloadTelegramFile(ctx.api, config.telegramBotToken, photo.file_id, config.uploadDir, selected.id);
  pendingMedia.addMedia({
    userId: ctx.from.id.toString(),
    chatId: ctx.chat.id,
    threadId: selected.id,
    mediaInput: { type: "localImage", path },
    caption: ctx.message.caption,
  });
}

async function handleDocument(
  ctx: Context,
  config: AppConfig,
  bridge: CodexBridge,
  pendingMedia: PendingMediaBuffer,
): Promise<void> {
  if (!ctx.message?.document || !ctx.chat || !ctx.from) {
    return;
  }

  const selected = bridge.getSelectedThread(ctx.from.id.toString());
  if (!selected) {
    await ctx.reply("Thread не выбран. Используй /threads, затем /use <номер>.");
    return;
  }

  const document = ctx.message.document;
  const path = await downloadTelegramFile(
    ctx.api,
    config.telegramBotToken,
    document.file_id,
    config.uploadDir,
    selected.id,
    document.file_name,
  );
  pendingMedia.addMedia({
    userId: ctx.from.id.toString(),
    chatId: ctx.chat.id,
    threadId: selected.id,
    mediaInput: textInput(`User attached file at local path: ${path}`),
    caption: ctx.message.caption,
  });
}

async function replySafely(ctx: Context, action: () => Promise<string>): Promise<void> {
  try {
    const message = await action();
    for (const chunk of splitTelegramMessage(message)) {
      await ctx.reply(chunk);
    }
  } catch (error) {
    await ctx.reply(error instanceof Error ? error.message : String(error));
  }
}

function helpText(): string {
  return [
    "Codex Telegram bridge.",
    "",
    "/threads [поиск] - показать существующие Codex-сессии",
    "/use <номер|thread_id> - выбрать существующую сессию",
    "/current - текущая сессия",
    "/status - активен ли turn",
    "/interrupt - остановить активный turn",
    "",
    "Обычный текст отправляется в выбранный thread. Новые threads из Telegram не создаются.",
  ].join("\n");
}
