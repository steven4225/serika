import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";
import { RecipeStore, recipeHash } from "./recipe-store.js";

function response(call?: { name: string; id: string; input: unknown }) {
  return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] },
    ...(call ? [{ type: "tool-call" as const, toolName: call.name, toolCallId: call.id, input: JSON.stringify(call.input) }] : [
      { type: "text-start" as const, id: "text" }, { type: "text-delta" as const, id: "text", delta: "已核对实际执行结果。" }, { type: "text-end" as const, id: "text" },
    ]),
    { type: "finish" as const, finishReason: { unified: call ? "tool-calls" as const : "stop" as const, raw: undefined }, usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined },
    } },
  ] }) };
}
const signal = () => new AbortController().signal;
async function wait(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Controller did not settle"); await new Promise(done => setTimeout(done, 10)); }
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-recipe-acceptance-")));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ version: 1, workspace, modules: { shell: { enabled: true } } }));
  return { root, workspace, config };
}
const definition = { id: "project-summary", description: "生成指定项目改动摘要并检查产物", cwd: ".",
  command: "node -e 'const f=require(\"node:fs\"); const p=JSON.parse(f.readFileSync(\"project.json\",\"utf8\")); f.writeFileSync(\"summary.md\",\"# Changes\\n\"+p.change); if(!f.readFileSync(\"summary.md\",\"utf8\").includes(p.change))process.exit(1)'" };

it("real Shell → receipt-checked registration → new Thread/process reconstruction → fresh approval → artifact, disable and rollback", async () => {
  const f = await fixture();
  let step = 0;
  const closers: (() => Promise<void>)[] = [];
  const open = async (thread: string, next: () => ReturnType<typeof response>) => {
    let output = "";
    const app = await createRuntimeApp({ directory: join(f.root, "transcripts"), assistant: { dataDirectory: join(f.workspace, ".runloom"), threadId: thread, configPath: f.config },
      modelAlias: "scripted", model: new MockLanguageModelV3({ doStream: async () => next() }), env: {}, cwd: f.root,
      output: new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } }) });
    const controller = createAssistantController(app);
    const approvals: string[] = [];
    const seenApprovals = new Set<string>();
    controller.subscribe(event => {
      if (event.type === "approval" && event.approval.preview.trim() && !seenApprovals.has(event.approval.approvalId)) {
        seenApprovals.add(event.approval.approvalId);
        approvals.push(event.approval.toolName);
        controller.confirm({ approvalId: event.approval.approvalId, decision: "allow" });
      }
    });
    const close = async () => { await controller.shutdown(); await app.dispose(); };
    closers.push(close);
    return { app, controller, approvals, output: () => output, close };
  };
  try {
    await writeFile(join(f.workspace, "project.json"), JSON.stringify({ change: "before" }));
    const first = await open("build", () => {
      step++;
      return step === 1 ? response({ name: "shell_exec", id: "tested", input: { command: definition.command, cwd: "." } })
        : step === 2 ? response({ name: "recipe_save", id: "register", input: { ...definition, testCallId: "tested", expectedRevision: 0 } }) : response();
    });
    const started = await first.controller.run("生成项目摘要，核对产物后登记为可复用命令配方"); assert.ok(started.ok);
    await wait(() => first.controller.getSnapshot().state.kind === "idle");
    const saved = await new RecipeStore(f.workspace, join(f.workspace, ".runloom/recipes.json")).list(signal());
    assert.equal(saved.length, 1); assert.equal(saved[0]!.activeHash, recipeHash(definition));
    assert.deepEqual(first.approvals, ["shell_exec", "recipe_save"]);
    assert.equal(await readFile(join(f.workspace, "summary.md"), "utf8"), "# Changes\nbefore");
    await first.close();

    // Reconstruct app/controller from disk with a different Thread. No in-memory catalog or permission survives.
    await writeFile(join(f.workspace, "project.json"), JSON.stringify({ change: "after-reopen" }));
    step = 0;
    const second = await open("reuse", () => {
      step++;
      return step === 1 ? response({ name: "recipe_list", id: "list", input: {} })
        : step === 2 ? response({ name: "recipe_run", id: "run", input: { id: definition.id, expectedHash: recipeHash(definition) } }) : response();
    });
    assert.equal((await second.controller.command("/recipes")).ok, true);
    assert.match(second.output(), /project-summary/);
    const reused = await second.controller.run("用已登记的方法更新项目摘要并核对"); assert.ok(reused.ok);
    await wait(() => second.controller.getSnapshot().state.kind === "idle");
    assert.ok(second.approvals.includes("recipe_run"), "prior registration must not grant execute permission");
    assert.equal(await readFile(join(f.workspace, "summary.md"), "utf8"), "# Changes\nafter-reopen");
    const receipt = await second.controller.runs.get(reused.runId);
    assert.equal(receipt?.tools.find(item => item.toolName === "recipe_run")?.shell?.exitCode, 0);
    await second.close();

    const store = new RecipeStore(f.workspace, join(f.workspace, ".runloom/recipes.json"));
    const changed = { ...definition, command: "printf updated" };
    const v2 = await store.save(changed, saved[0]!.versions[0]!.tested, 1, signal());
    await assert.rejects(store.get(definition.id, recipeHash(definition), signal()), /changed/);
    const rolled = await store.change(definition.id, v2.revision, "rollback", recipeHash(definition), signal());
    assert.equal((await store.get(definition.id, rolled.activeHash, signal())).command, definition.command);
    await store.change(definition.id, rolled.revision, "disable", undefined, signal());
    await assert.rejects(new RecipeStore(f.workspace, join(f.workspace, ".runloom/recipes.json")).get(definition.id, rolled.activeHash, signal()), /disabled/);
  } finally { for (const close of closers) await close(); await rm(f.root, { recursive: true, force: true }); }
});

