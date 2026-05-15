import { basename } from "node:path";
import type { CodexThread, CodexTurn, ThreadItem } from "./types.js";
import type { ThreadRef } from "../state/store.js";

export function formatThreadList(threads: ThreadRef[]): string {
  if (threads.length === 0) {
    return "Не нашел существующих Codex-сессий. Создай thread в VS Code extension или Codex CLI, потом повтори /threads.";
  }

  const lines = threads.map((thread, index) => {
    const title = thread.name || firstLine(thread.preview) || "(без названия)";
    return [
      `${index + 1}. ${title}`,
      `   cwd: ${thread.cwd}`,
      `   id: ${thread.id}`,
      `   source: ${thread.source}, status: ${thread.status}, updated: ${formatDate(thread.updatedAt)}`,
    ].join("\n");
  });

  return `Последние Codex-сессии:\n\n${lines.join("\n\n")}\n\nВыбери: /use <номер>`;
}

export function formatCurrentThread(thread: ThreadRef | CodexThread | undefined): string {
  if (!thread) {
    return "Thread не выбран. Используй /threads, затем /use <номер>.";
  }

  const title = thread.name || firstLine(thread.preview);
  const status = typeof thread.status === "string" ? thread.status : thread.status.type;
  return [
    `Текущий thread: ${title || "(без названия)"}`,
    `cwd: ${thread.cwd}`,
    `id: ${thread.id}`,
    `source: ${thread.source}`,
    `status: ${status}`,
  ].join("\n");
}

export function formatTurnResult(threadId: string, turn: CodexTurn, agentText: string): string {
  const summary = summarizeTurn(turn);
  const header = [`Codex завершил turn: ${turn.status}`, `thread: ${threadId}`];
  if (turn.durationMs !== null) {
    header.push(`duration: ${Math.round(turn.durationMs / 1000)}s`);
  }

  const body = agentText.trim() || "(Codex не вернул финальный текст)";
  return `${header.join("\n")}\n\n${body}${summary ? `\n\n${summary}` : ""}`;
}

export function summarizeTurn(turn: CodexTurn): string {
  const commands = turn.items
    .filter((item): item is Extract<ThreadItem, { type: "commandExecution" }> => item.type === "commandExecution")
    .slice(-6)
    .map((item) => {
      const status = item.exitCode === null ? item.status : `${item.status} (${item.exitCode})`;
      return `- ${truncateOneLine(item.command, 100)} -> ${status}`;
    });

  const fileChanges = new Set<string>();
  for (const item of turn.items) {
    if (item.type === "fileChange") {
      for (const change of item.changes) {
        fileChanges.add(change.path);
      }
    }
  }

  const parts: string[] = [];
  if (commands.length > 0) {
    parts.push(`Команды:\n${commands.join("\n")}`);
  }
  if (fileChanges.size > 0) {
    const paths = [...fileChanges].slice(0, 10).map((path) => `- ${path}`);
    const suffix = fileChanges.size > 10 ? `\n- ...и еще ${fileChanges.size - 10}` : "";
    parts.push(`Измененные файлы:\n${paths.join("\n")}${suffix}`);
  }

  return parts.join("\n\n");
}

export function extractAgentText(turn: CodexTurn): string {
  return turn.items
    .filter((item): item is Extract<ThreadItem, { type: "agentMessage" }> => item.type === "agentMessage")
    .map((item) => item.text)
    .filter(Boolean)
    .join("\n\n");
}

export function artifactPaths(turn: CodexTurn): string[] {
  const paths: string[] = [];
  for (const item of turn.items) {
    if (item.type === "imageGeneration") {
      paths.push(item.savedPath || item.result);
    }
  }
  return paths.filter(Boolean);
}

export function formatApprovalMessage(method: string, params: Record<string, unknown>): string {
  if (method === "item/commandExecution/requestApproval") {
    const command = String(params.command ?? "(command unavailable)");
    const cwd = String(params.cwd ?? "");
    const reason = params.reason ? `\nreason: ${params.reason}` : "";
    return `Codex просит разрешить команду:\n\n${command}\n\ncwd: ${cwd}${reason}`;
  }

  if (method === "item/fileChange/requestApproval") {
    const reason = params.reason ? `\nreason: ${params.reason}` : "";
    const grantRoot = params.grantRoot ? `\ngrant root: ${params.grantRoot}` : "";
    return `Codex просит разрешить изменение файлов.${reason}${grantRoot}`;
  }

  if (method === "item/permissions/requestApproval") {
    const cwd = String(params.cwd ?? "");
    const reason = params.reason ? `\nreason: ${params.reason}` : "";
    return `Codex просит дополнительные permissions.\n\ncwd: ${cwd}${reason}`;
  }

  return `Codex прислал request: ${method}`;
}

export function isProbablyImage(path: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(path);
}

function formatDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString();
}

function firstLine(value: string): string {
  return value.split(/\r?\n/)[0]?.trim() ?? "";
}

function truncateOneLine(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}...` : oneLine;
}

export function shortArtifactName(path: string): string {
  return basename(path) || path;
}
