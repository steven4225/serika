import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, rm, writeFile, chmod, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp, PRIMARY_AGENT_ID } from "./app.js";
import { createDemoModel } from "./demo-model.js";
import { DEFAULT_CONTEXT_BUDGET_CONFIG } from "./context-budget.js";
import { createPomodoroService } from "./modules/pomodoro-module.js";

function capture(): { output: PassThrough; text(): string } {
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk: Buffer | string) => {
    text += chunk.toString();
  });
  return { output, text: () => text };
}

describe("createRuntimeApp", () => {
  for (const boundary of ["file", "directory"] as const) {
    it(`receipt ${boundary} sync failure prevents model dispatch and a later Run in the real runtime`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "serika-runtime-receipt-fault-"));
      let requests = 0;
      const model = new MockLanguageModelV3({ doStream: async () => { requests++; throw new Error("model must not be dispatched"); } });
      const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { threadId: "sync-fault" },
        modelAlias: "scripted", model, output: capture().output, env: {}, cwd: root });
      try {
        app.enableExecutionRecords();
        const probe = await open(join(root, "probe"), "w"), prototype = Object.getPrototypeOf(probe), original = prototype.sync;
        await probe.close();
        let syncs = 0;
        const injected = t.mock.method(prototype, "sync", async function (this: typeof probe) {
          const kind = (await this.stat()).isDirectory() ? "directory" : "file";
          // startRun succeeds; the second replacement is step.started before
          // AiSdkAgentLoop calls its model. Exercise the optional trace seam.
          if (kind === boundary && ++syncs === 2) throw new Error("receipt persistence fault");
          return original.call(this);
        });
        const handle = await app.runtime.run({ agentId: app.agentId, threadId: app.threadId,
          messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }] });
        assert.equal((await handle.result).status, "failed");
        injected.mock.restore();
        assert.equal(requests, 0);
        await assert.rejects(app.runtime.run({ agentId: app.agentId, threadId: app.threadId,
          messages: [{ id: "u2", role: "user", parts: [{ type: "text", text: "must still stop" }] }] }), /restart|reconcile/);
        assert.equal(requests, 0);
        assert.deepEqual((await app.executionRecords.getRun(app.threadId, handle.runId))?.tools, []);
      } finally { app.dispose(); await rm(root, { recursive: true, force: true }); }
    });
  }

  it("preserves an injected timer across app reassembly, disabled modules and Thread changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "serika-app-timer-owner-"));
    const configPath = join(root, "config.json");
    const service = createPomodoroService({ desktopNotifier: () => undefined });
    const assemble = (thread: string) => createRuntimeApp({
      directory: join(root, "transcripts"), assistant: { threadId: thread, configPath },
      modelAlias: "mock", model: createDemoModel(), output: capture().output, env: {}, cwd: root,
      pomodoroService: service,
    });
    let app: Awaited<ReturnType<typeof assemble>> | undefined;
    try {
      await writeFile(configPath, JSON.stringify({ version: 1, modules: { pomodoro: { enabled: true } } }));
      app = await assemble("first");
      await app.commands!.get("pomodoro")!.execute("start 3");
      const initial = service.status().status;
      assert.equal(initial.state, "running");
      app.dispose();
      await writeFile(configPath, JSON.stringify({ version: 1, modules: { pomodoro: { enabled: false } } }));
      app = await assemble("second");
      assert.equal(app.commands!.has("pomodoro"), false);
      assert.equal(service.status().status.state, "running");
      app.dispose();
      await writeFile(configPath, JSON.stringify({ version: 1, modules: { pomodoro: { enabled: true } } }));
      app = await assemble("third");
      const current = service.status().status;
      assert.ok(initial.state === "running" && current.state === "running");
      assert.equal(current.endsAt, initial.endsAt);
      await app.commands!.get("pomodoro")!.execute("cancel");
      assert.equal(service.status().status.state, "idle");
    } finally { app?.dispose(); service.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  for (const writePolicy of ["review", "automatic"] as const) {
    it(`has exactly one conversation memory writer in ${writePolicy} mode`, async () => {
      const root = await mkdtemp(join(tmpdir(), "serika-memory-owner-"));
      await mkdir(join(root, "workspace"));
      const configPath = join(root, "config.json");
      await writeFile(configPath, JSON.stringify({ version: 1, workspace: "./workspace", modules: {
        memory: { enabled: true, autoConsolidate: true, writePolicy },
      } }));
      let names: string[] = [];
      let system = "";
      const model = new MockLanguageModelV3({ doStream: async options => {
        names = options.tools?.flatMap(tool => tool.type === "function" ? [tool.name] : []) ?? [];
        system = JSON.stringify(options.prompt.filter(message => message.role === "system"));
        return { stream: simulateReadableStream({ chunks: [
          { type: "stream-start" as const, warnings: [] },
          { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          } },
        ] }) };
      } });
      const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { threadId: "writer", configPath },
        modelAlias: "mock", model, output: capture().output, env: {}, cwd: root });
      try {
        const handle = await app.runtime.run({ agentId: app.agentId, threadId: app.threadId,
          messages: [{ id: "correction", role: "user", parts: [{ type: "text", text: "更正我的长期偏好，请记住。" }] }] });
        assert.equal((await handle.result).status, "completed");
        assert.equal(names.includes("memory_read"), true);
        assert.equal(names.some(name => name.startsWith("memory_") && name !== "memory_read"), writePolicy === "review");
        assert.equal(names.includes("memory_revise"), writePolicy === "review");
        assert.ok(app.memoryConsolidation, "automatic lifecycle must remain registered");
        assert.ok(app.memoryStore, "desktop administrative operations retain their original store");
        if (writePolicy === "automatic") {
          const consolidation = await app.runtime.run({ agentId: app.autoConsolidationAgentId!, threadId: app.threadId,
            messages: [{ id: "consolidation", role: "user", metadata: { source: "auto-consolidation" },
              parts: [{ type: "text", text: "整理已提交的用户信息" }] }] });
          assert.equal((await consolidation.result).status, "completed");
          assert.match(system, /explicitly corrects the uniquely matched prior preference: use correct, not change/);
          assert.match(system, /No effective date is needed for a correction/);
          assert.match(system, /actually ambiguous, retain needs_review/);
        }
      } finally { await app.dispose(); await rm(root, { recursive: true, force: true }); }
    });
  }
  for (const config of [
    { web: false, search: false, files: true },
    { web: true, search: false, files: true },
    { web: true, search: true, files: true },
    { web: true, search: false, files: false },
  ]) {
    it(`supplies research delivery checks only with enabled capabilities (${JSON.stringify(config)})`, async () => {
      const root = await mkdtemp(join(tmpdir(), "runloom-app-research-"));
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      const configPath = join(root, "config.json");
      await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: {
        "read-file": { enabled: config.files },
        web: { enabled: config.web, search: { enabled: config.search } },
      } }));
      let system = "";
      let names: string[] = [];
      const model = new MockLanguageModelV3({ doStream: async (options) => {
        system = JSON.stringify(options.prompt.filter((message) => message.role === "system"));
        names = options.tools?.flatMap((tool) => tool.type === "function" ? [tool.name] : []) ?? [];
        return { stream: simulateReadableStream({ chunks: [
          { type: "stream-start" as const, warnings: [] },
          { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          } },
        ] }) };
      } });
      const app = await createRuntimeApp({
        directory: join(root, "transcripts"), assistant: { threadId: "research", configPath },
        modelAlias: "mock", model, output: capture().output, env: {}, cwd: root,
      });
      try {
        const handle = await app.runtime.run({ agentId: app.agentId, threadId: app.threadId,
          messages: [{ id: "research-request", role: "user", parts: [{ type: "text", text: "Compare two supplied sources." }] }],
        });
        assert.equal((await handle.result).status, "completed");
        assert.equal(names.includes("web_fetch"), config.web);
        assert.equal(names.includes("web_search"), config.search);
        assert.equal(names.includes("read_file"), config.files);
        if (config.web) {
          assert.match(system, /directly supplied URLs without search/);
          assert.match(system, /attribute version\/date\/scope to the correct source/);
          assert.match(system, /missing section is not proof/);
          assert.match(system, /agreement and difference sections for contradictions/);
          assert.match(system, /self-check do not prove factual quality or user acceptance/);
          if (config.files) {
            assert.match(system, /read_file the saved report before final delivery/);
            assert.match(system, /do not repeat the write just to obtain verification/);
          } else {
            assert.match(system, /file tools are unavailable/);
            assert.doesNotMatch(system, /read_file the saved report/);
          }
        } else {
          assert.doesNotMatch(system, /directly supplied URLs without search|read_file the saved report/);
        }
        if (config.search) assert.match(system, /If web_search is refused, later web_fetch and feed_read/);
        else assert.doesNotMatch(system, /When web_search is available/);
      } finally { app.dispose(); await rm(root, { recursive: true, force: true }); }
    });
  }

  it("routes Computer reads/actions through ID approvals; denial launches no driver", { skip: process.platform !== "darwin" }, async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-app-computer-"));
    const executable = join(root, "driver");
    const marker = join(root, "must-not-exist");
    await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'dispatched');console.log('{}')`);
    await chmod(executable, 0o700);
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ version: 1, modules: { computer: { enabled: true, executable, allowedBundleIds: ["com.apple.TextEdit"] } } }));
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
    let step = 0;
    const names = ["computer_observe", "computer_action"];
    const model = new MockLanguageModelV3({ doStream: async () => {
      const current = step++;
      const chunks = current < 2
        ? [{ type: "stream-start" as const, warnings: [] }, { type: "tool-call" as const, toolCallId: `computer-${current}`, toolName: names[current]!, input: JSON.stringify(current === 0 ? { bundleId: "com.apple.TextEdit" } : { bundleId: "com.apple.TextEdit", pid: 123, windowId: 456, observationId: "invented", elementToken: "invented", action: "click" }) }, { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage }]
        : [{ type: "stream-start" as const, warnings: [] }, { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage }];
      return { stream: simulateReadableStream<(typeof chunks)[number]>({ chunks }) };
    } });
    const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { threadId: "computer-denial", configPath }, modelAlias: "mock", model, output: capture().output, env: {}, cwd: root });
    try {
      const handle = await app.runtime.run({ agentId: app.agentId, threadId: app.threadId, messages: [{ id: "user-computer", role: "user", parts: [{ type: "text", text: "Observe my permitted app" }] }] });
      for (const name of names) {
        const deadline = Date.now() + 2000;
        while (!app.toolConfirmation?.getPending() && Date.now() < deadline) await delay(1);
        const pending = app.toolConfirmation?.getPending();
        assert.equal(pending?.toolName, name);
        assert.equal(app.toolConfirmation!.resolveApproval({ approvalId: pending!.approvalId, decision: "deny" }), true);
      }
      assert.equal((await handle.result).status, "completed");
      await assert.rejects(access(marker));
    } finally { app.dispose(); await rm(root, { recursive: true, force: true }); }
  });
  for (const enabled of [false, true]) {
    it(`sends current memory after obsolete empty-selection answers without persisting the reference (compaction ${enabled})`, async () => {
      const root = await mkdtemp(join(tmpdir(), "runloom-app-current-memory-"));
      const workspace = join(root, "workspace"); await mkdir(workspace);
      const configPath = join(root, "config.json");
      await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true } },
        contextCompaction: { ...DEFAULT_CONTEXT_BUDGET_CONFIG, enabled } }));
      const prompts: string[][] = [];
      const model = new MockLanguageModelV3({ doStream: async options => {
        prompts.push(options.prompt.map(message => JSON.stringify(message)));
        return { stream: simulateReadableStream({ chunks: [
          { type: "stream-start" as const, warnings: [] },
          { type: "text-start" as const, id: "answer" },
          { type: "text-delta" as const, id: "answer", delta: "Earlier selected entries: []" },
          { type: "text-end" as const, id: "answer" },
          { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined },
          } },
        ] }) };
      } });
      const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { threadId: "current-memory", configPath },
        modelAlias: "mock", model, output: capture().output, env: {}, cwd: root });
      try {
        const run = async (id: string, text: string) => {
          const handle = await app.runtime.run({ agentId: app.agentId, threadId: app.threadId,
            messages: [{ id, role: "user", parts: [{ type: "text", text }] }] });
          assert.equal((await handle.result).status, "completed");
        };
        await run("first", "reports before saving");
        assert.ok((await app.memoryStore!.add({ text: "reports use three steps", scope: { kind: "workspace" } })).ok);
        await run("next", "reports after saving");
        const prompt = prompts[1]!;
        const old = prompt.findIndex(message => message.includes("Earlier selected entries: []"));
        const fresh = prompt.findIndex(message => message.includes("Memory updates supersede") && message.includes("reports use three steps"));
        const question = prompt.findIndex(message => message.includes("reports after saving"));
        assert.ok(old >= 0 && old < fresh && fresh === question);
        assert.equal(prompt.filter(message => message.includes("Memory updates supersede")).length, 1);
        assert.ok(prompt[fresh]!.includes("reports use three steps"));
        const saved = await app.store.getMessages(app.threadId);
        assert.ok(JSON.stringify(saved.find(message => message.id === "next")?.metadata).includes("Memory updates supersede"));
        assert.deepEqual(saved.find(message => message.id === "next")?.parts, [{ type: "text", text: "reports after saving" }]);
      } finally { app.dispose(); await rm(root, { recursive: true, force: true }); }
    });

    it(`reports reference selection failure instead of the previous successful preparation (compaction ${enabled})`, async () => {
      const root = await mkdtemp(join(tmpdir(), "runloom-app-context-diagnostics-"));
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      const configPath = join(root, "runloom.json");
      await writeFile(configPath, JSON.stringify({
        version: 1, workspace: "./workspace", modules: { memory: { enabled: true } },
        contextCompaction: { ...DEFAULT_CONTEXT_BUDGET_CONFIG, enabled },
      }), "utf8");
      const app = await createRuntimeApp({
        directory: join(root, "transcripts"), assistant: { threadId: "diagnostics", configPath },
        modelAlias: "mock", model: createDemoModel(), output: capture().output, env: {}, cwd: root,
      });
      try {
        const initial = await app.getContextDiagnostics();
        assert.equal(initial.ok && initial.value.lastPreparation, null);
        const run = (id: string) => app.runtime.run({
          agentId: app.agentId, threadId: app.threadId,
          messages: [{ id, role: "user", parts: [{ type: "text", text: "What is 20 + 22?" }] }],
        });
        const first = await run("diagnostic-user-1");
        // Deny the demo's arithmetic tool; completion still gives a real preparation.
        const deadline = Date.now() + 1_000;
        while (!app.toolConfirmation?.getPending() && Date.now() < deadline) await delay(1);
        const pending = app.toolConfirmation?.getPending();
        if (pending) app.toolConfirmation?.resolveApproval({ approvalId: pending.approvalId, decision: "deny" });
        await first.result;
        const successful = await app.getContextDiagnostics();
        assert.equal(successful.ok && successful.value.lastPreparation?.outcome, "passthrough");
        assert.equal(successful.ok && successful.value.lastPreparationSource?.messageId, "diagnostic-user-1");
        await mkdir(join(workspace, ".runloom"), { recursive: true });
        await writeFile(join(workspace, ".runloom", "memory.json"), "not JSON", "utf8");
        const second = await run("diagnostic-user-2");
        assert.equal((await second.result).status, "failed");
        const failed = await app.getContextDiagnostics();
        assert.equal(failed.ok, true);
        if (failed.ok) {
          assert.equal(failed.value.lastPreparation?.outcome, "failed");
          assert.equal(failed.value.lastPreparation?.compactionId, null);
          assert.ok(failed.value.lastPreparation?.error);
          assert.equal(failed.value.lastPreparationSource?.messageId, "diagnostic-user-2");
        }
      } finally {
        app.dispose();
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it("assembles the demo runtime without TUI surfaces and runs one turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runloom-app-demo-"));
    const { output } = capture();
    const app = await createRuntimeApp({
      directory,
      modelAlias: "mock",
      model: createDemoModel(),
      output,
      env: {},
      cwd: directory,
    });
    try {
      assert.equal(app.tuiMode, false);
      assert.equal(app.agentId, PRIMARY_AGENT_ID);
      assert.equal(app.threadId, "demo-thread");
      assert.equal(app.directory, directory);
      assert.equal(app.toolConfirmation, undefined);
      assert.equal(app.commands, undefined);
      assert.equal(app.resume, undefined);
      assert.equal(app.autoConsolidationAgentId, undefined);

      const handle = await app.runtime.run({
        agentId: app.agentId,
        threadId: app.threadId,
        messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "What is 20 + 22?" }] }],
      });
      for await (const _event of handle.events) {
        // drain
      }
      const result = await handle.result;
      assert.equal(result.status, "completed");
      const committed = await app.store.getMessages(app.threadId);
      assert.equal(committed[0]?.id, "user-1");
    } finally {
      app.dispose();
      app.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("assembles TUI surfaces from an explicit config and writes command output to the given stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-app-tui-"));
    const configDirectory = join(root, "config");
    const transcripts = join(root, "transcripts");
    await mkdir(configDirectory, { recursive: true });
    await mkdir(transcripts, { recursive: true });
    const configPath = join(configDirectory, "runloom.json");
    await writeFile(configPath, JSON.stringify({ version: 1, modules: {} }), "utf8");
    const { output, text } = capture();
    const app = await createRuntimeApp({
      directory: transcripts, assistant: { threadId: "app-test", configPath },
      modelAlias: "mock",
      model: createDemoModel(),
      output,
      env: {},
      cwd: root,
    });
    try {
      assert.equal(app.tuiMode, true);
      assert.equal(app.threadId, "app-test");
      assert.equal(app.directory, transcripts);
      assert.equal(app.workspaceRoot, undefined);
      assert.ok(app.toolConfirmation);
      assert.ok(app.commands);
      assert.deepEqual(
        [...app.commands.keys()].sort(),
        ["capabilities", "history", "home", "modules", "permissions"],
      );
      assert.equal(app.resume, undefined);

      await app.commands.get("modules")!.execute("");
      assert.match(text(), /\[modules\]/);
      assert.match(text(), /checkpoint: disabled/);
      assert.match(text(), /主 Run 步数上限: 8/);
      assert.match(text(), /主 Run 总时限: 120000 ms/);
      assert.equal(app.moduleConfig?.maxSteps, 8);
      assert.equal(app.moduleConfig?.totalTimeoutMs, 120_000);
      assert.doesNotMatch(text(), /Allow this call\? \[y\/n\]/);
    } finally {
      app.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies a configured total timeout to the primary TUI Run", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-app-timeout-"));
    const configPath = join(root, "runloom.json");
    await writeFile(configPath, JSON.stringify({ version: 1, modules: {}, run: { totalTimeoutMs: 25 } }), "utf8");
    const { output } = capture();
    const app = await createRuntimeApp({
      directory: join(root, "transcripts"), assistant: { threadId: "timeout-test", configPath },
      modelAlias: "mock",
      model: new MockLanguageModelV3({
        doStream: async () => {
          await delay(80);
          return { stream: simulateReadableStream({ chunks: [
            { type: "stream-start" as const, warnings: [] },
            { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            } },
          ] }) };
        },
      }),
      output,
      env: {},
      cwd: root,
    });
    try {
      const handle = await app.runtime.run({
        agentId: app.agentId,
        threadId: app.threadId,
        messages: [{ id: "user-timeout", role: "user", parts: [{ type: "text", text: "hello" }] }],
      });
      const result = await handle.result;
      assert.equal(result.status, "timed_out");
      assert.match(result.error?.message ?? "", /25ms/);
    } finally {
      app.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forwards configured Shell progress before the final tool result", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-app-shell-progress-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const transcripts = join(root, "transcripts");
    const configPath = join(root, "runloom.json");
    await writeFile(configPath, JSON.stringify({
      version: 1, workspace: "./workspace",
      modules: { shell: { enabled: true, timeoutMs: 1_000 } },
      run: { totalTimeoutMs: 3_000 },
    }), "utf8");
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    };
    let modelCalls = 0;
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.stdout.write('ready'); setTimeout(() => process.stderr.write('done'), 120)")}`;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        if (modelCalls === 1) return { stream: simulateReadableStream({ chunks: [
          { type: "stream-start" as const, warnings: [] },
          { type: "tool-call" as const, toolCallId: "shell-progress-call", toolName: "shell_exec", input: JSON.stringify({ command }) },
          { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
        ] }) };
        return { stream: simulateReadableStream({ chunks: [
          { type: "stream-start" as const, warnings: [] },
          { type: "text-start" as const, id: "answer" },
          { type: "text-delta" as const, id: "answer", delta: "check finished" },
          { type: "text-end" as const, id: "answer" },
          { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
        ] }) };
      },
    });
    const app = await createRuntimeApp({
      directory: transcripts, assistant: { threadId: "shell-progress", configPath },
      modelAlias: "mock", model, output: capture().output, env: {}, cwd: root,
    });
    try {
      let settled = false;
      const progress: Array<{ sequence: number; text: string; stream: string; beforeResult: boolean }> = [];
      app.subscribeShellProgress?.((event) => {
        progress.push({ sequence: event.sequence, text: event.text, stream: event.stream, beforeResult: !settled });
        assert.equal(event.toolCallId, "shell-progress-call");
      });
      const handle = await app.runtime.run({
        agentId: app.agentId, threadId: app.threadId,
        messages: [{ id: "shell-user", role: "user", parts: [{ type: "text", text: "Run the check" }] }],
      });
      const resultPromise = handle.result.then((result) => { settled = true; return result; });
      const deadline = Date.now() + 1_000;
      while (app.toolConfirmation?.getPending() === undefined && Date.now() < deadline) {
        await delay(1);
      }
      const approval = app.toolConfirmation?.getPending();
      assert.ok(approval);
      assert.equal(app.toolConfirmation?.resolveApproval({ approvalId: approval.approvalId, decision: "allow" }), true);
      const result = await resultPromise;
      assert.equal(result.status, "completed");
      assert.deepEqual(progress.map((event) => event.text), ["ready", "done"]);
      assert.deepEqual(progress.map((event) => event.stream), ["stdout", "stderr"]);
      assert.deepEqual(progress.map((event) => event.sequence), [1, 2]);
      assert.equal(progress.every((event) => event.beforeResult), true);
    } finally {
      app.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
