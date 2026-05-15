export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse<T = unknown> {
  id: JsonRpcId;
  result: T;
}

export interface JsonRpcError {
  id: JsonRpcId | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface TextInput {
  type: "text";
  text: string;
  text_elements: [];
}

export interface LocalImageInput {
  type: "localImage";
  path: string;
}

export type UserInput = TextInput | LocalImageInput;

export interface ThreadStatus {
  type: "notLoaded" | "idle" | "systemError" | "active";
  activeFlags?: unknown[];
}

export interface CodexThread {
  id: string;
  sessionId?: string;
  preview: string;
  ephemeral: boolean;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  status: ThreadStatus;
  path: string | null;
  cwd: string;
  cliVersion: string;
  source: string;
  name: string | null;
  turns?: CodexTurn[];
}

export interface ThreadListResponse {
  data: CodexThread[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

export interface ThreadResumeResponse {
  thread: CodexThread;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
  cwd: string;
  approvalPolicy: string;
  approvalsReviewer: string;
  sandbox: unknown;
  reasoningEffort: string | null;
}

export interface ThreadReadResponse {
  thread: CodexThread;
}

export interface TurnStartResponse {
  turn: CodexTurn;
}

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export interface CodexTurn {
  id: string;
  items: ThreadItem[];
  itemsView?: unknown;
  status: TurnStatus;
  error: unknown | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

export type ThreadItem =
  | { type: "userMessage"; id: string; content: UserInput[] }
  | { type: "agentMessage"; id: string; text: string; phase: string | null; memoryCitation: unknown | null }
  | { type: "plan"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd: string;
      status: string;
      aggregatedOutput: string | null;
      exitCode: number | null;
      durationMs: number | null;
    }
  | {
      type: "fileChange";
      id: string;
      changes: Array<{ path: string; kind: string; diff: string }>;
      status: string;
    }
  | { type: "imageView"; id: string; path: string }
  | { type: "imageGeneration"; id: string; status: string; revisedPrompt: string | null; result: string; savedPath?: string }
  | { type: "__unknown"; id?: string; [key: string]: unknown };

export interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface TurnStartedNotification {
  threadId: string;
  turn: CodexTurn;
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: CodexTurn;
}

export interface CommandApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  proposedExecpolicyAmendment?: unknown;
  proposedNetworkPolicyAmendments?: unknown[];
}

export interface FileChangeApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  grantRoot?: string | null;
}

export interface PermissionsApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  cwd: string;
  reason: string | null;
  permissions: {
    network: unknown | null;
    fileSystem: unknown | null;
  };
}

export function textInput(text: string): TextInput {
  return { type: "text", text, text_elements: [] };
}
