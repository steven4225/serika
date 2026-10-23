import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeApp } from "@serika/assistant";
import { createAssistantController } from "@serika/assistant";
import { createDemoModel } from "@serika/assistant";
import { RuntimeBridge, TeeOutput } from "../../main/runtime-bridge.js";
import { annotateMemoryReceipts, rowsFromHistory, type ConversationRow } from "./conversation.js";

test("real bridge history page renders committed host memory receipt; unreadable store clears it but preserves chat", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-factual-receipts-"));
  let bridge: RuntimeBridge | undefined;
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const config = join(root, "config.json");
    await writeFile(config, JSON.stringify({ version: 1, authorizedDirectory: workspace, modules: { memory: { enabled: true } } }));
    const output = new TeeOutput(() => {});
    const app = await createRuntimeApp({ directory: join(root, "history"), assistant: { dataDirectory: join(workspace, ".runloom"), threadId: "receipts", configPath: config },
      model: createDemoModel(), modelAlias: "mock/default", output, cwd: root, env: {} });
    const controller = createAssistantController(app);
    output.attach(controller);
    bridge = new RuntimeBridge(app, controller, { modelAlias: "mock/default", temporaryThread: false, temporaryDirectory: false }, output, () => {});
    const text = "我喝咖啡不加糖。";
    const messages = [
      { id: "older", role: "user" as const, parts: [{ type: "text" as const, text: "你好" }] },
      { id: "user-source", role: "user" as const, parts: [{ type: "text" as const, text }] },
    ];
    assert.ok((await app.memoryStore!.writeV6!([{ operation: "add", text, category: "preference", scope: { kind: "workspace" },
      source: { kind: "conversation", threadId: "receipts", messageId: "user-source", quote: text, sentAt: null } }])).ok);
    const duringRun = await bridge.historyPage();
    assert.equal(duringRun.memoryReceiptError, undefined, "the source can still be uncommitted while v6 is already saved");
    assert.equal(duringRun.memoryReceipts?.[0]?.text, "已保存");
    await app.store.save("receipts", messages);
    const page = await bridge.historyPage();
    assert.equal(page.memoryReceipts?.length, 1);
    const receiptTexts = (rows: readonly ConversationRow[]) => rows.flatMap(row => row.kind === "text" ? (row.memoryReceipts ?? []).map(receipt => receipt.text) : []);
    assert.match(receiptTexts(annotateMemoryReceipts(rowsFromHistory(page.messages), page.memoryReceipts ?? [], page.threadId)).join("\n"), /^已保存$/);
    const recent = await bridge.historyPage({ limit: 1 });
    const older = await bridge.historyPage({ beforeId: recent.beforeId!, limit: 1 });
    const recentRows = annotateMemoryReceipts(rowsFromHistory(recent.messages), recent.memoryReceipts ?? [], recent.threadId);
    const paginatedRows = annotateMemoryReceipts([...rowsFromHistory(older.messages), ...recentRows], older.memoryReceipts ?? [], older.threadId);
    assert.equal(receiptTexts(paginatedRows).filter(text => /^已保存$/.test(text)).length, 1, "loading older chat preserves the latest source-bound receipt exactly once");
    await writeFile(join(workspace, ".runloom/memory.json"), "{invalid");
    const failed = await bridge.historyPage();
    assert.deepEqual(failed.messages, messages, "receipt failure must not break history replay");
    assert.deepEqual(failed.memoryReceipts, []);
    assert.match(failed.memoryReceiptError ?? "", /暂时无法核实.*不能当作已经记住/);
  } finally { await bridge?.shutdown(); await rm(root, { recursive: true, force: true }); }
});
