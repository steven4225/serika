import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { simulateReadableStream, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";
import { createMemoryStore } from "./memory-v7-store.js";
import { createMemoryExtraction } from "./memory-extraction.js";
import { expandMessageReferences } from "./context-assembler.js";
import { DEFAULT_CONTEXT_BUDGET_CONFIG } from "./context-budget.js";
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
const text = (message: UIMessage) => message.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");

test("real runtime scopes main references and memory_read across A/B/null and cold-restored fixed/update references", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-context-scope-")), configPath = join(root, "config.json"), dataDirectory = join(root, "data");
  await writeFile(configPath, JSON.stringify({ version: 2, authorizedDirectories: [], modules: { memory: { enabled: true, autoConsolidate: false } } }));
  const projects = ["A", "B"].map(id => ({ id, name: id, directory: join(root, id), kind: "folder" as const }));
  await Promise.all(projects.map(project => mkdir(project.directory)));
  const requests: Array<Parameters<MockLanguageModelV3["doStream"]>[0]> = [];
  const model = new MockLanguageModelV3({ doStream: async request => {
    requests.push(request); let index = request.prompt.length - 1; while (index >= 0 && request.prompt[index]?.role !== "user") index--; const current = request.prompt[index];
    const command = current?.role === "user" ? current.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n").split("\n")[0]! : "";
    let input: Record<string, unknown> | undefined, toolName = "memory_write";
    if (!request.prompt.slice(index + 1).some(message => message.role === "tool")) {
      if (command.startsWith("save ")) { const [, scope, value] = command.split(" "); input = { operation: "add", scope, text: value, category: scope === "user" ? "preference" : "note", sourceQuote: command, identity: { subject: "user", attribute: value, value } }; }
      if (command === "read") { toolName = "memory_read"; input = { query: "PROJECT_" }; }
    }
    return { stream: simulateReadableStream({ chunks: [{ type: "stream-start", warnings: [] }, ...(input ? [{ type: "tool-call" as const, toolCallId: String(requests.length), toolName, input: JSON.stringify(input) }] : [{ type: "text-start" as const, id: "a" }, { type: "text-delta" as const, id: "a", delta: "done" }, { type: "text-end" as const, id: "a" }]), { type: "finish", finishReason: { unified: input ? "tool-calls" : "stop", raw: undefined }, usage }] }) };
  } });
  const open = async (project: typeof projects[number] | null, threadId = "shared") => {
    const output = new PassThrough(); output.resume();
    const app = await createRuntimeApp({ directory: join(root, threadId), assistant: { dataDirectory, configPath, threadId }, project, modelAlias: "scope", model, output, env: {}, cwd: root });
    return { app, controller: createAssistantController(app) };
  };
  const run = async (controller: ReturnType<typeof createAssistantController>, command: string) => {
    const idle = new Promise<void>(resolve => { const stop = controller.subscribe(event => { if (event.type === "state" && event.state.kind === "idle") { stop(); resolve(); } }); });
    assert.ok((await controller.run(command)).ok); await idle; assert.equal(controller.getSnapshot().lastPrimaryResult?.status, "completed");
  };
  try {
    const seed = await open(projects[0]!, "seed"); await run(seed.controller, "save user SHARED_PREFERENCE"); await run(seed.controller, "save project PROJECT_FIXED"); assert.ok((await seed.controller.memory.changeLibrary({ operation: "save-document", expectedRevision: 0, id: randomUUID(), title: "PROJECT_DOCUMENT_TITLE", folderId: null, text: "PROJECT_DOCUMENT_BODY_ONLY", entries: [] })).ok); await seed.controller.shutdown();
    const a = await open(projects[0]!); await run(a.controller, "read"); await run(a.controller, "save project PROJECT_UPDATE"); await run(a.controller, "observe");
    const captured = JSON.stringify(await a.app.store.getMessages("shared")); assert.match(captured, /contextSnapshot/); assert.match(captured, /memory-updates/); await a.controller.shutdown();
    for (const project of [projects[1]!, null, projects[0]!]) {
      const current = await open(project), start = requests.length; await run(current.controller, "read");
      const host = requests[start]!.prompt.flatMap(message => typeof message.content === "string" ? [] : message.content.flatMap(part => part.type === "text" ? [part.text] : [])).flatMap(body => body.startsWith("Fixed Memory snapshot:") ? [body] : body.includes("Host context captured with this message:\n") ? [body.split("Host context captured with this message:\n")[1]!] : []).join("\n");
      const visible = project?.id === "A"; assert.equal(JSON.stringify(requests[start]!.prompt).includes("PROJECT_DOCUMENT_BODY_ONLY"), visible); assert.match(host, /SHARED_PREFERENCE/); for (const marker of ["PROJECT_FIXED", "PROJECT_UPDATE"]) assert.equal(host.includes(marker), visible);
      const reference = current.app.getMemoryReferences!(); assert.ok(reference); assert.ok(reference.selected.some(entry => entry.text === "SHARED_PREFERENCE")); assert.equal(reference.selected.some(entry => entry.text === "PROJECT_FIXED"), visible);
      const history = await current.app.store.getMessages("shared"), result = history.flatMap(message => message.parts).reverse().find(part => "toolName" in part && part.toolName === "memory_read" && "output" in part);
      assert.ok(result && "output" in result); assert.equal(JSON.stringify(result.output).includes("PROJECT_FIXED"), visible); assert.equal(JSON.stringify(result.output).includes("PROJECT_UPDATE"), visible);
      assert.ok(JSON.stringify(history).includes("PROJECT_DOCUMENT_BODY_ONLY"), "Stored transcript keeps the original tool result");
      const saved = await current.app.memoryStore!.readV7!(); assert.ok(saved.ok); assert.ok(saved.value.entries.find(entry => entry.text === "SHARED_PREFERENCE")!.sources.some(source => source.kind === "conversation" && source.threadId === "seed"));
      await current.controller.shutdown();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("extraction excludes a foreign-project source and rejects a proposal trying to bind its message ID", { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-extract-scope-")), store = createMemoryStore(join(root, "memory.json"), "A"); let calls = 0;
  const messages: UIMessage[] = ["A", "B"].map(id => ({ id, role: "user", metadata: { memoryProjectId: id }, parts: [{ type: "text", text: `${id}_EXTRACT_SOURCE` }] }));
  const model = new MockLanguageModelV3({ doGenerate: async request => {
    calls++; const prompt = JSON.stringify(request.prompt); assert.match(prompt, /A_EXTRACT_SOURCE/); assert.doesNotMatch(prompt, /B_EXTRACT_SOURCE/);
    return { content: [{ type: "text", text: JSON.stringify({ proposals: [{ operation: "add", scope: "project", text: "B_EXTRACT_SOURCE", category: "note", sourceMessageId: "B", sourceQuote: "B_EXTRACT_SOURCE", identity: { subject: "user", attribute: "project", value: "B_EXTRACT_SOURCE" } }], outcomes: [{ messageId: "A", status: "extracted" }] }) }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
  } });
  const extraction = createMemoryExtraction({ store, projectId: "A", threadId: "t", getMessages: async () => messages, model, budget: DEFAULT_CONTEXT_BUDGET_CONFIG, updated() {} });
  try {
    extraction.afterMask("A"); extraction.idle(); for (let i = 0; i < 20000 && extraction.diagnostics().running; i++) await new Promise<void>(resolve => setImmediate(resolve)); await extraction.pause();
    assert.equal(calls, 1); assert.equal(extraction.diagnostics().completed, 0); assert.equal(extraction.diagnostics().failed, 1); assert.match(extraction.diagnostics().error!, /抽取来源越界/);
    const saved = await store.readV7!(); assert.ok(saved.ok); assert.deepEqual(saved.value.entries, []); assert.equal(saved.value.progress[0]!.projectId, "A");
  } finally { await extraction.close(); await rm(root, { recursive: true, force: true }); }
});


test("unknown historical Memory tool output is omitted from project model views without mutating transcript", () => {
  const messages: UIMessage[] = [{ id: "old", role: "user", parts: [{ type: "text", text: "old source remains" }] }, { id: "tool", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "memory_read", toolCallId: "old-read", state: "output-available", input: { query: "old" }, output: { ok: true, entries: [{ text: "UNKNOWN_SCOPE_TOOL_BODY" }] } }] }];
  const before = structuredClone(messages);
  for (const project of ["A", null]) { const projected = JSON.stringify(expandMessageReferences(messages, project)); assert.doesNotMatch(projected, /UNKNOWN_SCOPE_TOOL_BODY/); assert.match(projected, /old source remains/); }
  assert.deepEqual(messages, before);
});
