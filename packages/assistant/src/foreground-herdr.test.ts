import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController, type AssistantController } from "./assistant-controller.js";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined } };
async function fixture(options: { mode?: string; stale?: boolean; windowTokens?: number; calls: { name: string; input: unknown }[] }) {
  const root = await realpath(await mkdtemp("/private/tmp/serika-run-target-"));
  const directory = join(root, "work"), bin = join(root, "bin"), home = join(root, "home"), log = join(root, "calls.jsonl"), state = join(root, "state.json");
  await Promise.all([mkdir(directory), mkdir(bin), mkdir(home)]);
  const set = (mode: string) => writeFile(state, JSON.stringify(mode));
  await set(options.mode ?? "normal");
  await writeFile(join(directory, "bulk.txt"), "BULK_START\n" + "b".repeat(60000) + "\nBULK_END\n");
  await writeFile(join(bin, "herdr"), `#!${process.execPath}
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const a=process.argv.slice(2),mode=JSON.parse(readFileSync(${JSON.stringify(state)},'utf8'));
appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
const identity=p=>({pane_id:p,terminal_id:mode==='replaced'&&p==='p2'?'replacement':p==='p1'?'t1':'t2'});
const agent={...identity(a[4]),agent:'pi',agent_status:'idle',state_change_seq:1};
if(a[0]==='session')console.log(JSON.stringify({sessions:[{name:'offline',running:true}]}));
else if(a[2]==='pane'&&a[3]==='list')console.log(JSON.stringify({result:{panes:(mode==='one'?['p2']:['p1','p2']).map(p=>({...identity(p),terminal_title_stripped:'Pi '+p}))}}));
else if(a[2]==='pane')console.log(JSON.stringify({result:{type:'pane_info',pane:identity(a[4])}}));
else if(a[3]==='read')console.log('Current task artifact: answer.json sum=15');
else if(a[3]==='prompt'&&mode==='unknown')process.exit(1);
else {if(a[3]==='prompt')writeFileSync(${JSON.stringify(join(directory, "answer.json"))},JSON.stringify({sum:15}));console.log(JSON.stringify({result:{type:a[3]==='prompt'?'agent_prompted':'agent_info',agent}}));}
`);
  await chmod(join(bin, "herdr"), 0o700);
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ version: 2, authorizedDirectories: [{ path: directory, access: "readwrite" }],
    modules: { "read-file": { enabled: true }, terminal: { enabled: true, ...(options.stale ? { target: { authorizedDirectory: directory, session: "old", paneId: "gone", terminalId: "old" } } : {}) } },
    ...(options.windowTokens ? { contextCompaction: { enabled: true, contextWindowTokens: options.windowTokens,
      maxOutputTokens: 4096, safetyMarginTokens: 2048, keepRecentTokens: 8192, summaryMaxOutputTokens: 2048 },
      modelContextWindows: [{ provider: "mock-provider", modelId: "mock-model-id", contextWindowTokens: options.windowTokens }] } : {}) }));
  let step = 0;
  const requests: string[] = [];
  const app = await createRuntimeApp({ cwd: root, env: { HOME: home, PATH: bin }, directory: join(root, "transcripts"), output: new PassThrough(),
    assistant: { configPath, threadId: "thread", dataDirectory: join(root, "data") }, desktopAutonomyHost: { home }, modelAlias: "scripted",
    model: new MockLanguageModelV3({ doStream: async request => {
      if (JSON.stringify(request.prompt.filter(message => message.role === "system")).includes("You are a context compactor.")) {
        const ids = (await app.store.getMessages("thread")).map(message => message.id);
        const text = JSON.stringify({ version: 2, goal: { text: "使用现有 Pi 完成小任务并核对产物", evidenceMessageIds: ids.slice(0, 1) }, constraints: [], decisions: [], actions: [], pending: [], files: [], nextStep: null });
        return { stream: simulateReadableStream({ chunks: [{ type: "stream-start" as const, warnings: [] }, { type: "text-start" as const, id: "summary" },
          { type: "text-delta" as const, id: "summary", delta: text }, { type: "text-end" as const, id: "summary" },
          { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage }] }) };
      }
      requests.push(JSON.stringify(request.prompt));
      const index = step++ % (options.calls.length + 1), call = options.calls[index];
      return { stream: simulateReadableStream({ chunks: [{ type: "stream-start" as const, warnings: [] },
        ...(call ? [{ type: "tool-call" as const, toolCallId: `call-${step}`, toolName: call.name, input: JSON.stringify(call.input) }] : []),
        { type: "finish" as const, finishReason: { unified: call ? "tool-calls" as const : "stop" as const, raw: undefined }, usage }] }) };
    } }) });
  const controller = createAssistantController(app);
  const calls = async (): Promise<string[][]> => (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const run = async (text = "使用现有 Pi 完成小任务并核对产物") => {
    const done = new Promise<void>(resolve => { const off = controller.subscribe(event => { if (event.type === "state" && event.state.kind === "idle") { off(); resolve(); } }); });
    const start = await controller.run(text, { desktopEntry: true });
    assert.ok(start.ok); await done;
    return start.runId;
  };
  return { root, directory, app, controller, calls, run, set, requests,
    cleanup: async () => { await controller.shutdown(); await rm(root, { recursive: true, force: true }); } };
}
const prompt = { name: "herdr_pi_control", input: { action: "prompt", text: "create answer.json with sum 15" } };

