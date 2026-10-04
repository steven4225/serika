import type { UIMessage } from "ai";
import type { AgentEvent, RunResult } from "@aisdk-agent/core";
import { presentShellExec } from "../../shared/shell-result.js";
import type { ToolActivity } from "../../shared/ui-contract.js";
import type { ToolRowStatus } from "../../shared/tool-status.js";
import type { ShellProgressBuffer } from "../../shared/shell-progress.js";
import { presentComputerResult } from "../../shared/computer.js";
import type { ExecutionToolRecord, ExecutionRunRecord } from "../../shared/ui-contract.js";
import { fileToolReceipt, type FileToolReceipt } from "./delivery-data.js";

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
  /** Only full history/event outcomes have this marker; never receipt previews. */
  outcomeSource?: "full";
  /** Full history/event output only, never a bounded summary or model claim. */
  receipt?: FileToolReceipt;
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
  completion?: NonNullable<RunResult["completion"]>;
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
      return part.errorText?.startsWith("TOOL_OUTCOME_UNKNOWN") ? { status: "unknown", detail: part.errorText } : part.errorText?.startsWith("TOOL_DENIED")
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
      return presentComputerResult(part.toolName, part.output) ?? toolOutcome(part.output);
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

function withFileReceipt(row: ToolRow, output: unknown): ToolRow {
  const receipt = fileToolReceipt(row.toolName, output);
  const { receipt: previousReceipt, ...withoutReceipt } = row;
  return row.status === "ok" && receipt ? { ...withoutReceipt, receipt } : withoutReceipt;
}

/**
 * Walk parts in order so tool rows sit where the call happened, and merge
 * adjacent text parts of one message into a single row.
 */
export function rowsFromHistory(messages: readonly UIMessage[]): ConversationRow[] {
  const rows: ConversationRow[] = [];
  let backgroundConsolidation = false;
  for (const message of messages) {
    // The synthetic user marks a separate consolidation Run. Its assistant
    // output belongs in execution records, not in the user's conversation.
    // Use stored metadata, never guess from the wording of a message.
    if (message.role === "user") {
      const metadata = message.metadata as { source?: string } | undefined;
      backgroundConsolidation = metadata?.source === "auto-consolidation";
    }
    if (backgroundConsolidation) continue;
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
          ...(["output-available", "output-error", "output-denied"].includes(part.state) ? { outcomeSource: "full" as const } : {}),
          ...(outcome.detail ? { detail: outcome.detail } : {}),
        };
        rows.push(part.state === "output-available" ? withFileReceipt(withShellFields(row, part.output), part.output) : row);
      }
    }
    flushText();
  }
  return rows;
}

export function rowsFromToolActivity(activity: readonly ToolActivity[]): ConversationRow[] {
  return activity.map((item) => {
    let parsed: unknown;
    let complete = false;
    if (!item.truncated && item.summary.trim()) {
      try { parsed = JSON.parse(item.summary); complete = true; } catch { /* display-only bounded preview */ }
    }
    const returned = complete
      ? presentComputerResult(item.toolName, parsed) ?? presentShellExec(parsed) ?? toolOutcome(parsed)
      : { status: "incomplete" as const, detail: "回执不完整，不能据此判断工具返回结果" };
    const unknown = item.outcomeUnknown === true;
    return {
    kind: "tool" as const,
    key: `t:${item.toolCallId}`,
    toolCallId: item.toolCallId,
    toolName: item.toolName,
    status: unknown ? "unknown" : item.status === "failed" ? "failed" : returned.status,
    ...(unknown ? { detail: "效果未知 · 需人工核对，不自动重试" }
      : item.truncated ? { detail: "回执已截断，不能据此推断成功" } : returned.detail ? { detail: returned.detail } : {}),
  };
  });
}

export function canReuseReceiptHistory(record: Pick<ExecutionRunRecord, "status" | "runId">, historyRunId: string | null): boolean {
  return record.status === "completed" && record.runId === historyRunId;
}

function lastUserTurnStart(rows: readonly ConversationRow[]): number {
  let start = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.kind === "text" && row.role === "user") start = index + 1;
  }
  return start;
}

