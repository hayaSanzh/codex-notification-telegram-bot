import { describe, expect, it } from "vitest";
import { splitTelegramMessage, stripCommand } from "../src/telegram/message-utils.js";

describe("message utils", () => {
  it("splits long Telegram messages without exceeding the limit", () => {
    const chunks = splitTelegramMessage(`a\n\n${"b".repeat(50)}\n\n${"c".repeat(50)}`, 40);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 40)).toBe(true);
  });

  it("strips command prefix", () => {
    expect(stripCommand("/threads api", "/threads")).toBe("api");
  });
});
