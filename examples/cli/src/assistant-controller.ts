import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import type { AgentEvent, RunHandle, RunResult } from "@aisdk-agent/core";
import { AUTO_CONSOLIDATION_SOURCE } from "./consolidation.js";
import type { RuntimeApp } from "./app.js";
import type { ShellProgress } from "./modules/shell-module.js";
import type { PendingToolApproval } from "./tui.js";

const MAX_RECENT_OUTPUT_CHARS = 16 * 1024;
const MAX_TOOL_ACTIVITY = 30;
const MAX_TOOL_SUMMARY_CHARS = 1_000;

export interface ToolActivity {
  toolCallId: string;
  toolName: string;
  status: "completed" | "failed";
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
  | { type: "output"; text: string }
  | { type: "error"; message: string };

export type StartRunResponse =
  | { ok: true; runId: string }
  | { ok: false; reason: "busy" | "empty" | "starting" };

export type ControllerCommandResponse =
  | { ok: true }
  | { ok: false; reason: "busy" | "unknown" | "empty" | "cancelled" }
  | { ok: false; reason: "failed"; message: string };

export interface AssistantController {
  getSnapshot(): AssistantSnapshot;
  getHistory(): Promise<UIMessage[]>;
  run(text: string): Promise<StartRunResponse>;
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

function commandParts(line: string): { name: string; args: string } {
  const trimmed = line.trim().replace(/^\//, "");
  const space = trimmed.search(/\s/);
  return space < 0
    ? { name: trimmed, args: "" }
    : { name: trimmed.slice(0, space), args: trimmed.slice(space + 1) };
}

export function createAssistantController(app: RuntimeApp): AssistantController {
  let state: AssistantState = { kind: "idle" };
  let activeHandle: RunHandle | undefined;
  let startupController: AbortController | undefined;
  let operationController: AbortController | undefined;
  let activeTask: Promise<void> | undefined;
  let closed = false;
  let disposed = false;
  let cancelRequested = false;
  let recentOutput = "";
  let outputTruncated = false;
  let lastPrimaryResult: RunResult | null = null;
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

  const executeRun = async (
    agentId: string,
    message: UIMessage,
    phase: "primary" | "consolidation",
    signal?: AbortSignal,
    started?: (handle: RunHandle) => void,
  ): Promise<{ result: RunResult; requestedMemoryTool: boolean }> => {
    app.toolConfirmation?.beginRun();
    try {
      const handle = await app.runtime.run({
        agentId,
        threadId: app.threadId,
        messages: [message],
        context: { agentId },
        ...(signal === undefined ? {} : { signal }),
      });
      activeHandle = handle;
      setState({ kind: "running", runId: handle.runId, phase });
      started?.(handle);
      if (cancelRequested) await handle.cancel("Cancelled before Run started");
      let requestedMemoryTool = false;
      const pump = (async () => {
        for await (const event of handle.events) {
          if (event.type === "tool.call.requested") {
            toolNames.set(event.data.toolCallId, event.data.toolName);
            if (event.data.toolName.startsWith("memory_")) requestedMemoryTool = true;
          }
          if (event.type === "tool.call.completed" || event.type === "tool.call.failed") {
            const raw = event.type === "tool.call.completed"
              ? JSON.stringify(event.data.output) ?? ""
              : event.data.error.message;
            const item: ToolActivity = {
              toolCallId: event.data.toolCallId,
              toolName: event.data.toolName ?? toolNames.get(event.data.toolCallId) ?? "unknown",
              status: event.type === "tool.call.completed" ? "completed" : "failed",
              summary: raw.slice(0, MAX_TOOL_SUMMARY_CHARS),
              truncated: raw.length > MAX_TOOL_SUMMARY_CHARS,
            };
            toolActivity.push(item);
            if (toolActivity.length > MAX_TOOL_ACTIVITY) toolActivity.shift();
          }
          emit({ type: "run-event", phase, event });
        }
      })();
      const result = await handle.result;
      await pump;
      if (result.text.length > MAX_RECENT_OUTPUT_CHARS) resultTextTruncated = true;
      const retainedResult = result.text.length > MAX_RECENT_OUTPUT_CHARS
        ? { ...result, text: result.text.slice(-MAX_RECENT_OUTPUT_CHARS) }
        : result;
      if (phase === "primary") lastPrimaryResult = retainedResult;
      else lastConsolidationResult = retainedResult;
      emit({ type: "run-result", phase, result });
      return { result, requestedMemoryTool };
    } finally {
      activeHandle = undefined;
      app.toolConfirmation?.endRun();
    }
  };

  const controller: AssistantController = {
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
    run: async (text) => {
      if (text.trim().length === 0) return { ok: false, reason: "empty" };
      if (closed || state.kind !== "idle") return { ok: false, reason: "busy" };

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
      };
      activeTask = (async () => {
        let startSettled = false;
        const settleStart = (response: StartRunResponse): void => {
          if (!startSettled) { startSettled = true; resolveStarted(response); }
        };
        app.resume?.beginRun();
        try {
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
            !cancelRequested && app.autoConsolidationAgentId !== undefined
          ) {
            controller.recordOutput("\n正在自动整理记忆...\n");
            const consolidationMessage: UIMessage = {
              id: randomUUID(), role: "user", metadata: { source: AUTO_CONSOLIDATION_SOURCE },
              parts: [{ type: "text", text: "请整理最近已提交的对话，先取材，再提出记忆建议；不要保存。" }],
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
      unsubscribeApproval?.();
      unsubscribeShellProgress?.();
      app.resume?.clear();
      app.dispose();
      disposed = true;
    },
  };
  return controller;
}
