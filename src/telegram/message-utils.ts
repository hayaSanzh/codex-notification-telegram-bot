const TELEGRAM_SAFE_MESSAGE_LIMIT = 3900;

export function splitTelegramMessage(text: string, limit = TELEGRAM_SAFE_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n\n", limit);
    if (splitAt < limit * 0.5) {
      splitAt = remaining.lastIndexOf("\n", limit);
    }
    if (splitAt < limit * 0.5) {
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt < limit * 0.5) {
      splitAt = limit;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

export function stripCommand(text: string, command: string): string {
  const normalized = text.trim();
  if (!normalized.startsWith(command)) {
    return "";
  }
  return normalized.slice(command.length).trim();
}
