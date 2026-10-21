import type { UIMessage } from "ai";
import type { ContextSummaryAction } from "./context-compaction.js";
import type { ToolConfirmation } from "./tool-confirmation.js";
import type { WorkTask } from "./work-task-store.js";
import { estimateMessageTokens } from "./context-budget.js";
import { collectTranscriptToolFacts } from "./work-summary.js";
import { isAutoConsolidationRequest } from "./consolidation.js";
import type { ExecutionRunRecord } from "./execution-record-store.js";

export const SUMMARY_MAX_TOKENS = 12_000;
export const SUMMARY_RECENT_ACTIONS = 8;
export const SUMMARY_RECENT_RECEIPTS = 6;

/** Recompute from original receipts so repeated compactions cannot multiply rollups. */
export function compactSummaryActions(actions: readonly ContextSummaryAction[]): ContextSummaryAction[] {
  const retained = new Set<ContextSummaryAction>();
  const rollups: ContextSummaryAction[] = [];
  for (const status of ["completed", "not_executed"] as const) {
    const text = `Earlier ${status} actions; read original messages for details.`;
    const priorRollups = actions.filter(action => action.status === status && !action.toolCallIds.length && action.text === text);
    const matching = actions.filter(action => action.status === status && !priorRollups.includes(action));
    matching.slice(-SUMMARY_RECENT_ACTIONS).forEach(action => retained.add(action));
    const older = matching.slice(0, -SUMMARY_RECENT_ACTIONS);
    const archived = [...priorRollups, ...older];
    if (archived.length) rollups.push({ status, toolCallIds: [], text,
      evidenceMessageIds: [...new Set([archived[0]!.evidenceMessageIds[0]!, archived.at(-1)!.evidenceMessageIds.at(-1)!])],
    });
  }
  return [...rollups, ...actions.filter(action => action.status === "failed" || action.status === "unknown" || retained.has(action))];
}

/** Project only compaction inputs; persisted parts and their prefix hashes stay exact. */
export function maskCompactionSources(messages: readonly UIMessage[]): UIMessage[] {
  return messages.map(message => {
    const { contextReferences: _references, contextSnapshot: _snapshot, ...metadata } = (message.metadata ?? {}) as Record<string, unknown>;
    const facts = collectTranscriptToolFacts([message]);
    return { ...message, metadata, parts: message.parts.map(part => {
      if (part.type === "file") return { type: "text" as const,
        text: `[Attachment ${part.filename ?? "unnamed"} (${part.mediaType}) omitted; read original message ${message.id}.]` };
      if (part.type === "text" && part.text.startsWith("\n<attached-document name=")) {
        return { type: "text" as const, text: `[Text attachment omitted; read original message ${message.id}.]` };
      }
      if (part.type === "dynamic-tool") return { type: "text" as const,
        text: `[Tool ${part.toolName} ${part.toolCallId} state=${part.state} status=${facts.find(fact => fact.toolCallId === part.toolCallId)?.status ?? "unknown"}; input/output omitted; read original message ${message.id}.]` };
      return part;
    }) };
  });
}

export interface CompactionChecklistSources {
  workTask?: WorkTask | undefined;
  runs?: readonly ExecutionRunRecord[];
  permissions: ReturnType<ToolConfirmation["snapshot"]> | undefined;
}

