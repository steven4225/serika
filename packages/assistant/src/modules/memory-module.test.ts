import { AgentError } from "@serika/core";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModuleHost } from "../module-host.js";
import { createMemoryStore } from "../memory-store.js";
import { createMemoryModule } from "./memory-module.js";
import { bindMemoryWrite, memoryWriteSchema, MemoryWriteValidationError } from "../memory-write.js";
import type { UIMessage } from "ai";

const message = (id: string, role: "user" | "assistant", text: string): UIMessage => ({ id, role, parts: [{ type: "text", text }] });
const identity = { subject: "user", attribute: "language", value: "中文" };
test("M5 normalizes the body while binding literal values, numbers, polarity and conditions", () => {
  const quote = "我家地址是上海市甲路18号", user = message("u", "user", quote);
  const write = memoryWriteSchema.parse({ operation: "add", text: "用户家庭地址：上海市甲路18号", sourceQuote: quote, category: "note",
    identity: { subject: "user", attribute: "home_address", value: "上海市甲路18号" } });
  assert.equal((bindMemoryWrite(write, { messages: [user], user, threadId: "t" }) as { text: string }).text, write.text);
  for (const changed of [
    { ...write, text: "用户家庭地址：上海市乙路18号" }, { ...write, text: "用户家庭地址：上海市甲路19号" },
    { ...write, identity: { ...write.identity!, value: "上海市乙路18号" } }, { ...write, text: write.text + "，楼层20层" },
  ]) assert.throws(() => bindMemoryWrite(changed, { messages: [user], user, threadId: "t" }), /关键值|数字/);
  const conditional = "我喝咖啡不加糖，低血糖时除外", current = message("c", "user", conditional);
  const input = { ...write, sourceQuote: conditional, identity: { subject: "user", attribute: "coffee", value: "不加糖" } };
  assert.doesNotThrow(() => bindMemoryWrite({ ...input, text: "用户喝咖啡不加糖，低血糖时除外" }, { messages: [current], user: current, threadId: "t" }));
  for (const text of ["用户喝咖啡加糖，低血糖时除外", "用户喝咖啡不加糖", "用户喝咖啡不加糖，任何时候都如此"]) {
    assert.throws(() => bindMemoryWrite({ ...input, text }, { messages: [current], user: current, threadId: "t" }), /关键值|否定|条件/);
  }
  assert.equal(memoryWriteSchema.safeParse({ ...write, identity: undefined }).success, false);
});
test("C04 binds the specific confirmation; short acknowledgement and external evidence fail", () => {
  const assistant = message("a", "assistant", "以后使用中文"), user = message("u", "user", "是的，以后使用中文");
  const input = memoryWriteSchema.parse({ operation: "add", text: "以后使用中文", category: "preference", sourceQuote: "是的，以后使用中文", identity,
    proposal: { messageId: "a", quote: "以后使用中文", valueQuote: "中文" } });
  const result = bindMemoryWrite(input, { messages: [assistant, user], user, threadId: "t" });
  assert.equal(result.source.kind, "conversation");
  if (result.source.kind === "conversation") { assert.equal(result.source.messageId, "u"); assert.equal(result.source.proposal?.quote, "以后使用中文"); }
  const direct = bindMemoryWrite({ ...input, proposal: undefined }, { messages: [assistant, user], user, threadId: "t" });
  assert.equal(direct.source.kind, "conversation");
  if (direct.source.kind === "conversation") { assert.equal(direct.source.quote, input.sourceQuote); assert.equal(direct.source.proposal, undefined); }
  const contradiction = "我喜欢甜咖啡，但我又不喜欢甜咖啡", contradictoryUser = message("c", "user", contradiction);
  const uncertainWrite = memoryWriteSchema.parse({ operation: "add", text: contradiction, category: "preference", uncertain: true, sourceQuote: contradiction, identity: { subject: "user", attribute: "coffee", value: contradiction } });
  const uncertainResult = bindMemoryWrite(uncertainWrite, { messages: [contradictoryUser], user: contradictoryUser, threadId: "t" });
  assert.ok("text" in uncertainResult); assert.equal(uncertainResult.text, contradiction); assert.equal(uncertainResult.uncertain, true);
  const rewritten = bindMemoryWrite({ ...uncertainWrite, text: `[不确定] ${contradiction}` }, { messages: [contradictoryUser], user: contradictoryUser, threadId: "t" });
  assert.ok("text" in rewritten); assert.equal(rewritten.text, contradiction); assert.equal(rewritten.uncertain, true);
  for (const text of ["嗯", "好", "好吧"]) {
    const short = message("u", "user", text);
    assert.throws(() => bindMemoryWrite({ ...input, sourceQuote: text }, { messages: [assistant, short], user: short, threadId: "t" }),
      (error: unknown) => error instanceof MemoryWriteValidationError && error.validationFailure.reasonCode === "SOURCE_VALUE_MISSING");
  }
  const tool: UIMessage = { ...assistant, parts: [{ type: "dynamic-tool", toolName: "web_fetch", toolCallId: "w", state: "output-available", input: {}, output: "以后使用中文" }] };
  assert.throws(() => bindMemoryWrite(input, { messages: [tool, user], user, threadId: "t" }), /确认必须相邻/);
  assert.throws(() => bindMemoryWrite({ ...input, proposal: undefined } as never, { messages: [assistant], user: assistant, threadId: "t" }), /普通用户消息/);
  assert.throws(() => bindMemoryWrite({ ...input, proposal: undefined, sourceQuote: "看网页" } as never, { messages: [message("u", "user", "看网页")], user: message("u", "user", "看网页"), threadId: "t" }), /关键值/);
});

