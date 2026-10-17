import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeApp } from "@serika/assistant";
import { createAssistantController } from "@serika/assistant";
import { createDemoModel } from "@serika/assistant";
import { createMemoryConsolidation } from "@serika/assistant/testing";
import { AUTO_CONSOLIDATION_AGENT_ID } from "@serika/assistant/testing";
import { RuntimeBridge, TeeOutput } from "../../main/runtime-bridge.js";
import { annotateMemoryReceipts, rowsFromHistory } from "./conversation.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeConversation } from "./zcode/conversation.js";

test("real bridge history page renders committed host memory receipt; unreadable store clears it but preserves chat", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-factual-receipts-"));
  let bridge: RuntimeBridge | undefined;
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const config = join(root, "config.json");
    await writeFile(config, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true } } }));
    const output = new TeeOutput(() => {});
    const app = await createRuntimeApp({ args: ["--tui", join(root, "history"), "--thread", "receipts", "--config", config],
      model: createDemoModel(), modelAlias: "mock/default", output, cwd: root, env: {} });
    const controller = createAssistantController(app);
    output.attach(controller);
    bridge = new RuntimeBridge(app, controller, { modelAlias: "mock/default", temporaryThread: false, temporaryDirectory: false }, output, () => {});
    const text = "我喝咖啡不加糖。";
    const messages = [
      { id: "older", role: "user" as const, parts: [{ type: "text" as const, text: "你好" }] },
      { id: "user-source", role: "user" as const, parts: [{ type: "text" as const, text }] },
    ];
    await app.store.save("receipts", messages);
    const service = createMemoryConsolidation({ store: app.memoryStore!, threadId: "receipts", writePolicy: "automatic", getMessages: async () => messages });
    service.begin(AUTO_CONSOLIDATION_AGENT_ID);
    const prepared = await service.prepare({ mode: "incremental" }); assert.ok(prepared.ok);
    const staged = await service.stage({ batchId: prepared.value.batchId, proposals: [{ action: "add", kind: "preference", text,
      sourceMessageId: "user-source", sourceQuote: text, reason: "明确偏好", eligibility: "durable_self_statement",
      factIdentity: { attribute: "coffee", scenario: "general", value: "unsweetened" } }], outcomes: [
        { messageId: "older", status: "no_memory" },
        { messageId: "user-source", status: "extracted" },
      ] }); assert.ok(staged.ok);
    assert.ok((await service.finalize({ status: "completed" })).ok);
    const page = await bridge.historyPage();
    assert.equal(page.memoryReceipts?.length, 1);
    const rendered = renderToStaticMarkup(createElement(ZCodeConversation, { rows: annotateMemoryReceipts(rowsFromHistory(page.messages), page.memoryReceipts ?? [], page.threadId), running: false, streaming: "" }));
    assert.match(rendered, /当时已保存：我喝咖啡不加糖/);
    assert.match(rendered, /记忆回执（最近一批）/);
    const recent = await bridge.historyPage({ limit: 1 });
    const older = await bridge.historyPage({ beforeId: recent.beforeId!, limit: 1 });
    const recentRows = annotateMemoryReceipts(rowsFromHistory(recent.messages), recent.memoryReceipts ?? [], recent.threadId);
    const paginatedRows = annotateMemoryReceipts([...rowsFromHistory(older.messages), ...recentRows], older.memoryReceipts ?? [], older.threadId);
    const paginated = renderToStaticMarkup(createElement(ZCodeConversation, { rows: paginatedRows, running: false, streaming: "" }));
    assert.equal((paginated.match(/当时已保存/g) ?? []).length, 1, "loading older chat preserves the latest source-bound receipt exactly once");
    await writeFile(join(workspace, ".runloom/memory.json"), "{invalid");
    const failed = await bridge.historyPage();
    assert.deepEqual(failed.messages, messages, "receipt failure must not break history replay");
    assert.deepEqual(failed.memoryReceipts, []);
    assert.match(failed.memoryReceiptError ?? "", /暂时无法核实.*不能当作已经记住/);
  } finally { await bridge?.shutdown(); await rm(root, { recursive: true, force: true }); }
});
