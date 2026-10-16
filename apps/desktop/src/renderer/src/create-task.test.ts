import assert from "node:assert/strict";
import { it } from "node:test";
import { createAndStartTask } from "./create-task.js";
import type { RendererApi } from "../../shared/ui-contract.js";
import type { WorkTask } from "../../shared/work-tasks.js";
const scope = { workspaceRoot: "/workspace", directory: "/transcripts", threadId: "thread" };
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, values };
}
const task = { id: "task", revision: 1, threadId: "thread" } as WorkTask;
it("first submit creates a real task with human acceptance, binds its composer before starting and does not use ordinary run", async () => {
  const order: string[] = [], saved = storage();
  const api: Parameters<typeof createAndStartTask>[0] = {
    createWorkTask: async input => { order.push("create"); assert.equal(input.goal, "deliver report"); assert.ok(input.operationId); assert.equal(input.acceptance[0]?.method, "human"); return { ok: true, value: task }; },
    saveTaskDraft: async (identity, update) => { assert.deepEqual(identity, scope); assert.deepEqual(update, { kind: "created", taskId: "task", expectedGoal: "deliver report" }); order.push("bind"); },
    runWorkTask: async input => { assert.deepEqual(input, { id: "task", expectedRevision: 1 }); order.push("start"); return { ok: true, runId: "run" }; },
  };
  assert.deepEqual(await createAndStartTask(api, saved, scope, "deliver report", () => order.push("attached")), { kind: "started" });
  assert.deepEqual(order, ["create", "bind", "attached", "start"]); assert.equal(saved.values.size, 0);
});
it("binding failure retains operation id and never starts; explicit recovery uses the same creation id", async () => {
  const saved = storage(); const ids: string[] = []; let failBinding = true, starts = 0;
  const api: Parameters<typeof createAndStartTask>[0] = {
    createWorkTask: async input => { ids.push(input.operationId!); return { ok: true, value: task }; },
    saveTaskDraft: async () => { if (failBinding) throw new Error("draft failure"); },
    runWorkTask: async () => { starts++; return { ok: false, reason: "busy" }; },
  };
  await assert.rejects(createAndStartTask(api, saved, scope, "goal", () => {}), /draft failure/); assert.equal(starts, 0);
  failBinding = false;
  assert.deepEqual(await createAndStartTask(api, saved, scope, "goal", () => {}), { kind: "saved" });
  assert.equal(ids[0], ids[1]); assert.equal(starts, 1);
});
it("unknown start reports a saved task and does not retry or resubmit creation", async () => {
  let starts = 0, creates = 0;
  const api: Pick<RendererApi, "createWorkTask" | "saveTaskDraft" | "runWorkTask"> = {
    createWorkTask: async () => { creates++; return { ok: true, value: task }; }, saveTaskDraft: async () => {},
    runWorkTask: async () => { starts++; throw new Error("response lost"); },
  };
  assert.deepEqual(await createAndStartTask(api, storage(), scope, "goal", () => {}), { kind: "start_unknown" });
  assert.equal(starts, 1); assert.equal(creates, 1);
});
