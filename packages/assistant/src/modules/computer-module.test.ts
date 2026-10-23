import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { AiSdkAgentLoop, InMemoryModelRegistry, ToolRegistry } from "@serika/ai-sdk-adapter";
import { createModuleHost, type ToolPermissionFacts } from "../module-host.js";
import { computerConfigSchema, createComputerModule, createDriverCall, type DriverCall } from "./computer-module.js";

const config = { enabled: true, executable: "/trusted/cua-driver", allowedBundleIds: ["com.apple.TextEdit"] };
const target = { bundleId: "com.apple.TextEdit", pid: 123, windowId: 456 };
const state = { pid: 123, window_id: 456, elements: [{ element_index: 99, role: "AXWindow" }, { element_index: 0, parent_index: 99, element_token: "s1-e0", role: "AXTextField", value: "before" }] };

function harness(overrides: { action?: unknown; state?: unknown; changed?: () => boolean; failAction?: boolean; now?: () => number } = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const call: DriverCall = async (name, args) => {
    calls.push({ name, args });
    if (name === "list_apps") return { apps: [{ pid: 123, bundle_id: overrides.changed?.() ? "com.other.App" : "com.apple.TextEdit", running: true }, { pid: 789, bundle_id: "com.other.App", running: true }] };
    if (name === "list_windows") return { windows: [{ pid: 123, window_id: 456, title: "Allowed" }, { pid: 789, window_id: 987, title: "Private other app" }] };
    if (name === "get_window_state") return overrides.state ?? state;
    if (overrides.failAction) throw new Error("lost after dispatch");
    return "action" in overrides ? overrides.action : { effect: "confirmed" };
  };
  const host = createModuleHost([createComputerModule(config, { call, ...(overrides.now ? { now: overrides.now } : {}) })], { notify() {} });
  const invoke = async (name: string, input: unknown) => {
    const registered = host.tools.find((t) => t.metadata.name === name)!;
    const execute = registered.tool.execute!;
    return await execute(input as never, { toolCallId: "call-1", messages: [], context: undefined, abortSignal: new AbortController().signal }) as Record<string, unknown>;
  };
  const observe = () => invoke("computer_observe", target);
  const action = (observationId: unknown, extra: Record<string, unknown> = {}) => invoke("computer_action", { ...target, observationId, elementToken: "s1-e0", action: "click", ...extra });
  return { host, calls, invoke, observe, action };
}

