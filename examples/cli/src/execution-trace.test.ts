import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@aisdk-agent/core";
import { createExecutionRecordStore, EXECUTION_RECORD_FILE } from "./execution-record-store.js";
import { compactTraceEvent, TRACE_MAX_EVENTS, validTrace } from "./execution-trace.js";
import { createExecutionRecordAdapter } from "./execution-record-adapter.js";
import { InMemoryAgentStore } from "@aisdk-agent/core";

const at = "2026-10-08T01:00:00.000Z";
const event = (type: string, data: unknown, sequence = 1): AgentEvent => ({ id: `event-${sequence}`, type,
  runId: "run", threadId: "thread", occurredAt: at, sequence, data }) as AgentEvent;
async function fixture(test: (store: ReturnType<typeof createExecutionRecordStore>, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "runloom-trace-"));
  try {
    const store = createExecutionRecordStore(directory);
    await store.startRun({ runId: "run", threadId: "thread", phase: "primary", startedAt: at });
    await test(store, directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
it("persists bounded model/approval metadata across restart without raw payloads", async () => fixture(async (store, dir) => {
  await store.recordTraceEvent(event("step.started", { stepNumber: 1 }));
  await store.recordTraceEvent(event("model.retry.scheduled", { stepNumber: 1, nextAttempt: 2, maxAttempts: 3, delayMs: 250,
    error: { code: "MODEL_TIMEOUT", message: "secret" } }, 2));
  await store.recordTraceEvent(event("step.completed", { stepNumber: 1, finishReason: "tool-calls", usage: { inputTokens: 12 } }, 3));
  await store.recordTraceEvent(event("tool.call.approval_required", { toolCallId: "call", toolName: "write_file", approvalId: "approval", input: { content: "secret" } }, 4));
  await store.recordTraceEvent(event("message.delta", { text: "secret reasoning" }, 5));
  await store.finishRun("run", { runId: "run", threadId: "thread", status: "completed", text: "done", steps: 1, usage: { inputTokens: 12 } });
  const run = await createExecutionRecordStore(dir).getRun("thread", "run");
  assert.equal(run?.trace?.events.length, 4);
  assert.deepEqual(run?.trace?.usage, { inputTokens: 12 });
  assert.equal(JSON.stringify(run?.trace).includes("secret"), false);
  assert.equal(await store.getRun("foreign", "run"), null);
}));
it("truncates display metadata without blocking or changing tool receipts", async () => fixture(async (store, dir) => {
  for (let i = 1; i <= TRACE_MAX_EVENTS + 1; i++) await store.recordTraceEvent(event("step.started", { stepNumber: i }, i));
  await store.recordToolEvent("run", event("tool.call.requested", { toolCallId: "call", toolName: "write_file", input: {} }, 150) as Extract<AgentEvent, { type: "tool.call.requested" }>);
  await store.recordToolEvent("run", event("tool.call.started", { toolCallId: "call", toolName: "write_file" }, 151) as Extract<AgentEvent, { type: "tool.call.started" }>);
  await store.recoverInterrupted("thread");
  const run = await createExecutionRecordStore(dir).getRun("thread", "run");
  assert.equal(run?.trace?.events.length, TRACE_MAX_EVENTS);
  assert.equal(run?.trace?.truncated, true);
  assert.equal(run?.tools[0]?.status, "unknown");
}));
it("optional trace failures leave a visible gap on next successful write, never weaken dispatch barrier", async () => fixture(async (store, dir) => {
  const file = join(dir, EXECUTION_RECORD_FILE);
  const saved = await readFile(file, "utf8");
  await writeFile(file, "{broken");
  await store.recordTraceEvent(event("step.started", { stepNumber: 1 }));
  await assert.rejects(store.recordToolEvent("run", event("tool.call.requested", { toolCallId: "call", toolName: "write_file", input: {} }) as Extract<AgentEvent, { type: "tool.call.requested" }>));
  await writeFile(file, saved);
  await store.finishRun("run", { runId: "run", threadId: "thread", status: "failed", text: "", steps: 0, usage: {} });
  assert.equal((await store.getRun("thread", "run"))?.trace?.incomplete, true);
}));
it("old receipts remain readable and malformed traces fail closed", async () => fixture(async (store, dir) => {
  const file = join(dir, EXECUTION_RECORD_FILE);
  const doc = JSON.parse(await readFile(file, "utf8"));
  delete doc.runs[0].trace;
  await writeFile(file, JSON.stringify(doc));
  assert.equal((await store.getRun("thread", "run"))?.trace, undefined);
  doc.runs[0].trace = { version: 1, events: [], truncated: false, incomplete: false, usage: { totalTokens: -1 } };
  await writeFile(file, JSON.stringify(doc));
  await assert.rejects(store.getRun("thread", "run"), /trace is invalid/);
}));
it("rejects unknown trace fields and does not extract text/tool output", () => {
  assert.equal(compactTraceEvent(event("tool.call.completed", { output: "secret" })), null);
  assert.equal(validTrace({ version: 1, events: [{ ...compactTraceEvent(event("step.started", { stepNumber: 1 })), prompt: "secret" }], truncated: false, incomplete: false }), false);
});
it("the adapter persists steps/confirmation before emitting them to the controller stream", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runloom-trace-adapter-"));
  try {
    const records = createExecutionRecordStore(dir);
    const adapter = createExecutionRecordAdapter(new InMemoryAgentStore(), records);
    adapter.enable();
    await adapter.store.create({ id: "run", threadId: "thread", agentId: "test", agentVersion: "1", version: 0, status: "created", createdAt: at, updatedAt: at });
    await adapter.store.append(event("step.started", { stepNumber: 1 }));
    assert.equal((await records.getRun("thread", "run"))?.trace?.events[0]?.type, "step.started");
    assert.equal((await adapter.store.list("run"))[0]?.type, "step.started");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
it("records actual pending approval once, scoped to the active Thread; automatic calls get no fabricated wait", async () => fixture(async (store, dir) => {
  await store.recordToolEvent("run", event("tool.call.requested", { toolCallId: "call", toolName: "read_file", input: {} }) as Extract<AgentEvent, { type: "tool.call.requested" }>);
  await store.recordApprovalRequested("foreign", "call", "read_file");
  assert.equal((await store.getRun("thread", "run"))?.tools[0]?.approvalRequestedAt, undefined);
  await store.recordApprovalRequested("thread", "call", "read_file");
  const first = (await store.getRun("thread", "run"))?.tools[0]?.approvalRequestedAt;
  assert.ok(first);
  await store.recordApprovalRequested("thread", "call", "read_file");
  assert.equal((await createExecutionRecordStore(dir).getRun("thread", "run"))?.tools[0]?.approvalRequestedAt, first);
}));
