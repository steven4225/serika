import type { ControllerKernel } from "./controller-kernel.js";
import { createMemoryControls, type AssistantMemoryControls } from "./controller-memory.js";
import { createWorkTaskControls, type AssistantWorkTaskControls } from "./controller-work-tasks.js";
import { createAutomationControls, type AssistantAutomationControls } from "./controller-automation.js";
import { createDreamingControls, type AssistantDreamingControls } from "./controller-dreaming.js";
import { createRssControls, type AssistantRssControls } from "./controller-rss.js";
import { createRecipeControls, type AssistantRecipeControls } from "./controller-recipes.js";
import { validateChatAttachments, chatAttachmentParts, type ChatAttachment } from "./chat-attachments.js";
import { createHash, randomUUID } from "node:crypto";
import { userMessageClock } from "./memory-observation-policy.js";
import type { UIMessage } from "ai";
import type { AgentEvent, RunHandle, RunResult } from "@serika/core";
import { automaticConsolidationSkip, waitForConsolidationHandoff } from "./consolidation-lifecycle.js";
import { createRuntimeAutomation, MEMORY_SKILL_ID, type AutomationExecution, type SkillRunInput, type SkillResult } from "./automation-execution.js";
import { createBuiltinSkill } from "./skill-catalog.js";
import { DREAMING_AGENT_ID, type DreamingOverview, type DreamingResult } from "./dreaming.js";
import type { HookRequest } from "./automation-hooks.js";
import type { RuntimeApp } from "./app.js";
import type { ContextDiagnostics, ContextResult } from "./context-diagnostics.js";
import type { AssistantSteerRecord, ExecutionRunRecord } from "./execution-record-store.js";
export type { AssistantSteerRecord } from "./execution-record-store.js";
import type { WorkTask } from "./work-task-store.js";
import { recoverRunningWorkTasks } from "./work-task-recovery.js";
import type { ShellProgress } from "./modules/shell-module.js";
import type { PendingToolApproval } from "./tool-confirmation.js";
import { memoryControlFailure, type MemoryMaintenance } from "./memory-controls.js";
import { memoryConsolidationBacklog, prepareConsolidationExtraction, stageConsolidationExtraction } from "./memory-consolidation.js";
import { memoryConsolidationFailureText } from "./memory-failure.js";
import { AUTO_CONSOLIDATION_AGENT_ID } from "./consolidation.js";

const MAX_RECENT_OUTPUT_CHARS = 16 * 1024;
const MAX_TOOL_ACTIVITY = 30;
const MAX_TOOL_SUMMARY_CHARS = 1_000;

/** Application admission errors and persisted TaskStore errors share one honest result. */
export type AutomationResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

export type DreamingControllerOverview = DreamingOverview & {
  enabled: boolean;
  lastAttempt?: { status: "running" | "completed" | "failed" | "cancelled" | "uncertain"; message?: string; runId?: string };
};

export interface ToolActivity {
  toolCallId: string;
  toolName: string;
  status: "completed" | "failed";
  /** Invocation failed, but the external effect is not known to have failed. */
  outcomeUnknown?: boolean;
  /** From the complete error, never recovered by parsing a truncated preview. */
  errorCode?: string;
  summary: string;
  truncated: boolean;
}

export type AssistantState =
  | { kind: "idle" }
  | { kind: "running"; runId: string | null; phase: "primary" | "consolidation" | "skill"; background?: true; source?: "telegram" }
  | { kind: "compacting" }
  | { kind: "resuming" }
  | { kind: "command"; name: string };

