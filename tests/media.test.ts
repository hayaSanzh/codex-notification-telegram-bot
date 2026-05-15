import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadTelegramFile } from "../src/telegram/media.js";

describe("downloadTelegramFile", () => {
  let dir: string | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stores Telegram files using absolute local paths", async () => {
    dir = await mkdtemp(join(tmpdir(), "codex-media-test-"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => Buffer.from("image-bytes").buffer,
      }),
    );

    const path = await downloadTelegramFile(
      { getFile: async () => ({ file_path: "photos/file_0.jpg" }) },
      "token",
      "file-id",
      join(dir, "uploads"),
      "thread/with:unsafe",
    );

    expect(isAbsolute(path)).toBe(true);
    expect(path).toContain("thread_with_unsafe");
    await expect(readFile(path)).resolves.toBeInstanceOf(Buffer);
  });

  it("keeps safe document extensions and original names", async () => {
    dir = await mkdtemp(join(tmpdir(), "codex-media-test-"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => Buffer.from("%PDF-1.4").buffer,
      }),
    );

    const path = await downloadTelegramFile(
      { getFile: async () => ({ file_path: "documents/file_7" }) },
      "token",
      "file-id",
      join(dir, "uploads"),
      "thread-1",
      "Admission Plan 2026.pdf",
    );

    expect(isAbsolute(path)).toBe(true);
    expect(path).toMatch(/Admission Plan 2026\.pdf$/);
    await expect(readFile(path)).resolves.toBeInstanceOf(Buffer);
  });
});
