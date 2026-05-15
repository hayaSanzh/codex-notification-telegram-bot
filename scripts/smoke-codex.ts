import { CodexRpcClient } from "../src/codex/rpc-client.js";
import type { ThreadListResponse } from "../src/codex/types.js";
import { Logger } from "../src/logger.js";

const logger = new Logger("warn");
const client = new CodexRpcClient({
  codexBin: process.env.CODEX_BIN || "codex",
  logger,
  requestTimeoutMs: 30_000,
});

try {
  await client.start();
  const response = await client.request<ThreadListResponse>("thread/list", {
    limit: 1,
    sortKey: "updated_at",
    sortDirection: "desc",
    archived: false,
  });
  console.log(JSON.stringify({ ok: true, count: response.data.length }, null, 2));
} finally {
  await client.stop();
}
