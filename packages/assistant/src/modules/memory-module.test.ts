import { AgentError } from "@serika/core";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModuleHost } from "../module-host.js";
import { createMemoryStore } from "../memory-store.js";
import { createMemoryModule } from "./memory-module.js";
import { bindMemoryWrite, memoryWriteSchema } from "../memory-write.js";
import type { UIMessage } from "ai";

const message = (id: string, role: "user" | "assistant", text: string): UIMessage => ({ id, role, parts: [{ type: "text", text }] });
const identity = { subject: "user", attribute: "language", value: "中文" };
test("C04 binds the specific confirmation; short acknowledgement and external evidence fail", () => {
  const assistant = message("a", "assistant", "以后使用中文"), user = message("u", "user", "是的，以后使用中文");
  const input = memoryWriteSchema.parse({ operation: "add", text: "以后使用中文", category: "preference", sourceQuote: "是的，以后使用中文", identity,
    proposal: { messageId: "a", quote: "以后使用中文", valueQuote: "中文" } });
  const result = bindMemoryWrite(input, { messages: [assistant, user], user, threadId: "t" });
  assert.equal(result.source.kind, "conversation");
  if (result.source.kind === "conversation") { assert.equal(result.source.messageId, "u"); assert.equal(result.source.proposal?.quote, "以后使用中文"); }
  for (const text of ["嗯", "好吧"]) {
    const short = message("u", "user", text);
    assert.throws(() => bindMemoryWrite({ ...input, sourceQuote: text }, { messages: [assistant, short], user: short, threadId: "t" }), /具体值/);
  }
  const tool: UIMessage = { ...assistant, parts: [{ type: "dynamic-tool", toolName: "web_fetch", toolCallId: "w", state: "output-available", input: {}, output: "以后使用中文" }] };
  assert.throws(() => bindMemoryWrite(input, { messages: [tool, user], user, threadId: "t" }), /确认必须相邻/);
  assert.throws(() => bindMemoryWrite({ ...input, proposal: undefined } as never, { messages: [assistant], user: assistant, threadId: "t" }), /普通用户消息/);
  assert.throws(() => bindMemoryWrite({ ...input, proposal: undefined, sourceQuote: "看网页" } as never, { messages: [message("u", "user", "看网页")], user: message("u", "user", "看网页"), threadId: "t" }), /证据中的原话/);
});

test("ordinary memory module registers exactly one host-bound writer with primary-only approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm4-module-"));
  try {
    const user = message("u", "user", "记住：我喝咖啡不加糖"), store = createMemoryStore(root);
    const host = createModuleHost([createMemoryModule(store, async () => [], { threadId: "t", getCurrentUserMessage: () => user })], { notify() {} });
    assert.deepEqual(host.tools.map(tool => tool.metadata.name), ["memory_write"]);
    assert.deepEqual(host.toolPermissions.get("memory_write")?.defaults, { approvalAgents: ["calculator"], remember: "never" });
    const execute = host.tools[0]!.tool.execute! as unknown as (input: unknown, options: unknown) => Promise<{ ok: boolean }>;
    const result = await execute(memoryWriteSchema.parse({ operation: "add", text: "我喝咖啡不加糖", category: "preference", sourceQuote: "我喝咖啡不加糖" }), { toolCallId: "w", messages: [], abortSignal: new AbortController().signal });
    assert.equal(result.ok, true);
    const saved = await store.readV6!(); assert.ok(saved.ok); assert.equal(saved.value.entries[0]!.text, "我喝咖啡不加糖");
    host.dispose();
    const uncertain = createModuleHost([createMemoryModule({ ...store, writeV6: async () => ({ ok: false, error: { code: "MEMORY_COMMIT_UNCERTAIN", message: "unknown" } }) } as never, async () => [], { threadId: "t", getCurrentUserMessage: () => user })], { notify() {} });
    const unknownWrite = uncertain.tools[0]!.tool.execute! as unknown as typeof execute;
    await assert.rejects(unknownWrite(memoryWriteSchema.parse({ operation: "add", text: "我喝咖啡不加糖", category: "preference", sourceQuote: "我喝咖啡不加糖" }), { toolCallId: "unknown", messages: [] }), (error: unknown) => error instanceof AgentError && error.data.code === "TOOL_OUTCOME_UNKNOWN");
    uncertain.dispose();
    const notices: string[] = [];
    const full = createModuleHost([createMemoryModule({ writeV6: async () => ({ ok: false, error: { code: "MEMORY_LIMIT_EXCEEDED", message: "Memory 已满，未保存" } }) } as never, async () => [], { threadId: "t", getCurrentUserMessage: () => user })], { notify(_moduleId, text) { notices.push(text); } });
    const failedWrite = full.tools[0]!.tool.execute! as unknown as typeof execute;
    assert.equal((await failedWrite(memoryWriteSchema.parse({ operation: "add", text: "我喝咖啡不加糖", category: "preference", sourceQuote: "我喝咖啡不加糖" }), { toolCallId: "full", messages: [] })).ok, false);
    assert.match(notices[0]!, /记忆未保存.*已满/); full.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});
