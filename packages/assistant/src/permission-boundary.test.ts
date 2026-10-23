import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { InMemoryAgentStore } from "@serika/core";
import { createRuntimeApp } from "./app.js";
import { createAssistantController, type AssistantEvent } from "./assistant-controller.js";
import { resolveTuiModuleConfig } from "./tui-module-config.js";
import { createTaskWorkerAgent } from "./task-worker-entry.js";
import { readFileFromWorkspace } from "./read-file.js";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined } };
const request = "我喜欢乌龙茶";
const calls = [
  ["capability_status", {}], ["memory_read", { query: "乌龙茶" }],
  ["memory_write", { operation: "add", text: request, category: "preference", sourceQuote: request,
    identity: { subject: "用户", attribute: "茶", value: "乌龙茶" } }],
  ["task_list", {}], ["read_file", { path: "note.txt" }],
  ["write_file", { path: "created.txt", content: "allowed" }], ["shell_exec", { command: "pwd", cwd: "." }],
] as const;

it("b0 locks full host decisions, current Memory, configuration and filesystem boundaries", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-permission-boundary-")));
  const workspace = join(root, "directory"); await mkdir(workspace);
  await writeFile(join(workspace, "note.txt"), "fixture");
  await symlink(join(root, "outside"), join(workspace, "link"));
  const rows: Record<string, unknown> = {};
  try {
    for (const mode of ["plain", "desktop", "telegram-desktop-only", "telegram", "foreign-grant", "other-thread", "tui"] as const) {
      const configPath = join(root, `${mode}.json`), threadId = mode === "other-thread" ? "other" : "thread";
      await writeFile(configPath, JSON.stringify({ version: 1, authorizedDirectory: workspace,
        desktopAutonomy: { authorizedDirectory: mode === "foreign-grant" ? join(root, "foreign") : workspace },
        ...(mode === "telegram" || mode === "other-thread" ? { telegramAutonomy: { authorizedDirectory: workspace, botId: 1, userId: 2, chatId: 3, threadId: "thread" } } : {}),
        modules: { memory: { enabled: true }, task: { enabled: true }, "read-file": { enabled: true }, shell: { enabled: true } } }));
      let selected: typeof calls[number] = calls[0], step = 0;
      const model = new MockLanguageModelV3({ doStream: async options => {
        rows[`${mode}/tools`] = options.tools?.map(tool => tool.name).sort() ?? [];
        return { stream: simulateReadableStream({ chunks: [
          { type: "stream-start" as const, warnings: [] },
          ...(step++ === 0 ? [{ type: "tool-call" as const, toolCallId: "call", toolName: selected[0], input: JSON.stringify(selected[1]) }] : []),
          { type: "finish" as const, finishReason: { unified: step === 1 ? "tool-calls" as const : "stop" as const, raw: undefined }, usage },
        ] }) };
      } });
      const app = await createRuntimeApp({ directory: join(root, mode, "transcripts"),
        assistant: { dataDirectory: join(root, mode, "data"), threadId, configPath }, modelAlias: "scripted", model,
        output: new PassThrough(), env: {}, cwd: root, ...(mode !== "tui" && mode !== "plain" ? { desktopAutonomyHost: { home: join(root, mode) } } : {}), ...(mode !== "tui" ? { allowDirectoryTaskReads: true } : {}),
        authorizeTelegramAutonomy: grant => grant.botId === 1 && grant.userId === 2 && grant.chatId === 3 });
      const controller = createAssistantController(app);
      const approvals: { tool: string; preview: string; remember: string | null }[] = [];
      const toolEvents: Extract<AssistantEvent, { type: "run-event" }>[] = [];
      const unsubscribe = controller.subscribe(event => {
        if (event.type === "run-event" && ["tool.call.completed", "tool.call.failed"].includes(event.event.type)) toolEvents.push(event);
        if (event.type === "approval" && event.approval.preview) {
          const pending = event.approval;
          approvals.push({ tool: pending.toolName, preview: pending.preview, remember: pending.remember?.label ?? null });
          controller.confirm({ approvalId: pending.approvalId, decision: "deny" });
        }
      });
      rows[`${mode}/commands`] = [...(app.commands?.keys() ?? [])].sort();
      try {
        for (selected of calls) {
          step = 0; approvals.length = 0; toolEvents.length = 0;
          const source = mode.startsWith("telegram") || mode === "other-thread" ? "telegram" : mode === "tui" ? undefined : "desktop";
          const done = new Promise<void>(resolve => {
            const remove = controller.subscribe(event => { if (event.type === "state" && event.state.kind === "idle") { remove(); resolve(); } });
          });
          const started = await controller.run(request, source === "telegram" ? { source } : source === "desktop" ? { desktopEntry: true } : {});
          assert.ok(started.ok);
          await done;
          rows[`${mode}/${selected[0]}`] = { approvals: [...approvals], status: controller.getSnapshot().lastPrimaryResult?.status,
            events: toolEvents.map(({ event: { type, data } }) => ({ type, ok: "output" in data && typeof data.output === "object" && data.output !== null && "ok" in data.output ? data.output.ok : null,
              code: "error" in data && typeof data.error === "object" && data.error !== null && "code" in data.error ? data.error.code : null })) };
          if (selected[0] === "memory_write") {
            const memory = await app.memoryStore!.readV6!(); assert.ok(memory.ok);
            rows[`${mode}/saved-memory`] = memory.value.entries.map(entry => ({ text: entry.text, category: entry.category }));
          }
          if (selected[0] === "write_file") await rm(join(workspace, "created.txt"), { force: true });
        }
      } finally { unsubscribe(); await controller.shutdown(); app.dispose(); }
    }
    for (const [name, path] of [["valid", "note.txt"], ["absolute", join(root, "outside")], ["traversal", "../outside"], ["symlink", "link/private"]]) {
      const result = await readFileFromWorkspace(workspace, path!, new AbortController().signal);
      rows[`path/${name}`] = result.ok ? "ok" : result.error.code;
    }
    for (const inside of [false, true]) for (const policy of ["implicit", "files", "autonomy", "docker"] as const) {
      const directory = inside ? workspace : root, configPath = join(directory, `policy-${policy}.json`);
      await writeFile(configPath, JSON.stringify({ version: 1, authorizedDirectory: inside ? "." : "./directory",
        ...(policy === "autonomy" ? { desktopAutonomy: { authorizedDirectory: workspace } } : {}),
        ...(policy === "files" ? { fileAuthorizations: [{ tools: ["read_file"], allowedPaths: ["."] }] } : {}),
        modules: { memory: { enabled: true, autoConsolidate: true },
          "read-file": { enabled: true }, ...(policy === "docker" ? { shell: { enabled: true, sandbox: { backend: "docker", image: "img", readablePaths: ["note.txt"], writablePaths: ["."] } } } : {}) } }));
      try {
        const config = await resolveTuiModuleConfig({ configPath, dataDirectory: join(root, "config-data") }, { cwd: root });
        rows[`config/${inside ? "inside" : "outside"}/${policy}`] = { fileRules: config.fileAuthorizations, docker: config.shellSandbox };
      } catch (error) { rows[`config/${inside ? "inside" : "outside"}/${policy}`] = error instanceof Error ? error.message : "error"; }
    }
    let workerTools: string[] = [];
    const worker = createTaskWorkerAgent({ modelAlias: "worker", store: new InMemoryAgentStore(),
      model: new MockLanguageModelV3({ doStream: async options => {
        workerTools = options.tools?.map(tool => tool.name).sort() ?? [];
        return { stream: simulateReadableStream({ chunks: [{ type: "stream-start", warnings: [] }, { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage }] }) };
      } }) });
    try {
      const handle = await worker.runtime.run({ agentId: "scheduled-responder", threadId: "worker", messages: [{ id: "worker", role: "user", parts: [{ type: "text", text: "run" }] }] });
      await handle.result; rows.worker = workerTools;
    } finally { worker.dispose(); }
    const normalized = JSON.parse(JSON.stringify(rows).replaceAll(root, "<fixture>"));
    if (process.env.SERIKA_B0_CAPTURE) await writeFile(process.env.SERIKA_B0_CAPTURE, JSON.stringify(normalized, null, 2) + "\n");
    const baseline: Record<string, unknown> = JSON.parse(await readFile(new URL("../src/permission-boundary.snapshot.json", import.meta.url), "utf8"));
    // e removes mode metadata and explicit review/automatic config inputs; the stored baseline stays frozen.
    for (const [key, value] of Object.entries(baseline)) {
      if (/^config\/(inside|outside)\/(automatic|review)$/.test(key)) delete baseline[key];
      else if (key.startsWith("config/") && typeof value === "object" && value !== null && "policy" in value) delete value.policy;
    }
    assert.deepEqual(normalized, baseline);
  } finally { await rm(root, { recursive: true, force: true }); }
});