it("unbound multi-target choice keeps the original Run, freezes approval, sends once, verifies the artifact and clears at end", async () => {
  const f = await fixture({ calls: [prompt, { name: "herdr_pi_read", input: { action: "read" } }, { name: "read_file", input: { path: "answer.json" } }] });
  let choices = 0, approvals = 0;
  const remove = f.controller.subscribe(event => {
    if (event.type === "herdr-selection") {
      choices++;
      assert.equal(f.controller.getSnapshot().pendingApproval, null);
      assert.equal(f.controller.selectHerdrTarget({ selectionId: "stale", candidateId: event.selection.candidates[1]!.candidateId }), false);
      assert.ok(f.controller.selectHerdrTarget({ selectionId: event.selection.selectionId, candidateId: event.selection.candidates[1]!.candidateId }));
      assert.equal(f.controller.selectHerdrTarget({ selectionId: event.selection.selectionId, candidateId: null }), false);
    }
    if (event.type === "approval" && event.approval.preview) {
      if (event.approval.toolName === "herdr_pi_control") {
        approvals++;
        assert.equal(event.approval.herdr?.target.terminalId, "t2");
        assert.deepEqual(event.approval.herdr?.action, prompt.input);
      }
      assert.equal(f.controller.confirm({ approvalId: event.approval.approvalId, decision: "allow", remember: true }), false);
      f.controller.confirm({ approvalId: event.approval.approvalId, decision: "allow" });
    }
  });
  try {
    for (let i = 0; i < 2; i++) {
      const id = await f.run();
      assert.equal(f.controller.getSnapshot().lastPrimaryResult?.status, "completed");
      assert.equal((await f.controller.runs.get(id))?.tools.length, 3);
      assert.deepEqual(JSON.parse(await readFile(join(f.directory, "answer.json"), "utf8")), { sum: 15 });
      assert.equal(f.app.foregroundHerdr?.snapshot().adoptedTarget, null);
      assert.equal(f.controller.getSnapshot().pendingHerdrSelection, null);
    }
    assert.equal(choices, 2); assert.equal(approvals, 2);
    const calls = await f.calls();
    assert.equal(calls.filter(a => a[3] === "prompt").length, 2);
    assert.ok(calls.filter(a => a[3] === "prompt").every(a => a[4] === "p2"));
    assert.equal(calls.filter(a => a[0] === "session").length, 2, "one discovery per Run, no rediscovery for readback");
  } finally { remove(); await f.cleanup(); }
});