/** Read host records directly; modeled summaries never supply checklist facts. */
export function createCompactionChecklist(input: CompactionChecklistSources & {
  messages: readonly UIMessage[];
  maxTokens?: number;
  requestReferenceOnly?: boolean;
}): UIMessage {
  const request = [...input.messages].reverse().find(message => message.role === "user" &&
    !isAutoConsolidationRequest(message) && (message.metadata as { source?: string } | undefined)?.source !== "steer");
  const start = request ? input.messages.findIndex(message => message.id === request.id) : input.messages.length;
  const corrections = input.messages.slice(start + 1).filter(message => message.role === "user" &&
    (message.metadata as { source?: string } | undefined)?.source === "steer");
  const literal = (message: UIMessage) => input.requestReferenceOnly ? message.id : ({ messageId: message.id,
    parts: maskCompactionSources([message])[0]!.parts });
  const facts = collectTranscriptToolFacts(input.messages);
  const receipts = new Map<string, unknown>(facts.map(fact => [fact.toolCallId, fact]));
  const unknown = new Map<string, unknown>(facts.filter(fact => fact.status === "unknown").map(fact => [fact.toolCallId, fact]));
  const failed = new Map<string, unknown>(facts.filter(fact => fact.status === "failed").map(fact => [fact.toolCallId, fact]));
  for (const run of [...(input.runs ?? [])].reverse().filter(run => run.phase === "primary")) {
    for (const tool of run.tools) {
      if (tool.status === "requested" || tool.status === "started") continue;
      const receipt = { runId: run.runId, toolCallId: tool.toolCallId, toolName: tool.toolName,
        status: tool.status, errorCode: tool.errorCode, fileInput: tool.fileInput, fileWrite: tool.fileWrite, shell: tool.shell,
        ...(tool.toolName === "shell_exec" ? { inputPreview: tool.inputPreview, inputTruncated: tool.inputTruncated } : {}) };
      receipts.delete(tool.toolCallId);
      receipts.set(tool.toolCallId, receipt);
      if (tool.status === "unknown") unknown.set(tool.toolCallId, receipt);
      if (tool.status === "failed" && tool.errorCode !== "TOOL_DENIED") failed.set(tool.toolCallId, receipt);
    }
  }
  const compactReceipt = (value: unknown) => {
    if (input.maxTokens === undefined) return value;
    const receipt = value as { toolCallId: string; toolName: string; status: string; path?: string; evidenceMessageIds?: string[]; fileInput?: {path: string}; errorCode?: string };
    return { id: receipt.toolCallId, tool: receipt.toolName, status: receipt.status, ...(receipt.path || receipt.fileInput ? { path: receipt.path ?? receipt.fileInput!.path } : {}),
      ...(receipt.evidenceMessageIds ? { messages: receipt.evidenceMessageIds } : {}), ...(receipt.errorCode ? { error: receipt.errorCode } : {}) };
  };
  const task = input.workTask;
  const recent = [...receipts.values()].filter(receipt => { const status = (receipt as {status: string}).status; return status !== "unknown" && status !== "failed"; }).slice(-SUMMARY_RECENT_RECEIPTS);
  const requestView = request;
  const permissions = input.permissions;
  const permissionView = !permissions || input.maxTokens === undefined ? permissions : {
    files: permissions.autonomousFiles, shell: permissions.shell,
    ...(permissions.web ? { web: permissions.web } : {}),
    ...(permissions.fileAuthorizations.length ? { fileAuthorizations: permissions.fileAuthorizations } : {}),
    ...(permissions.blocked.length ? { blocked: permissions.blocked } : {}),
    ...(permissions.remembered.length ? { remembered: permissions.remembered } : {}),
  };
  const compose = (): UIMessage => ({ id: "runloom-compaction-checklist", role: "assistant", ...(input.maxTokens === undefined ? { metadata: { source: "compaction-checklist" } } : {}),
    parts: [{ type: "text", text: "Host checklist:\n" + JSON.stringify({
      ...(task ? { goal: task.goal, constraints: task.constraints } : {}),
      request: requestView ? literal(requestView) : null,
      ...(corrections.length ? { corrections: corrections.map(literal) } : {}),
      ...(task ? { unfinished: { taskId: task.id, status: task.status,
        criteria: task.acceptance.filter(criterion => criterion.status !== "passed").map(criterion => ({ id: criterion.id, description: criterion.description, status: criterion.status })),
        unresolved: task.delivery?.unresolved ?? [],
      } } : {}),
      ...(unknown.size ? { unknown: [...unknown.values()].map(compactReceipt) } : {}),
      ...(failed.size ? { failed: [...failed.values()].map(compactReceipt) } : {}),
      ...(input.permissions ? { permissions: permissionView } : {}),
      ...(recent.length ? { recentReceipts: recent.map(compactReceipt) } : {}),
    }) }] });
  if (input.maxTokens !== undefined) {
    while (recent.length && estimateMessageTokens([compose()]) > input.maxTokens) recent.shift();
    const originalTokens = estimateMessageTokens([compose()]);
    if (originalTokens > input.maxTokens) {
      const overflow: UIMessage = { id: "runloom-compaction-checklist", role: "assistant", metadata: { overflowTokens: originalTokens },
        parts: [{ type: "text", text: "Checklist overflow; never retry unknown effects.\n" + JSON.stringify({
          unknown: unknown.size, failed: failed.size, messages: [1, input.messages.length],
          read: "history_read id=runloom-compaction-checklist", ...(task ? { task: task.id } : {}),
          ...(permissions ? { permissions: { files: permissions.autonomousFiles, shell: permissions.shell } } : {}),
        }) }] };
      if (estimateMessageTokens([overflow]) > input.maxTokens) throw new Error("Checklist reference metadata exceeds section budget; original records retained");
      return overflow;
    }
  }
  return compose();
}

export function compactedRecentMessages(messages: readonly UIMessage[], firstKept: number): UIMessage[] {
  const latest = [...messages].reverse().findIndex(message => message.role === "user" &&
    (message.metadata as { source?: string } | undefined)?.source !== "steer");
  const currentRequest = latest < 0 ? messages.length : messages.length - 1 - latest;
  return messages.slice(firstKept).map((message, index) => index + firstKept < currentRequest
    ? maskCompactionSources([message])[0]! : message);
}