it("registration refuses a guessed receipt, mismatched command and a real failed test; no catalog is invented", async () => {
  for (const mode of ["missing", "mismatch", "failed", "stale"] as const) {
    const f = await fixture(); let step = 0;
    const command = mode === "failed" ? "exit 7" : "printf tested";
    const app = await createRuntimeApp({ directory: join(f.root, "transcripts"), assistant: { dataDirectory: join(f.workspace, ".runloom"), threadId: "guard", configPath: f.config },
      modelAlias: "scripted", model: new MockLanguageModelV3({ doStream: async () => {
        step++;
        if (mode !== "missing" && step === 1) return response({ name: "shell_exec", id: "test", input: { command, cwd: "." } });
        if (mode === "stale" && step === 2) return response({ name: "shell_exec", id: "later", input: { command: "exit 2", cwd: "." } });
        if (step === (mode === "missing" ? 1 : mode === "stale" ? 3 : 2)) return response({ name: "recipe_save", id: "save", input: {
          ...definition, command: mode === "mismatch" ? "printf NOT-tested" : command, testCallId: "test", expectedRevision: 0,
        } });
        return response();
      } }), env: {}, cwd: f.root, output: new Writable({ write(_chunk, _encoding, done) { done(); } }) });
    const controller = createAssistantController(app);
    controller.subscribe(event => { if (event.type === "approval") controller.confirm({ approvalId: event.approval.approvalId, decision: "allow" }); });
    try {
      assert.ok((await controller.run("测试后登记复用")).ok);
      await wait(() => controller.getSnapshot().state.kind === "idle");
      assert.deepEqual(await new RecipeStore(f.workspace, join(f.workspace, ".runloom/recipes.json")).list(signal()), [], mode);
      const receipts = await controller.runs.list();
      assert.match(receipts[0]?.tools.find(item => item.toolName === "recipe_save")?.resultPreview ?? "", /RECIPE_TEST_(REQUIRED|MISMATCH|STALE)/, mode);
    } finally { await controller.shutdown(); await app.dispose(); await rm(f.root, { recursive: true, force: true }); }
  }
});
it("denying a recipe or disabling it while its preview is open prevents real Shell dispatch", async () => {
  for (const mode of ["deny", "changed"] as const) {
    const f = await fixture(); let step = 0;
    const def = { ...definition, command: "touch should-not-exist" };
    const recipes = new RecipeStore(f.workspace, join(f.workspace, ".runloom/recipes.json"));
    const entry = await recipes.save(def, { threadId: "old", runId: "tested", toolCallId: "test" }, 0, signal());
    const app = await createRuntimeApp({ directory: join(f.root, "transcripts"), assistant: { dataDirectory: join(f.workspace, ".runloom"), threadId: "guard", configPath: f.config },
      modelAlias: "scripted", model: new MockLanguageModelV3({ doStream: async () => ++step === 1 ? response({ name: "recipe_run", id: "run", input: { id: def.id, expectedHash: entry.activeHash } }) : response() }),
      env: {}, cwd: f.root, output: new Writable({ write(_chunk, _encoding, done) { done(); } }) });
    const controller = createAssistantController(app);
    let preview = "", decision: Promise<void> | undefined;
    controller.subscribe(event => {
      if (event.type === "approval" && event.approval.preview && !decision) {
        preview = event.approval.preview;
        decision = (async () => {
          if (mode === "changed") await recipes.change(def.id, entry.revision, "disable", undefined, signal());
          assert.ok(controller.confirm({ approvalId: event.approval.approvalId, decision: mode === "deny" ? "deny" : "allow" }));
        })();
      }
    });
    try {
      assert.ok((await controller.run("运行已登记命令")).ok);
      await wait(() => controller.getSnapshot().state.kind === "idle"); await decision;
      assert.match(preview, /touch should-not-exist/); assert.match(preview, /工作目录不是系统隔离/);
      await assert.rejects(readFile(join(f.workspace, "should-not-exist")), { code: "ENOENT" });
    } finally { await controller.shutdown(); await app.dispose(); await rm(f.root, { recursive: true, force: true }); }
  }
});
