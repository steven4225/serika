import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  builtinMemoryHookRules,
  compileHookRules,
  hooksConfigSchema,
  MAX_HOOK_RULES,
  type HookEvent,
  type HookRule,
} from "./automation-hooks.js";

const primary: HookEvent = {
  event: "primary.completed", threadId: "thread-1", runId: "run-1",
  agentId: "calculator", phase: "primary", status: "completed",
};
const rules = () => builtinMemoryHookRules("memory-consolidation");
const compile = (config: readonly HookRule[]) => compileHookRules(config, ["memory-consolidation"]);

describe("automation hooks", () => {
  it("selects registered skill requests in rule order with host lifecycle identity", () => {
    const registry = compile(rules());
    assert.equal(registry.rules[0]?.enabled, true);
    assert.deepEqual(registry.selectHookRequests({ event: "thread.ready", threadId: "thread-1" }), [{
      ruleId: "memory.thread-ready", skillId: "memory-consolidation",
      event: { event: "thread.ready", threadId: "thread-1" },
    }]);
    assert.deepEqual(registry.selectHookRequests(primary), [{
      ruleId: "memory.primary-completed", skillId: "memory-consolidation", event: primary,
    }]);
    const readyRule = rules()[0]!;
    const ordered = compile([readyRule, { ...readyRule, id: "second" }]);
    assert.deepEqual(ordered.selectHookRequests({ event: "thread.ready", threadId: "t" })
      .map((request) => request.ruleId), ["memory.thread-ready", "second"]);
  });

  it("changes matching by configuration and uses equality rather than regex", () => {
    const rule = rules()[1]!;
    const registry = compile([{ ...rule, match: { agentId: "custom-agent" } }]);
    assert.deepEqual(registry.selectHookRequests(primary), []);
    assert.equal(registry.selectHookRequests({ ...primary, agentId: "custom-agent" }).length, 1);
    const literal = compile([{ ...rule, match: { agentId: "calc.*" } }]);
    assert.deepEqual(literal.selectHookRequests(primary), []);
    assert.equal(literal.selectHookRequests({ ...primary, agentId: "calc.*" }).length, 1);
    assert.deepEqual(registry.selectHookRequests({ event: "thread.ready", threadId: "t" }), []);
  });

  it("never recurses from consolidation or other auxiliary agent completion", () => {
    const registry = compile(rules());
    assert.deepEqual(registry.selectHookRequests({ ...primary, phase: "consolidation" }), []);
    assert.deepEqual(registry.selectHookRequests({ ...primary, agentId: "memory-consolidator" }), []);
    for (const status of ["failed", "cancelled", "timed_out"] as const) {
      assert.deepEqual(registry.selectHookRequests({ ...primary, status }), []);
    }
    const noMatcher = compile([{ ...rules()[1]!, match: undefined }]);
    assert.deepEqual(noMatcher.selectHookRequests({ ...primary, phase: "consolidation" }), []);
    assert.deepEqual(noMatcher.selectHookRequests({ event: "primary.completed", threadId: "t" }), []);
    assert.equal(compile(builtinMemoryHookRules("memory-consolidation", "custom-primary"))
      .selectHookRequests({ ...primary, agentId: "custom-primary" }).length, 1);
  });

  it("preserves explicit empty configuration and disabled rules without fallback", () => {
    assert.deepEqual(hooksConfigSchema.parse([]), []);
    assert.deepEqual(compile([]).selectHookRequests(primary), []);
    const registry = compile(rules().map((rule) => ({ ...rule, enabled: false })));
    assert.deepEqual(registry.selectHookRequests(primary), []);
    assert.deepEqual(registry.selectHookRequests({ event: "thread.ready", threadId: "t" }), []);
  });

  it("rejects unknown skills including disabled rules and duplicate rule identities", () => {
    assert.throws(() => compileHookRules(rules(), new Set()), /Unknown hook skill/);
    assert.throws(() => compileHookRules(rules().map((rule) => ({ ...rule, enabled: false })), []), /Unknown hook skill/);
    assert.throws(() => compile([rules()[0]!, rules()[0]!]), /Duplicate hook rule id/);
  });

  it("rejects unsupported events, handlers, matcher fields and incompatible combinations", () => {
    const ready = rules()[0]!;
    const completed = rules()[1]!;
    for (const invalid of [
      { ...ready, event: "tool.completed" },
      { ...ready, command: "echo forbidden" },
      { ...ready, handler: { type: "shell", id: "memory-consolidation" } },
      { ...ready, handler: { ...ready.handler, command: "echo forbidden" } },
      { ...ready, match: { regex: "calculator" } },
      { ...ready, match: { phase: "primary" } },
      { ...ready, match: { status: "completed" } },
      { ...completed, match: { phase: "consolidation" } },
      ...["failed", "cancelled", "timed_out"].map((status) => ({ ...completed, match: { status } })),
      { ...ready, id: " " },
      { ...ready, handler: { type: "skill", id: "" } },
    ]) assert.equal(hooksConfigSchema.safeParse([invalid]).success, false);
    assert.equal(hooksConfigSchema.safeParse(Array.from({ length: MAX_HOOK_RULES + 1 }, (_, index) => ({
      ...ready, id: `rule-${index}`,
    }))).success, false);
  });

  it("snapshots validated configuration instead of retaining mutable inputs", () => {
    const config = rules();
    const registry = compile(config);
    config[1]!.enabled = false;
    config[1]!.handler.id = "unregistered";
    config[1]!.match!.agentId = "other";
    assert.equal(registry.selectHookRequests(primary)[0]?.skillId, "memory-consolidation");
    assert.equal(Object.isFrozen(registry.rules), true);
    assert.equal(Object.isFrozen(registry.rules[1]?.handler), true);
    const request = registry.selectHookRequests(primary)[0]!;
    assert.notEqual(request.event, primary);
  });
});
