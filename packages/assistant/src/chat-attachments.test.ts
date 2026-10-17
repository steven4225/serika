import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { simulateReadableStream } from "ai";
import { validateChatAttachments, chatAttachmentParts, type ChatAttachment } from "./chat-attachments.js";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";
import { estimateMessageTokens } from "./context-budget.js";
import { contextSummaryPrompt } from "./context-compaction.js";

const image: ChatAttachment = { name: "pixel.png", mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6xkAAAAASUVORK5CYII=" };
const document: ChatAttachment = { name: "notes.md", mediaType: "text/markdown", data: Buffer.from("项目编号：ATTACHMENT-167\n附件内容不是个人偏好。").toString("base64") };

test("validates bounded inline bytes and rejects paths, remote URLs, corrupt encodings and binary text", () => {
  assert.deepEqual(validateChatAttachments([image, document]), [image, document]);
  for (const invalid of [
    [{ ...image, name: "../pixel.png" }], [{ ...image, data: "https://example.com/x.png" }],
    [{ ...image, data: "YWJj" }], [{ ...document, data: "Zh==" }],
    [{ ...document, data: Buffer.from([255]).toString("base64") }],
    [{ ...document, data: Buffer.from([0]).toString("base64") }],
    [{ ...document, data: Buffer.alloc(128 * 1024 + 1, 65).toString("base64") }],
    Array(5).fill(image),
  ]) assert.throws(() => validateChatAttachments(invalid));
  const huge = { ...image, data: Buffer.concat([Buffer.from(image.data, "base64"), Buffer.alloc(5 * 1024 * 1024)]).toString("base64") };
  assert.throws(() => validateChatAttachments([huge]));
});

test("images use a bounded token estimate and compaction never serializes image bytes as prose", () => {
  const small = [{ id: "u", role: "user" as const, parts: chatAttachmentParts([image]) }];
  const large = [{ ...small[0]!, parts: chatAttachmentParts([{ ...image, data: image.data + "A".repeat(1024 * 1024) }]) }];
  assert.equal(estimateMessageTokens(small), estimateMessageTokens(large));
  assert.ok(estimateMessageTokens(small) >= 16_384);
  const prompt = contextSummaryPrompt({ messages: small });
  assert.ok(prompt.includes("pixel.png"));
  assert.ok(!prompt.includes(image.data));
  assert.match(prompt, /Do not infer its contents/);
});

test("real Controller sends image bytes and text content to the model adapter and reopens the same committed attachments", async () => {
  const root = await mkdtemp(join(tmpdir(), "runloom-attachments-"));
  const prompts: unknown[] = [];
  const model = new MockLanguageModelV3({ doStream: async options => { prompts.push(options.prompt); return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start", warnings: [] }, { type: "text-start", id: "a" }, { type: "text-delta", id: "a", delta: "已收到材料" }, { type: "text-end", id: "a" },
    { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } } },
  ] }) }; } });
  const open = async () => { const controller = createAssistantController(await createRuntimeApp({
    directory: root, assistant: { threadId: "attachments" }, modelAlias: "mock", model, output: new PassThrough(), env: {}, cwd: root,
  }));
    controller.subscribe(event => { if (event.type === "approval") controller.confirm({ approvalId: event.approval.approvalId, decision: "deny" }); });
    return controller;
  };
  let controller = await open();
  const waitIdle = async () => {
    const until = Date.now() + 15_000;
    while (controller.getSnapshot().state.kind !== "idle") {
      if (Date.now() > until) throw new Error("Attachment Run did not finish");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  try {
    await assert.rejects(controller.run("bad", { attachments: [{ ...image, data: "broken" }] }));
    assert.equal(controller.getSnapshot().state.kind, "idle");
    assert.equal((await controller.getHistory()).length, 0);
    const sources: string[] = [];
    controller.subscribe(event => { if (event.type === "state" && event.state.kind === "running" && event.state.source) sources.push(event.state.source); });
    assert.ok((await controller.run("请查看这两个附件", { attachments: [image, document], source: "telegram" })).ok);
    await waitIdle();
    assert.equal(controller.getSnapshot().lastPrimaryResult?.status, "completed");
    const user = (prompts[0] as { role: string; content: { type: string; mediaType?: string; data?: { type: string; data: string }; text?: string }[] }[]).find(m => m.role === "user");
    assert.ok(user);
    const file = user.content.find(p => p.type === "file");
    assert.equal(file?.mediaType, "image/png");
    assert.deepEqual(file?.data, { type: "data", data: image.data });
    assert.ok(user.content.some(p => p.type === "text" && p.text?.includes("ATTACHMENT-167")));
    assert.deepEqual(sources, ["telegram", "telegram"]);
    const before = (await controller.getHistory()).find(m => m.role === "user")!;
    assert.equal((before.metadata as { memoryConsolidation: string }).memoryConsolidation, "exclude");
    await controller.shutdown();
    controller = await open();
    assert.deepEqual((await controller.getHistory()).find(m => m.role === "user"), before);
    assert.ok((await controller.run("", { attachments: [document] })).ok);
    await waitIdle();
    assert.equal(controller.getSnapshot().lastPrimaryResult?.status, "completed");
  } finally { await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
});