describe("allowed local application computer tools", () => {
  it("explicit health check probes only connection and filters unrelated app metadata; never reads UI or claims OS permission", async () => {
    const h = harness();
    const result = await h.invoke("computer_check", {});
    assert.equal(result.ok, true);
    assert.equal(result.service, "reachable"); assert.equal(result.permissions, "not_checked");
    assert.deepEqual(result.runningAllowedApps, ["com.apple.TextEdit"]);
    assert.deepEqual(h.calls.map(item => item.name), ["list_apps"]);
    assert.doesNotMatch(JSON.stringify(result), /com.other.App|Private/);
  });
  it("health failures stay unverified, do not leak driver text or guess missing OS permission", async () => {
    let calls = 0;
    const host = createModuleHost([createComputerModule(config, { call: async () => { calls++; throw new Error("SECRET unrelated driver body"); } })], { notify() {} });
    const registered = host.tools.find(item => item.metadata.name === "computer_check")!;
    const result = await registered.tool.execute!({}, { toolCallId: "health", messages: [], context: undefined, abortSignal: new AbortController().signal }) as { service: string; permissions: string };
    assert.equal(result.service, "check_failed"); assert.equal(result.permissions, "not_checked");
    assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(result), /SECRET/);
    host.dispose();
  });
  it("excludes app menus and their tokens from the exact-window observation", async () => {
    const h = harness({ state: { ...state, elements: [...state.elements, { element_index: 100, role: "AXMenuBar", element_token: "menu-root" }, { element_index: 101, parent_index: 100, role: "AXMenuItem", label: "Private recent document", element_token: "menu-item" }] } });
    const observed = await h.observe();
    assert.equal(observed.ok, true);
    assert.equal(JSON.stringify(observed).includes("Private recent document"), false);
    assert.equal((await h.action(observed.observationId, { elementToken: "menu-item" })).ok, false);
    assert.equal(h.calls.some((c) => c.name === "click"), false);
  });
  it("fails closed on missing/ambiguous roots and over-limit exact window subtrees", async () => {
    for (const elements of [[], [{ element_index: 0, role: "AXWindow" }, { element_index: 1, role: "AXWindow" }], [state.elements[0], ...Array.from({ length: 201 }, (_, i) => ({ element_index: i + 200, parent_index: 99, role: "AXButton" }))]]) {
      assert.equal((await harness({ state: { ...state, elements } }).observe()).ok, false);
    }
  });
  it("rejects duplicate indices and excludes orphaned or cyclic nodes", async () => {
    const duplicate = harness({ state: { ...state, elements: [...state.elements, { element_index: 0, parent_index: 99, role: "AXButton" }] } });
    assert.equal((await duplicate.observe()).ok, false);
    const h = harness({ state: { ...state, elements: [...state.elements,
      { element_index: 200, parent_index: 999, role: "AXButton", element_token: "orphan" },
      { element_index: 201, parent_index: 202, role: "AXButton", element_token: "cycle" },
      { element_index: 202, parent_index: 201, role: "AXButton" },
    ] } });
    const observed = await h.observe();
    assert.equal(observed.ok, true);
    assert.ok(Array.isArray(observed.elements));
    assert.equal(observed.elements.length, 2);
    assert.equal(h.calls.find((c) => c.name === "get_window_state")!.args.max_elements, 2000);
    assert.equal((await h.action(observed.observationId, { elementToken: "orphan" })).ok, false);
    assert.equal(h.calls.some((c) => c.name === "click"), false);
  });
  it("stops the existing AgentLoop on an unknown action without another model call or replay", async () => {
    const h = harness({ failAction: true });
    const observed = await h.observe();
    let modelCalls = 0;
    const model = new MockLanguageModelV3({ doStream: async () => {
      modelCalls++;
      return { stream: simulateReadableStream({ chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "tool-call" as const, toolCallId: "computer-unknown", toolName: "computer_action", input: JSON.stringify({ ...target, observationId: observed.observationId, elementToken: "s1-e0", action: "click" }) },
        { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } } },
      ] }) };
    } });
    const loop = new AiSdkAgentLoop({ models: new InMemoryModelRegistry({ test: model }), tools: new ToolRegistry(h.host.tools) });
    const outcome = await loop.execute({
      definition: { id: "test", version: "1", model: "test", instructions: "Use the allowed app", tools: ["computer_action"], limits: { maxSteps: 4, totalTimeoutMs: 5000, stepTimeoutMs: 2000 } },
      messages: [{ id: "user", role: "user", parts: [{ type: "text", text: "Click the approved control" }] }],
      signal: new AbortController().signal, generateId: () => "assistant", emit: async () => {},
    });
    assert.equal(outcome.stopReason, "failed");
    assert.ok(outcome.stopReason === "failed");
    assert.equal(outcome.error.code, "TOOL_OUTCOME_UNKNOWN");
    assert.match(JSON.stringify(outcome.messages), /TOOL_OUTCOME_UNKNOWN/);
    assert.equal(modelCalls, 1);
    assert.equal(h.calls.filter((c) => c.name === "click").length, 1);
  });
  it("requires explicit driver and exact app whitelist", () => {
    assert.equal(computerConfigSchema.safeParse({ enabled: true }).success, false);
    assert.equal(computerConfigSchema.safeParse({ ...config, allowedBundleIds: ["*"] }).success, false);
    assert.equal(computerConfigSchema.safeParse({ enabled: false }).success, true);
  });
  it("returns only the allowed app windows and never dispatches for a foreign app", async () => {
    const h = harness();
    const listed = await h.invoke("computer_observe", { bundleId: target.bundleId });
    assert.deepEqual(listed.windows, [{ pid: 123, windowId: 456, title: "Allowed" }]);
    const count = h.calls.length;
    assert.equal((await h.invoke("computer_observe", { bundleId: "com.other.App" })).ok, false);
    assert.equal(h.calls.length, count);
  });
  it("observes then acts with a target-scoped token, consumes it and requires re-observation", async () => {
    const h = harness();
    const observed = await h.observe();
    assert.equal(observed.ok, true);
    const result = await h.action(observed.observationId);
    assert.equal(result.ok, true);
    assert.equal(result.verified, false);
    const dispatch = h.calls.at(-1)!;
    assert.equal(dispatch.name, "click");
    assert.equal(dispatch.args.delivery_mode, "background");
    assert.equal(dispatch.args.element_token, "s1-e0");
    assert.equal("x" in dispatch.args, false);
    assert.equal((await h.action(observed.observationId)).ok, false);
    assert.equal(h.calls.filter((c) => c.name === "click").length, 1);
    assert.equal((await h.observe()).ok, true);
  });
  it("rejects expired snapshots, changed ownership and tokens from replaced observations", async () => {
    let time = 0;
    let changed = false;
    const h = harness({ now: () => time, changed: () => changed });
    const old = await h.observe();
    time = 60_001;
    assert.equal((await h.action(old.observationId)).ok, false);
    const one = await h.observe();
    const two = await h.observe();
    assert.notEqual(one.observationId, two.observationId);
    assert.equal((await h.action(one.observationId)).ok, false);
    const fresh = await h.observe();
    changed = true;
    assert.equal((await h.action(fresh.observationId)).ok, false);
    assert.equal(h.calls.some((c) => c.name === "click"), false);
  });
  it("rejects degraded, mismatched, oversized and truncated snapshots", async () => {
    for (const bad of [{ ...state, truncated: true }, { ...state, degraded_reason: "ax_window_unresolved" }, { ...state, pid: 789 }, { ...state, elements: [state.elements[0], ...Array.from({ length: 100 }, (_, i) => ({ element_index: i + 200, parent_index: 99, element_token: `t${i}`, role: "AXTextField", value: "x".repeat(1000) }))] }]) {
      const h = harness({ state: bad });
      assert.equal((await h.observe()).ok, false);
      assert.equal((await h.action("invented")).ok, false);
    }
  });
  it("inserts bounded text only into the observed element and disables screenshots", async () => {
    const h = harness();
    const observed = await h.observe();
    await h.action(observed.observationId, { action: "type_text", text: "hello" });
    assert.equal(h.calls.at(-1)!.args.text, "hello");
    assert.equal(h.calls.find((c) => c.name === "get_window_state")!.args.include_screenshot, false);
  });
  it("lets transport/unknown effects escape, does not repeat dispatch, and disposes tokens", async () => {
    for (const options of [{ failAction: true }, { action: { effect: "indeterminate" } }, { action: { effect: "partial" } }, { action: null }]) {
      const h = harness(options);
      const observed = await h.observe();
      await assert.rejects(h.action(observed.observationId));
      assert.equal((await h.action(observed.observationId)).ok, false);
      assert.equal(h.calls.filter((c) => c.name === "click").length, 1);
      const next = await h.observe();
      h.host.dispose();
      assert.equal((await h.action(next.observationId)).ok, false);
      assert.equal(h.host.tools.find(item => item.metadata.name === "computer_action")!.metadata.idempotent, false);
    }
  });
  it("allows a fresh read after a dispatched but not business-verified click without repeating the action", async () => {
    const h = harness({ action: { effect: "unverifiable" } });
    const observed = await h.observe();
    const result = await h.action(observed.observationId);
    assert.equal(result.dispatched, true);
    assert.equal(result.verified, false);
    assert.equal(result.effect, "unverifiable");
    assert.equal((await h.observe()).ok, true);
    assert.equal(h.calls.filter((c) => c.name === "click").length, 1);
  });
  it("declares never-remembered calls, the connectivity-check card and its instructions", () => {
    const host = createModuleHost([createComputerModule(config, { call: async () => ({}) })], { notify() {} });
    assert.deepEqual([...host.toolPermissions.keys()], ["computer_check", "computer_observe", "computer_action"]);
    for (const declared of host.toolPermissions.values()) assert.equal(declared.defaults?.remember, "never");
    const check = host.toolPermissions.get("computer_check")?.confirmation?.({ toolName: "computer_check" } as Parameters<NonNullable<ToolPermissionFacts["confirmation"]>>[0]);
    assert.match(String(check), /^\n检查 CUA 连接\n.*Allow this call\? \[y\/n\] $/s);
    assert.equal(host.toolPermissions.get("computer_action")?.confirmation, undefined);
    assert.match(host.instructions("computer"), /^Computer tools control only explicitly allowed local apps/);
    host.dispose();
  });
});

