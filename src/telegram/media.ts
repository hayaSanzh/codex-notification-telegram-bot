import { randomUUID } from "node:crypto";
import { basename, extname, join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

export interface TelegramFileApi {
  getFile(fileId: string): Promise<{ file_path?: string }>;
}

export async function downloadTelegramFile(
  api: TelegramFileApi,
  botToken: string,
  fileId: string,
  uploadDir: string,
  threadId: string,
  originalName?: string,
): Promise<string> {
  const file = await api.getFile(fileId);
  if (!file.file_path) {
    throw new Error("Telegram did not return file_path");
  }

  const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
  if (!response.ok) {
    throw new Error(`Telegram file download failed: ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const directory = resolve(uploadDir, sanitizePathSegment(threadId));
  await mkdir(directory, { recursive: true });

  const fallbackName = basename(file.file_path) || `${randomUUID()}${extname(file.file_path) || ".bin"}`;
  const safeName = sanitizeFileName(originalName || fallbackName);
  const finalName = `${Date.now()}-${randomUUID()}-${safeName}`;
  const path = join(directory, finalName);
  await writeFile(path, bytes);
  return path;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120) || "thread";
}

function sanitizeFileName(value: string): string {
  const base = basename(value).replace(/[^a-zA-Z0-9_. -]/g, "_").trim();
  return base.slice(0, 180) || "telegram-file.bin";
}
