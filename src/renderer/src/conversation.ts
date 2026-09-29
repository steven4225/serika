import type { UIMessage } from "ai";
import type { AgentEvent, RunResult } from "@aisdk-agent/core";
import { presentShellExec } from "../../shared/shell-result.js";
import type { ToolActivity } from "../../shared/ui-contract.js";
import type { ToolRowStatus } from "../../shared/tool-status.js";
import type { ShellProgressBuffer } from "../../shared/shell-progress.js";

export type { ToolRowStatus };

/**
 * Renderer-side view of one thread: committed messages read from the Store
 * plus the live Run being streamed. This is a display projection only; the
 * Store remains the single source of committed history and nothing here is
 * written back. Shell progress is overlayed from a process-local buffer and
 * never stored as transcript text.
 */

export interface ToolRow {
  kind: "tool";
  key: string;
  toolCallId: string;
  toolName: string;
  status: ToolRowStatus;
  detail?: string;
  stdout?: string;
  stderr?: string;
  progressTruncated?: boolean;
  timedOut?: boolean;
  cancelled?: boolean;
  exitCode?: number | null;
}

export interface TextRow {
  kind: "text";
  key: string;
  role: "user" | "assistant" | "system";
  text: string;
  /** Committed rows come from the Store; live rows come from the current Run. */
  committed: boolean;
}

export interface StepRow {
  kind: "step";
  key: string;
  step: number;
}

export interface ResultRow {
  kind: "result";
  key: string;
  status: RunResult["status"];
  detail?: string;
}

export type ConversationRow = ToolRow | TextRow | StepRow | ResultRow;

function messageRole(message: UIMessage): TextRow["role"] {
  return message.role === "user" || message.role === "assistant" ? message.role : "system";
}

function committedToolStatus(part: Extract<UIMessage["parts"][number], { type: "dynamic-tool" }>): {
  status: ToolRowStatus;
  detail?: string;
} {
  switch (part.state) {
    case "output-error":
      return part.errorText?.startsWith("TOOL_DENIED")
        ? { status: "denied", detail: part.errorText }
        : { status: "failed", detail: part.errorText };
    case "output-denied":
      return { status: "denied" };
    case "output-available": {
      const shell = presentShellExec(part.output);
      if (shell !== undefined) {
        return {
          status: shell.status,
          ...(shell.detail ? { detail: shell.detail } : {}),
        };
      }
      return toolOutcome(part.output);
    }
    case "input-streaming":
    case "input-available":
    case "approval-requested":
    case "approval-responded":
      return { status: "requested" };
    default: {
      const exhaustive: never = part;
      return exhaustive;
    }
  }
}

function withShellFields(
  row: ToolRow,
  output: unknown,
): ToolRow {
  const shell = presentShellExec(output);
  if (shell === undefined) return row;
  return {
    ...row,
    status: shell.status,
    ...(shell.detail ? { detail: shell.detail } : {}),
    timedOut: shell.timedOut,
    cancelled: shell.cancelled,
    progressTruncated: row.progressTruncated === true || shell.truncated,
    ...(shell.exitCode !== undefined ? { exitCode: shell.exitCode } : {}),
  };
}

/**
 * Walk parts in order so tool rows sit where the call happened, and merge
 * adjacent text parts of one message into a single row.
 */
export function rowsFromHistory(messages: readonly UIMessage[]): ConversationRow[] {
  const rows: ConversationRow[] = [];
  for (const message of messages) {
    const role = messageRole(message);
    let text = "";
    let textIndex = 0;
    const flushText = (): void => {
      if (text.trim().length === 0) {
        text = "";
        return;
      }
      rows.push({ kind: "text", key: `h:${message.id}:text:${textIndex}`, role, text, committed: true });
      textIndex += 1;
      text = "";
    };
    for (const part of message.parts) {
      if (part.type === "text") {
        text += part.text;
        continue;
      }
      if (part.type === "dynamic-tool") {
        flushText();
        const outcome = committedToolStatus(part);
        const row: ToolRow = {
          kind: "tool",
          key: `h:${message.id}:${part.toolCallId}`,
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          status: outcome.status,
          ...(outcome.detail ? { detail: outcome.detail } : {}),
        };
        rows.push(part.state === "output-available" ? withShellFields(row, part.output) : row);
      }
    }
    flushText();
  }
  return rows;
}

export function rowsFromToolActivity(activity: readonly ToolActivity[]): ConversationRow[] {
  return activity.map((item) => ({
    kind: "tool" as const,
    key: `t:${item.toolCallId}`,
    toolCallId: item.toolCallId,
    toolName: item.toolName,
    status: (item.status === "failed" ? "failed" : "ok") as ToolRowStatus,
    ...(item.truncated ? { detail: "回执已截断" } : {}),
  }));
}

