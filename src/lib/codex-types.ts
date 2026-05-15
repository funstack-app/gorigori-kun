// Loose types for codex app-server responses. We deliberately keep these
// permissive — the JSON-RPC payloads carry many fields and we only need the
// subset our UI actually renders.

export type ItemPhase = "commentary" | "final" | string;

export type ItemBase = {
  id: string;
  type: string;
  status?: "inProgress" | "completed" | "interrupted" | "failed";
  // free-form bag for fields we don't enumerate
  [key: string]: unknown;
};

export type AgentMessageItem = ItemBase & {
  type: "agentMessage";
  text?: string;
  phase?: ItemPhase;
};

export type ReasoningItem = ItemBase & {
  type: "reasoning";
  summary?: string;
  content?: string;
};

export type CommandExecutionItem = ItemBase & {
  type: "commandExecution";
  command?: string[];
  cwd?: string;
  output?: string;
};

export type FileChangeItem = ItemBase & {
  type: "fileChange";
  changes?: Array<{ path: string; kind: string; diff?: string }>;
};

export type DynamicToolCallItem = ItemBase & {
  type: "dynamicToolCall";
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  contentItems?: unknown[];
};

export type McpToolCallItem = ItemBase & {
  type: "mcpToolCall";
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
};

export type WebSearchItem = ItemBase & {
  type: "webSearch";
  query?: string;
};

export type ImageViewItem = ItemBase & {
  type: "imageView";
  path?: string;
};

/**
 * Codex emits this for every image_gen invocation. While running, only `id`
 * + `status` are reliable; on completion `savedPath` points at the file
 * codex wrote (under `~/.codex/generated_images/...`) and `revisedPrompt`
 * is the prompt the model actually used.
 */
export type ImageGenerationItem = ItemBase & {
  type: "imageGeneration";
  result?: string;
  revisedPrompt?: string | null;
  savedPath?: string | null;
};

export type UserMessageItem = ItemBase & {
  type: "userMessage";
  text?: string;
};

export type Item =
  | AgentMessageItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | DynamicToolCallItem
  | McpToolCallItem
  | WebSearchItem
  | ImageViewItem
  | ImageGenerationItem
  | UserMessageItem
  | ItemBase;

export type Turn = {
  id: string;
  status: "inProgress" | "completed" | "interrupted" | "failed";
  items: Item[];
  // text snapshot of the first text input (for left-rail labels)
  promptPreview?: string;
};

export type Thread = {
  id: string;
  name?: string;
  turns: Turn[];
};

// ──────────── Inputs ────────────
export type InputItemText = { type: "text"; text: string };
export type InputItemImageUrl = { type: "image"; url: string };
export type InputItemLocalImage = { type: "localImage"; path: string };
export type InputItem = InputItemText | InputItemImageUrl | InputItemLocalImage;

// ──────────── model/list shape ────────────
export type Model = {
  id: string;
  model: string;
  displayName: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  inputModalities?: string[];
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{
    reasoningEffort: string;
    description?: string;
  }>;
};
export type ModelList = { data: Model[]; nextCursor?: string | null };

// ──────────── thread/start params ────────────
export type ThreadStartParams = {
  model?: string;
  cwd?: string;
  approvalPolicy?: "never" | "on-request" | "everything";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  personality?: string;
};
export type ThreadStartResult = { thread: { id: string } };