export interface AssistantSnapshot {
  state: AssistantState;
  /** Ordinary chat can interrupt automatic consolidation; edits/commands still require idle. */
  canSubmit: boolean;
  canSteer: boolean;
  steers: readonly AssistantSteerRecord[];
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
  | { type: "steer"; steer: AssistantSteerRecord }
  | { type: "approval"; approval: PendingToolApproval }
  | { type: "approval-cleared"; approvalId: string }
  | { type: "run-event"; phase: "primary" | "consolidation" | "skill"; event: AgentEvent }
  | { type: "run-result"; phase: "primary" | "consolidation" | "skill"; result: RunResult }
  | { type: "shell-progress"; phase: "primary" | "consolidation" | "skill"; runId: string; progress: ShellProgress }
  | { type: "work-task-updated"; task: WorkTask }
  | { type: "memory-updated"; reason: "proposals" | "review" | "write" }
  | { type: "memory-references-changed" }
  | { type: "output"; text: string }
  | { type: "error"; message: string };

export type StartRunResponse =
  | { ok: true; runId: string }
  | { ok: false; reason: "busy" | "empty" | "starting" };

export interface AssistantRunOptions {
  attachments?: ChatAttachment[];
  /** Exclude this ordinary user message from present and future memory consolidation. */
  memoryConsolidation?: "exclude";
  /** Trusted bridge only; renderer options are sanitized before reaching here. */
  desktopEntry?: true;
  /** Trusted channel receipt clock; never accepted from renderer run options. */
  receivedAt?: string;
  /** Trusted embedding channel; renderer options cannot set it. */
  source?: "telegram";
}

export type AssistantSteerResponse =
  | { ok: true; steer: AssistantSteerRecord }
  | { ok: false; reason: "busy" | "stale" | "invalid" | "limit" | "closed" | "conflict" | "failed"; message?: string };

export type ControllerCommandResponse =
  | { ok: true }
  | { ok: false; reason: "busy" | "unknown" | "empty" | "cancelled" }
  | { ok: false; reason: "failed"; message: string };

/** Local execution receipts for this Thread. */
export interface AssistantRunRecords {
  /** Newest-first local receipts for this Thread. They never authorize replay. */
  list(limit?: number): Promise<ExecutionRunRecord[]>;
  get(runId: string): Promise<ExecutionRunRecord | null>;
  listModelUsage(): Promise<import("./model-usage.js").ModelUsagePage>;
}

/**
 * One Thread's assistant. The top level is the conversation itself (state,
 * history, Runs, steering, approvals, commands, events); everything else is
 * grouped by domain. All groups share the core's single idle / running /
 * command state machine, so a group operation is still refused while busy.
 */
export interface AssistantController {
  getSnapshot(): AssistantSnapshot;
  getHistory(): Promise<UIMessage[]>;
  getContextDiagnostics(): Promise<ContextResult<ContextDiagnostics>>;
  run(text: string, options?: AssistantRunOptions): Promise<StartRunResponse>;
  /** Supplement the active primary Run; this is not a queued or new Run. */
  steer(input: { expectedRunId: string; id: string; text: string }): Promise<AssistantSteerResponse>;
  cancel(): Promise<void>;
  /** `remember: true` keeps the approval's offered conversation grant (see `PendingToolApproval.remember`). */
  confirm(input: { approvalId: string; decision: "allow" | "deny"; remember?: boolean }): boolean;
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
  readonly memory: AssistantMemoryControls;
  readonly workTasks: AssistantWorkTaskControls;
  readonly automation: AssistantAutomationControls;
  readonly dreaming: AssistantDreamingControls;
  readonly rss: AssistantRssControls;
  readonly recipes: AssistantRecipeControls;
  readonly runs: AssistantRunRecords;
}

function commandParts(line: string): { name: string; args: string } {
  const trimmed = line.trim().replace(/^\//, "");
  const space = trimmed.search(/\s/);
  return space < 0
    ? { name: trimmed, args: "" }
    : { name: trimmed.slice(0, space), args: trimmed.slice(space + 1) };
}

/**
 * The dreaming Run's Thread: `dreaming-` + the first 24 hex of sha256(workspace root, else the app's Thread).
 * It is persisted (Thread ID → transcript file name, owner locks); exported only for its golden sample.
 */
export function dreamingThreadIdFor(workspaceRoot: string | undefined, threadId: string): string {
  return `dreaming-${createHash("sha256").update(workspaceRoot ?? threadId).digest("hex").slice(0, 24)}`;
}

export function createAssistantController(app: RuntimeApp): AssistantController {
  // Compatibility for embedders supplying the pre-registry RuntimeApp shape.
  const automation = app.automation ?? createRuntimeAutomation({
    skills: app.autoConsolidationAgentId ? [createBuiltinSkill({ id: MEMORY_SKILL_ID,
      description: "Legacy registered memory consolidator", kind: "memory-consolidate",
      instructions: "Consolidate committed incremental material using the host's existing memory lifecycle.",
      agentId: app.autoConsolidationAgentId })] : [],
    registrations: [], workspaceRoot: app.workspaceRoot,
  });
  app.enableExecutionRecords();
  let workTaskLease: Awaited<ReturnType<NonNullable<RuntimeApp["workTasks"]>["claimThread"]>> | undefined;
  let threadLease: Awaited<ReturnType<RuntimeApp["executionRecords"]["claimThread"]>> | undefined;
  let recoveryError: unknown;
  let steers: AssistantSteerRecord[] = [];
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
      const latest = (await app.executionRecords.listRuns(app.threadId, 50)).find(run => run.phase === "primary");
      steers = structuredClone(latest?.steers ?? []);
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
    lifecycleReady = true;
  };
  let state: AssistantState = { kind: "idle" };
  let activeHandle: RunHandle | undefined;
  let startupController: AbortController | undefined;
  let operationController: AbortController | undefined;
  let activeTask: Promise<void> | undefined;
  let backgroundTask: Promise<void> | undefined;
  let backgroundController: AbortController | undefined;
  let memoryIndexRequested = true;
  let memoryIndexRunning = false;
  let lifecycleReady = false;
  let idleDreamingRequested = false;
  let nextWorkTask: WorkTask | undefined;
  let activeWorkTask: WorkTask | undefined;
  let workTaskCompletionCheck = true;
  let closed = false;
  let disposed = false;
  let cancelRequested = false;
  let recentOutput = "";
  let outputTruncated = false;
  let lastPrimaryResult: RunResult | null = null;
  let primaryRunId: string | undefined;
  let primaryContextMessageIds = new Set<string>();
  const steerRequests = new Map<string, { text: string; response: Promise<AssistantSteerResponse> }>();
  let primaryMemoryReferences = new Map<string, { id: string; revision: number }>();
  let primaryMemoryReferencesTruncated = false;
  let lastConsolidationResult: RunResult | null = null;
  // A completed model Run is not proof that its proposal/cursor write succeeded.
  let consolidationFailure: string | undefined;
  let consolidationRunning = false;
  let lastConsolidationAttempt: MemoryMaintenance["consolidation"]["lastAttempt"];
  let lastConsolidationSkippedReason: string | undefined;
  let lastDreamingAttempt: DreamingControllerOverview["lastAttempt"];
  const dreamingThreadId = dreamingThreadIdFor(app.workspaceRoot, app.threadId);
  let resultTextTruncated = false;
  const toolActivity: ToolActivity[] = [];
  const toolNames = new Map<string, string>();
  let pendingApproval = app.toolConfirmation?.getPending() ?? null;
  const listeners = new Set<(event: AssistantEvent) => void>();

  const emit = (event: AssistantEvent): void => {
    if (event.type === "memory-updated") memoryIndexRequested = true;
    for (const listener of listeners) {
      try { listener(event); } catch { /* A disconnected view cannot fail a Run. */ }
    }
  };
  const setState = (next: AssistantState): void => {
    state = next;
    emit({ type: "state", state: next });
    if (next.kind === "idle") queueMicrotask(() => { startMemoryIndexMaintenance(); });
  };
  let approvalTracePending: Promise<void> = Promise.resolve();
  const unsubscribeApproval = app.toolConfirmation?.subscribePending((next) => {
    const previous = pendingApproval;
    pendingApproval = next ?? null;
    if (next !== undefined && previous?.approvalId !== next.approvalId) {
      // The local approval hook does not emit Core's approval_required event.
      // Observe real pending creation; never infer human waiting for auto-approved calls.
      const write = app.executionRecords.recordApprovalRequested?.(app.threadId, next.toolCallId, next.toolName) ?? Promise.resolve();
      approvalTracePending = Promise.all([approvalTracePending, write]).then(() => undefined).catch(() => undefined);
    }
    if (previous !== null && (next === undefined || next.approvalId !== previous.approvalId)) {
      emit({ type: "approval-cleared", approvalId: previous.approvalId });
    }
    if (next !== undefined) emit({ type: "approval", approval: next });
  });
  const unsubscribeShellProgress = app.subscribeShellProgress?.((progress) => {
    if (state.kind !== "running" || state.runId === null) return;
    emit({ type: "shell-progress", phase: state.phase, runId: state.runId, progress });
  });
  const unsubscribeMemoryReferences = app.subscribeMemoryReferences?.(() => {
    const references = app.getMemoryReferences?.();
    if (references && primaryContextMessageIds.has(references.messageId)) {
      for (const selected of references.selected) {
        const key = `${selected.id}:${selected.revision}`;
        if (primaryMemoryReferences.has(key)) continue;
        if (primaryMemoryReferences.size >= 16) primaryMemoryReferencesTruncated = true;
        else primaryMemoryReferences.set(key, { id: selected.id, revision: selected.revision });
      }
    }
    emit({ type: "memory-references-changed" });
  });

  const executeRun = async (
    agentId: string,
    message: UIMessage,
    phase: "primary" | "consolidation" | "skill",
    signal?: AbortSignal,
    started?: (handle: RunHandle) => void,
    background = false,
    executionThreadId = app.threadId,
    source?: "telegram",
    desktopEntry = false,
  ): Promise<{ result: RunResult; requestedMemoryTool: boolean; finalizationFailed: boolean }> => {
    const outputTiming = phase === "primary" ? app.beginOutputTiming?.(message) : undefined;
    const autonomous = phase === "primary" && app.beginForegroundExecution?.(source === "telegram" ? "telegram" : desktopEntry ? "desktop" : undefined, message) === true;
    app.toolConfirmation?.beginRun(autonomous, source);
    if (phase === "primary") {
      primaryRunId = undefined;
      primaryContextMessageIds = new Set([message.id]);
      steers = []; steerRequests.clear();
      primaryMemoryReferences = new Map(); primaryMemoryReferencesTruncated = false;
    }
    if (phase === "consolidation") { consolidationFailure = undefined; consolidationRunning = true; }
    try {
      app.memoryConsolidation?.begin(agentId);
      const hostExtraction = app.hostConsolidationExtraction === true && phase === "consolidation" && agentId === AUTO_CONSOLIDATION_AGENT_ID && app.memoryConsolidation !== undefined;
      if (hostExtraction) message = await prepareConsolidationExtraction(app.memoryConsolidation!, message, signal);
      const handle = await app.runtime.run({
        agentId,
        threadId: executionThreadId,
        messages: [message],
        ...(phase === "primary" ? { enableSteering: true } : {}),
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
      if (!background || !signal?.aborted) setState({ kind: "running", runId: handle.runId, phase, ...(phase === "primary" && source ? { source } : {}), ...(background ? { background: true as const } : {}) });
      started?.(handle);
      if (cancelRequested || signal?.aborted) await handle.cancel("Cancelled before Run started");
      let requestedMemoryTool = false;
      let completionCorrections = 0;
      const consolidationAttempts = { prepare: 0, stage: 0 };
      const pump = (async () => {
        for await (const event of handle.events) {
          if (phase === "primary" && (event.type === "run.steer.accepted" || event.type === "run.steer.applied" || event.type === "run.steer.not_applied")) {
            let record = steers.find(item => item.id === event.data.id);
            if (event.type === "run.steer.accepted") {
              if (!record) { record = { id: event.data.id, runId: event.runId, text: event.data.text, status: "accepted", receivedAt: event.occurredAt }; steers.push(record); }
            } else if (record) {
              if (event.type === "run.steer.applied") {
                record.status = "applied"; record.messageId = event.data.messageId; record.appliedAt = event.occurredAt;
                primaryContextMessageIds.add(event.data.messageId);
              } else { record.status = "not_applied"; record.reason = event.data.reason; }
            }
            if (record) emit({ type: "steer", steer: structuredClone(record) });
          }
          if (event.type === "run.completion.checked") {
            completionCorrections = event.data.corrections;
            if (event.data.decision === "continue") controller.recordOutput(`\n正在补齐任务证据（${completionCorrections}/2），工具按当前授权执行。\n`);
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
            // A completed invocation may return an explicit failure. Classify
            // before bounding the display preview; Run completion is unrelated.
            const output = event.type === "tool.call.completed" ? event.data.output : undefined;
            const returnedFailure = typeof output === "object" && output !== null && "ok" in output && output.ok === false;
            const returnedError = returnedFailure && "error" in output && typeof output.error === "object" && output.error !== null ? output.error : undefined;
            const errorCode = event.type === "tool.call.failed" ? event.data.error.code
              : returnedError && "code" in returnedError && typeof returnedError.code === "string" ? returnedError.code : undefined;
            const failureMessage = event.type === "tool.call.failed" ? event.data.error.message
              : returnedError && "message" in returnedError && typeof returnedError.message === "string" ? returnedError.message : undefined;
            const failed = event.type === "tool.call.failed" || returnedFailure;
            const raw = failed ? [errorCode, failureMessage].filter(Boolean).join(": ") || "工具返回失败，详情见执行追踪"
              : JSON.stringify(output) ?? "";
            const item: ToolActivity = {
              toolCallId: event.data.toolCallId,
              toolName: event.data.toolName ?? toolNames.get(event.data.toolCallId) ?? "unknown",
              status: failed ? "failed" : "completed",
              ...(errorCode ? { errorCode: errorCode.slice(0, 128) } : {}),
              ...(errorCode === "TOOL_OUTCOME_UNKNOWN"
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
          outputTiming?.observe(event);
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
      let finalizationFailed = false;
      let accepted: NonNullable<NonNullable<MemoryMaintenance["consolidation"]["lastAttempt"]>["accepted"]> = [];
      try {
        const extracted = hostExtraction && result.status === "completed" ?
          await stageConsolidationExtraction(app.memoryConsolidation!, result.text, signal) : undefined;
        const finalized = await app.memoryConsolidation?.finalize({ ...result,
          ...(extracted && !extracted.ok ? { extractionFailed: true } : {}),
          ...(hostExtraction && consolidationAttempts.prepare === 0 && consolidationAttempts.stage === 0 ? {} : { consolidationAttempts }) }, signal);
        if (finalized !== undefined && !finalized.ok) {
          finalizationFailed = true;
          consolidationFailure = `${finalized.error.code}: ${finalized.error.message}`;
          emit({ type: "error", message: memoryConsolidationFailureText(consolidationFailure) });
        } else if (finalized?.ok) {
          lastProcessedCount = finalized.value.processedCount ?? 0;
          accepted = finalized.value.accepted ?? [];
          const pendingIds = finalized.value.pendingCandidateIds ?? finalized.value.candidateIds;
          lastCandidateCount = pendingIds.length;
          if (!finalized.value.replayed) for (const outcome of finalized.value.outcomes ?? []) {
            if (outcome.status === "not_saved") {
              const message = outcome.reason === "retry_exhausted"
                ? memoryConsolidationFailureText("MEMORY_RETRY_EXHAUSTED")
                : "这条记忆没保存：内容太长，请分段再告诉我。原话仍保留在对话里。";
              controller.recordOutput(`\n${message}\n`);
              emit({ type: "error", message });
            }
          }
          if (phase === "consolidation" || consolidationAttempts.prepare > 0 || consolidationAttempts.stage > 0) {
            consolidationFailure = result.status === "completed" ? undefined : result.error?.message ?? `Consolidation Run ${result.status}`;
          }
          const deferred = finalized.value.outcomes?.some(outcome => outcome.status === "deferred");
          if (finalized.value.outcomes?.some(outcome => outcome.status === "not_saved" && outcome.reason === "retry_exhausted")) consolidationFailure = "MEMORY_RETRY_EXHAUSTED";
          else if (deferred || extracted && !extracted.ok) {
            consolidationFailure = "MEMORY_EXTRACTION_DEFERRED" + (extracted && !extracted.ok ? `: ${extracted.error.code}: ${extracted.error.message}` : "");
            if (!finalized.value.replayed) emit({ type: "error", message: memoryConsolidationFailureText(consolidationFailure) });
          }
          if (deferred || finalized.value.outcomes?.some(outcome => outcome.status === "not_saved" && outcome.reason === "retry_exhausted")) finalizationFailed = true;
          if (finalized.value.outcomes?.length && !finalized.value.candidateIds.length && !finalized.value.replayed) emit({ type: "memory-updated", reason: "proposals" });
          if (finalized.value.candidateIds.length > 0 && !finalized.value.replayed) {
            emit({ type: "memory-updated", reason: "proposals" });
            if (pendingIds.length > 0) controller.recordOutput(app.memoryConsolidation?.reviewQueue === false
              ? `\n有 ${pendingIds.length} 项内容不确定或与已有记忆冲突，没有自动保存；原记忆没有被覆盖。\n`
              : `\n有 ${pendingIds.length} 项记忆待确认；原记忆没有被覆盖。可以让助手列出并逐项确认。\n`);
            for (const receipt of accepted) {
              const label = receipt.operation === "retract" ? "已撤回" : receipt.operation === "disable" ? "已停用" : receipt.operation === "add" ? "已保存" : "已更新";
              controller.recordOutput(`\n记忆${label}，可在记忆页查看或撤回。\n`);
            }
          }
        }
      } catch (error) {
        finalizationFailed = true;
        consolidationFailure = String(error);
        emit({ type: "error", message: memoryConsolidationFailureText("acknowledgement: " + String(error)) });
      }
      if (phase === "consolidation") {
        const yielded = result.status === "cancelled" && signal?.aborted &&
          signal.reason instanceof Error && signal.reason.message === "Foreground chat has priority";
        if (yielded && !finalizationFailed) {
          consolidationFailure = undefined;
          lastConsolidationSkippedReason = "自动整理已让给新消息，未推进游标；待处理材料会在后续整理中重试";
          lastConsolidationAttempt = undefined;
        } else lastConsolidationAttempt = {
          mode: "incremental", runId: handle.runId,
          status: result.status === "completed" && !consolidationFailure ? "completed" : "failed",
          processedCount: lastProcessedCount, candidateCount: lastCandidateCount,
          ...(accepted.length ? { accepted } : {}),
        };
      }
      let executionFinalized = true;
      try {
        await approvalTracePending;
        await app.executionRecords.finishRun(handle.runId, result, phase === "primary"
          ? { references: [...primaryMemoryReferences.values()], truncated: primaryMemoryReferencesTruncated } : undefined);
        if (phase === "primary") {
          const persisted = await app.executionRecords.getRun(app.threadId, handle.runId);
          if (persisted?.steers) steers = structuredClone(persisted.steers);
        }
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
      else if (phase === "consolidation") lastConsolidationResult = retainedResult;
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
            const submitted = await controller.workTasks.submitDelivery({
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
      return { result, requestedMemoryTool, finalizationFailed };
    } catch (error) {
      if (phase === "consolidation") consolidationFailure = String(error);
      throw error;
    } finally {
      await outputTiming?.finish();
      consolidationRunning = false;
      app.memoryConsolidation?.discard();
      if (phase === "primary" && activeWorkTask !== undefined) {
        app.workTaskContext.end();
        activeWorkTask = undefined;
      }
      activeHandle = undefined;
      app.toolConfirmation?.endRun();
      app.endForegroundExecution?.();
    }
  };

  const invokeSkill = async (
    input: SkillRunInput,
    origin: Pick<AutomationExecution, "source" | "ruleId" | "event">,
    signal: AbortSignal,
    background: boolean,
    started?: (runId: string) => void,
  ): Promise<SkillResult<{ runId: string }>> => {
    const skill = automation.getSkill(input?.id);
    if (!skill) return { ok: false, error: { code: "SKILL_UNAVAILABLE", message: "Skill is not registered" } };
    const base = { skillId: skill.id, hash: skill.hash, ...origin };
    const id = automation.record({ ...base, status: "starting" });
    let runId: string | undefined;
    try {
      signal.throwIfAborted();
      const prepared = await automation.prepare(input);
      if (!prepared.ok) {
        automation.record({ ...base, id, status: "failed", message: prepared.error.message });
        if (skill.kind === "memory-consolidate") consolidationFailure = prepared.error.message;
        return prepared;
      }
      signal.throwIfAborted();
      if (skill.kind === "memory-consolidate") {
        if (!app.memoryConsolidation) {
          automation.record({ ...base, id, status: "failed", message: "Memory consolidation is unavailable" });
          return memoryControlFailure("MEMORY_DISABLED", "Memory consolidation is unavailable");
        }
        const readiness = await app.memoryConsolidation?.canStart(signal);
        if (readiness && (!readiness.ok || !readiness.value.canStart)) {
          const failure = !readiness.ok ? readiness : memoryControlFailure("MEMORY_LIMIT_EXCEEDED", "Review pending candidates before consolidating");
          consolidationFailure = `${failure.error.code}: ${failure.error.message}`;
          if (readiness.ok) controller.recordOutput("\nMemory candidate queue is full; review pending candidates before consolidating.\n");
          automation.record({ ...base, id, status: "failed", message: consolidationFailure });
          return failure;
        }
        if (origin.source === "hook" && app.getMemoryConsolidationBacklog) {
          const backlog = await app.getMemoryConsolidationBacklog();
          if (!backlog.ok) {
            consolidationFailure = `${backlog.error.code}: ${backlog.error.message}`;
            automation.record({ ...base, id, status: "failed", message: consolidationFailure });
            return backlog;
          }
          if (backlog.value === 0) {
            const message = "没有尚未整理的合格增量";
            lastConsolidationSkippedReason = message;
            automation.record({ ...base, id, status: "skipped", message });
            return { ok: false, error: { code: "SKILL_NO_MATERIAL", message } };
          }
        }
      }
      controller.recordOutput(`\n[automation] ${origin.source === "hook" ? `规则 ${origin.ruleId}` : "手动调用"} → ${skill.id} · ${skill.hash.slice(0, 12)}${background ? "（新对话优先）" : ""}\n`);
      const execution = await executeRun(skill.agentId, prepared.value.message,
        skill.kind === "memory-consolidate" ? "consolidation" : "skill", signal, handle => {
          runId = handle.runId;
          automation.record({ ...base, id, runId, status: "running" });
          started?.(runId);
        }, background);
      const failed = execution.result.status !== "completed" || execution.finalizationFailed;
      automation.record({ ...base, id, ...(runId ? { runId } : {}),
        status: signal.aborted || execution.result.status === "cancelled" ? "cancelled" : failed ? "failed" : "completed",
        ...(failed ? { message: execution.result.error?.message ?? consolidationFailure ?? `Run ${execution.result.status}` } : {}),
      });
      return failed ? { ok: false, error: { code: "SKILL_EXECUTION_FAILED", message: execution.result.error?.message ?? consolidationFailure ?? `Run ${execution.result.status}` } }
        : { ok: true, value: { runId: execution.result.runId } };
    } catch (error) {
      const message = String(error);
      automation.record({ ...base, id, ...(runId ? { runId } : {}), status: signal.aborted ? "cancelled" : "failed", message });
      if (skill.kind === "memory-consolidate" && !signal.aborted) consolidationFailure = message;
      return { ok: false, error: { code: signal.aborted ? "SKILL_CANCELLED" : "SKILL_EXECUTION_FAILED", message } };
    }
  };

  const startAutomaticSkills = (requests: readonly HookRequest[]): void => {
    if (closed || state.kind !== "idle" || backgroundTask || requests.length === 0) return;
    const background = new AbortController();
    backgroundController = background;
    const task = Promise.resolve().then(async () => {
      try {
        // One ephemeral matched batch, not an event queue. Abort abandons later handlers.
        const seen = new Set<string>();
        for (const request of requests) {
          if (closed || background.signal.aborted) break;
          const skill = automation.getSkill(request.skillId)!;
          if (seen.has(skill.id)) {
            automation.record({ skillId: skill.id, hash: skill.hash, source: "hook", ruleId: request.ruleId,
              event: request.event.event, status: "skipped", message: "同一事件的相同 Skill 已合并" });
            continue;
          }
          seen.add(skill.id);
          const result = await invokeSkill({ id: skill.id, expectedHash: skill.hash,
            ...(skill.kind === "text" ? { input: `Lifecycle event (host metadata only): ${JSON.stringify(request.event)}` } : {}) },
            { source: "hook", ruleId: request.ruleId, event: request.event.event }, background.signal, true);
          if (!result.ok && result.error.code !== "SKILL_NO_MATERIAL" && !background.signal.aborted) {
            emit({ type: "error", message: `Automatic Skill failed: ${result.error.code}: ${result.error.message}` });
          }
        }
      } catch (error) {
        if (!background.signal.aborted) emit({ type: "error", message: `Automatic Skill failed: ${String(error)}` });
      } finally {
        if (backgroundController === background) backgroundController = undefined;
        const current = controller.getSnapshot().state;
        if (current.kind === "running" && current.background) setState({ kind: "idle" });
      }
    });
    backgroundTask = task;
    void task.finally(() => {
      if (backgroundTask === task) backgroundTask = undefined;
      startIdleDreaming();
    });
    const first = automation.getSkill(requests[0]!.skillId)!;
    setState({ kind: "running", runId: null, phase: first.kind === "memory-consolidate" ? "consolidation" : "skill", background: true });
  };

  const startMemoryIndexMaintenance = (): boolean => {
    if (!lifecycleReady || closed || state.kind !== "idle" || backgroundTask || !memoryIndexRequested || !app.maintainMemoryIndex) return false;
    memoryIndexRequested = false;
    memoryIndexRunning = true;
    const operation = new AbortController();
    backgroundController = operation;
    const task = Promise.resolve().then(async () => {
      try {
        operation.signal.throwIfAborted();
        await app.maintainMemoryIndex!(operation.signal);
      } catch {
        if (!operation.signal.aborted) emit({ type: "error", message: "记忆索引补齐失败；当前仍可使用关键词检索，本次不会自动重试。" });
      } finally {
        memoryIndexRunning = false;
        if (backgroundController === operation) backgroundController = undefined;
        if (backgroundTask === task) backgroundTask = undefined;
        const current = controller.getSnapshot().state;
        if (current.kind === "running" && current.background) setState({ kind: "idle" });
        if (idleDreamingRequested) startIdleDreaming();
      }
    });
    backgroundTask = task;
    setState({ kind: "running", runId: null, phase: "skill", background: true });
    return true;
  };

  const startManualSkill = async (input: SkillRunInput): Promise<SkillResult<{ runId: string }>> => {
    if (closed || state.kind !== "idle") return memoryControlFailure("BUSY", "Wait for the current operation to finish");
    const skill = automation.getSkill(input?.id);
    if (!skill) return memoryControlFailure("SKILL_UNAVAILABLE", "Skill is not registered");
    const startup = new AbortController();
    startupController = startup;
    cancelRequested = false;
    if (skill.kind === "memory-consolidate") {
      lastConsolidationResult = null;
      lastConsolidationSkippedReason = undefined;
    }
    setState({ kind: "running", phase: skill.kind === "memory-consolidate" ? "consolidation" : "skill", runId: null });
    let resolveStarted!: (value: SkillResult<{ runId: string }>) => void;
    const started = new Promise<SkillResult<{ runId: string }>>(resolve => { resolveStarted = resolve; });
    activeTask = (async () => {
      try {
        await ensureRecovered();
        const result = await invokeSkill(input, { source: "manual" }, startup.signal, false,
          runId => resolveStarted({ ok: true, value: { runId } }));
        resolveStarted(result);
        if (!result.ok && !startup.signal.aborted) emit({ type: "error", message: `${result.error.code}: ${result.error.message}` });
      } catch (error) {
        resolveStarted(memoryControlFailure("SKILL_EXECUTION_FAILED", String(error)));
        emit({ type: "error", message: String(error) });
      } finally {
        startupController = undefined;
        setState({ kind: "idle" });
      }
    })();
    return started;
  };

  const dreamingFailure = (code: string, message: string): DreamingResult<never> => ({ ok: false, error: { code, message } });
  const startDreaming = (background: boolean): Promise<DreamingResult<{ runId: string }>> => {
    if (!app.dreaming || app.moduleConfig?.automation?.dreaming?.enabled !== true) {
      return Promise.resolve(dreamingFailure("DREAMING_DISABLED", "请先显式启用经验学习；不会默认读取任务或调用模型"));
    }
    if (closed || state.kind !== "idle" || backgroundTask) return Promise.resolve(dreamingFailure("BUSY", "请等待当前操作结束"));
    const operation = new AbortController();
    if (background) backgroundController = operation;
    else startupController = operation;
    cancelRequested = false;
    setState({ kind: "running", phase: "skill", runId: null, ...(background ? { background: true as const } : {}) });
    let resolveStarted!: (response: DreamingResult<{ runId: string }>) => void;
    const started = new Promise<DreamingResult<{ runId: string }>>(resolve => { resolveStarted = resolve; });
    let notStarted: DreamingResult<{ runId: string }> | undefined;
    const task = (async () => {
      let lease: Awaited<ReturnType<RuntimeApp["executionRecords"]["claimThread"]>> | undefined;
      let workspaceLease: Awaited<ReturnType<NonNullable<RuntimeApp["workTasks"]>["claimThread"]>> | undefined;
      let commitUncertain = false;
      try {
        await ensureRecovered();
        operation.signal.throwIfAborted();
        // One reflection owner per workspace, even across foreground Threads.
        workspaceLease = await app.workTasks?.claimThread(dreamingThreadId);
        operation.signal.throwIfAborted();
        lease = await app.executionRecords.claimThread(dreamingThreadId);
        await app.executionRecords.recoverInterrupted(dreamingThreadId);
        operation.signal.throwIfAborted();
        const prepared = await app.dreaming!.prepare(operation.signal);
        if (!prepared.ok) throw new Error(`${prepared.error.code}: ${prepared.error.message}`);
        if (!prepared.value) {
          notStarted = dreamingFailure("DREAMING_NO_MATERIAL", "至少需要两条来源完整且有人工验收的独立任务经验");
          return;
        }
        const batch = prepared.value;
        lastDreamingAttempt = { status: "running" };
        const execution = await executeRun(DREAMING_AGENT_ID, batch.message, "skill", operation.signal, handle => {
          lastDreamingAttempt = { status: "running", runId: handle.runId };
          resolveStarted({ ok: true, value: { runId: handle.runId } });
        }, background, dreamingThreadId);
        operation.signal.throwIfAborted();
        if (execution.result.status !== "completed") throw new Error(execution.result.error?.message ?? `Run ${execution.result.status}`);
        const committed = await app.dreaming!.commit(batch, execution.result.text, operation.signal);
        if (!committed.ok) {
          commitUncertain = committed.error.code === "DREAMING_COMMIT_UNCERTAIN";
          throw new Error(`${committed.error.code}: ${committed.error.message}`);
        }
        lastDreamingAttempt = { status: "completed", runId: execution.result.runId,
          message: committed.value.skillIds.length ? `已沉淀 ${committed.value.skillIds.length} 条可试用方法` : "已处理这批经验，没有可泛化的方法" };
        controller.recordOutput(`\n[经验学习] ${lastDreamingAttempt.message}。文本方法不授予工具权限。\n`);
      } catch (error) {
        const cancelled = operation.signal.aborted && !commitUncertain;
        const message = commitUncertain ? "经验写入回执未确认，可能已经保存；请刷新核对，不会自动重试这次提交" : cancelled ? "经验学习已停止，未完成的批次不会标记为已处理" : String(error);
        lastDreamingAttempt = { ...lastDreamingAttempt, status: commitUncertain ? "uncertain" : cancelled ? "cancelled" : "failed", message };
        notStarted = dreamingFailure(commitUncertain ? "DREAMING_COMMIT_UNCERTAIN" : cancelled ? "DREAMING_CANCELLED" : "DREAMING_FAILED", message);
        if (!cancelled) emit({ type: "error", message: `经验学习失败：${message}` });
      } finally {
        await lease?.release().catch(error => emit({ type: "error", message: `经验学习租约释放失败：${String(error)}` }));
        await workspaceLease?.release().catch(error => emit({ type: "error", message: `经验学习工作区租约释放失败：${String(error)}` }));
        if (backgroundController === operation) backgroundController = undefined;
        if (startupController === operation) startupController = undefined;
        const current = controller.getSnapshot().state;
        if (!background || (current.kind === "running" && current.background)) setState({ kind: "idle" });
        if (notStarted) resolveStarted(notStarted);
      }
    })();
    if (background) {
      backgroundTask = task;
      void task.finally(() => { if (backgroundTask === task) backgroundTask = undefined; });
    } else activeTask = task;
    return started;
  };
  const startIdleDreaming = (): void => {
    idleDreamingRequested = true;
    if (startMemoryIndexMaintenance()) return;
    if (!closed && state.kind === "idle" && !backgroundTask && app.dreaming && app.moduleConfig?.automation?.dreaming?.enabled === true) {
      idleDreamingRequested = false;
      void startDreaming(true);
    }
  };

  const kernel: ControllerKernel = {
    app,
    isClosed: () => closed,
    isIdle: () => state.kind === "idle",
    emit,
    ensureRecovered,
    recovered: () => recovery,
    exclusive: <T>(name: string, body: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const operation = new AbortController();
      operationController = operation;
      setState({ kind: "command", name });
      let result!: T;
      const task = (async () => {
        try { result = await body(operation.signal); }
        finally { operationController = undefined; setState({ kind: "idle" }); }
      })();
      activeTask = task;
      return task.then(() => result);
    },
    primaryReference: reference => reference && primaryContextMessageIds.has(reference.messageId) && primaryRunId
      ? { ...reference, runId: primaryRunId } : null,
  };
  const memory = createMemoryControls(kernel, {
    automation,
    consolidationStatus: () => ({
      running: consolidationRunning,
      failure: consolidationFailure,
      lastAttempt: lastConsolidationAttempt,
      lastSkippedReason: lastConsolidationSkippedReason,
    }),
  });
  const workTasks = createWorkTaskControls(kernel, {
    slot: {
      busy: () => nextWorkTask !== undefined || activeWorkTask !== undefined,
      reserve: (task, completionCheck) => { workTaskCompletionCheck = completionCheck; nextWorkTask = task; },
      release: () => { nextWorkTask = undefined; },
    },
    run: (text, options) => controller.run(text, options),
    onCompleted: () => startIdleDreaming(),
  });
  const automationControls = createAutomationControls(kernel, { automation, startSkill: input => startManualSkill(input) });
  const dreaming = createDreamingControls(kernel, { startDreaming: () => startDreaming(false), lastAttempt: () => lastDreamingAttempt });

  const controller: AssistantController = {
    memory,
    workTasks,
    automation: automationControls,
    dreaming,
    rss: createRssControls(kernel),
    recipes: createRecipeControls(kernel),
    runs: {
      list: async (limit) => {
        await ensureRecovered();
        return app.executionRecords.listRuns(app.threadId, limit);
      },
      listModelUsage: async () => {
        await ensureRecovered();
        return app.executionRecords.listModelUsage(app.threadId);
      },
      get: async (runId) => {
        await ensureRecovered();
        return app.executionRecords.getRun(app.threadId, runId);
      },
    },
    getSnapshot: () => ({
      state,
      canSubmit: !closed && (state.kind === "idle" || (state.kind === "running" && state.background === true)),
      canSteer: !closed && !cancelRequested && state.kind === "running" && state.phase === "primary" && state.runId !== null && activeHandle?.runId === state.runId && activeHandle.steer !== undefined,
      steers: structuredClone(steers),
      pendingApproval,
      recentOutput,
      outputTruncated,
      toolActivity: [...toolActivity],
      lastPrimaryResult,
      lastConsolidationResult,
      resultTextTruncated,
    }),
    getHistory: async () => { await recovery; return app.store.getMessages(app.threadId); },
    getContextDiagnostics: async () => {
      const diagnostics = await app.getContextDiagnostics();
      const source = diagnostics.ok ? diagnostics.value.lastPreparationSource : null;
      if (source && primaryContextMessageIds.has(source.messageId) && primaryRunId) {
        source.runId = primaryRunId;
      }
      return diagnostics;
    },
    run: async (text, options) => {
      const receivedAt = options?.receivedAt ?? new Date().toISOString();
      const attachments = validateChatAttachments(options?.attachments);
      if (text.trim().length === 0 && attachments.length === 0) return { ok: false, reason: "empty" };
      const previousBackground = state.kind === "running" && state.background === true ? backgroundTask : undefined;
      if (closed || (state.kind !== "idle" && previousBackground === undefined)) return { ok: false, reason: "busy" };
      const excludeFromConsolidation = options?.memoryConsolidation === "exclude" || attachments.length > 0;
      lastConsolidationSkippedReason = undefined;

      cancelRequested = false;
      toolActivity.length = 0;
      toolNames.clear();
      lastPrimaryResult = null;
      lastConsolidationResult = null;
      resultTextTruncated = false;
      const startup = new AbortController();
      startupController = startup;
      setState({ kind: "running", runId: null, phase: "primary", ...(options?.source ? { source: options.source } : {}) });
      if (previousBackground) {
        if (memoryIndexRunning) memoryIndexRequested = true;
        backgroundController?.abort(new DOMException("Foreground chat has priority", "AbortError"));
        void activeHandle?.cancel("Foreground chat has priority").catch(error => emit({ type: "error", message: String(error) }));
      }
      let resolveStarted!: (response: StartRunResponse) => void;
      const started = new Promise<StartRunResponse>((resolve) => { resolveStarted = resolve; });
      const userMessage: UIMessage = {
        id: randomUUID(), role: "user", parts: [{ type: "text", text: text.trim() || "请查看附件。" }, ...chatAttachmentParts(attachments)],
        metadata: { ...userMessageClock(), receivedAt, ...(options?.receivedAt ? { sentAt: options.receivedAt, timeZone: "Asia/Shanghai" } : {}),
          ...(excludeFromConsolidation ? { memoryConsolidation: "exclude" } : {}),
          ...(attachments.length ? { attachments: attachments.map(({ name, mediaType }) => ({ name, mediaType })) } : {}) },
      };
      activeWorkTask = nextWorkTask;
      nextWorkTask = undefined;
      activeTask = (async () => {
        let startSettled = false;
        let pendingHooks: HookRequest[] = [];
        const settleStart = (response: StartRunResponse): void => {
          if (!startSettled) { startSettled = true; resolveStarted(response); }
        };
        try {
          if (previousBackground && !await waitForConsolidationHandoff(previousBackground)) {
            emit({ type: "error", message: "Background consolidation is still stopping; your message was not submitted. Retry after it stops." });
            settleStart({ ok: false, reason: "busy" });
            return;
          }
          await ensureRecovered();
          app.resume?.beginRun();
          let primary: { result: RunResult; requestedMemoryTool: boolean };
          try {
            primary = await executeRun(app.agentId, userMessage, "primary", startup.signal, (handle) => {
              settleStart({ ok: true, runId: handle.runId });
            }, false, app.threadId, options?.source, options?.desktopEntry === true);
          } finally {
            app.resume?.endRun();
          }
          const skip = automaticConsolidationSkip({ enabled: app.autoConsolidationAgentId !== undefined,
            status: primary.result.status, requestedMemoryTool: primary.requestedMemoryTool,
            cancelled: cancelRequested || startup.signal.aborted, excluded: excludeFromConsolidation });
          if (app.autoConsolidationAgentId) lastConsolidationSkippedReason = skip;
          if (primary.result.status === "completed" && !cancelRequested && !startup.signal.aborted) {
            const matched = automation.select({ event: "primary.completed", threadId: app.threadId,
              runId: primary.result.runId, agentId: app.agentId, phase: "primary", status: "completed" });
            pendingHooks = matched.filter(request => {
              const skill = automation.getSkill(request.skillId)!;
              if (skill.kind !== "memory-consolidate" || skip === undefined) return true;
              automation.record({ skillId: skill.id, hash: skill.hash, source: "hook", ruleId: request.ruleId,
                event: request.event.event, status: "skipped", message: skip });
              return false;
            });
            if (app.autoConsolidationAgentId && !matched.some(request => automation.getSkill(request.skillId)?.kind === "memory-consolidate")) {
              lastConsolidationSkippedReason = "当前配置没有匹配的记忆 Hook";
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
          if (previousBackground && backgroundTask === previousBackground) {
            setState({ kind: "running", runId: activeHandle?.runId ?? null, phase: "consolidation", background: true });
          } else {
            setState({ kind: "idle" });
            startAutomaticSkills(pendingHooks);
            if (!pendingHooks.length && lastDreamingAttempt?.status === "cancelled") startIdleDreaming();
          }
        }
      })();
      return started;
    },
    steer: async (input) => {
      if (!input || typeof input.expectedRunId !== "string" || typeof input.id !== "string" ||
          !/^[A-Za-z0-9._:-]{1,128}$/.test(input.id) || typeof input.text !== "string" || !input.text.trim() || Buffer.byteLength(input.text, "utf8") > 4096) {
        return { ok: false, reason: "invalid" };
      }
      const persisted = steers.find(item => item.id === input.id && item.runId === input.expectedRunId);
      if (persisted) return persisted.text === input.text
        ? { ok: true, steer: structuredClone(persisted) } : { ok: false, reason: "conflict" };
      if (closed || cancelRequested) return { ok: false, reason: "closed" };
      if (state.kind !== "running" || state.phase !== "primary" || state.background || state.runId === null || !activeHandle?.steer) return { ok: false, reason: "busy" };
      if (activeHandle.runId !== input.expectedRunId || state.runId !== input.expectedRunId) return { ok: false, reason: "stale" };
      const key = `${input.expectedRunId}:${input.id}`;
      const existing = steerRequests.get(key);
      if (existing) return existing.text === input.text ? existing.response : { ok: false, reason: "conflict" };
      const handle = activeHandle;
      const response = (async (): Promise<AssistantSteerResponse> => {
        try {
          const accepted = await handle.steer!({ id: input.id, text: input.text });
          if (accepted.status !== "accepted") return { ok: false, reason: accepted.reason ?? "closed" };
          const receipt = await app.executionRecords.getRun(app.threadId, handle.runId);
          const record = receipt?.steers?.find(item => item.id === input.id);
          if (!record) return { ok: false, reason: "failed", message: "Steering acknowledgement is uncertain; inspect this Run before retrying." };
          return { ok: true, steer: structuredClone(record) };
        } catch (error) {
          return { ok: false, reason: "failed", message: `Steering acknowledgement is uncertain: ${String(error)}` };
        }
      })();
      steerRequests.set(key, { text: input.text, response });
      return response;
    },
    cancel: async () => {
      cancelRequested = true;
      startupController?.abort(new DOMException("Run cancelled", "AbortError"));
      backgroundController?.abort(new DOMException("Consolidation cancelled", "AbortError"));
      operationController?.abort(new DOMException("Operation cancelled", "AbortError"));
      if (activeHandle !== undefined) await activeHandle.cancel("Cancelled from application");
    },
    confirm: (input) => app.toolConfirmation?.resolveApproval(input) ?? false,
    command: async (line) => {
      const { name, args } = commandParts(line);
      if (name.length === 0) return { ok: false, reason: "empty" };
      if (closed || state.kind !== "idle") return { ok: false, reason: "busy" };
      if (name === "skills" || name === "hooks") {
        if (args.trim()) return { ok: false, reason: "failed", message: `Usage: /${name}` };
        const diagnostics = automation.diagnostics();
        if (name === "skills") {
          controller.recordOutput(`\n[skills] ${diagnostics.skills.length ? diagnostics.skills.map(skill =>
            `${skill.id}: ${skill.description}\nhash=${skill.hash}; tools=${skill.tools.join(",") || "none"}`).join("\n") : "没有已登记的 Skill"}\n使用 /skill <id> [输入] 运行；这不会创建定时安排。\n`);
        } else {
          controller.recordOutput(`\n[hooks] ${diagnostics.hooks.length ? diagnostics.hooks.map(rule =>
            `${rule.id}: ${rule.event} → ${rule.handler.id} (${rule.enabled === false ? "disabled" : "enabled"})`).join("\n") : "当前配置未启用任何 Hook"}\n`);
          for (const item of diagnostics.recent.slice(0, 10)) controller.recordOutput(
            `${item.skillId}: ${item.status}${item.ruleId ? ` (${item.ruleId})` : " (manual)"}${item.runId ? ` Run ${item.runId}` : ""}${item.message ? `: ${item.message}` : ""}\n`);
        }
        return { ok: true };
      }
      if (name === "skill") {
        const text = args.trim();
        const boundary = text.search(/\s/);
        const id = boundary < 0 ? text : text.slice(0, boundary);
        const skill = automation.getSkill(id);
        if (!skill) return { ok: false, reason: "failed", message: "Usage: /skill <registered-id> [input]. Use /skills to list available Skills." };
        const input = boundary < 0 ? undefined : text.slice(boundary).trim();
        const started = await startManualSkill({ id, expectedHash: skill.hash, ...(input ? { input } : {}) });
        if (!started.ok) return { ok: false, reason: "failed", message: `${started.error.code}: ${started.error.message}` };
        await activeTask;
        const execution = automation.diagnostics().recent.find(item => item.runId === started.value.runId);
        return execution?.status === "completed" ? { ok: true } : execution?.status === "cancelled"
          ? { ok: false, reason: "cancelled" } : { ok: false, reason: "failed", message: execution?.message ?? "Skill did not complete" };
      }
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
      await backgroundTask;
      await approvalTracePending;
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
  void recovery.then(async () => {
    if (closed || state.kind !== "idle") return;
    try {
      await ensureRecovered();
      const matched = automation.select({ event: "thread.ready", threadId: app.threadId, agentId: app.agentId });
      // Old RuntimeApp embedders have no backlog callback; retain the existing read check.
      let requests = matched.filter(request => automation.getSkill(request.skillId)?.kind !== "memory-consolidate" ||
        (app.memoryStore !== undefined && app.memoryConsolidation !== undefined));
      if (requests.some(request => automation.getSkill(request.skillId)?.kind === "memory-consolidate")) {
        const backlog = app.getMemoryConsolidationBacklog
          ? await app.getMemoryConsolidationBacklog()
          : await (async () => {
            const cursor = await app.memoryStore!.getConsolidationCursor(app.threadId);
            if (!cursor.ok) return cursor;
            return memoryConsolidationBacklog(await app.store.getMessages(app.threadId), cursor.value);
          })();
        if (!backlog.ok) throw new Error(`${backlog.error.code}: ${backlog.error.message}`);
        if (backlog.value === 0) requests = requests.filter(request => automation.getSkill(request.skillId)?.kind !== "memory-consolidate");
      }
      startAutomaticSkills(requests);
      lifecycleReady = true;
      if (!requests.length) startIdleDreaming();
    } catch (error) { consolidationFailure = String(error); emit({ type: "error", message: String(error) }); }
  });
  return controller;
}
