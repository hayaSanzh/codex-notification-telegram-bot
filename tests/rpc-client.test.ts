import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CodexRpcClient, type RpcProcess } from "../src/codex/rpc-client.js";
import { Logger } from "../src/logger.js";

class FakeProcess extends EventEmitter implements RpcProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  killed = false;

  constructor(private readonly onPayload: (payload: Record<string, unknown>, process: FakeProcess) => void) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const line of chunk.toString().split(/\r?\n/)) {
          if (!line.trim()) {
            continue;
          }
          this.onPayload(JSON.parse(line), this);
        }
        callback();
      },
    });
  }

  kill(): boolean {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
    return true;
  }

  send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

describe("CodexRpcClient", () => {
  it("initializes app-server and sends initialized notification", async () => {
    const seen: Record<string, unknown>[] = [];
    const fake = new FakeProcess((payload, process) => {
      seen.push(payload);
      if (payload.method === "initialize") {
        process.send({ id: payload.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } });
      }
    });

    const client = new CodexRpcClient({
      codexBin: "codex",
      logger: new Logger("error"),
      processFactory: () => fake,
    });

    await client.start();

    expect(seen[0]?.method).toBe("initialize");
    expect(seen[1]).toEqual({ method: "initialized" });
  });

  it("matches request responses by id", async () => {
    const fake = new FakeProcess((payload, process) => {
      if (payload.method === "initialize") {
        process.send({ id: payload.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } });
      }
      if (payload.method === "thread/list") {
        process.send({ id: payload.id, result: { data: [], nextCursor: null, backwardsCursor: null } });
      }
    });

    const client = new CodexRpcClient({
      codexBin: "codex",
      logger: new Logger("error"),
      processFactory: () => fake,
    });

    await client.start();
    await expect(client.request("thread/list", { limit: 1 })).resolves.toEqual({
      data: [],
      nextCursor: null,
      backwardsCursor: null,
    });
  });

  it("emits notifications and server requests", async () => {
    const fake = new FakeProcess((payload, process) => {
      if (payload.method === "initialize") {
        process.send({ id: payload.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } });
      }
    });
    const client = new CodexRpcClient({
      codexBin: "codex",
      logger: new Logger("error"),
      processFactory: () => fake,
    });
    const notification = vi.fn();
    const request = vi.fn();
    client.on("notification", notification);
    client.on("serverRequest", request);

    await client.start();
    fake.send({ method: "turn/completed", params: { threadId: "t1" } });
    fake.send({ id: "req1", method: "item/commandExecution/requestApproval", params: { threadId: "t1" } });

    expect(notification).toHaveBeenCalledWith({ method: "turn/completed", params: { threadId: "t1" } });
    expect(request).toHaveBeenCalledWith({
      id: "req1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "t1" },
    });
  });
});