export interface LiveRun {
  rows: ConversationRow[];
  /** Streaming assistant text for the current step. */
  streaming: string;
}

export const emptyLiveRun: LiveRun = { rows: [], streaming: "" };

function flushStreaming(live: LiveRun, key: string): ConversationRow[] {
  if (live.streaming.length === 0) return live.rows;
  return [...live.rows, { kind: "text", key, role: "assistant", text: live.streaming, committed: false }];
}

function toolOutcome(output: unknown): { status: ToolRowStatus; detail?: string } {
  if (typeof output !== "object" || output === null) return { status: "ok" };
  const record = output as { ok?: unknown; error?: { code?: unknown; message?: unknown } };
  if (record.ok === false) {
    const code = typeof record.error?.code === "string" ? record.error.code : "error";
    const message = typeof record.error?.message === "string" ? record.error.message : "";
    return { status: code === "TOOL_DENIED" ? "denied" : "failed", detail: message ? `${code}: ${message}` : code };
  }
  return { status: "ok" };
}

export function applyEvent(live: LiveRun, event: AgentEvent): LiveRun {
  const seq = String(event.sequence);
  switch (event.type) {
    case "step.started":
      return {
        rows: [...flushStreaming(live, `s:${seq}:text`), { kind: "step", key: `s:${seq}`, step: event.data.stepNumber }],
        streaming: "",
      };
    case "message.delta":
      return { rows: live.rows, streaming: live.streaming + event.data.text };
    case "tool.call.requested":
      return {
        rows: [
          ...flushStreaming(live, `t:${seq}:text`),
          {
            kind: "tool",
            key: `t:${event.data.toolCallId}`,
            toolCallId: event.data.toolCallId,
            toolName: event.data.toolName,
            status: "requested",
          },
        ],
        streaming: "",
      };
    case "tool.call.completed": {
      const outcome = presentShellExec(event.data.output) ?? toolOutcome(event.data.output);
      return {
        rows: live.rows.map((row) => {
          if (row.kind !== "tool" || row.toolCallId !== event.data.toolCallId) return row;
          const next: ToolRow = {
            ...row,
            status: outcome.status,
            ...(outcome.detail ? { detail: outcome.detail } : {}),
          };
          return presentShellExec(event.data.output) === undefined ? next : withShellFields(next, event.data.output);
        }),
        streaming: live.streaming,
      };
    }
    case "tool.call.failed": {
      const unknown = event.data.error.code === "TOOL_OUTCOME_UNKNOWN";
      return {
        rows: live.rows.map((row) =>
          row.kind === "tool" && row.toolCallId === event.data.toolCallId
            ? { ...row, status: unknown ? "unknown" : "failed", detail: event.data.error.message }
            : row,
        ),
        streaming: live.streaming,
      };
    }
    default:
      return live;
  }
}

export function overlayShellProgress(rows: ConversationRow[], buffer: ShellProgressBuffer): ConversationRow[] {
  return rows.map((row) => {
    if (row.kind !== "tool") return row;
    const view = buffer.view(row.toolCallId);
    if (view === undefined) return row;
    return {
      ...row,
      stdout: view.stdout,
      stderr: view.stderr,
      progressTruncated: view.truncated,
    };
  });
}

export function applyShellProgress(
  live: LiveRun,
  toolCallId: string,
  buffer: ShellProgressBuffer,
): LiveRun {
  const view = buffer.view(toolCallId);
  if (view === undefined) return live;
  const existing = live.rows.some((row) => row.kind === "tool" && row.toolCallId === toolCallId);
  if (!existing) {
    return {
      rows: [
        ...live.rows,
        {
          kind: "tool",
          key: `t:${toolCallId}`,
          toolCallId,
          toolName: "shell_exec",
          status: "requested",
          stdout: view.stdout,
          stderr: view.stderr,
          progressTruncated: view.truncated,
        },
      ],
      streaming: live.streaming,
    };
  }
  return { rows: overlayShellProgress(live.rows, buffer), streaming: live.streaming };
}

export function resultRow(result: RunResult): ResultRow {
  const detail = result.error ? `${result.error.code}: ${result.error.message}` : undefined;
  return { kind: "result", key: `r:${result.runId}`, status: result.status, ...(detail ? { detail } : {}) };
}

export function finishRun(live: LiveRun, result: RunResult): ConversationRow[] {
  return [...flushStreaming(live, `r:${result.runId}:text`), resultRow(result)];
}
