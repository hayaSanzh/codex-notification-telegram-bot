import { describe, expect, it, vi } from "vitest";
import { PendingMediaBuffer } from "../src/telegram/media-buffer.js";

describe("PendingMediaBuffer", () => {
  it("combines pending media with next text into one Codex turn", async () => {
    const bridge = {
      startInputsTurn: vi.fn().mockResolvedValue("sent"),
    };
    const sender = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    const buffer = new PendingMediaBuffer(bridge, sender, 10_000);

    buffer.addMedia({
      userId: "1",
      chatId: 2,
      threadId: "t1",
      mediaInput: { type: "localImage", path: "/tmp/image.png" },
    });

    await expect(buffer.flushWithText("1", 2, "t1", "inspect this")).resolves.toBe(true);

    expect(bridge.startInputsTurn).toHaveBeenCalledWith("1", 2, [
      { type: "text", text: "inspect this", text_elements: [] },
      { type: "localImage", path: "/tmp/image.png" },
    ]);
    expect(sender.sendMessage).toHaveBeenCalledWith(2, "sent");
  });

  it("uses captions as text when no separate text arrives", async () => {
    vi.useFakeTimers();
    const bridge = {
      startInputsTurn: vi.fn().mockResolvedValue("sent"),
    };
    const sender = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    const buffer = new PendingMediaBuffer(bridge, sender, 100);

    buffer.addMedia({
      userId: "1",
      chatId: 2,
      threadId: "t1",
      mediaInput: { type: "localImage", path: "/tmp/image.png" },
      caption: "caption",
    });

    await vi.advanceTimersByTimeAsync(150);

    expect(bridge.startInputsTurn).toHaveBeenCalledWith("1", 2, [
      { type: "text", text: "caption", text_elements: [] },
      { type: "localImage", path: "/tmp/image.png" },
    ]);

    vi.useRealTimers();
  });

  it("passes Telegram documents as local file path text", async () => {
    const bridge = {
      startInputsTurn: vi.fn().mockResolvedValue("sent"),
    };
    const sender = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    const buffer = new PendingMediaBuffer(bridge, sender, 10_000);

    buffer.addMedia({
      userId: "1",
      chatId: 2,
      threadId: "t1",
      mediaInput: {
        type: "text",
        text: "User attached file at local path: /tmp/Admission Plan 2026.pdf",
        text_elements: [],
      },
    });

    await expect(buffer.flushWithText("1", 2, "t1", "проверь документ")).resolves.toBe(true);

    expect(bridge.startInputsTurn).toHaveBeenCalledWith("1", 2, [
      { type: "text", text: "проверь документ", text_elements: [] },
      {
        type: "text",
        text: "User attached file at local path: /tmp/Admission Plan 2026.pdf",
        text_elements: [],
      },
    ]);
  });
});
