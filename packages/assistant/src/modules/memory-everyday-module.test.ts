import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asSchema } from "ai";
import type { RegisteredTool } from "@serika/ai-sdk-adapter";
import { createMemoryModule } from "./memory-module.js";
import { createMemoryStore } from "../memory-store.js";

test("memory tool output schemas preserve new versioned facts and reject invalid v2 values", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-everyday-module-"));
  try {
    const store = createMemoryStore(root);
    const seeded = await store.add({ text: "我的通知渠道是Telegram。", kind: "preference",
      factIdentity: { version: 2, subject: "user", attribute: "notification_channel", scenario: "general", value: "telegram" } });
    assert.ok(seeded.ok);
    const tools: RegisteredTool[] = [];
    createMemoryModule(store, async () => [], { threadId: "thread" }).setup({
      registerTool: registered => tools.push(registered), registerCommand: () => {}, notify: () => {},
    });
    const list = tools.find(registered => registered.metadata.name === "memory_list")!.tool;
    const output = await list.execute!({}, { toolCallId: "list", messages: [], context: {} });
    assert.equal(output.ok, true);
    assert.equal((await asSchema(list.outputSchema!).validate?.(output))?.success, true);
    const invalid = structuredClone(output); invalid.entries[0].assertion.factIdentity.value = "sms";
    assert.equal((await asSchema(list.outputSchema!).validate?.(invalid))?.success, false);
    assert.deepEqual(tools.map(registered => registered.metadata.name).filter(name => /notify|telegram|task_create/.test(name)), [], "preference storage grants no delivery tools");
  } finally { await rm(root, { recursive: true, force: true }); }
});
