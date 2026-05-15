import { Bot } from "grammy";
import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { CodexRpcClient } from "./codex/rpc-client.js";
import { CodexBridge } from "./codex/bridge.js";
import { StateStore } from "./state/store.js";
import { registerTelegramHandlers, TelegramNotifier } from "./telegram/bot.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel, config.logPath);

  const state = new StateStore(config.statePath);
  await state.load();

  const rpc = new CodexRpcClient({
    codexBin: config.codexBin,
    sandboxMode: config.codexSandboxMode,
    approvalPolicy: config.codexApprovalPolicy,
    logger,
  });

  const bot = new Bot(config.telegramBotToken);
  const bridge = new CodexBridge({
    rpc,
    state,
    notifier: new TelegramNotifier(bot, logger),
    logger,
    threadListLimit: config.threadListLimit,
    streamUpdatesMs: config.streamUpdatesMs,
    streamMinChars: config.streamMinChars,
    externalSessionStaleMs: config.externalSessionStaleMs,
    externalSessionTailBytes: config.externalSessionTailBytes,
    externalSessionWatchMs: config.externalSessionWatchMs,
  });
  registerTelegramHandlers(bot, config, bridge, logger);
  await bridge.start();

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info("Shutting down", { signal });
    bot.stop();
    await rpc.stop();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info("Starting Telegram long polling");
  await bot.start({
    onStart: (info) => logger.info("Telegram bot started", { username: info.username }),
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
