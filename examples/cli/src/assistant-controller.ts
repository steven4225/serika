import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import type { AgentEvent, RunHandle, RunResult } from "@aisdk-agent/core";
import { AUTO_CONSOLIDATION_SOURCE } from "./consolidation.js";
import type { RuntimeApp } from "./app.js";
import type { ContextDiagnostics, ContextResult } from "./context-diagnostics.js";
import type { ExecutionRunRecord } from "./execution-record-store.js";
import { verifyAutomaticCriterion } from "./work-task-verification.js";
import {
  type AcceptanceStatus,
  type CreateWorkTaskInput,
  type WorkTask,
  type WorkTaskDelivery,
  type WorkTaskEvidence,
  type WorkTaskFailure,
  type WorkTaskObservedOutcome,
  type WorkTaskResult,
} from "./work-task-store.js";
import { recoverRunningWorkTasks } from "./work-task-recovery.js";
import { workTaskContinuation, type WorkTaskContinuation } from "./work-task-continuation.js";
import type { ShellProgress } from "./modules/shell-module.js";
import type { PendingToolApproval } from "./tui.js";
import type {
  CandidateListInput, CandidatePage, CandidatePreview, CandidateResolution,
  CandidateResolveInput, MemoryResult,
} from "./memory-candidates.js";
import { createRssSubscriptionStore, rssFailure, type RssAction, type RssInbox, type RssResult, type RssView } from "./rss-subscriptions.js";
import { createTaskStore } from "./task-store.js";
import { formalMemory, memoryPage, validMemoryEdit, visibleMemory, type FormalMemory, type MemoryPage, type MemoryListInput, type MemoryEditInput } from "./memory-management.js";
import type { MemoryReferenceSnapshot } from "./memory-query-rewrite.js";
import { memoryActionPreview, memoryCapacity, memoryControlFailure, memoryHistoryPage, temporalMemoryStore, validateMemoryAction, validateMemoryHistoryInput, type MemoryAction, type MemoryActionPreview, type MemoryHistoryInput, type MemoryHistoryPage, type MemoryMaintenance, type MemoryTemporalInput } from "./memory-controls.js";
import type { MemoryTemporalView } from "./memory-store.js";
import { consolidationSourcePage, memoryConsolidationBacklog, validateConsolidationRequest, type MemoryConsolidationRequest, type MemoryConsolidationSourcePage } from "./memory-consolidation.js";
import { readWorkTaskArtifact, workTaskDeliveryDraft, type WorkTaskReadInput, type WorkTaskArtifactInput, type WorkTaskReadResult, type WorkTaskDeliveryDraft, type WorkTaskArtifactPreview } from "./work-task-artifacts.js";

const MAX_RECENT_OUTPUT_CHARS = 16 * 1024;
const MAX_TOOL_ACTIVITY = 30;
const MAX_TOOL_SUMMARY_CHARS = 1_000;

export interface ToolActivity {
  toolCallId: string;
  toolName: string;
  status: "completed" | "failed";
  /** Invocation failed, but the external effect is not known to have failed. */
  outcomeUnknown?: boolean;
  summary: string;
  truncated: boolean;
}

export type AssistantState =
  | { kind: "idle" }
  | { kind: "running"; runId: string | null; phase: "primary" | "consolidation" }
  | { kind: "compacting" }
  | { kind: "resuming" }
  | { kind: "command"; name: string };

export interface AssistantSnapshot {
  state: AssistantState;
  pendingApproval: PendingToolApproval | null;
  recentOutput: string;
  outputTruncated: boolean;
  toolActivity: readonly ToolActivity[];
  lastPrimaryResult: RunResult | null;
  lastConsolidationResult: RunResult | null;
  resultTextTruncated: boolean;
}

export type AssistantEvent =
  | { type: "state"; state: AssistantState }
  | { type: "approval"; approval: PendingToolApproval }
  | { type: "approval-cleared"; approvalId: string }
  | { type: "run-event"; phase: "primary" | "consolidation"; event: AgentEvent }
  | { type: "run-result"; phase: "primary" | "consolidation"; result: RunResult }
  | { type: "shell-progress"; phase: "primary" | "consolidation"; runId: string; progress: ShellProgress }
  | { type: "work-task-updated"; task: WorkTask }
  | { type: "memory-updated"; reason: "proposals" | "review" | "write" }
  | { type: "memory-references-changed" }
  | { type: "output"; text: string }
  | { type: "error"; message: string };

export type StartRunResponse =
  | { ok: true; runId: string }
  | { ok: false; reason: "busy" | "empty" | "starting" };

export interface AssistantRunOptions {
  /** Exclude this ordinary user message from present and future memory consolidation. */
  memoryConsolidation?: "exclude";
}

export type ControllerCommandResponse =
  | { ok: true }
  | { ok: false; reason: "busy" | "unknown" | "empty" | "cancelled" }
  | { ok: false; reason: "failed"; message: string };

export interface AssistantController {
  getSnapshot(): AssistantSnapshot;
  getHistory(): Promise<UIMessage[]>;
  getContextDiagnostics(): Promise<ContextResult<ContextDiagnostics>>;
  listMemories(input?: MemoryListInput): Promise<MemoryResult<MemoryPage>>;
  getMemory(id: string): Promise<MemoryResult<FormalMemory>>;
  updateMemory(input: MemoryEditInput): Promise<MemoryResult<FormalMemory>>;
  getMemoryHistory(input: MemoryHistoryInput): Promise<MemoryResult<MemoryHistoryPage>>;
  queryMemory(input: MemoryTemporalInput): Promise<MemoryResult<MemoryTemporalView>>;
  previewMemoryAction(input: MemoryAction): Promise<MemoryResult<MemoryActionPreview>>;
  applyMemoryAction(input: MemoryAction): Promise<MemoryResult<FormalMemory | null>>;
  getMemoryMaintenance(): Promise<MemoryResult<MemoryMaintenance>>;
  listMemoryConsolidationSources(offset?: number): Promise<MemoryResult<MemoryConsolidationSourcePage>>;
  consolidateMemory(input: MemoryConsolidationRequest): Promise<MemoryResult<{ runId: string }>>;
  getMemoryReferences(): (MemoryReferenceSnapshot & { runId: string }) | null;
  /** Newest-first local receipts for this Thread. They never authorize replay. */
  listRuns(limit?: number): Promise<ExecutionRunRecord[]>;
  getRun(runId: string): Promise<ExecutionRunRecord | null>;
  listMemoryCandidates(input?: CandidateListInput): Promise<MemoryResult<CandidatePage>>;
  getMemoryCandidate(id: string): Promise<MemoryResult<CandidatePreview>>;
  resolveMemoryCandidate(input: CandidateResolveInput): Promise<MemoryResult<CandidateResolution>>;
  getRssSubscriptions(): Promise<RssResult<RssView>>;
  updateRssSubscriptions(input: RssAction): Promise<RssResult<RssView>>;
  getRssInbox(): Promise<RssResult<RssInbox>>;
  acknowledgeRssResult(id: string): Promise<RssResult<void>>;
  createWorkTask(input: Omit<CreateWorkTaskInput, "threadId">): Promise<WorkTaskResult<WorkTask>>;
  listWorkTasks(): Promise<WorkTaskResult<WorkTask[]>>;
  getWorkTask(id: string): Promise<WorkTaskResult<WorkTask>>;
  getWorkTaskDeliveryDraft(input: WorkTaskReadInput): Promise<WorkTaskReadResult<WorkTaskDeliveryDraft>>;
  getWorkTaskContinuation(input: WorkTaskReadInput): Promise<WorkTaskResult<WorkTaskContinuation>>;
  getWorkTaskArtifact(input: WorkTaskArtifactInput): Promise<WorkTaskReadResult<WorkTaskArtifactPreview>>;
  runWorkTask(input: { id: string; expectedRevision: number; instruction?: string; completionCheck?: boolean }): Promise<StartRunResponse>;
  submitWorkTaskDelivery(input: {
    id: string;
    expectedRevision: number;
    summary: string;
    artifactRefs?: string[];
    unresolved?: string[];
  }): Promise<WorkTaskResult<WorkTask>>;
  recordHumanAcceptance(input: {
    id: string;
    expectedRevision: number;
    criterionId: string;
    decision: "passed" | "failed";
    note?: string;
  }): Promise<WorkTaskResult<WorkTask>>;
  reconcileWorkTask(input: {
    id: string;
    expectedRevision: number;
    observedOutcome: WorkTaskObservedOutcome;
    decision: "continue" | "cancel";
    note: string;
  }): Promise<WorkTaskResult<WorkTask>>;
  cancelWorkTask(input: { id: string; expectedRevision: number }): Promise<WorkTaskResult<WorkTask>>;
  requestWorkTaskChanges(input: { id: string; expectedRevision: number }): Promise<WorkTaskResult<WorkTask>>;
  run(text: string, options?: AssistantRunOptions): Promise<StartRunResponse>;
  cancel(): Promise<void>;
  confirm(input: { approvalId: string; decision: "allow" | "deny" }): boolean;
  /**
   * Resolves after the command settles. A command that threw or was cancelled
   * returns `ok: false` here as well as emitting an `error` event; callers
   * that only await the Promise must not treat those as success.
   */
  command(line: string): Promise<ControllerCommandResponse>;
  /**
   * Forward text emitted by the app's output stream to the bounded activity
   * snapshot. Embedders must tee the `Writable` they pass to
   * `createRuntimeApp` as `output` into this method; command output, module
   * notifications, and Home text only reach reload snapshots through it.
   */
  recordOutput(text: string): void;
  subscribe(listener: (event: AssistantEvent) => void): () => void;
  shutdown(): Promise<void>;
}

