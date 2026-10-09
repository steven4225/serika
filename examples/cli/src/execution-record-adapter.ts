import type { AgentEvent, AgentStore, RunRecord } from "@aisdk-agent/core";
import { AUTO_CONSOLIDATION_AGENT_ID } from "./consolidation.js";
import type { ExecutionRecordStore, ExecutionPhase } from "./execution-record-store.js";
import type { WorkTaskStore } from "./work-task-store.js";

/**
 * The controller opts in before its first Run. The TUI and print CLI continue
 * to use the same runtime without creating incomplete audit records.
 *
 * Persisting tool events here, rather than from the controller's async event
 * stream, makes `tool.call.started` a barrier before tool execution.
 */
export function createExecutionRecordAdapter(
  store: AgentStore,
  records: ExecutionRecordStore,
  workTasks?: WorkTaskStore,
  phaseForAgent?: (agentId: string) => ExecutionPhase,
): {
  store: AgentStore;
  enable: () => void;
  bindNextWorkTask: (input: { id: string; expectedRevision: number }) => () => void;
} {
  let enabled = false;
  let nextWorkTask: { id: string; expectedRevision: number } | undefined;
  const audited: AgentStore = {
    async create(record: RunRecord) {
      if (!enabled) return store.create(record);
      const binding = nextWorkTask;
      nextWorkTask = undefined;
      let begunRevision: number | undefined;
      if (binding !== undefined) {
        if (workTasks === undefined) throw new Error("WorkTask store is unavailable");
        const begun = await workTasks.beginRun(binding.id, {
          expectedRevision: binding.expectedRevision,
          runId: record.id,
        });
        if (!begun.ok) throw new Error(`${begun.error.code}: ${begun.error.message}`);
        begunRevision = begun.value.revision;
      }
      try {
        await records.startRun({
          runId: record.id,
          threadId: record.threadId,
          ...(binding === undefined ? {} : { workTaskId: binding.id }),
          phase: phaseForAgent?.(record.agentId) ?? (record.agentId === AUTO_CONSOLIDATION_AGENT_ID ? "consolidation" : "primary"),
          startedAt: record.createdAt,
        });
        await store.create(record);
      } catch (error) {
        // A failed Core create did not start a Run. Keep that fact visible.
        try { await records.failStart(record.id, error); } catch { /* Original failure wins. */ }
        if (binding !== undefined && begunRevision !== undefined && workTasks !== undefined) {
          try { await workTasks.markNeedsReview(binding.id, begunRevision); } catch { /* Original failure wins. */ }
        }
        throw error;
      }
    },
    getRun: (runId) => store.getRun(runId),
    transition: (runId, version, status, result) => store.transition(runId, version, status, result),
    save: (threadId, messages) => store.save(threadId, messages),
    getMessages: (threadId) => store.getMessages(threadId),
    async append(event: AgentEvent) {
      if (enabled && (
        event.type === "tool.call.requested" || event.type === "tool.call.started" ||
        event.type === "tool.call.completed" || event.type === "tool.call.failed" || event.type === "tool.call.superseded"
      )) {
        await records.recordToolEvent(event.runId, event);
      }
      if (enabled && (event.type === "run.steer.accepted" || event.type === "run.steer.applied" || event.type === "run.steer.not_applied")) {
        await records.recordSteerEvent(event);
      }
      if (enabled) await records.recordTraceEvent(event);
      await store.append(event);
    },
    list: (runId, afterSequence) => store.list(runId, afterSequence),
  };
  return {
    store: audited,
    enable: () => { enabled = true; },
    bindNextWorkTask: (input) => {
      if (!input.id || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
        throw new Error("A valid WorkTask binding is required");
      }
      if (nextWorkTask !== undefined) throw new Error("A WorkTask is already bound to the next Run");
      nextWorkTask = input;
      return () => {
        if (nextWorkTask === input) nextWorkTask = undefined;
      };
    },
  };
}
