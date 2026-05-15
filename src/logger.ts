import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

type LogLevel = "debug" | "info" | "warn" | "error";

const order: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  constructor(
    private readonly level: LogLevel = "info",
    private readonly filePath?: string,
  ) {}

  debug(message: string, meta?: unknown): void {
    this.write("debug", message, meta);
  }

  info(message: string, meta?: unknown): void {
    this.write("info", message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.write("warn", message, meta);
  }

  error(message: string, meta?: unknown): void {
    this.write("error", message, meta);
  }

  private write(level: LogLevel, message: string, meta?: unknown): void {
    if (order[level] < order[this.level]) {
      return;
    }

    const payload = {
      level,
      time: new Date().toISOString(),
      message,
      ...(meta === undefined ? {} : { meta: redact(meta) }),
    };
    const line = JSON.stringify(payload);
    if (this.filePath) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, `${line}\n`, "utf8");
    }
    if (level === "error" || level === "warn") {
      console.error(line);
    } else {
      console.log(line);
    }
  }
}

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]");
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(redact);
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|password|secret|auth/i.test(key)) {
      out[key] = "[redacted]";
    } else {
      out[key] = redact(item);
    }
  }
  return out;
}
