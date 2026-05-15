import "dotenv/config";

export interface AppConfig {
  telegramBotToken: string;
  allowedUserIds: Set<string>;
  codexBin: string;
  codexSandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  codexApprovalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  statePath: string;
  uploadDir: string;
  logPath: string;
  threadListLimit: number;
  mediaTextWaitMs: number;
  streamUpdatesMs: number;
  streamMinChars: number;
  externalSessionStaleMs: number;
  externalSessionTailBytes: number;
  externalSessionWatchMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function parseAllowedUserIds(raw: string): Set<string> {
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (values.length === 0) {
    throw new Error("TELEGRAM_ALLOWED_USER_IDS must contain at least one Telegram user id");
  }

  return new Set(values);
}

function parsePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseLogLevel(value: string | undefined): AppConfig["logLevel"] {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return "info";
}

function parseEnum<T extends string>(name: string, allowed: readonly T[]): T | undefined {
  const value = process.env[name]?.trim();
  if (!value) {
    return undefined;
  }
  if ((allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
}

export function loadConfig(): AppConfig {
  return {
    telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    allowedUserIds: parseAllowedUserIds(requireEnv("TELEGRAM_ALLOWED_USER_IDS")),
    codexBin: process.env.CODEX_BIN?.trim() || "codex",
    codexSandboxMode: parseEnum("CODEX_SANDBOX_MODE", ["read-only", "workspace-write", "danger-full-access"] as const),
    codexApprovalPolicy: parseEnum("CODEX_APPROVAL_POLICY", ["untrusted", "on-failure", "on-request", "never"] as const),
    statePath: process.env.STATE_PATH?.trim() || "data/state.json",
    uploadDir: process.env.UPLOAD_DIR?.trim() || "data/uploads",
    logPath: process.env.LOG_PATH?.trim() || "data/bot.log",
    threadListLimit: parsePositiveInt("THREAD_LIST_LIMIT", 10),
    mediaTextWaitMs: parsePositiveInt("MEDIA_TEXT_WAIT_MS", 3500),
    streamUpdatesMs: parsePositiveInt("STREAM_UPDATES_MS", 5000),
    streamMinChars: parsePositiveInt("STREAM_MIN_CHARS", 120),
    externalSessionStaleMs: parsePositiveInt("EXTERNAL_SESSION_STALE_MS", 12 * 60 * 60 * 1000),
    externalSessionTailBytes: parsePositiveInt("EXTERNAL_SESSION_TAIL_BYTES", 16 * 1024 * 1024),
    externalSessionWatchMs: parsePositiveInt("EXTERNAL_SESSION_WATCH_MS", 5000),
    logLevel: parseLogLevel(process.env.LOG_LEVEL),
  };
}