/** Final receipt is authoritative, including cancelled Runs without a failed-tool event. */
export function overlayExecutionReceipts(
  rows: readonly ConversationRow[],
  tools: readonly ExecutionToolRecord[],
  { reuseHistory = true }: { reuseHistory?: boolean } = {},
): ConversationRow[] {
  const result = [...rows];
  const turnStart = lastUserTurnStart(rows);
  for (const tool of tools) {
    // Tool call IDs may repeat between Runs. The caller must also verify that
    // the loaded history belongs to this Run before allowing tail reuse.
    const index = reuseHistory ? result.findIndex((row, position) => position >= turnStart
      && row.kind === "tool" && row.toolName === tool.toolName && row.toolCallId === tool.toolCallId) : -1;
    const existing = index < 0 ? undefined : result[index] as ToolRow;
    let parsed: unknown;
    let complete = false;
    if (!tool.resultTruncated && tool.resultPreview?.trim()) {
      try { parsed = JSON.parse(tool.resultPreview); complete = true; } catch { /* incomplete preview */ }
    }
    const shellFacts = tool.shell && (typeof tool.shell.exitCode === "number" || tool.shell.timedOut || tool.shell.cancelled)
      ? presentShellExec(tool.shell) : undefined;
    // "completed" is call lifecycle, not the returned ok:true predicate.
    // Prefer the full output already in the transcript over a bounded preview.
    const returned = existing?.outcomeSource === "full" ? existing
      : complete ? presentComputerResult(tool.toolName, parsed) ?? presentShellExec(parsed)
        ?? shellFacts ?? toolOutcome(parsed)
      : shellFacts
        ?? { status: "incomplete" as const, detail: "回执不完整，不能据此判断工具返回结果" };
    const status: ToolRowStatus = tool.status === "unknown" ? "unknown" : tool.status === "not_started" ? "not_started"
      : tool.status === "failed" ? (tool.errorPreview?.includes("User denied") || tool.errorPreview?.startsWith("TOOL_DENIED") ? "denied" : "failed")
      : tool.status === "requested" || tool.status === "started" ? "requested"
      : returned.status;
    const detail = tool.status === "unknown" ? "已进入执行，但效果未知；请核对应用，不自动重试"
      : tool.status === "not_started" ? "调用未开始，未派发动作"
      : tool.status === "failed" ? tool.errorPreview ?? "调用失败"
      : returned.detail ?? (tool.resultTruncated ? "回执已截断，不能据此推断成功" : undefined);
    const next: ToolRow = { kind: "tool", key: `receipt:${tool.toolName}:${tool.toolCallId}:${result.length}`, toolCallId: tool.toolCallId,
      toolName: tool.toolName, status, ...(tool.shell ?? {}), ...(detail ? { detail } : {}) };
    if (index < 0) result.push(next);
    else {
      // A later authoritative failure/unknown must not keep an earlier success
      // receipt. A truncated *preview* need not erase a known full output.
      const { receipt, outcomeSource, ...withoutReceipt } = existing!;
      result[index] = { ...withoutReceipt, status, ...(detail ? { detail } : {}),
        ...(tool.status === "completed" && outcomeSource === "full" ? { outcomeSource } : {}),
        ...(status === "ok" && receipt ? { receipt } : {}) };
    }
  }
  return result;
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
    return { status: code === "TOOL_DENIED" ? "denied" : code === "TOOL_OUTCOME_UNKNOWN" ? "unknown" : "failed", detail: message ? `${code}: ${message}` : code };
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
      const outcome = presentComputerResult(event.data.toolName, event.data.output) ?? presentShellExec(event.data.output) ?? toolOutcome(event.data.output);
      return {
        rows: live.rows.map((row) => {
          if (row.kind !== "tool" || row.toolCallId !== event.data.toolCallId) return row;
          const next: ToolRow = {
            ...row,
            status: outcome.status,
            outcomeSource: "full",
            ...(outcome.detail ? { detail: outcome.detail } : {}),
          };
          return withFileReceipt(withShellFields(next, event.data.output), event.data.output);
        }),
        streaming: live.streaming,
      };
    }
    case "tool.call.failed": {
      const unknown = event.data.error.code === "TOOL_OUTCOME_UNKNOWN";
      return {
        rows: live.rows.map((row) => {
          if (row.kind !== "tool" || row.toolCallId !== event.data.toolCallId) return row;
          const { receipt, ...withoutReceipt } = row;
          return { ...withoutReceipt, outcomeSource: "full", status: unknown ? "unknown" : event.data.error.code === "TOOL_DENIED" ? "denied" : "failed", detail: event.data.error.message };
        }),
        streaming: live.streaming,
      };
    }
    default:
      return live;
  }
}

export function overlayShellProgress(rows: ConversationRow[], buffer: ShellProgressBuffer): ConversationRow[] {
  const turnStart = lastUserTurnStart(rows);
  return rows.map((row, index) => {
    // A process-local buffer belongs to the current Run, not old tool IDs in
    // previous turns. No-user live/activity rows are all within that Run.
    if (index < turnStart || row.kind !== "tool" || row.toolName !== "shell_exec") return row;
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
  return { kind: "result", key: `r:${result.runId}`, status: result.status, ...(result.completion ? { completion: result.completion } : {}), ...(detail ? { detail } : {}) };
}

export function finishRun(live: LiveRun, result: RunResult): ConversationRow[] {
  return [...flushStreaming(live, `r:${result.runId}:text`), resultRow(result)];
}