function unavailableWorkTask(): WorkTaskResult<never> {
  return { ok: false, error: { code: "WORK_TASK_INVALID_STATE", message: "WorkTask requires a configured workspace" } };
}

function missingWorkTask(): WorkTaskResult<never> {
  return { ok: false, error: { code: "WORK_TASK_NOT_FOUND", message: "Work task not found" } };
}

function commandParts(line: string): { name: string; args: string } {
  const trimmed = line.trim().replace(/^\//, "");
  const space = trimmed.search(/\s/);
  return space < 0
    ? { name: trimmed, args: "" }
    : { name: trimmed.slice(0, space), args: trimmed.slice(space + 1) };
}


export function createAssistantController(app: RuntimeApp): AssistantController {
  app.enableExecutionRecords();
  let workTaskLease: Awaited<ReturnType<NonNullable<RuntimeApp["workTasks"]>["claimThread"]>> | undefined;
  let threadLease: Awaited<ReturnType<RuntimeApp["executionRecords"]["claimThread"]>> | undefined;
  let recoveryError: unknown;
  const recovery = (async () => {
    try {
      workTaskLease = await app.workTasks?.claimThread(app.threadId);
      threadLease = await app.executionRecords.claimThread(app.threadId);
      await app.executionRecords.recoverInterrupted(app.threadId);
      if (app.workTasks !== undefined) {
        await recoverRunningWorkTasks({
          threadId: app.threadId,
          workTasks: app.workTasks,
          executionRecords: app.executionRecords,
        });
      }
    } catch (error) {
      await threadLease?.release().catch(() => undefined);
      threadLease = undefined;
      await workTaskLease?.release().catch(() => undefined);
      workTaskLease = undefined;
      throw error;
    }
  })().catch((error: unknown) => {
    recoveryError = error;
  });
  const ensureRecovered = async (): Promise<void> => {
    await recovery;
    if (recoveryError !== undefined) throw recoveryError;
  };
  let state: AssistantState = { kind: "idle" };
  let activeHandle: RunHandle | undefined;
  let startupController: AbortController | undefined;
  let operationController: AbortController | undefined;
  let activeTask: Promise<void> | undefined;
  let nextWorkTask: WorkTask | undefined;
  let activeWorkTask: WorkTask | undefined;
  let workTaskCompletionCheck = true;
  let closed = false;
  let disposed = false;
  let cancelRequested = false;
  let recentOutput = "";
  let outputTruncated = false;
  let lastPrimaryResult: RunResult | null = null;
  let primaryMessageId: string | undefined;
  let primaryRunId: string | undefined;
  let lastConsolidationResult: RunResult | null = null;
  // A completed model Run is not proof that its proposal/cursor write succeeded.
  let consolidationFailure: string | undefined;
  let consolidationRunning = false;
  let consolidationRequest: MemoryConsolidationRequest | undefined;
  let lastConsolidationAttempt: MemoryMaintenance["consolidation"]["lastAttempt"];
  let lastConsolidationSkippedReason: string | undefined;
  let resultTextTruncated = false;
  const toolActivity: ToolActivity[] = [];
  const toolNames = new Map<string, string>();
  let pendingApproval = app.toolConfirmation?.getPending() ?? null;
  const listeners = new Set<(event: AssistantEvent) => void>();

  const emit = (event: AssistantEvent): void => {
    for (const listener of listeners) {
      try { listener(event); } catch { /* A disconnected view cannot fail a Run. */ }
    }
  };
  const workTaskRecoveryFailure = async (): Promise<WorkTaskFailure | undefined> => {
    try {
      await ensureRecovered();
      return undefined;
    } catch (error) {
      const message = `WorkTask recovery unavailable: ${String(error)}`;
      emit({ type: "error", message });
      return { ok: false, error: { code: "WORK_TASK_INVALID_STATE", message } };
    }
  };
  const setState = (next: AssistantState): void => {
    state = next;
    emit({ type: "state", state: next });
  };
  const unsubscribeApproval = app.toolConfirmation?.subscribePending((next) => {
    const previous = pendingApproval;
    pendingApproval = next ?? null;
    if (previous !== null && (next === undefined || next.approvalId !== previous.approvalId)) {
      emit({ type: "approval-cleared", approvalId: previous.approvalId });
    }
    if (next !== undefined) emit({ type: "approval", approval: next });
  });
  const unsubscribeShellProgress = app.subscribeShellProgress?.((progress) => {
    if (state.kind !== "running" || state.runId === null) return;
    emit({ type: "shell-progress", phase: state.phase, runId: state.runId, progress });
  });
  const unsubscribeMemoryReferences = app.subscribeMemoryReferences?.(() => emit({ type: "memory-references-changed" }));

  const executeRun = async (
    agentId: string,
    message: UIMessage,
    phase: "primary" | "consolidation",
    signal?: AbortSignal,
    started?: (handle: RunHandle) => void,
  ): Promise<{ result: RunResult; requestedMemoryTool: boolean }> => {
    app.toolConfirmation?.beginRun();
    if (phase === "primary") { primaryMessageId = message.id; primaryRunId = undefined; }
    if (phase === "consolidation") { consolidationFailure = undefined; consolidationRunning = true; }
    try {
      app.memoryConsolidation?.begin(agentId, phase === "consolidation" ? consolidationRequest : undefined);
      const handle = await app.runtime.run({
        agentId,
        threadId: app.threadId,
        messages: [message],
        context: { agentId, ...(phase === "primary" && activeWorkTask !== undefined ? { workTaskId: activeWorkTask.id, completionCheck: workTaskCompletionCheck } : {}) },
        ...(signal === undefined ? {} : { signal }),
      });
      activeHandle = handle;
      if (phase === "primary") primaryRunId = handle.runId;
      if (phase === "primary" && activeWorkTask !== undefined && app.workTasks !== undefined) {
        const running = await app.workTasks.get(activeWorkTask.id);
        if (running.ok && running.value.status === "running" && running.value.runIds.includes(handle.runId)) {
          activeWorkTask = running.value;
          emit({ type: "work-task-updated", task: running.value });
        } else {
          emit({ type: "error", message: running.ok
            ? "WorkTask Run ownership could not be reread after start"
            : `${running.error.code}: ${running.error.message}` });
        }
      }
      setState({ kind: "running", runId: handle.runId, phase });
      started?.(handle);
      if (cancelRequested) await handle.cancel("Cancelled before Run started");
      let requestedMemoryTool = false;
      let completionCorrections = 0;
      const consolidationAttempts = { prepare: 0, stage: 0 };
      const pump = (async () => {
        for await (const event of handle.events) {
          if (event.type === "run.completion.checked") {
            completionCorrections = event.data.corrections;
            if (event.data.decision === "continue") controller.recordOutput(`\n正在补齐任务证据（${completionCorrections}/2），仍需逐次确认工具。\n`);
          }
          if (event.type === "tool.call.requested") {
            toolNames.set(event.data.toolCallId, event.data.toolName);
            if (event.data.toolName.startsWith("memory_")) requestedMemoryTool = true;
            if (event.data.toolName === "memory_prepare_consolidation") consolidationAttempts.prepare += 1;
            if (event.data.toolName === "memory_stage_candidates") consolidationAttempts.stage += 1;
            if (event.data.toolName === "memory_prepare_consolidation" || event.data.toolName === "memory_stage_candidates") {
              if (!consolidationRunning) consolidationFailure = undefined;
              consolidationRunning = true;
            }
          }
          if (event.type === "tool.call.completed" || event.type === "tool.call.failed") {
            const raw = event.type === "tool.call.completed"
              ? JSON.stringify(event.data.output) ?? ""
              : event.data.error.message;
            const item: ToolActivity = {
              toolCallId: event.data.toolCallId,
              toolName: event.data.toolName ?? toolNames.get(event.data.toolCallId) ?? "unknown",
              status: event.type === "tool.call.completed" ? "completed" : "failed",
              ...(event.type === "tool.call.failed" && event.data.error.code === "TOOL_OUTCOME_UNKNOWN"
                ? { outcomeUnknown: true } : {}),
              summary: raw.slice(0, MAX_TOOL_SUMMARY_CHARS),
              truncated: raw.length > MAX_TOOL_SUMMARY_CHARS,
            };
            toolActivity.push(item);
            if (toolActivity.length > MAX_TOOL_ACTIVITY) toolActivity.shift();
            if (event.type === "tool.call.completed" &&
                ["memory_add", "memory_update", "memory_revise", "memory_delete", "memory_apply_candidate"].includes(item.toolName) &&
                typeof event.data.output === "object" && event.data.output !== null &&
                "ok" in event.data.output && event.data.output.ok === true) {
              emit({ type: "memory-updated", reason: "write" });
            }
          }
          emit({ type: "run-event", phase, event });
        }
      })();
      let result = await handle.result;
      await pump;
      if (phase === "primary" && activeWorkTask !== undefined && workTaskCompletionCheck && result.completion === undefined) {
        const receipt = await app.executionRecords.getRun(app.threadId, handle.runId).catch(() => null);
        const uncertain = receipt === null || receipt.tools.some(tool => tool.status === "unknown" || tool.status === "started");
        const reason = uncertain || result.error?.code === "TOOL_OUTCOME_UNKNOWN" ? "needs_review" :
          result.status === "timed_out" || result.error?.code === "RUN_LIMIT_EXCEEDED" ? "budget_exhausted" : "needs_information";
        result = { ...result, completion: { reason, corrections: completionCorrections } };
      }
      if (phase === "primary" && result.completion !== undefined) {
        const labels = { delivered: "结束检查通过，交付仍会再次核验；人工质量不自动通过", needs_confirmation: "需要你的确认，不会自动重复被拒绝的操作",
          needs_information: "缺少信息或可用能力，请补充后再执行", budget_exhausted: "本轮预算耗尽，任务未完成", needs_review: "效果待核对，不会自动重放" };
        controller.recordOutput(`\n任务停止原因：${result.status === "cancelled" ? "已取消" : labels[result.completion.reason]}。\n`);
      }
      let lastProcessedCount = 0, lastCandidateCount = 0;
      try {
        const finalized = await app.memoryConsolidation?.finalize({ ...result, consolidationAttempts }, signal);
        if (finalized !== undefined && !finalized.ok) {
          consolidationFailure = `${finalized.error.code}: ${finalized.error.message}`;
          emit({ type: "error", message: `Memory candidates were not saved: ${finalized.error.code}: ${finalized.error.message}` });
        } else if (finalized?.ok) {
          lastProcessedCount = finalized.value.processedCount ?? 0;
          lastCandidateCount = finalized.value.candidateIds.length;
          if (phase === "consolidation" || consolidationAttempts.prepare > 0 || consolidationAttempts.stage > 0) {
            consolidationFailure = result.status === "completed" ? undefined : result.error?.message ?? `Consolidation Run ${result.status}`;
          }
          if (finalized.value.candidateIds.length > 0 && !finalized.value.replayed) {
            emit({ type: "memory-updated", reason: "proposals" });
            controller.recordOutput(`\nMemory candidates saved for review: ${finalized.value.candidateIds.join(", ")}\n`);
          }
        }
      } catch (error) {
        consolidationFailure = String(error);
        emit({ type: "error", message: `Memory candidates were not saved: ${String(error)}` });
      }
      if (phase === "consolidation") {
        lastConsolidationAttempt = {
          mode: consolidationRequest?.mode ?? "incremental", runId: handle.runId,
          status: result.status === "completed" && !consolidationFailure ? "completed" : "failed",
          processedCount: lastProcessedCount, candidateCount: lastCandidateCount,
        };
      }
      let executionFinalized = true;
      try {
        await app.executionRecords.finishRun(handle.runId, result);
      } catch (error) {
        executionFinalized = false;
        // The Run result is a fact even if its local audit receipt failed.
        emit({ type: "error", message: `Execution record could not be finalized: ${String(error)}` });
      }
      if (result.text.length > MAX_RECENT_OUTPUT_CHARS) resultTextTruncated = true;
      const retainedResult = result.text.length > MAX_RECENT_OUTPUT_CHARS
        ? { ...result, text: result.text.slice(-MAX_RECENT_OUTPUT_CHARS) }
        : result;
      if (phase === "primary") lastPrimaryResult = retainedResult;
      else lastConsolidationResult = retainedResult;
      if (phase === "primary" && activeWorkTask !== undefined && app.workTasks !== undefined) {
        const record = executionFinalized
          ? await app.executionRecords.getRun(app.threadId, handle.runId).catch(() => null)
          : null;
        const needsReview = !executionFinalized || record === null || record.tools.some((tool) => tool.status === "unknown");
        const current = await app.workTasks.get(activeWorkTask.id);
        const settled = !current.ok
          ? current
          : needsReview
            ? await app.workTasks.markNeedsReview(current.value.id, current.value.revision)
            : await app.workTasks.pause(current.value.id, current.value.revision);
        if (settled.ok) {
          activeWorkTask = settled.value;
          emit({ type: "work-task-updated", task: settled.value });
          if (!needsReview && result.status === "completed" && result.completion?.reason === "delivered") {
            const submitted = await controller.submitWorkTaskDelivery({
              id: settled.value.id, expectedRevision: settled.value.revision,
              summary: result.text.trim().slice(0, 2000) || "Program conditions verified; human quality remains pending.",
              artifactRefs: settled.value.acceptance.flatMap(criterion => criterion.verification.kind === "artifact_exists" ? [criterion.verification.path] : []),
            });
            if (submitted.ok) activeWorkTask = submitted.value;
            else emit({ type: "error", message: `WorkTask delivery could not be submitted: ${submitted.error.code}: ${submitted.error.message}` });
          }
        }
        else emit({ type: "error", message: `WorkTask could not settle: ${settled.error.code}: ${settled.error.message}` });
      }
      // A primary result is published after its task settlement/delivery attempt;
      // consumers must still use the WorkTask criteria for business acceptance.
      emit({ type: "run-result", phase, result });
      return { result, requestedMemoryTool };
    } catch (error) {
      if (phase === "consolidation") consolidationFailure = String(error);
      throw error;
    } finally {
      consolidationRunning = false;
      app.memoryConsolidation?.discard();
      if (phase === "primary" && activeWorkTask !== undefined) {
        app.workTaskContext.end();
        activeWorkTask = undefined;
      }
      activeHandle = undefined;
      app.toolConfirmation?.endRun();
    }
  };

  async function readTaskForDisplay(input: WorkTaskReadInput): Promise<WorkTaskResult<WorkTask>> {
    if (closed) return { ok: false, error: { code: "WORK_TASK_INVALID_STATE", message: "Controller is closed" } };
    if (!input || typeof input.id !== "string" || !input.id.trim() || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      return { ok: false, error: { code: "WORK_TASK_INVALID_INPUT", message: "Task id and current revision are required" } };
    }
    const recoveryFailure = await workTaskRecoveryFailure();
    if (recoveryFailure) return recoveryFailure;
    if (!app.workTasks) return unavailableWorkTask();
    const found = await app.workTasks.get(input.id);
    if (!found.ok) return found;
    if (found.value.threadId !== app.threadId) return missingWorkTask();
    if (found.value.revision !== input.expectedRevision) return { ok: false, error: { code: "WORK_TASK_REVISION_CONFLICT", message: "Task changed; reload before reading its artifact or draft" } };
    return found;
  }

  const controller: AssistantController = {
    getRssInbox: async () => {
      if (!app.workspaceRoot || !app.moduleConfig?.enabled.task) return { ok: false, error: { code: "RSS_UNAVAILABLE", message: "RSS requires workspace and task module" } };
      try {
        const view = await createRssSubscriptionStore(app.workspaceRoot).read();
        if (view.scheduleId === null) return { ok: true, value: { tasks: [], truncated: false } };
        const tasks = createTaskStore(app.workspaceRoot);
        const list = await tasks.list({ recurringTaskId: view.scheduleId, inbox: true, limit: 5 });
        if (!list.ok) return list;
        const entries: RssInbox["tasks"] = [];
        for (const s of list.value.tasks) {
          const task = await tasks.get(s.id);
          if (!task.ok) return task;
          const t = task.value;
          const text = t.resultText ?? `${t.error?.code ?? t.status}: ${t.error?.message ?? "无结果回执"}`;
          entries.push({ id: t.id, status: t.status, finishedAt: t.finishedAt, text: text.slice(0, 24000), textTruncated: text.length > 24000 });
        }
        return { ok: true, value: { tasks: entries, truncated: list.value.truncated } };
      } catch (e) { return rssFailure(e); }
    },
    acknowledgeRssResult: async id => {
      if (!app.workspaceRoot || !app.moduleConfig?.enabled.task) return { ok: false, error: { code: "RSS_UNAVAILABLE", message: "Acknowledgement requires enabled task module" } };
      if (closed || state.kind !== "idle") return { ok: false, error: { code: "BUSY", message: "Acknowledgement requires an idle controller" } };
      setState({ kind: "command", name: "rss-acknowledge" });
      let response!: RssResult<void>;
      activeTask = (async (): Promise<RssResult<void>> => { try {
        const view = await createRssSubscriptionStore(app.workspaceRoot!).read();
        const tasks = createTaskStore(app.workspaceRoot!);
        const task = await tasks.get(id);
        if (!task.ok) return task;
        if (!view.scheduleId || task.value.recurringTaskId !== view.scheduleId) return { ok: false, error: { code: "RSS_NOT_FOUND", message: "Result does not belong to this RSS schedule" } };
        const ack = await tasks.acknowledge(id);
        return ack.ok ? { ok: true, value: undefined } : ack;
      } catch (e) { return rssFailure(e); }
      finally { setState({ kind: "idle" }); }
      })().then(result => { response = result; });
      await activeTask;
      return response;
    },
    getRssSubscriptions: async () => {
      if (!app.workspaceRoot || !app.moduleConfig?.enabled.task) return { ok: false, error: { code: "RSS_UNAVAILABLE", message: "RSS subscriptions require workspace and task module" } };
      return createRssSubscriptionStore(app.workspaceRoot).get();
    },
    updateRssSubscriptions: async input => {
      if (!app.workspaceRoot || !app.moduleConfig?.enabled.task) return { ok: false, error: { code: "RSS_UNAVAILABLE", message: "RSS subscriptions require workspace and task module" } };
      if (closed || state.kind !== "idle") return { ok: false, error: { code: "BUSY", message: "RSS changes require an idle controller" } };
      setState({ kind: "command", name: "rss-subscriptions" });
      let response!: RssResult<RssView>;
      activeTask = (async () => {
        try { response = await createRssSubscriptionStore(app.workspaceRoot!).update(input); }
        catch (error) { response = rssFailure(error); }
        finally { setState({ kind: "idle" }); }
      })();
      await activeTask;
      return response;
    },
    getSnapshot: () => ({
      state,
      pendingApproval,
      recentOutput,
      outputTruncated,
      toolActivity: [...toolActivity],
      lastPrimaryResult,
      lastConsolidationResult,
      resultTextTruncated,
    }),
    getHistory: () => app.store.getMessages(app.threadId),
    getContextDiagnostics: async () => {
      const diagnostics = await app.getContextDiagnostics();
      const source = diagnostics.ok ? diagnostics.value.lastPreparationSource : null;
      if (source && source.messageId === primaryMessageId && primaryRunId) {
        source.runId = primaryRunId;
      }
      return diagnostics;
    },
    listRuns: async (limit) => {
      await ensureRecovered();
      return app.executionRecords.listRuns(app.threadId, limit);
    },
    getRun: async (runId) => {
      await ensureRecovered();
      return app.executionRecords.getRun(app.threadId, runId);
    },
    getMemoryReferences: () => {
      const reference = app.getMemoryReferences?.();
      return reference && reference.messageId === primaryMessageId && primaryRunId ? { ...reference, runId: primaryRunId } : null;
    },
    listMemories: async (input) => {
      if (!app.memoryStore || closed) return { ok: false, error: { code: "MEMORY_DISABLED", message: "Memory is unavailable" } };
      const result = await app.memoryStore.list();
      return result.ok ? memoryPage(result.entries, app.threadId, input) : result;
    },
    getMemory: async (id) => {
      if (!app.memoryStore || closed) return { ok: false, error: { code: "MEMORY_DISABLED", message: "Memory is unavailable" } };
      const result = await app.memoryStore.get(id);
      if (!result.ok) return result;
      if (!visibleMemory(result.entry, app.threadId)) return { ok: false, error: { code: "MEMORY_ENTRY_NOT_FOUND", message: "Memory not found" } };
      return { ok: true, value: formalMemory(result.entry) };
    },
    updateMemory: async (input) => {
      if (!app.memoryStore) return { ok: false, error: { code: "MEMORY_DISABLED", message: "Memory is unavailable" } };
      if (!validMemoryEdit(input)) return { ok: false, error: { code: "INVALID_INPUT", message: "Only explicit text, pin and disable edits with a current revision are allowed" } };
      if (closed || state.kind !== "idle") return { ok: false, error: { code: "BUSY", message: "Memory editing requires an idle controller" } };
      const operation = new AbortController();
      operationController = operation;
      setState({ kind: "command", name: "memory-edit" });
      let result!: MemoryResult<FormalMemory>;
      activeTask = (async () => {
        try {
          await ensureRecovered();
          const { id, ...edit } = input;
          const updated = await app.memoryStore!.update(id, edit, operation.signal, { boundThreadId: app.threadId });
          result = updated.ok ? { ok: true, value: formalMemory(updated.entry) } : updated;
          if (result.ok) emit({ type: "memory-updated", reason: "write" });
        } catch (error) {
          result = { ok: false, error: { code: "WRITE_FAILED", message: String(error) } };
        } finally { operationController = undefined; setState({ kind: "idle" }); }
      })();
      await activeTask;
      return result;
    },
    getMemoryHistory: async (input) => {
      if (!validateMemoryHistoryInput(input)) return memoryControlFailure("INVALID_INPUT", "History requires id, offset >=0 and limit 1..10");
      const store = app.memoryStore && !closed ? temporalMemoryStore(app.memoryStore) : undefined;
      if (!store) return memoryControlFailure("MEMORY_DISABLED", "Temporal Memory is unavailable");
      const record = await store.inspectMemory(input.id, undefined, { boundThreadId: app.threadId });
      return record.ok ? memoryHistoryPage(record.value, input) : record;
    },
    queryMemory: async (input) => {
      const store = app.memoryStore && !closed ? temporalMemoryStore(app.memoryStore) : undefined;
      if (!store) return memoryControlFailure("MEMORY_DISABLED", "Temporal Memory is unavailable");
      if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.id !== "string" || !input.id || input.id.length > 256 || Object.keys(input).some(key => !["id", "validAt", "knownAt", "includeDisabled"].includes(key))) return memoryControlFailure("INVALID_INPUT", "Invalid temporal Memory query");
      const { id, ...query } = input;
      const result = await store.queryMemory(id, query, undefined, { boundThreadId: app.threadId });
      return result.ok && Buffer.byteLength(JSON.stringify(result.value), "utf8") > 64 * 1024
        ? memoryControlFailure("MEMORY_CONTEXT_TOO_LARGE", "Temporal Memory view exceeds 64 KiB") : result;
    },
    previewMemoryAction: async (input) => {
      const validated = validateMemoryAction(input);
      if (!validated.ok) return validated;
      const store = app.memoryStore && !closed ? temporalMemoryStore(app.memoryStore) : undefined;
      if (!store) return memoryControlFailure("MEMORY_DISABLED", "Temporal Memory is unavailable");
      const preview = await store.previewMemoryMutation(validated.value, undefined, { boundThreadId: app.threadId });
      return preview.ok ? memoryActionPreview(validated.value, preview.value) : preview;
    },
    applyMemoryAction: async (input) => {
      const validated = validateMemoryAction(input);
      if (!validated.ok) return validated;
      const store = app.memoryStore ? temporalMemoryStore(app.memoryStore) : undefined;
      if (!store) return memoryControlFailure("MEMORY_DISABLED", "Temporal Memory is unavailable");
      if (closed || state.kind !== "idle") return memoryControlFailure("BUSY", "Memory editing requires an idle controller");
      const operation = new AbortController();
      operationController = operation;
      setState({ kind: "command", name: "memory-action" });
      let result!: MemoryResult<FormalMemory | null>;
      activeTask = (async () => {
        try {
          await ensureRecovered();
          const { operation: action, id, ...fields } = validated.value;
          const options = { boundThreadId: app.threadId };
          if (action === "delete") {
            const deleted = await store.deleteMemory({ id, expectedRevision: fields.expectedRevision }, operation.signal, options);
            result = deleted.ok ? { ok: true, value: null } : deleted;
          } else {
            const updated = action === "restore"
              ? await store.restoreMemory({ id, ...fields } as Extract<MemoryAction, { operation: "restore" }>, operation.signal, options)
              : action === "metadata"
                ? await store.update(id, fields, operation.signal, options)
                : await store.reviseMemory({ id, operation: action, ...fields }, operation.signal, options);
            result = updated.ok ? { ok: true, value: formalMemory(updated.entry) } : updated;
          }
          if (result.ok) emit({ type: "memory-updated", reason: "write" });
        } catch (error) {
          result = memoryControlFailure("WRITE_FAILED", String(error));
        } finally { operationController = undefined; setState({ kind: "idle" }); }
      })();
      await activeTask;
      return result;
    },
    getMemoryMaintenance: async () => {
      const store = app.memoryStore && !closed ? temporalMemoryStore(app.memoryStore) : undefined;
      if (!store) return memoryControlFailure("MEMORY_DISABLED", "Temporal Memory is unavailable");
      const counts = await store.inspectMemoryMaintenance(undefined, { boundThreadId: app.threadId });
      if (!counts.ok) return counts;
      const enabled = app.autoConsolidationAgentId !== undefined;
      let backlogCount: number | undefined, backlogError: string | undefined;
      if (enabled) {
        const cursor = await store.getConsolidationCursor(app.threadId);
        if (!cursor.ok) backlogError = `${cursor.error.code}: ${cursor.error.message}`;
        else {
          try {
            const backlog = memoryConsolidationBacklog(await app.store.getMessages(app.threadId), cursor.value);
            if (backlog.ok) backlogCount = backlog.value;
            else backlogError = `${backlog.error.code}: ${backlog.error.message}`;
          } catch (error) { backlogError = `READ_FAILED: ${String(error)}`; }
        }
      }
      const running = consolidationRunning;
      const error = consolidationFailure ?? backlogError;
      const consolidation: MemoryMaintenance["consolidation"] = {
        enabled,
        state: running ? "running" : error ? "failed" : counts.value.pending > 0 ? "awaiting_review" : !enabled ? "off" : (backlogCount ?? 0) > 0 ? "backlog" : "idle",
        ...(error === undefined ? {} : { error }), ...(backlogCount === undefined ? {} : { backlogCount }),
        ...(lastConsolidationAttempt === undefined ? {} : { lastAttempt: structuredClone(lastConsolidationAttempt) }),
        ...(lastConsolidationSkippedReason === undefined ? {} : { lastSkippedReason: lastConsolidationSkippedReason }),
      };
      return { ok: true, value: { ...counts.value, capacity: { ...memoryCapacity }, consolidation } };
    },
    listMemoryConsolidationSources: async (offset) => {
      if (!app.memoryStore || closed) return memoryControlFailure("MEMORY_DISABLED", "Memory is unavailable");
      try { return consolidationSourcePage(await app.store.getMessages(app.threadId), offset); }
      catch (error) { return memoryControlFailure("READ_FAILED", String(error)); }
    },
    consolidateMemory: async (input) => {
      const validated = validateConsolidationRequest(input);
      if (!validated.ok) return validated;
      if (closed || state.kind !== "idle") return memoryControlFailure("BUSY", "Wait for the current operation to finish");
      if (!app.autoConsolidationAgentId || !app.memoryConsolidation) return memoryControlFailure("MEMORY_DISABLED", "Enable memory and consolidation in the configuration first");
      const agentId = app.autoConsolidationAgentId;
      const startup = new AbortController();
      startupController = startup;
      consolidationRequest = validated.value;
      cancelRequested = false;
      lastConsolidationResult = null;
      lastConsolidationSkippedReason = undefined;
      setState({ kind: "running", phase: "consolidation", runId: null });
      let resolveStarted!: (value: MemoryResult<{ runId: string }>) => void;
      const started = new Promise<MemoryResult<{ runId: string }>>(resolve => { resolveStarted = resolve; });
      activeTask = (async () => {
        try {
          await ensureRecovered();
          const ready = await app.memoryConsolidation!.canStart(startup.signal);
          if (!ready.ok || !ready.value.canStart) {
            const failure = !ready.ok ? ready : memoryControlFailure("MEMORY_LIMIT_EXCEEDED", "Review pending candidates before consolidating");
            consolidationFailure = `${failure.error.code}: ${failure.error.message}`;
            resolveStarted(failure);
            return;
          }
          await executeRun(agentId, {
            id: randomUUID(), role: "user", metadata: { source: AUTO_CONSOLIDATION_SOURCE },
            parts: [{ type: "text", text: validated.value.mode === "history"
              ? "调用 memory_prepare_consolidation，参数仍为 {\"mode\":\"incremental\"}，不要提供 turns。程序已经绑定用户选定的历史消息，模型不能另选范围；返回 selection.mode=history。本次不移动自动游标。再调用 memory_stage_candidates 一次，没有建议也提交空数组。只提出有来源的候选，不写正式记忆。"
              : "请重试增量整理。先取材，再提交候选；没有建议也提交空数组，不写正式记忆。" }],
          }, "consolidation", startup.signal, handle => resolveStarted({ ok: true, value: { runId: handle.runId } }));
        } catch (error) {
          consolidationFailure = String(error);
          resolveStarted(memoryControlFailure("CONSOLIDATION_FAILED", String(error)));
          emit({ type: "error", message: `Memory consolidation failed: ${String(error)}` });
        } finally {
          consolidationRequest = undefined;
          startupController = undefined;
          setState({ kind: "idle" });
        }
      })();
      return started;
    },
    listMemoryCandidates: async (input) => {
      if (app.memoryStore === undefined || app.workspaceRoot === undefined) {
        return { ok: false, error: { code: "MEMORY_DISABLED", message: "Memory requires an enabled module and configured workspace" } };
      }
      if (closed) return { ok: false, error: { code: "MEMORY_CANDIDATE_CONFLICT", message: "Controller is closed" } };
      return app.memoryStore.listCandidates(input, undefined, { boundThreadId: app.threadId });
    },
    getMemoryCandidate: async (id) => {
      if (app.memoryStore === undefined || app.workspaceRoot === undefined) {
        return { ok: false, error: { code: "MEMORY_DISABLED", message: "Memory requires an enabled module and configured workspace" } };
      }
      if (closed) return { ok: false, error: { code: "MEMORY_CANDIDATE_CONFLICT", message: "Controller is closed" } };
      return app.memoryStore.getCandidate(id, undefined, { boundThreadId: app.threadId });
    },
    resolveMemoryCandidate: async (input) => {
      if (app.memoryStore === undefined || app.workspaceRoot === undefined) {
        return { ok: false, error: { code: "MEMORY_DISABLED", message: "Memory requires an enabled module and configured workspace" } };
      }
      if (closed || state.kind !== "idle") {
        return { ok: false, error: { code: "MEMORY_CANDIDATE_CONFLICT", message: "Memory review requires an idle controller" } };
      }
      const operation = new AbortController();
      operationController = operation;
      setState({ kind: "command", name: "memory-review" });
      let resolution!: MemoryResult<CandidateResolution>;
      activeTask = (async () => {
        try {
          await ensureRecovered();
          resolution = await app.memoryStore!.resolveCandidate(input, operation.signal, { boundThreadId: app.threadId });
          if (resolution.ok || resolution.error.code === "MEMORY_CANDIDATE_STALE") {
            emit({ type: "memory-updated", reason: "review" });
          }
        } catch (error) {
          const message = String(error);
          resolution = { ok: false, error: { code: "WRITE_FAILED", message } };
          emit({ type: "error", message });
        } finally {
          operationController = undefined;
          setState({ kind: "idle" });
        }
      })();
      await activeTask;
      return resolution;
    },
    createWorkTask: async (input) => {
      const recoveryFailure = await workTaskRecoveryFailure();
      if (recoveryFailure !== undefined) return recoveryFailure;
      if (app.workTasks === undefined) return unavailableWorkTask();
      const created = await app.workTasks.create({ ...input, threadId: app.threadId });
      if (created.ok) emit({ type: "work-task-updated", task: created.value });
      return created;
    },
    listWorkTasks: async () => {
      const recoveryFailure = await workTaskRecoveryFailure();
      if (recoveryFailure !== undefined) return recoveryFailure;
      return app.workTasks?.list({ threadId: app.threadId }) ?? unavailableWorkTask();
    },
    getWorkTask: async (id) => {
      const recoveryFailure = await workTaskRecoveryFailure();
      if (recoveryFailure !== undefined) return recoveryFailure;
      if (app.workTasks === undefined) return unavailableWorkTask();
      const task = await app.workTasks.get(id);
      if (task.ok && task.value.threadId !== app.threadId) {
        return { ok: false, error: { code: "WORK_TASK_NOT_FOUND", message: "Work task not found" } };
      }
      return task;
    },
    getWorkTaskContinuation: async (input) => {
      const task = await readTaskForDisplay(input);
      if (!task.ok) return task;
      try {
        const runId = task.value.runIds.at(-1);
        const run = runId ? await app.executionRecords.getRun(app.threadId, runId) : null;
        return { ok: true, value: workTaskContinuation(task.value, run) };
      } catch {
        return { ok: false, error: { code: "WORK_TASK_READ_FAILED", message: "Unable to read continuation receipts; no older Run was substituted" } };
      }
    },
    getWorkTaskDeliveryDraft: async (input) => {
      const task = await readTaskForDisplay(input);
      if (!task.ok) return task;
      const runId = task.value.runIds.at(-1);
      try {
        const run = runId ? await app.executionRecords.getRun(app.threadId, runId) : null;
        return { ok: true, value: workTaskDeliveryDraft(task.value, run) };
      } catch {
        return { ok: false, error: { code: "WORK_TASK_READ_FAILED", message: "Unable to read the latest execution receipt; no older draft was used" } };
      }
    },
    getWorkTaskArtifact: async (input) => {
      const task = await readTaskForDisplay(input);
      if (!task.ok) return task;
      if (typeof input.path !== "string" || !input.path.trim() || input.path.length > 1024) {
        return { ok: false, error: { code: "WORK_TASK_INVALID_INPUT", message: "A bounded artifact path is required" } };
      }
      if (!app.moduleConfig?.enabled["read-file"] || !app.workspaceRoot) {
        return { ok: false, error: { code: "WORK_TASK_INVALID_STATE", message: "Artifact preview requires enabled file module and workspace" } };
      }
      const runId = task.value.runIds.at(-1);
      try {
        const run = runId ? await app.executionRecords.getRun(app.threadId, runId) : null;
        return await readWorkTaskArtifact(app.workspaceRoot, task.value, run, input.path);
      } catch {
        return { ok: false, error: { code: "WORK_TASK_READ_FAILED", message: "Unable to read artifact preview or its execution receipt" } };
      }
    },
    runWorkTask: async (input) => {
      if (await workTaskRecoveryFailure() !== undefined) return { ok: false, reason: "starting" };
      if (app.workTasks === undefined || app.workspaceRoot === undefined) return { ok: false, reason: "starting" };
      if (closed || state.kind !== "idle" || nextWorkTask !== undefined || activeWorkTask !== undefined) {
        return { ok: false, reason: "busy" };
      }
      const found = await app.workTasks.get(input.id);
      if (!found.ok || found.value.threadId !== app.threadId || found.value.revision !== input.expectedRevision ||
          !["ready", "paused"].includes(found.value.status)) {
        return { ok: false, reason: "starting" };
      }
      if (closed || state.kind !== "idle" || nextWorkTask !== undefined || activeWorkTask !== undefined) {
        return { ok: false, reason: "busy" };
      }
      let clearBinding: (() => void) | undefined;
      try {
        const runId = found.value.runIds.at(-1);
        const run = runId ? await app.executionRecords.getRun(app.threadId, runId) : null;
        // Receipt reads are asynchronous. Recheck the idle mutex before reserving the next Run.
        if (closed || state.kind !== "idle" || nextWorkTask !== undefined || activeWorkTask !== undefined) return { ok: false, reason: "busy" };
        app.workTaskContext.begin(found.value, workTaskContinuation(found.value, run));
        workTaskCompletionCheck = input.completionCheck !== false;
        nextWorkTask = found.value;
        clearBinding = app.bindNextExecutionWorkTask({ id: found.value.id, expectedRevision: found.value.revision });
        // A task execution instruction is not evidence of a lasting user preference.
        // Persist the existing exclusion marker so later history consolidation also skips it.
        const started = await controller.run(input.instruction?.trim() || found.value.goal, {
          memoryConsolidation: "exclude",
        });
        clearBinding();
        clearBinding = undefined;
        if (!started.ok) {
          nextWorkTask = undefined;
          app.workTaskContext.end();
        }
        return started;
      } catch (error) {
        clearBinding?.();
        nextWorkTask = undefined;
        app.workTaskContext.end();
        emit({ type: "error", message: String(error) });
        return { ok: false, reason: "starting" };
      }
    },
    submitWorkTaskDelivery: async (input) => {
      const recoveryFailure = await workTaskRecoveryFailure();
      if (recoveryFailure !== undefined) return recoveryFailure;
      if (app.workTasks === undefined) return unavailableWorkTask();
      const found = await app.workTasks.get(input.id);
      if (!found.ok) return found;
      if (found.value.threadId !== app.threadId) return missingWorkTask();
      let current = await app.workTasks.submitDelivery(input.id, {
        expectedRevision: input.expectedRevision,
        delivery: {
          summary: input.summary,
          artifactRefs: input.artifactRefs ?? [],
          evidence: [],
          unresolved: input.unresolved ?? [],
        },
      });
      if (!current.ok) return current;
      const automaticCriteria = current.value.acceptance
        .filter((criterion) => criterion.method === "automatic")
        .sort((left, right) => Number(left.required) - Number(right.required));
      for (const criterion of automaticCriteria) {
        const verified = await verifyAutomaticCriterion(app, current.value, criterion);
        current = await app.workTasks.recordAcceptance(current.value.id, {
          expectedRevision: current.value.revision,
          criterionId: criterion.id,
          actor: "automatic",
          status: verified.status,
          evidence: verified.evidence,
          note: verified.note,
        });
        if (!current.ok) return current;
      }
      emit({ type: "work-task-updated", task: current.value });
      return current;
    },
    recordHumanAcceptance: async (input) => {
      const recoveryFailure = await workTaskRecoveryFailure();
      if (recoveryFailure !== undefined) return recoveryFailure;
      if (app.workTasks === undefined) return unavailableWorkTask();
      const found = await app.workTasks.get(input.id);
      if (!found.ok) return found;
      if (found.value.threadId !== app.threadId) return missingWorkTask();
      const evidence: WorkTaskEvidence[] = input.decision === "passed"
        ? [{ id: randomUUID(), kind: "human", criterionId: input.criterionId, acceptedAt: new Date().toISOString() }]
        : [];
      const updated = await app.workTasks.recordAcceptance(input.id, {
        expectedRevision: input.expectedRevision,
        criterionId: input.criterionId,
        actor: "human",
        status: input.decision,
        evidence,
        ...(input.note === undefined ? {} : { note: input.note }),
      });
      if (updated.ok) emit({ type: "work-task-updated", task: updated.value });
      return updated;
    },
    reconcileWorkTask: async (input) => {
      const recoveryFailure = await workTaskRecoveryFailure();
      if (recoveryFailure !== undefined) return recoveryFailure;
      if (app.workTasks === undefined) return unavailableWorkTask();
      const found = await app.workTasks.get(input.id);
      if (!found.ok) return found;
      if (found.value.threadId !== app.threadId) return missingWorkTask();
      const updated = await app.workTasks.reconcile(input.id, {
        expectedRevision: input.expectedRevision,
        observedOutcome: input.observedOutcome,
        decision: input.decision,
        note: input.note,
      });
      if (updated.ok) emit({ type: "work-task-updated", task: updated.value });
      return updated;
    },
    requestWorkTaskChanges: async (input) => {
      const recoveryFailure = await workTaskRecoveryFailure();
      if (recoveryFailure !== undefined) return recoveryFailure;
      if (app.workTasks === undefined) return unavailableWorkTask();
      if (closed || state.kind !== "idle") return { ok: false, error: { code: "WORK_TASK_INVALID_STATE", message: "Controller must be idle to request changes" } };
      const found = await app.workTasks.get(input.id);
      if (!found.ok) return found;
      if (found.value.threadId !== app.threadId) return missingWorkTask();
      const updated = await app.workTasks.requestChanges(input.id, input.expectedRevision);
      if (updated.ok) emit({ type: "work-task-updated", task: updated.value });
      return updated;
    },
    cancelWorkTask: async (input) => {
      const recoveryFailure = await workTaskRecoveryFailure();
      if (recoveryFailure !== undefined) return recoveryFailure;
      if (app.workTasks === undefined) return unavailableWorkTask();
      const found = await app.workTasks.get(input.id);
      if (!found.ok) return found;
      if (found.value.threadId !== app.threadId) return missingWorkTask();
      const cancelled = await app.workTasks.cancel(input.id, input.expectedRevision);
      if (cancelled.ok) emit({ type: "work-task-updated", task: cancelled.value });
      return cancelled;
    },
    run: async (text, options) => {
      if (text.trim().length === 0) return { ok: false, reason: "empty" };
      if (closed || state.kind !== "idle") return { ok: false, reason: "busy" };
      const excludeFromConsolidation = options?.memoryConsolidation === "exclude";
      lastConsolidationSkippedReason = undefined;

      cancelRequested = false;
      toolActivity.length = 0;
      toolNames.clear();
      lastPrimaryResult = null;
      lastConsolidationResult = null;
      resultTextTruncated = false;
      const startup = new AbortController();
      startupController = startup;
      setState({ kind: "running", runId: null, phase: "primary" });
      let resolveStarted!: (response: StartRunResponse) => void;
      const started = new Promise<StartRunResponse>((resolve) => { resolveStarted = resolve; });
      const userMessage: UIMessage = {
        id: randomUUID(), role: "user", parts: [{ type: "text", text: text.trim() }],
        ...(excludeFromConsolidation ? { metadata: { memoryConsolidation: "exclude" } } : {}),
      };
      activeWorkTask = nextWorkTask;
      nextWorkTask = undefined;
      activeTask = (async () => {
        let startSettled = false;
        const settleStart = (response: StartRunResponse): void => {
          if (!startSettled) { startSettled = true; resolveStarted(response); }
        };
        try {
          await ensureRecovered();
          app.resume?.beginRun();
          let primary: { result: RunResult; requestedMemoryTool: boolean };
          try {
            primary = await executeRun(app.agentId, userMessage, "primary", startup.signal, (handle) => {
              settleStart({ ok: true, runId: handle.runId });
            });
          } finally {
            app.resume?.endRun();
          }
          if (
            primary.result.status === "completed" && !primary.requestedMemoryTool &&
            !cancelRequested && !excludeFromConsolidation && app.autoConsolidationAgentId !== undefined
          ) {
            const readiness = await app.memoryConsolidation?.canStart(startup.signal);
            if (readiness !== undefined && !readiness.ok) {
              consolidationFailure = `${readiness.error.code}: ${readiness.error.message}`;
              emit({ type: "error", message: `Automatic consolidation unavailable: ${readiness.error.code}: ${readiness.error.message}` });
              return;
            }
            if (readiness?.ok && !readiness.value.canStart) {
              lastConsolidationSkippedReason = "待审候选已满，请先审核后重试整理";
              controller.recordOutput("\nMemory candidate queue is full; review pending candidates before consolidating.\n");
              return;
            }
            if (cancelRequested || startup.signal.aborted) return;
            controller.recordOutput("\n正在自动整理记忆...\n");
            const consolidationMessage: UIMessage = {
              id: randomUUID(), role: "user", metadata: { source: AUTO_CONSOLIDATION_SOURCE },
              parts: [{ type: "text", text: "请整理最近已提交的对话：先取材，再调用 memory_stage_candidates 提交结构化提案；没有建议也提交空数组。不要写入 active 记忆。" }],
            };
            try {
              const consolidation = await executeRun(
                app.autoConsolidationAgentId, consolidationMessage, "consolidation",
                startup.signal,
              );
              if (consolidation.result.status === "failed" || consolidation.result.status === "timed_out") {
                controller.recordOutput(`\nAutomatic consolidation failed: ${consolidation.result.error?.message ?? consolidation.result.status}\n`);
              }
            } catch (error) {
              controller.recordOutput(`\nAutomatic consolidation failed: ${String(error)}\n`);
            }
          } else if (app.autoConsolidationAgentId !== undefined) {
            lastConsolidationSkippedReason = excludeFromConsolidation
              ? activeWorkTask !== undefined ? "任务执行指令不参与记忆整理，避免将一次性要求误记为长期偏好" : "你选择了本条消息不参与记忆"
              : primary.requestedMemoryTool ? "本轮已请求记忆工具，自动整理跳过，避免重复处理"
              : "主任务未成功结束或已取消，未触发自动整理";
          }
        } catch (error) {
          settleStart({ ok: false, reason: "starting" });
          emit({ type: "error", message: String(error) });
        } finally {
          startupController = undefined;
          if (activeWorkTask !== undefined) {
            app.workTaskContext.end();
            activeWorkTask = undefined;
          }
          setState({ kind: "idle" });
        }
      })();
      return started;
    },
    cancel: async () => {
      cancelRequested = true;
      startupController?.abort(new DOMException("Run cancelled", "AbortError"));
      operationController?.abort(new DOMException("Operation cancelled", "AbortError"));
      if (activeHandle !== undefined) await activeHandle.cancel("Cancelled from application");
    },
    confirm: (input) => app.toolConfirmation?.resolveApproval(input) ?? false,
    command: async (line) => {
      const { name, args } = commandParts(line);
      if (name.length === 0) return { ok: false, reason: "empty" };
      if (closed || state.kind !== "idle") return { ok: false, reason: "busy" };
      const special = name === "compact" ? app.compaction : name === "resume" ? app.resume : undefined;
      const registered = app.commands?.get(name);
      if (special === undefined && registered === undefined) return { ok: false, reason: "unknown" };
      const operation = new AbortController();
      operationController = operation;
      setState(name === "compact" ? { kind: "compacting" } : name === "resume"
        ? { kind: "resuming" } : { kind: "command", name });
      let failure: Extract<ControllerCommandResponse, { ok: false }> | undefined;
      activeTask = (async () => {
        try {
          if (name === "compact" && app.compaction !== undefined) {
            if (args.trim() !== "") throw new Error("Usage: /compact");
            const result = await app.compaction.compact(operation.signal);
            if (operation.signal.aborted) failure = { ok: false, reason: "cancelled" };
            else controller.recordOutput(`\n[compact] ${result?.message ?? "Context compacted."}\n`);
          } else if (name === "resume" && app.resume !== undefined) {
            if (args.trim() !== "") throw new Error("Usage: /resume");
            app.resume.clear();
            const result = await app.resume.inspect(operation.signal);
            if (operation.signal.aborted) {
              app.resume.clear();
              failure = { ok: false, reason: "cancelled" };
            } else {
              controller.recordOutput(`\n[resume] ${result}\n`);
            }
          } else {
            await registered!.execute(args);
          }
        } catch (error) {
          if (name === "resume") app.resume?.clear();
          failure = operation.signal.aborted
            ? { ok: false, reason: "cancelled" }
            : { ok: false, reason: "failed", message: String(error) };
          emit({ type: "error", message: operation.signal.aborted ? `${name} cancelled` : String(error) });
        } finally {
          operationController = undefined;
          setState({ kind: "idle" });
        }
      })();
      await activeTask;
      return failure ?? { ok: true };
    },
    recordOutput: (text) => {
      if (text.length === 0) return;
      recentOutput += text;
      if (recentOutput.length > MAX_RECENT_OUTPUT_CHARS) {
        recentOutput = recentOutput.slice(-MAX_RECENT_OUTPUT_CHARS);
        outputTruncated = true;
      }
      emit({ type: "output", text });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    shutdown: async () => {
      if (disposed) return;
      closed = true;
      await controller.cancel();
      await activeTask;
      await recovery;
      const leaseReleases = await Promise.allSettled([
        threadLease?.release() ?? Promise.resolve(),
        workTaskLease?.release() ?? Promise.resolve(),
      ]);
      unsubscribeApproval?.();
      unsubscribeShellProgress?.();
      unsubscribeMemoryReferences?.();
      app.resume?.clear();
      app.memoryConsolidation?.discard();
      app.dispose();
      disposed = true;
      const releaseErrors = leaseReleases
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (releaseErrors.length > 0) throw new AggregateError(releaseErrors, "Unable to release controller leases");
    },
  };
  return controller;
}