it("a new explicit selector revokes the old adoption and remains binding through rediscovery", async () => {
  const f = await fixture({ mode: "one", calls: [
    { name: "herdr_pi_discover", input: { requested: { session: "offline", paneId: "p2", sourceQuote: "offline p2" } } },
    { name: "herdr_pi_discover", input: { requested: { session: "missing", sourceQuote: "missing" } } },
    { name: "herdr_pi_discover", input: { refresh: true } }, prompt,
  ] });
  try {
    const id = await f.run("目标先为 offline p2，然后指定 missing");
    assert.ok(!(await f.calls()).some(a => a[3] === "prompt"));
    assert.match(JSON.stringify(await f.controller.runs.get(id)), /HERDR_REQUESTED_TARGET_NOT_FOUND/);
  } finally { await f.cleanup(); }
});

it("historical Steer cannot become new-Run target evidence or revive a selection", async () => {
  const f = await fixture({ calls: [] });
  try {
    const target = f.app.foregroundHerdr!;
    const current = { id: "new-request", role: "user" as const, parts: [{ type: "text" as const, text: "当前新任务" }] };
    const old = { id: "old-steer", role: "user" as const, metadata: { source: "steer" }, parts: [{ type: "text" as const, text: "offline p1" }] };
    target.begin(current);
    target.observeSteers([old, current]);
    const result = await target.discover({ requested: { session: "offline", paneId: "p1", sourceQuote: "offline p1" } });
    assert.ok(!result.ok);
    assert.equal(result.error.code, "HERDR_REQUEST_EVIDENCE_INVALID");
    assert.equal(target.snapshot().adoptedTarget, null);
    assert.ok(!(await f.calls()).some(a => a[3] === "prompt"));
    target.end();
  } finally { await f.cleanup(); }
});

for (const windowTokens of [32768, 1000000]) it(`current Run choice and discovery survive production compaction at ${windowTokens} tokens`, async () => {
  const f = await fixture({ windowTokens, calls: [prompt, { name: "read_file", input: { path: "bulk.txt" } },
    { name: "herdr_pi_read", input: { action: "read" } }, { name: "read_file", input: { path: "answer.json" } }] });
  let choices = 0;
  const remove = f.controller.subscribe(event => {
    if (event.type === "herdr-selection") { choices++; f.controller.selectHerdrTarget({ selectionId: event.selection.selectionId, candidateId: event.selection.candidates[1]!.candidateId }); }
    if (event.type === "approval" && event.approval.preview) f.controller.confirm({ approvalId: event.approval.approvalId, decision: "allow" });
  });
  try {
    await f.run();
    assert.equal(f.controller.getSnapshot().lastPrimaryResult?.status, "completed");
    assert.equal(choices, 1);
    const afterBulk = f.requests[2]!;
    assert.match(afterBulk, /adoptedTarget/);
    assert.match(afterBulk, /checkedCandidates/);
    assert.match(afterBulk, /t2/);
    assert.match(afterBulk, /使用现有 Pi 完成小任务并核对产物/);
    if (windowTokens === 32768) assert.match(afterBulk, /masked pending background/);
    assert.equal((await f.calls()).filter(a => a[0] === "session").length, 1);
    assert.equal((await f.calls()).filter(a => a[3] === "prompt").length, 1);
    assert.match(f.requests.at(-1)!, /sum/);
  } finally { remove(); await f.cleanup(); }
});

it("a replacement while approval waits rejects the frozen identity with zero input dispatch", async () => {
  const f = await fixture({ mode: "one", calls: [prompt] });
  let changed: Promise<void> | undefined;
  const remove = f.controller.subscribe(event => {
    if (event.type === "approval" && event.approval.preview) changed = f.set("replaced").then(() => {
      f.controller.confirm({ approvalId: event.approval.approvalId, decision: "allow" });
    });
  });
  try {
    const id = await f.run(); await changed;
    assert.ok(!(await f.calls()).some(a => a[3] === "prompt"));
    assert.match(JSON.stringify(await f.controller.runs.get(id)), /HERDR_TARGET_CHANGED/);
  } finally { remove(); await f.cleanup(); }
});

