import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { JsonRpcError, JsonRpcId, JsonRpcNotification, JsonRpcRequest } from "./types.js";
import type { Logger } from "../logger.js";

export interface RpcProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export interface CodexRpcClientOptions {
  codexBin: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  logger: Logger;
  requestTimeoutMs?: number;
  processFactory?: () => RpcProcess;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export class CodexRpcClient extends EventEmitter {
  private process?: RpcProcess;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private started = false;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: CodexRpcClientOptions) {
    super();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.process = this.options.processFactory?.() ?? this.spawnCodex();
    this.process.stdout.on("data", (chunk: Buffer | string) => this.handleStdout(chunk.toString()));
    this.process.stderr.on("data", (chunk: Buffer | string) => this.handleStderr(chunk.toString()));
    this.process.stdin.on("error", (error) => this.handleProcessError(error));
    this.process.on("exit", (code, signal) => this.handleExit(code, signal));
    this.process.on("error", (error) => this.handleProcessError(error));

    await this.request("initialize", {
      clientInfo: {
        name: "codex-notification-bot",
        title: "Codex Telegram Bot",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized");
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }
    this.process.kill("SIGTERM");
    this.process = undefined;
    this.started = false;
  }

  request<T>(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    const id = this.nextId++;
    const payload = params === undefined ? { id, method } : { id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex RPC request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        method,
        timer,
        resolve: (value) => resolve(value as T),
        reject,
      });

      try {
        this.write(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: JsonRpcId | null, code: number, message: string, data?: unknown): void {
    const error = data === undefined ? { code, message } : { code, message, data };
    this.write({ id, error });
  }

  private spawnCodex(): ChildProcessWithoutNullStreams {
    const args = this.appServerArgs();
    this.options.logger.info("Starting codex app-server", {
      codexBin: this.options.codexBin,
      sandboxMode: this.options.sandboxMode,
      approvalPolicy: this.options.approvalPolicy,
    });
    return spawn(this.options.codexBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
  }

  private appServerArgs(): string[] {
    const args = ["app-server"];
    if (this.options.approvalPolicy) {
      args.push("-c", `approval_policy="${this.options.approvalPolicy}"`);
    }
    if (this.options.sandboxMode) {
      args.push("-c", `sandbox_mode="${this.options.sandboxMode}"`);
    }
    return args;
  }

  private write(payload: unknown): void {
    if (!this.process) {
      throw new Error("Codex app-server is not running");
    }
    this.process.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      this.handleMessage(trimmed);
    }
  }

  private handleMessage(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.options.logger.warn("Failed to parse Codex RPC line", { line, error: String(error) });
      return;
    }

    if (!message || typeof message !== "object") {
      return;
    }

    const record = message as Record<string, unknown>;
    if (typeof record.method === "string" && record.id !== undefined) {
      this.emit("serverRequest", record as unknown as JsonRpcRequest);
      return;
    }

    if (typeof record.method === "string") {
      this.emit("notification", record as unknown as JsonRpcNotification);
      return;
    }

    if (record.id !== undefined && ("result" in record || "error" in record)) {
      this.handleResponse(record as { id: JsonRpcId; result?: unknown; error?: JsonRpcError["error"] });
    }
  }

  private handleResponse(message: { id: JsonRpcId; result?: unknown; error?: JsonRpcError["error"] }): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.options.logger.debug("Received response for unknown request", { id: message.id });
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(`${pending.method} failed: ${message.error.message}`));
      return;
    }
    pending.resolve(message.result);
  }

  private handleStderr(chunk: string): void {
    const text = chunk.trim();
    if (text) {
      this.options.logger.warn("Codex app-server stderr", { text });
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.options.logger.warn("Codex app-server exited", { code, signal });
    this.started = false;
    this.process = undefined;

    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Codex app-server exited before ${pending.method} completed`));
      this.pending.delete(id);
    }
  }

  private handleProcessError(error: Error): void {
    this.options.logger.error("Codex app-server process error", { error: error.message });
  }
}
