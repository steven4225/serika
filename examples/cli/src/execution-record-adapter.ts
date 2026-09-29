import type { AgentEvent, AgentStore, RunRecord } from "@aisdk-agent/core";
import { AUTO_CONSOLIDATION_AGENT_ID } from "./consolidation.js";
import type { ExecutionRecordStore } from "./execution-record-store.js";

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
): { store: AgentStore; enable: () => void } {
  let enabled = false;
  const audited: AgentStore = {
    async create(record: RunRecord) {
      if (!enabled) return store.create(record);
      await records.startRun({
        runId: record.id,
        threadId: record.threadId,
        phase: record.agentId === AUTO_CONSOLIDATION_AGENT_ID ? "consolidation" : "primary",
        startedAt: record.createdAt,
      });
      try {
        await store.create(record);
      } catch (error) {
        // A failed Core create did not start a Run. Keep that fact visible.
        try { await records.failStart(record.id, error); } catch { /* Original failure wins. */ }
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
        event.type === "tool.call.completed" || event.type === "tool.call.failed"
      )) {
        await records.recordToolEvent(event.runId, event);
      }
      await store.append(event);
    },
    list: (runId, afterSequence) => store.list(runId, afterSequence),
  };
  return { store: audited, enable: () => { enabled = true; } };
}