test("ordinary memory module registers exactly one host-bound writer with primary-only approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm4-module-"));
  try {
    const user = message("u", "user", "记住：我喝咖啡不加糖"), store = createMemoryStore(root);
    const host = createModuleHost([createMemoryModule(store, async () => [], { threadId: "t", getCurrentUserMessage: () => user })], { notify() {} });
    assert.deepEqual(host.tools.map(tool => tool.metadata.name), ["memory_write"]);
    assert.deepEqual(host.toolPermissions.get("memory_write")?.defaults, { approvalAgents: ["calculator"], remember: "never" });
    const execute = host.tools[0]!.tool.execute! as unknown as (input: unknown, options: unknown) => Promise<{ ok: boolean }>;
    const result = await execute(memoryWriteSchema.parse({ operation: "add", text: "我喝咖啡不加糖", category: "preference", sourceQuote: "我喝咖啡不加糖", identity: { subject: "user", attribute: "coffee", value: "不加糖" } }), { toolCallId: "w", messages: [], abortSignal: new AbortController().signal });
    assert.equal(result.ok, true);
    const saved = await store.readV6!(); assert.ok(saved.ok); assert.equal(saved.value.entries[0]!.text, "我喝咖啡不加糖");
    host.dispose();
    const uncertain = createModuleHost([createMemoryModule({ ...store, writeV6: async () => ({ ok: false, error: { code: "MEMORY_COMMIT_UNCERTAIN", message: "unknown" } }) } as never, async () => [], { threadId: "t", getCurrentUserMessage: () => user })], { notify() {} });
    const unknownWrite = uncertain.tools[0]!.tool.execute! as unknown as typeof execute;
    await assert.rejects(unknownWrite(memoryWriteSchema.parse({ operation: "add", text: "我喝咖啡不加糖", category: "preference", sourceQuote: "我喝咖啡不加糖", identity: { subject: "user", attribute: "coffee", value: "不加糖" } }), { toolCallId: "unknown", messages: [] }), (error: unknown) => error instanceof AgentError && error.data.code === "TOOL_OUTCOME_UNKNOWN");
    uncertain.dispose();
    const notices: string[] = [];
    const full = createModuleHost([createMemoryModule({ writeV6: async () => ({ ok: false, error: { code: "MEMORY_LIMIT_EXCEEDED", message: "Memory 已满，未保存" } }) } as never, async () => [], { threadId: "t", getCurrentUserMessage: () => user })], { notify(_moduleId, text) { notices.push(text); } });
    const failedWrite = full.tools[0]!.tool.execute! as unknown as typeof execute;
    assert.equal((await failedWrite(memoryWriteSchema.parse({ operation: "add", text: "我喝咖啡不加糖", category: "preference", sourceQuote: "我喝咖啡不加糖", identity: { subject: "user", attribute: "coffee", value: "不加糖" } }), { toolCallId: "full", messages: [] })).ok, false);
    assert.match(notices[0]!, /记忆未保存.*已满/); full.dispose();
  } finally { await rm(root, { recursive: true, force: true }); }
});
