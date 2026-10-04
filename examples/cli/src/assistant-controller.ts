import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import type { UIMessage } from "ai";
import type { AgentEvent, RunHandle, RunResult } from "@aisdk-agent/core";
import { AUTO_CONSOLIDATION_SOURCE } from "./consolidation.js";
import type { RuntimeApp } from "./app.js";
import type { ContextDiagnostics, ContextResult } from "./context-diagnostics.js";
import { matchesFileWritePath, readFileWriteReceipt, type ExecutionRunRecord } from "./execution-record-store.js";
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
import { rejectSymlinkComponents, validateWorkspacePath } from "./workspace-path.js";
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
  runWorkTask(input: { id: string; expectedRevision: number; instruction?: string }): Promise<StartRunResponse>;
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

function previewObject(value: string | null): Record<string, unknown> | undefined {
  if (value === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch { return undefined; }
}

function taskOwnsRun(task: WorkTask, run: ExecutionRunRecord): boolean {
  return run.threadId === task.threadId && run.workTaskId === task.id &&
    run.phase === "primary" && task.runIds.includes(run.runId);
}

async function verifyAutomaticCriterion(
  app: RuntimeApp,
  task: WorkTask,
  criterion: WorkTask["acceptance"][number],
): Promise<{ status: AcceptanceStatus; evidence: WorkTaskEvidence[]; note: string }> {
  const now = new Date().toISOString();
  const latestRunId = task.runIds.at(-1);
  const latestRun = latestRunId === undefined
    ? null
    : await app.executionRecords.getRun(task.threadId, latestRunId);
  if (latestRun === undefined || latestRun === null) {
    return { status: "blocked", evidence: [], note: "No task-owned Run receipt is available for this delivery." };
  }
  if (!taskOwnsRun(task, latestRun) || latestRun.status === "running" || latestRun.status === "interrupted" ||
      latestRun.tools.some((tool) => tool.status === "unknown")) {
    return { status: "blocked", evidence: [], note: "The latest task Run contains a missing, foreign, interrupted, or unknown receipt that requires review." };
  }
  if (criterion.verification.kind === "shell_exit_zero") {
    const expectedCommand = criterion.verification.command;
    const expectedCwd = criterion.verification.cwd;
    const matchingShell = latestRun.tools.filter((item) => {
      if (item.toolName !== "shell_exec" || item.inputTruncated) return false;
      const input = previewObject(item.inputPreview);
      return input?.command === expectedCommand && (input.cwd ?? ".") === expectedCwd;
    }).at(-1);
    const succeeded = matchingShell?.status === "completed" && matchingShell.shell?.exitCode === 0 &&
      matchingShell.shell.timedOut === false && matchingShell.shell.cancelled === false;
    return matchingShell === undefined || !succeeded
      ? { status: "failed", evidence: [], note: "No matching successful Shell receipt was found." }
      : {
          status: "passed",
          evidence: [{ id: randomUUID(), kind: "tool", runId: latestRun.runId,
            toolCallId: matchingShell.toolCallId, toolName: "shell_exec",
            command: expectedCommand, cwd: expectedCwd,
            verifiedAt: now, outcome: "succeeded" }],
          note: "Matched the latest Run's exact, untruncated Shell command and cwd with exitCode 0 and no timeout or cancellation.",
        };
  }
  if (criterion.verification.kind === "artifact_exists") {
    if (app.workspaceRoot === undefined) return { status: "blocked", evidence: [], note: "No workspace is configured." };
    const requested = criterion.verification.path;
    const path = validateWorkspacePath(app.workspaceRoot, requested);
    if (!path.ok) return { status: "failed", evidence: [], note: path.message };
    const matchingWrite = latestRun.tools.filter((tool) => matchesFileWritePath(tool, requested)).at(-1);
    const written = matchingWrite === undefined ? undefined : readFileWriteReceipt(matchingWrite, requested);
    if (matchingWrite === undefined || written === undefined) {
      return { status: "failed", evidence: [], note: "No matching successful write/edit receipt belongs to this WorkTask." };
    }
    try {
      if (await rejectSymlinkComponents(app.workspaceRoot, path.relativePath, new AbortController().signal)) {
        return { status: "failed", evidence: [], note: "Artifact path contains a symbolic link." };
      }
      const stats = await lstat(path.target);
      if (!stats.isFile()) return { status: "failed", evidence: [], note: "Artifact is not a regular file." };
      if (stats.size > 8 * 1024 * 1024) {
        return { status: "blocked", evidence: [], note: "Artifact exceeds the 8 MiB verification limit." };
      }
      const content = await readFile(path.target);
      const digest = createHash("sha256").update(content).digest("hex");
      if ((written.sha256 !== null && digest !== written.sha256) ||
          (written.bytes !== null && content.length !== written.bytes)) {
        return { status: "failed", evidence: [], note: "Artifact content no longer matches the successful file write receipt." };
      }
      return {
        status: "passed",
        evidence: [{ id: randomUUID(), kind: "artifact", runId: latestRun.runId,
          toolCallId: matchingWrite.toolCallId, path: path.relativePath,
          sha256: digest, verifiedAt: now }],
        note: written.sha256 === null
          ? "Artifact currently exists as a regular non-symlink file and matches a complete legacy task write/edit receipt."
          : "Artifact path, byte count and SHA-256 match the latest task-owned compact file write receipt.",
      };
    } catch {
      return { status: "failed", evidence: [], note: "Artifact could not be read from the current workspace." };
    }
  }
  return { status: "blocked", evidence: [], note: "Human acceptance must be recorded explicitly." };
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
  let closed = false;
  let disposed = false;
  let cancelRequested = false;
  let recentOutput = "";
  let outputTruncated = false;
  let lastPrimaryResult: RunResult | null = null;
  let primaryMessageId: string | undefined;
  let primaryRunId: string | undefined;
  let lastConsolidationResult: RunResult | null = null;
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
    try {
      app.memoryConsolidation?.begin(agentId);
      const handle = await app.runtime.run({
        agentId,
        threadId: app.threadId,
        messages: [message],
        context: { agentId },
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
      const consolidationAttempts = { prepare: 0, stage: 0 };
      const pump = (async () => {
        for await (const event of handle.events) {
          if (event.type === "tool.call.requested") {
            toolNames.set(event.data.toolCallId, event.data.toolName);
            if (event.data.toolName.startsWith("memory_")) requestedMemoryTool = true;
            if (event.data.toolName === "memory_prepare_consolidation") consolidationAttempts.prepare += 1;
            if (event.data.toolName === "memory_stage_candidates") consolidationAttempts.stage += 1;
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
      const result = await handle.result;
      await pump;
      try {
        const finalized = await app.memoryConsolidation?.finalize({ ...result, consolidationAttempts }, signal);
        if (finalized !== undefined && !finalized.ok) {
          emit({ type: "error", message: `Memory candidates were not saved: ${finalized.error.code}: ${finalized.error.message}` });
        } else if (finalized?.ok && finalized.value.candidateIds.length > 0 && !finalized.value.replayed) {
          emit({ type: "memory-updated", reason: "proposals" });
          controller.recordOutput(`\nMemory candidates saved for review: ${finalized.value.candidateIds.join(", ")}\n`);
        }
      } catch (error) {
        emit({ type: "error", message: `Memory candidates were not saved: ${String(error)}` });
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
      emit({ type: "run-result", phase, result });
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
        }
        else emit({ type: "error", message: `WorkTask could not settle: ${settled.error.code}: ${settled.error.message}` });
      }
      return { result, requestedMemoryTool };
    } finally {
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
        nextWorkTask = found.value;
        clearBinding = app.bindNextExecutionWorkTask({ id: found.value.id, expectedRevision: found.value.revision });
        const started = await controller.run(input.instruction?.trim() || found.value.goal);
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
              emit({ type: "error", message: `Automatic consolidation unavailable: ${readiness.error.code}: ${readiness.error.message}` });
              return;
            }
            if (readiness?.ok && !readiness.value.canStart) {
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
