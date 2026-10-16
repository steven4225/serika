import assert from "node:assert/strict";
import { it } from "node:test";
import type { UIMessage } from "ai";
import { createForegroundTaskReference, placeForegroundTaskReference } from "./foreground-autonomy.js";

const request: UIMessage = { id: "request", role: "user", parts: [{ type: "text", text: "查询 Pi 版本然后交付" }] };
const result: UIMessage = { id: "result", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "shell_exec",
  toolCallId: "version", state: "output-available", input: { command: "pi --version" },
  output: { ok: true, exitCode: 0, output: "0.87.0\n" } }] };
const summary: UIMessage = { id: "summary", role: "assistant", parts: [{ type: "text", text: "Old summary: Pi not yet probed." }] };

it("retains the current request before surviving current tool results, never as a fresh request after them", () => {
  const reference = createForegroundTaskReference(request, [request, result]);
  const prepared = placeForegroundTaskReference([...reference, summary, result]);
  const taskAt = prepared.findIndex(m => m.id === "runloom-foreground-task");
  assert.ok(taskAt >= 0 && taskAt < prepared.findIndex(m => m.id === "result"));
  assert.notEqual(prepared.at(-1)?.role, "user");
});

it("retains bounded host-observed current Run results when compaction consumes the original tool message", () => {
  const reference = createForegroundTaskReference(request, [request, result]);
  const prepared = placeForegroundTaskReference([...reference, summary]);
  const progress = prepared.find(m => m.id === "runloom-foreground-progress");
  assert.equal(progress?.role, "assistant");
  assert.match(JSON.stringify(progress?.parts), /0.87.0/);
  assert.match(JSON.stringify(progress?.parts), /version/);
  assert.ok(prepared.findIndex(m => m.id === "runloom-foreground-task") < prepared.indexOf(progress!));
});

it("does not duplicate a surviving request, leak previous Runs or lose same-Run corrections", () => {
  const old = { ...result, id: "old" };
  const correction: UIMessage = { id: "steer", role: "user", metadata: { source: "steer" },
    parts: [{ type: "text", text: "不要再探测，说明已有结果" }] };
  const refs = createForegroundTaskReference(request, [old, request, result, correction]);
  const prepared = placeForegroundTaskReference([...refs, request, result, correction]);
  assert.deepEqual(prepared, [request, result, correction]);
  const compacted = placeForegroundTaskReference([...refs, summary]);
  assert.match(JSON.stringify(compacted), /不要再探测/);
  assert.doesNotMatch(JSON.stringify(compacted.find(m => m.id === "runloom-foreground-progress")), /"messageId":"old"/);
});

it("bounds direct receipt previews and makes truncation and omitted evidence explicit", () => {
  const many = Array.from({ length: 20 }, (_, n): UIMessage => ({ ...result, id: `result-${n}`,
    parts: [{ type: "dynamic-tool", toolName: "shell_exec", toolCallId: `call-${n}`, state: "output-available",
      input: { command: "test" }, output: { ok: true, output: "长".repeat(50_000) } }] }));
  const refs = createForegroundTaskReference(request, [request, ...many]);
  const progress = refs.find(m => m.id === "runloom-foreground-progress")!;
  const text = progress.parts[0]; assert.ok(text?.type === "text");
  const receipts = JSON.parse(text.text.split("\n").at(-1)!);
  assert.equal(receipts.totalResults, 20);
  assert.ok(receipts.omittedResults > 0);
  assert.ok(receipts.recent.every((r: {result: {truncated:boolean}}) => r.result.truncated));
  assert.ok(Buffer.byteLength(JSON.stringify(receipts.recent), "utf8") <= 8192);
  assert.equal(receipts.recent.at(-1).toolCallId, "call-19");
});