describe("bounded Cua CLI transport", () => {
  it("uses stdin JSON, not shell/argv text, and strips secrets and bypass flags", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-computer-driver-"));
    const executable = join(root, "driver");
    await writeFile(executable, `#!${process.execPath}\nlet data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>console.log(JSON.stringify({args:process.argv.slice(2),input:JSON.parse(data),secret:process.env.TEST_API_KEY??null,bypass:process.env.CUA_DRIVER_RS_PERMISSIONS_GATE??null})));`);
    await chmod(executable, 0o700);
    const call = createDriverCall(executable, { ...process.env, TEST_API_KEY: "must-not-leak", CUA_DRIVER_RS_PERMISSIONS_GATE: "0" });
    const result = await call("type_text", { text: "$(touch never); secret input" }, new AbortController().signal) as Record<string, unknown>;
    assert.deepEqual(result.args, ["call", "type_text"]);
    assert.equal(result.secret, null);
    assert.equal(result.bypass, null);
    assert.deepEqual(result.input, { text: "$(touch never); secret input" });
  });
  it("fails closed on invalid JSON, excessive output and cancelled child processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-computer-driver-"));
    for (const [mode, program] of [["invalid", "console.log('not json')"], ["huge", "console.log('x'.repeat(300000))"], ["cancel", "setInterval(()=>{},1000)"]] as const) {
      const executable = join(root, mode);
      await writeFile(executable, `#!${process.execPath}\n${program}`);
      await chmod(executable, 0o700);
      const signal = new AbortController();
      const pending = createDriverCall(executable, process.env)("list_apps", {}, signal.signal);
      if (mode === "cancel") setTimeout(() => signal.abort(), 20);
      await assert.rejects(pending);
    }
  });
});

it("returns clipped AX text as bounded read-only diagnostics with no action authority", async () => {
  const h = harness({ state: { ...state, elements: [state.elements[0], { ...state.elements[1], value: "x".repeat(5000) }] } });
  const observed = await h.observe();
  assert.equal(observed.ok, true);
  assert.equal(observed.readOnly, true);
  assert.equal(observed.observationId, undefined);
  assert.doesNotMatch(JSON.stringify(observed), /element_token/);
  assert.ok(Buffer.byteLength(JSON.stringify(observed)) < 24 * 1024);
  assert.equal((await h.action("forged")).ok, false);
  assert.equal(h.calls.some(call => call.name === "click"), false);
});
