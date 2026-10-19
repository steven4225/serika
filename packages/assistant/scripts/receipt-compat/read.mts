// Reads thread-1 receipts with the ExecutionRecordStore from <src> and prints one JSON line.
const [src, dir] = process.argv.slice(2);
const { ExecutionRecordStore } = await import(`${src}/packages/assistant/src/execution-record-store.ts`);
const store = new ExecutionRecordStore(dir);
const runs = await store.listRuns("thread-1");
const out: Record<string, unknown> = { runs: runs.length };
for (const id of ["run-1", "run-2"]) {
  const run = await store.getRun("thread-1", id);
  if (run) out[id] = run.tools.map((t: any) => ({ id: t.toolCallId, status: t.status, errorCode: t.errorCode ?? null }));
}
console.log(JSON.stringify(out));
