import assert from "node:assert/strict";
import { test } from "node:test";
import type { UIMessage } from "ai";
import { createReferenceAssembler, expandMessageReferences, preparePrimaryContext, type ReferenceSource } from "./context-assembler.js";
import { createMemorySnapshotMessage, memorySnapshot } from "./memory-snapshot.js";
import { createForegroundTaskReference } from "./foreground-autonomy.js";

const user = (id: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text: id }] });
const signal = new AbortController().signal;
const observer = { passthrough() {}, referencesFailed(error: unknown) { throw error; }, compactionFailed(error: unknown) { throw error; }, published() {} };

test("five-layer references persist only on new messages, remain stable after reopen and refresh at a boundary", async () => {
  let revision = 1, time = 0, includeExtra = false;
  const source: ReferenceSource = { name: "memory", slots: ["memory"], collect: () => {
    const memory = createMemorySnapshotMessage(memorySnapshot([{ id: "fact", text: `version-${revision}`, revision, enabled: true },
      ...(includeExtra ? [{ id: "extra", text: "added after snapshot", enabled: true }] : [])], { now: new Date(0) }), null);
    memory.parts.push({ type: "text", text: JSON.stringify({ documents: includeExtra ? ["new-document"] : [] }) });
    return { messages: { memory } };
  } };
  const sources: ReferenceSource[] = [source, { name: "clock", slots: ["task-time"], collect: () => ({ messages: {
    "task-time": { id: "clock", role: "assistant", parts: [{ type: "text", text: `time-${++time}` }] },
  } }) }];
  const old = user("legacy"), oldBytes = JSON.stringify(old), first = user("first");
  const assembler = createReferenceAssembler(sources);
  const prepare = (references: typeof assembler, messages: UIMessage[]) => preparePrimaryContext({ references, messages, signal, currentUserId: messages.at(-1)?.id, compactor: undefined, observer });
  const one = await prepare(assembler, [old, first]);
  const saved = assembler.annotate([old, first]);
  assert.equal(JSON.stringify(saved[0]), oldBytes);
  assert.equal(first.metadata, undefined);
  assert.match(JSON.stringify(one.at(-1)), /time-1/);
  assert.deepEqual(await prepare(assembler, [old, first]), one);
  revision = 2; includeExtra = true;
  const two = await prepare(assembler, [...saved, user("second")]);
  assert.deepEqual(two.slice(0, one.length), one);
  assert.match(JSON.stringify(two.at(-1)), /invalidated.*fact.*version-2/);
  const reopened = createReferenceAssembler(sources); reopened.restore(assembler.annotate([...saved, user("second")]));
  includeExtra = false;
  const three = await prepare(reopened, [...assembler.annotate([...saved, user("second")]), user("third")]);
  assert.deepEqual(three.slice(0, two.length), two);
  assert.match(JSON.stringify(three.at(-1)), /invalidated.*extra/, "reopening must invalidate a post-snapshot addition that was withdrawn");
  assert.match(JSON.stringify(three.at(-1)), /documentIndex.*documents.*\[\]/, "an index reverting to the original must supersede its previous update");
  const rollback = reopened.refresh();
  const refreshed = await prepare(reopened, [...assembler.annotate([...saved, user("second")]), user("boundary")]);
  assert.match(JSON.stringify(refreshed[0]), /version-2/);
  assert.doesNotMatch(JSON.stringify(refreshed), /added after snapshot/, "refresh folds old host updates into the new snapshot without repeating stale references");
  rollback();
  assert.deepEqual(await prepare(reopened, [...assembler.annotate([...saved, user("second")]), user("third")]), three);
  assert.equal(JSON.stringify(saved[0]), oldBytes);
});

test("foreground original is restored only after compaction, and complete old tool output is never clipped", async () => {
  const original = user("request");
  let active = true;
  const assembler = createReferenceAssembler([{ name: "foreground", slots: ["foreground-task"], collect: () => ({ messages: {
    "foreground-task": active ? createForegroundTaskReference(original, [original]) : undefined,
  } }) }]);
  const tool: UIMessage = { id: "tool", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "read_file", toolCallId: "call", state: "output-available", input: {}, output: "x".repeat(140_000) }] };
  const before = await preparePrimaryContext({ references: assembler, messages: [original, tool], signal, currentUserId: original.id, compactor: undefined, observer });
  assert.equal(before.length, 2); assert.deepEqual(before[1], tool);
  const after = await preparePrimaryContext({ references: assembler, messages: [original, tool], signal, currentUserId: original.id,
    compactor: { effectiveReferencePrefix: [], prepare: async () => [tool] }, observer });
  assert.equal(after.at(-1)?.id, "runloom-foreground-task");
  assert.match(JSON.stringify(after.at(-1)), /request/);
  active = false;
  const next = user("next-run");
  const later = await preparePrimaryContext({ references: assembler, messages: [...assembler.annotate([original, tool]), next], signal, currentUserId: next.id,
    compactor: { effectiveReferencePrefix: [], prepare: async () => [next] }, observer });
  assert.deepEqual(later, [next], "a compacted earlier Run must never revive its foreground request");
  assert.deepEqual(expandMessageReferences([original])[0], original);
});
