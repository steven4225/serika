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
async function fixture(options: { mode?: string; stale?: boolean; windowTokens?: number; totalTimeoutMs?: number; onRequest?: (index: number) => Promise<void>; calls: { name: string; input: unknown }[] }) {
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
const identity=p=>({pane_id:p,terminal_id:(mode==='replaced'||mode==='replacement-only')&&p==='p2'?'replacement':p==='p1'?'t1':'t2'});
const agent={...identity(a[4]),agent:'pi',agent_status:'idle',state_change_seq:1};
if(a[0]==='session')console.log(JSON.stringify({sessions:[{name:'offline',running:true}]}));
else if(a[2]==='pane'&&a[3]==='list')console.log(JSON.stringify({result:{panes:(mode==='one'||mode==='replacement-only'?['p2']:['p1','p2']).map(p=>({...identity(p),terminal_title_stripped:'Pi '+p}))}}));
else if(a[2]==='pane')console.log(JSON.stringify({result:{type:'pane_info',pane:identity(a[4])}}));
else if(a[3]==='read')console.log('Current task artifact: answer.json sum=15');
else if(a[3]==='prompt'&&mode==='unknown')process.exit(1);
else {if(a[3]==='prompt')writeFileSync(${JSON.stringify(join(directory, "answer.json"))},JSON.stringify({sum:15}));console.log(JSON.stringify({result:{type:a[3]==='prompt'?'agent_prompted':'agent_info',agent}}));}
`);
  await chmod(join(bin, "herdr"), 0o700);
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ version: 2, ...(options.totalTimeoutMs ? { run: { totalTimeoutMs: options.totalTimeoutMs } } : {}), authorizedDirectories: [{ path: directory, access: "readwrite" }],
    modules: { "read-file": { enabled: true }, terminal: { enabled: true, ...(options.stale ? { target: { authorizedDirectory: directory, session: "old", paneId: "gone", terminalId: "old" } } : {}) } },
    ...(options.windowTokens ? { contextCompaction: { enabled: true, contextWindowTokens: options.windowTokens,
      maxOutputTokens: 4096, safetyMarginTokens: 2048, keepRecentTokens: 8192, summaryMaxOutputTokens: 2048 },
      modelContextWindows: [{ provider: "mock-provider", modelId: "mock-model-id", contextWindowTokens: options.windowTokens }] } : {}) }));
  const callsInRun = options.calls.length && options.calls[0]?.name !== "herdr_pi_discover"
    ? [{ name: "herdr_pi_discover", input: {} }, ...options.calls] : options.calls;
  let step = 0;
  const requests: string[] = [];
  const contracts: string[][] = [];
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
      contracts.push((request.tools ?? []).map(tool => tool.name));
      const index = step++ % (callsInRun.length + 1), call = callsInRun[index];
      await options.onRequest?.(index);
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
  return { root, directory, app, controller, calls, run, set, requests, contracts,
    cleanup: async () => { await controller.shutdown(); await rm(root, { recursive: true, force: true }); } };
}
const prompt = { name: "herdr_pi_control", input: { action: "prompt", text: "create answer.json with sum 15" } };

it("discovery blocks until one host choice, then every model step removes discover and continues read/control", async () => {
  const f = await fixture({ calls: [{ name: "herdr_pi_discover", input: {} },
    { name: "herdr_pi_read", input: { action: "get" } }, prompt,
    { name: "herdr_pi_read", input: { action: "read" } }, { name: "read_file", input: { path: "answer.json" } }] });
  let choices = 0;
  const off = f.controller.subscribe(event => {
    if (event.type === "herdr-selection") choices++;
    if (event.type === "approval" && event.approval.preview) f.controller.confirm({ approvalId: event.approval.approvalId, decision: "allow" });
  });
  try {
    const running = f.run();
    const deadline = Date.now() + 5000;
    while (!f.controller.getSnapshot().pendingHerdrSelection && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const pending = f.controller.getSnapshot().pendingHerdrSelection;
    assert.ok(pending, "discover must establish host choice before the model can finish");
    assert.equal(f.requests.length, 1, "no model continuation while choice is pending");
    const state = f.controller.getSnapshot().state;
    assert.equal(state.kind, "running");
    const waitingReceipt = state.kind === "running" && await f.controller.runs.get(state.runId!);
    assert.ok(waitingReceipt);
    assert.equal(waitingReceipt.tools[0]?.status, "completed", "discovery execution deadline ended before choice wait");
    assert.equal(f.app.foregroundHerdr?.snapshot().adoptedTarget, null);
    assert.ok(f.controller.selectHerdrTarget({ selectionId: pending.selectionId, candidateId: pending.candidates[1]!.candidateId }));
    assert.equal(f.controller.selectHerdrTarget({ selectionId: pending.selectionId, candidateId: null }), false);
    const id = await running;
    assert.equal(choices, 1);
    assert.ok(f.contracts[0]!.includes("herdr_pi_discover"));
    for (const names of f.contracts.slice(1)) {
      assert.ok(!names.includes("herdr_pi_discover"));
      assert.ok(names.includes("herdr_pi_read") && names.includes("herdr_pi_control"));
    }
    assert.equal((await f.controller.runs.get(id))?.tools.length, 5);
    assert.equal((await f.calls()).filter(args => args[0] === "session").length, 1);
    assert.equal((await f.calls()).filter(args => args[3] === "prompt").length, 1);
    assert.deepEqual(JSON.parse(await readFile(join(f.directory, "answer.json"), "utf8")), { sum: 15 });
  } finally { off(); await f.cleanup(); }
});

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
      assert.equal((await f.controller.runs.get(id))?.tools.length, 4);
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

it("adopted discovery rejects stale same-response selectors without changing adoption or weakening source evidence", async () => {
  const f = await fixture({ mode: "one", calls: [] });
  try {
    const targets = f.app.foregroundHerdr!;
    targets.begin({ id: "request", role: "user", parts: [{ type: "text", text: "请找一个现有 Pi" }] });
    const requested = { session: "offline", paneId: "p2", terminalId: "t2", sourceQuote: "请找一个现有 Pi" };
    const invalid = await targets.discover({ requested });
    assert.ok(!invalid.ok);
    assert.equal(invalid.error.code, "HERDR_REQUEST_EVIDENCE_INVALID");
    assert.ok((await targets.discover({})).ok);
    const adopted = targets.snapshot(), before = await f.calls();
    const rejected = await targets.discover({ refresh: true, requested });
    assert.ok(!rejected.ok);
    assert.equal(rejected.error.code, "HERDR_TARGET_ALREADY_ADOPTED");
    assert.deepEqual(targets.snapshot(), adopted);
    assert.deepEqual(await f.calls(), before, "no discovery or input dispatch after adoption");
    targets.end();
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
    const afterBulk = f.requests[3]!;
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
    if (event.type === "herdr-selection") f.controller.selectHerdrTarget({ selectionId: event.selection.selectionId, candidateId: event.selection.candidates[0]!.candidateId });
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

for (const outcome of ["cancel-selection", "deny-control", "cancel-run", "run-budget"] as const) it(`${outcome} after discovery leaves zero prompt dispatches`, async () => {
  const f = await fixture({ ...(outcome === "run-budget" ? { totalTimeoutMs: 4000 } : {}), calls: [{ name: "herdr_pi_discover", input: {} }, prompt] });
  let choices = 0, approvals = 0;
  const off = f.controller.subscribe(event => {
    if (event.type === "herdr-selection") {
      choices++;
      if (outcome !== "run-budget") f.controller.selectHerdrTarget({ selectionId: event.selection.selectionId,
        candidateId: outcome === "cancel-selection" ? null : event.selection.candidates[0]!.candidateId });
    }
    if (event.type === "approval" && event.approval.preview) {
      approvals++;
      if (outcome === "cancel-run") void f.controller.cancel();
      else {
        assert.equal(outcome, "deny-control");
        assert.ok(f.controller.confirm({ approvalId: event.approval.approvalId, decision: "deny" }));
      }
    }
  });
  try {
    const id = await f.run();
    assert.equal(choices, 1);
    assert.equal(approvals, outcome === "deny-control" || outcome === "cancel-run" ? 1 : 0);
    assert.equal((await f.calls()).filter(args => args[3] === "prompt").length, 0);
    assert.equal(f.controller.getSnapshot().pendingHerdrSelection, null);
    if (outcome === "cancel-selection" || outcome === "run-budget") assert.equal(f.requests.length, 1);
    if (outcome === "cancel-run") assert.equal((await f.controller.runs.get(id))?.status, "cancelled");
    if (outcome === "run-budget") assert.equal((await f.controller.runs.get(id))?.status, "timed_out");
  } finally { off(); await f.cleanup(); }
});

it("identity failure restores discover but cached exact pane evidence cannot auto-adopt a replacement", async () => {
  let replace = async () => {};
  const f = await fixture({ onRequest: async index => { if (index === 1) await replace(); }, calls: [
    { name: "herdr_pi_discover", input: { requested: { session: "offline", paneId: "p2", sourceQuote: "offline p2" } } },
    { name: "herdr_pi_read", input: { action: "get" } },
    { name: "herdr_pi_discover", input: { refresh: true } }, prompt] });
  replace = () => f.set("replaced");
  let choices = 0;
  const off = f.controller.subscribe(event => {
    if (event.type === "herdr-selection") {
      choices++;
      assert.equal(f.requests.length, 3);
      assert.equal(f.app.foregroundHerdr?.snapshot().adoptedTarget, null);
      assert.equal(event.selection.candidates[0]?.target.terminalId, "replacement");
      f.controller.selectHerdrTarget({ selectionId: event.selection.selectionId, candidateId: null });
    }
    assert.notEqual(event.type, "approval");
  });
  try {
    await f.run("使用 offline p2 完成任务");
    assert.equal(choices, 1);
    assert.ok(!f.contracts[1]!.includes("herdr_pi_discover"));
    assert.ok(f.contracts[2]!.includes("herdr_pi_discover"));
    assert.equal((await f.calls()).filter(args => args[3] === "prompt").length, 0);
  } finally { off(); await f.cleanup(); }
});

it("identity rejection cannot auto-adopt the sole replacement on the next discovery", async () => {
  const f = await fixture({ calls: [{ name: "herdr_pi_discover", input: {} }, prompt, { name: "herdr_pi_discover", input: {} }, prompt] });
  let choices = 0, changed: Promise<void> | undefined;
  const off = f.controller.subscribe(event => {
    if (event.type === "herdr-selection") {
      choices++;
      const candidate = choices === 1 ? event.selection.candidates[1] : null;
      f.controller.selectHerdrTarget({ selectionId: event.selection.selectionId, candidateId: candidate?.candidateId ?? null });
    }
    if (event.type === "approval" && event.approval.preview) changed = f.set("replacement-only").then(() => {
      assert.ok(f.controller.confirm({ approvalId: event.approval.approvalId, decision: "allow" }));
    });
  });
  try {
    await f.run(); await changed;
    assert.equal(choices, 2);
    assert.equal((await f.calls()).filter(args => args[3] === "prompt").length, 0);
  } finally { off(); await f.cleanup(); }
});
