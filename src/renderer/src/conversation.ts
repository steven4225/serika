import type { UIMessage } from "ai";
import type { AgentEvent, RunResult } from "@aisdk-agent/core";

/**
 * Renderer-side view of one thread: committed messages read from the Store
 * plus the live Run being streamed. This is a display projection only; the
 * Store remains the single source of committed history and nothing here is
 * written back.
 */

export type ToolRowStatus = "requested" | "ok" | "failed" | "denied" | "unknown";

export interface ToolRow {
  kind: "tool";
  key: string;
  toolName: string;
  status: ToolRowStatus;
  detail?: string;
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
    case "output-available":
      return toolOutcome(part.output);
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
        rows.push({
          kind: "tool",
          key: `h:${message.id}:${part.toolCallId}`,
          toolName: part.toolName,
          status: outcome.status,
          ...(outcome.detail ? { detail: outcome.detail } : {}),
        });
      }
    }
    flushText();
  }
  return rows;
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
          { kind: "tool", key: `t:${event.data.toolCallId}`, toolName: event.data.toolName, status: "requested" },
        ],
        streaming: "",
      };
    case "tool.call.completed": {
      const outcome = toolOutcome(event.data.output);
      return {
        rows: live.rows.map((row) =>
          row.kind === "tool" && row.key === `t:${event.data.toolCallId}`
            ? { ...row, status: outcome.status, ...(outcome.detail ? { detail: outcome.detail } : {}) }
            : row,
        ),
        streaming: live.streaming,
      };
    }
    case "tool.call.failed": {
      const unknown = event.data.error.code === "TOOL_OUTCOME_UNKNOWN";
      return {
        rows: live.rows.map((row) =>
          row.kind === "tool" && row.key === `t:${event.data.toolCallId}`
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

export function finishRun(live: LiveRun, result: RunResult): ConversationRow[] {
  const rows = flushStreaming(live, `r:${result.runId}:text`);
  const detail = result.error ? `${result.error.code}: ${result.error.message}` : undefined;
  return [...rows, { kind: "result", key: `r:${result.runId}`, status: result.status, ...(detail ? { detail } : {}) }];
}
