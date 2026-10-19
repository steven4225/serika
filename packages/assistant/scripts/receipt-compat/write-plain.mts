// Writes run-2 (no tools) with the store from <src>; used to append with the old code.
const [src, dir] = process.argv.slice(2);
const { ExecutionRecordStore } = await import(`${src}/packages/assistant/src/execution-record-store.ts`);
const store = new ExecutionRecordStore(dir);
await store.startRun({ runId: "run-2", threadId: "thread-1", phase: "primary" });
await store.finishRun("run-2", { runId: "run-2", threadId: "thread-1", status: "completed", text: "ok", steps: 1, usage: {} });