it("same-Run Steer revokes old approval and binds its exact target correction before one new dispatch", async () => {
  const f = await fixture({ calls: [
    { name: "herdr_pi_discover", input: { requested: { session: "offline", paneId: "p1", sourceQuote: "offline p1" } } }, prompt,
    { name: "herdr_pi_discover", input: { requested: { session: "offline", paneId: "p2", sourceQuote: "改用 offline p2" } } }, prompt,
  ] });
  let steered: Promise<void> | undefined, approvals = 0;
  const remove = f.controller.subscribe(event => {
    if (event.type === "approval" && event.approval.preview) {
      if (approvals++ === 0) {
        const state = f.controller.getSnapshot().state;
        assert.ok(state.kind === "running" && state.runId);
        steered = f.controller.steer({ expectedRunId: state.runId, id: "change-pi", text: "改用 offline p2" }).then(result => {
          assert.ok(result.ok);
          assert.equal(f.controller.confirm({ approvalId: event.approval.approvalId, decision: "allow" }), false);
        });
      } else f.controller.confirm({ approvalId: event.approval.approvalId, decision: "allow" });
    }
  });
  try {
    const id = await f.run("使用 offline p1 完成任务"); await steered;
    assert.equal(f.controller.getSnapshot().lastPrimaryResult?.status, "completed");
    assert.equal(approvals, 2);
    assert.deepEqual((await f.calls()).filter(a => a[3] === "prompt").map(a => a[4]), ["p2"]);
    assert.equal((await f.controller.runs.get(id))?.steers?.[0]?.status, "applied");
  } finally { remove(); await f.cleanup(); }
});

it("unknown dispatch stops the original AgentLoop before readback and never resends", async () => {
  const f = await fixture({ mode: "unknown", calls: [prompt, { name: "herdr_pi_read", input: { action: "read" } }] });
  const remove = chooseAndApprove(f.controller);
  try {
    const id = await f.run();
    const calls = await f.calls();
    assert.equal(calls.filter(a => a[3] === "prompt").length, 1);
    assert.equal(calls.filter(a => a[3] === "read" || a[3] === "wait").length, 0);
    const receipt = await f.controller.runs.get(id);
    assert.equal(receipt?.tools.at(-1)?.status, "unknown");
    assert.equal(f.controller.getSnapshot().lastPrimaryResult?.status, "failed");
  } finally { remove(); await f.cleanup(); }
});

it("a stale configured binding cannot silently redirect even to the only healthy candidate", async () => {
  const f = await fixture({ mode: "one", stale: true, calls: [prompt] });
  let selected = false;
  const remove = f.controller.subscribe(event => {
    if (event.type === "herdr-selection") {
      selected = true;
      assert.equal(event.selection.candidates.length, 1);
      f.controller.selectHerdrTarget({ selectionId: event.selection.selectionId, candidateId: null });
    }
    assert.notEqual(event.type, "approval", "cancelled selection must never offer operation approval");
  });
  try {
    const id = await f.run();
    assert.ok(selected);
    assert.ok(!(await f.calls()).some(a => a[3] === "prompt"));
    assert.match(JSON.stringify(await f.controller.runs.get(id)), /HERDR_TARGET_SELECTION_CANCELLED/);
  } finally { remove(); await f.cleanup(); }
});

function chooseAndApprove(controller: AssistantController) {
  return controller.subscribe(event => {
    if (event.type === "herdr-selection") controller.selectHerdrTarget({ selectionId: event.selection.selectionId, candidateId: event.selection.candidates[1]!.candidateId });
    if (event.type === "approval" && event.approval.preview) controller.confirm({ approvalId: event.approval.approvalId, decision: "allow" });
  });
}
