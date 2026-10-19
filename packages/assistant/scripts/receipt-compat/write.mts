// Writes run-1 (one TOOL_DENIED failure, one TOOL_EXECUTION_FAILED failure) with the store from <src>.
const [src, dir] = process.argv.slice(2);
const { ExecutionRecordStore } = await import(`${src}/packages/assistant/src/execution-record-store.ts`);
const store = new ExecutionRecordStore(dir);
const ev = (type: string, data: Record<string, unknown>) => ({ id: `${type}-${String(data.toolCallId)}`, type, runId: "run-1", threadId: "thread-1", sequence: 1, occurredAt: "2026-10-20T01:00:00.000Z", data });
await store.startRun({ runId: "run-1", threadId: "thread-1", phase: "primary" });
for (const [id, name, input] of [["deny", "write_file", { path: "a.md", content: "x" }], ["fail", "read_file", { path: "b.md" }]] as const) {
  await store.recordToolEvent("run-1", ev("tool.call.requested", { toolCallId: id, toolName: name, input }));
}
await store.recordToolEvent("run-1", ev("tool.call.failed", { toolCallId: "deny", toolName: "write_file", error: { code: "TOOL_DENIED", message: "Tool execution denied: write_file", phase: "tool", retryable: false } }));
await store.recordToolEvent("run-1", ev("tool.call.started", { toolCallId: "fail", toolName: "read_file" }));
await store.recordToolEvent("run-1", ev("tool.call.failed", { toolCallId: "fail", toolName: "read_file", error: { code: "TOOL_EXECUTION_FAILED", message: "boom", phase: "tool", retryable: false } }));
await store.finishRun("run-1", { runId: "run-1", threadId: "thread-1", status: "completed", text: "done", steps: 1, usage: {} });
