import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { assistantDataPaths, createAssistantController, createRuntimeApp, createTaskStore, readinessExitCode } from "@serika/assistant";
import { resolveCliHome } from "./application-home.js";
import { parseTuiArgs } from "./cli-options.js";
import { checkTuiStartup } from "./startup-check.js";

const quote = "我喝咖啡不加糖";
const usage = { inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

test("home precedence and read-only preflight neither create files nor alter the environment", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-home-check-")));
  try {
    const env = { SERIKA_HOME: join(root, "environment") };
    const resolve = (home?: string) => resolveCliHome(home ? parseTuiArgs(["--home", home]) : {}, { cwd: root, env, userHome: root, initialize: false });
    assert.equal((await resolve("flag")).dataDirectory, join(root, "flag/data"));
    assert.equal((await resolve()).dataDirectory, join(root, "environment/data"));
    assert.equal((await resolveCliHome({}, { cwd: root, env: {}, userHome: root, initialize: false })).dataDirectory, join(root, ".serika/data"));
    const snapshot = await checkTuiStartup(["--home", join(root, "missing")], { cwd: root, env });
    assert.equal(readinessExitCode(snapshot), 0);
    assert.equal(snapshot.identity.transcriptDirectory, join(root, "missing/transcripts"));
    assert.match(snapshot.checks.find(item => item.id === "data-locations")!.message, /missing\/data\/memory.json/);
    assert.deepEqual(await readdir(root), []);
    assert.deepEqual(env, { SERIKA_HOME: join(root, "environment") });
    assert.throws(() => parseTuiArgs(["--home"]), /requires a directory/);
    assert.throws(() => parseTuiArgs(["--home", "a", "--home", "b"]), /at most one/);
    await assert.rejects(resolveCliHome({ home: " " }, { cwd: root, env, initialize: true }), /non-empty/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fresh CLI homes keep real memory writes, tasks and transcripts apart across restart without a workspace", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-home-isolation-")));
  const controllers: ReturnType<typeof createAssistantController>[] = [];
  try {
    const initialize = (name: string) => resolveCliHome(parseTuiArgs(["--home", join(root, name), "--thread", "same"]), { cwd: root, env: {}, initialize: true });
    const first = await initialize("first"), second = await initialize("second");
    const open = async (args: typeof first, save: boolean) => {
      let calls = 0;
      const prompts: string[] = [];
      const model = new MockLanguageModelV3({ doGenerate: async () => assert.fail("No auxiliary model call"), doStream: async request => {
        prompts.push(JSON.stringify(request.prompt));
        const toolName = save && calls < 2 ? ["memory_write", "task_create"][calls] : undefined;
        calls++;
        const input = toolName === "memory_write" ? { operation: "add", scope: "user", text: quote, category: "preference", sourceQuote: quote,
          identity: { subject: "user", attribute: "coffee", value: "不加糖" } } : { prompt: "提醒喝水", runAt: "2099-01-01T09:00:00+08:00" };
        return { stream: simulateReadableStream({ chunks: [
          { type: "stream-start", warnings: [] },
          ...(toolName ? [{ type: "tool-call" as const, toolCallId: `call-${calls}`, toolName, input: JSON.stringify(input) }]
            : [{ type: "text-start" as const, id: "answer" }, { type: "text-delta" as const, id: "answer", delta: "收到" }, { type: "text-end" as const, id: "answer" }]),
          { type: "finish", finishReason: { unified: toolName ? "tool-calls" : "stop", raw: undefined }, usage },
        ] }) };
      } });
      const { directory, home: _home, ...assistant } = args;
      const app = await createRuntimeApp({ directory: directory!, assistant, modelAlias: "offline", model, output: new PassThrough().resume(), cwd: root, env: {} });
      const controller = createAssistantController(app); controllers.push(controller);
      app.toolConfirmation!.subscribePending(pending => { if (pending) app.toolConfirmation!.resolveApproval({ approvalId: pending.approvalId, decision: "allow" }); });
      const run = async (text: string) => {
        const settled = new Promise<void>(resolve => { const stop = controller.subscribe(event => { if (event.type === "state" && event.state.kind === "idle") { stop(); resolve(); } }); });
        assert.equal((await controller.run(text)).ok, true); await settled;
      };
      assert.equal(app.workspaceRoot, undefined);
      assert.equal(app.moduleConfig!.enabled["read-file"], false);
      assert.equal(app.moduleConfig!.enabled.shell, false);
      return { app, controller, run, prompts };
    };
    const a = await open(first, true), b = await open(second, false);
    await a.run(`${quote}，请记住；并提醒喝水`);
    const memory = await a.app.memoryStore!.readV7!(); assert.ok(memory.ok);
    assert.equal(memory.value.entries[0]!.text, quote);
    assert.equal(memory.value.entries[0]!.sources[0]!.kind, "conversation");
    const tasks = await createTaskStore(assistantDataPaths(first.dataDirectory!).tasks).list(); assert.ok(tasks.ok);
    assert.equal(tasks.value.tasks.length, 1);
    const empty = await b.app.memoryStore!.readV7!(); assert.ok(empty.ok); assert.equal(empty.value.entries.length, 0);
    assert.deepEqual(await b.app.store.getMessages("same"), []);
    const otherTasks = await createTaskStore(assistantDataPaths(second.dataDirectory!).tasks).list(); assert.ok(otherTasks.ok); assert.equal(otherTasks.value.tasks.length, 0);
    const configBytes = await readFile(first.configPath!, "utf8");
    await a.controller.shutdown();
    const reopened = await open(await initialize("first"), false);
    await reopened.run("继续");
    assert.ok(reopened.prompts[0]!.includes(quote));
    assert.equal(await readFile(first.configPath!, "utf8"), configBytes);
    const overview = await reopened.controller.automation.getOverview(); assert.ok(overview.ok);
    assert.equal(overview.value.tasksEnabled, true);
    const cold = await reopened.app.memoryStore!.readV7!(); assert.ok(cold.ok); assert.equal(cold.value.entries[0]!.text, quote);
    assert.equal((await readdir(root)).includes("workspace"), false);
  } finally {
    for (const controller of controllers.reverse()) await controller.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("a storage home does not grant workspace file access or load old workspace memory", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-home-authority-")));
  try {
    const home = await resolveCliHome({ home: join(root, "home") }, { cwd: root, env: {}, initialize: true });
    await writeFile(home.configPath!, JSON.stringify({ version: 2, authorizedDirectories: [{ path: root, access: "readwrite" }], modules: { memory: { enabled: true }, "read-file": { enabled: true } }, fileAuthorizations: [] }));
    const snapshot = await checkTuiStartup(["--home", join(root, "home")], { cwd: root, env: {} });
    assert.equal(readinessExitCode(snapshot), 0);
    await mkdir(join(root, ".runloom"));
    const oldFile = join(root, ".runloom/memory.json");
    await writeFile(oldFile, "old data must not be read");
    const { directory, home: _home, ...assistant } = home;
    const app = await createRuntimeApp({ directory: directory!, assistant, modelAlias: "offline", model: new MockLanguageModelV3(), output: new PassThrough().resume(), cwd: root, env: {} });
    try { const memory = await app.memoryStore!.readV7!(); assert.ok(memory.ok); assert.equal(memory.value.entries.length, 0); } finally { app.dispose(); }
    assert.equal(await readFile(oldFile, "utf8"), "old data must not be read");
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("CLI entry creates only its selected home and --check stays read-only", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-home-entry-")));
  try {
    const home = join(root, "chosen"), index = fileURLToPath(new URL("./index.js", import.meta.url));
    const env = { PATH: process.env.PATH!, SERIKA_HOME: join(root, "not-selected") };
    const checked = spawnSync(process.execPath, [index, "--check", "--home", home], { cwd: root, env, encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
    assert.deepEqual(await readdir(root), []);
    const launched = spawnSync(process.execPath, [index, "--tui", "--home", home, "--thread", "cli"], { cwd: root, env, input: "/exit\n", encoding: "utf8" });
    assert.equal(launched.status, 0, launched.stderr);
    assert.deepEqual(await readdir(root), ["chosen"]);
    assert.equal(JSON.parse(await readFile(join(home, "config.json"), "utf8")).authorizedDirectory, undefined);
    assert.ok((await readdir(home)).includes("transcripts"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
