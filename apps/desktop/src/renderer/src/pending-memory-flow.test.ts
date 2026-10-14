import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRuntimeApp } from "@aisdk-agent/example-cli/dist/app.js";
import { createAssistantController } from "@aisdk-agent/example-cli/dist/assistant-controller.js";
import { createDemoModel } from "@aisdk-agent/example-cli/dist/demo-model.js";
import { RuntimeBridge, TeeOutput } from "../../main/runtime-bridge.js";
import { MemoryTabs } from "./memory.js";
import { TodayPanel } from "./personal/today.js";
import { initialPendingMemory, pendingMemoryReducer, pendingMemoryStatus } from "./pending-memory-data.js";
import { resolvePayload } from "../../shared/memory-review.js";
import { loadActionablePending } from "./pending-memory-query.js";
import { PendingMemoryCard } from "./pending-memory.js";
import { canAccept, canReject } from "../../shared/memory-review.js";

test("real Controller/Bridge pagination counts four actionable adds in both Today and Memory, then three after explicit review without a Run", async () => {
  const root = await mkdtemp(join(tmpdir(), "pending-memory-flow-"));
  let bridge: RuntimeBridge | undefined;
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const config = join(root, "config.json");
    await writeFile(config, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true } } }));
    const output = new TeeOutput(() => {});
    const app = await createRuntimeApp({ args: ["--tui", join(root, "history"), "--thread", "pending-thread", "--config", config], model: createDemoModel(), modelAlias: "mock/default", output, cwd: root, env: {} });
    const controller = createAssistantController(app); output.attach(controller);
    bridge = new RuntimeBridge(app, controller, { modelAlias: "mock/default", temporaryThread: false, temporaryDirectory: false }, output, () => {});
    const drafts = ["喜欢喝茶", "复盘先结论", "偏好简短回答", "周末喝美式"].map((text, index) => ({
      change: { operation: "add" as const, text, scope: { kind: "workspace" as const }, expiresAt: null },
      source: { kind: "conversation" as const, threadId: "pending-thread", messageId: `u${index}`, quote: text }, reason: "需要用户确认",
    }));
    const expired = { ...drafts[0]!, change: { ...drafts[0]!.change, text: "已经过期的待审", expiresAt: "2000-01-01T00:00:00.000Z" }, source: { ...drafts[0]!.source, messageId: "expired" } };
    const batch = await app.memoryStore!.commitCandidateBatch({ batchId: "pending-batch", originThreadId: "pending-thread", expectedCursor: null, nextCursor: null, candidates: [...drafts, expired] }, undefined, { boundThreadId: "pending-thread", now: new Date("1999-01-01T00:00:00.000Z") }); assert.ok(batch.ok, JSON.stringify(batch));
    const expiredPreview = await bridge.getMemoryCandidate(batch.value.candidateIds[4]!); assert.ok(expiredPreview.ok);
    assert.equal(expiredPreview.value.candidate.status, "pending");
    assert.equal(expiredPreview.value.applicable, false);
    assert.equal(expiredPreview.value.unavailableReason, "expired");
    const occupied = await app.memoryStore!.checkCandidateCapacity(); assert.ok(occupied.ok); assert.equal(occupied.value.pendingCount, 5);
    const withExpired = await loadActionablePending(bridge, "pending-thread"); assert.ok(withExpired.ok);
    assert.equal(withExpired.value.candidates.length, 5, "expired pending remains visible and counted while it occupies capacity and can be rejected");
    let expiredState = pendingMemoryReducer(initialPendingMemory(), { type: "list-result", request: 0, result: withExpired });
    expiredState = pendingMemoryReducer(expiredState, { type: "select", id: expiredPreview.value.candidate.id, request: 1 });
    expiredState = pendingMemoryReducer(expiredState, { type: "detail-result", id: expiredPreview.value.candidate.id, request: 1, result: expiredPreview });
    assert.equal(canAccept(expiredState), false); assert.equal(canReject(expiredState), true);
    const expiredCard = renderToStaticMarkup(createElement(PendingMemoryCard, { state: expiredState, status: pendingMemoryStatus(expiredState, true, true, true), enabled: true, visible: true, controllerIdle: true, fresh: true, onResolve: () => {}, onReload: () => {} }));
    assert.match(expiredCard, /5 条待审/);
    assert.match(expiredCard, /已经过期/);
    assert.match(expiredCard, /disabled=""[^>]*>保存这条记忆/);
    assert.doesNotMatch(expiredCard, /disabled=""[^>]*>不保存这项/);
    const discardExpired = await bridge.resolveMemoryCandidate(resolvePayload(expiredPreview.value, "reject")); assert.ok(discardExpired.ok);
    const freed = await app.memoryStore!.checkCandidateCapacity(); assert.ok(freed.ok); assert.equal(freed.value.pendingCount, 4);
    const foreign = await app.memoryStore!.commitCandidateBatch({ batchId: "foreign", originThreadId: "foreign-thread", expectedCursor: null, nextCursor: null, candidates: [{ ...drafts[0]!, source: { ...drafts[0]!.source, threadId: "foreign-thread" } }] }, undefined, { boundThreadId: "foreign-thread" }); assert.ok(foreign.ok);
    const api = { listMemoryCandidates: (input: Parameters<RuntimeBridge["listMemoryCandidates"]>[0]) => bridge!.listMemoryCandidates({ ...input, limit: 2 }), getMemoryCandidate: (id: string) => bridge!.getMemoryCandidate(id) };
    const page = await loadActionablePending(api, "pending-thread"); assert.ok(page.ok);
    let state = pendingMemoryReducer(initialPendingMemory(), { type: "list-result", request: 0, result: page });
    const count = pendingMemoryStatus(state, true, true, true).count;
    assert.equal(count, 4, "the badge must count later pages, not backend capabilities or first-page length");
    const tabs = renderToStaticMarkup(createElement(MemoryTabs, { tab: "pending", onSelect: () => {}, pendingCount: count }));
    assert.match(tabs, /待审核（4）/);
    const info = bridge.info();
    const today = renderToStaticMarkup(createElement(TodayPanel, { info, tasks: [], tasksLoading: false, tasksError: null, pendingMemory: count, pendingMemoryError: null, onContinue: () => {}, onPomodoro: () => {}, onAutomation: () => {} }));
    assert.match(today, /当前会话有 4 条记忆等你确认/);
    const preview = await bridge.getMemoryCandidate(page.value.candidates[0]!.id); assert.ok(preview.ok); assert.equal(preview.value.current, null);
    state = pendingMemoryReducer(state, { type: "select", id: preview.value.candidate.id, request: 1 });
    state = pendingMemoryReducer(state, { type: "detail-result", id: preview.value.candidate.id, request: 1, result: preview });
    const renderReview = (reviewState = state) => createElement(PendingMemoryCard, { state: reviewState, status: pendingMemoryStatus(reviewState, true, true, true), enabled: true, visible: true, controllerIdle: reviewState.controllerIdle, fresh: true, onResolve: () => {}, onReload: () => {}, onOpenCandidate: () => {} });
    const direct = renderToStaticMarkup(createElement(TodayPanel, { info, tasks: [], tasksLoading: false, tasksError: null, pendingMemory: count, pendingMemoryError: null, memoryReview: renderReview(), onContinue: () => {}, onPomodoro: () => {}, onAutomation: () => {} }));
    assert.match(direct, /要记住这项内容吗？/);
    assert.match(direct, /4 条待审/);
    assert.match(direct, /保存这条记忆|不保存这项/);
    assert.match(direct, /详细审核/);
    assert.doesNotMatch(direct, /有记忆等你确认|我们先看等确认的记忆|candidate-|pending-thread|revision|Run:/);
    const busy = pendingMemoryReducer(state, { type: "controller", idle: false });
    assert.equal(canAccept(busy), false); assert.equal(canReject(busy), false);
    assert.match(renderToStaticMarkup(renderReview(busy)), /disabled=""[^>]*>不保存这项/);
    const resolving = pendingMemoryReducer(state, { type: "resolve-start", decision: "accept" });
    assert.equal(canAccept(resolving), false); assert.equal(canReject(resolving), false);
    assert.equal(pendingMemoryReducer(resolving, { type: "resolve-start", decision: "accept" }), resolving, "second click cannot admit another review");
    const oldRevision = await bridge.resolveMemoryCandidate({ ...resolvePayload(preview.value, "accept"), expectedCandidateRevision: 99 }); assert.equal(oldRevision.ok, false);
    const beforeWrite = await app.memoryStore!.list(); assert.ok(beforeWrite.ok); assert.equal(beforeWrite.entries.length, 0, "old revision must not save or replace anything");
    const [result, doubleClick] = await Promise.all([bridge.resolveMemoryCandidate(resolvePayload(preview.value, "accept")), bridge.resolveMemoryCandidate(resolvePayload(preview.value, "accept"))]); assert.ok(result.ok); assert.equal(doubleClick.ok, false, "Controller idle mutex rejects an overlapping decision");
    const after = await loadActionablePending(api, "pending-thread"); assert.ok(after.ok); assert.equal(after.value.candidates.length, 3);
    state = pendingMemoryReducer(state, { type: "list-result", request: 0, result: after });
    assert.equal(pendingMemoryStatus(state, true, true, true).count, 3);
    const tabsAfter = renderToStaticMarkup(createElement(MemoryTabs, { tab: "pending", onSelect: () => {}, pendingCount: 3 }));
    assert.match(tabsAfter, /待审核（3）/);
    const formal = await app.memoryStore!.list(); assert.ok(formal.ok); assert.equal(formal.entries.length, 1);
    const entry = formal.entries[0]!;
    const toStale = await app.memoryStore!.commitCandidateBatch({ batchId: "stale-update", originThreadId: "pending-thread", expectedCursor: null, nextCursor: null, candidates: [{
      change: { operation: "update", memoryId: entry.id, expectedRevision: entry.revision!, text: "这是一条之后会失效的更新", expiresAt: null }, source: drafts[0]!.source, reason: "用户更新",
    }] }, undefined, { boundThreadId: "pending-thread" }); assert.ok(toStale.ok);
    const changed = await controller.updateMemory({ id: entry.id, expectedRevision: entry.revision!, text: "手动调整后的内容" }); assert.ok(changed.ok);
    const stale = await bridge.getMemoryCandidate(toStale.value.candidateIds[0]!); assert.ok(stale.ok); assert.equal(stale.value.candidate.status, "stale");
    const stable = await loadActionablePending(api, "pending-thread"); assert.ok(stable.ok); assert.equal(stable.value.candidates.length, 3, "terminal stale updates do not inflate the count");
    const identity = { attribute: "coffee" as const, scenario: "general" as const, value: "unsweetened" as const };
    const seed = await app.memoryStore!.commitCandidateBatch({ batchId: "coffee-current", originThreadId: "pending-thread", expectedCursor: null, nextCursor: null, candidates: [{
      change: { operation: "add", text: "我喝咖啡不加糖", kind: "preference", factIdentity: identity, scope: { kind: "workspace" }, expiresAt: null }, source: { ...drafts[0]!.source, messageId: "coffee-current", quote: "我喝咖啡不加糖" }, reason: "明确长期偏好",
    }] }, undefined, { boundThreadId: "pending-thread" }); assert.ok(seed.ok, JSON.stringify(seed));
    const seedPreview = await bridge.getMemoryCandidate(seed.value.candidateIds[0]!); assert.ok(seedPreview.ok);
    assert.ok((await bridge.resolveMemoryCandidate(resolvePayload(seedPreview.value, "accept"))).ok);
    const conflict = await app.memoryStore!.commitCandidateBatch({ batchId: "coffee-conflict", originThreadId: "pending-thread", expectedCursor: null, nextCursor: null, candidates: [{
      change: { operation: "add", text: "我喝咖啡加糖", kind: "preference", factIdentity: { ...identity, value: "sweetened" }, scope: { kind: "workspace" }, expiresAt: null }, source: { ...drafts[0]!.source, messageId: "coffee-conflict", quote: "我喝咖啡加糖" }, reason: "和原偏好不同，需确认",
    }] }, undefined, { boundThreadId: "pending-thread" }); assert.ok(conflict.ok, JSON.stringify(conflict));
    const conflictingPreview = await bridge.getMemoryCandidate(conflict.value.candidateIds[0]!); assert.ok(conflictingPreview.ok);
    assert.equal(conflictingPreview.value.applicable, false);
    assert.equal(conflictingPreview.value.unavailableReason, "MEMORY_REVISION_CONFLICT");
    const includingConflict = await loadActionablePending(api, "pending-thread"); assert.ok(includingConflict.ok);
    assert.equal(includingConflict.value.candidates.length, 4, "a real semantic conflict is still pending and can be explicitly rejected, not silently hidden");
    let conflictState = pendingMemoryReducer(initialPendingMemory(), { type: "list-result", request: 0, result: includingConflict });
    conflictState = pendingMemoryReducer(conflictState, { type: "select", id: conflictingPreview.value.candidate.id, request: 1 });
    conflictState = pendingMemoryReducer(conflictState, { type: "detail-result", id: conflictingPreview.value.candidate.id, request: 1, result: conflictingPreview });
    assert.equal(canAccept(conflictState), false); assert.equal(canReject(conflictState), true);
    const conflictCard = renderToStaticMarkup(renderReview(conflictState));
    assert.match(conflictCard, /当前已有不同的有效记忆/);
    assert.match(conflictCard, /disabled=""[^>]*>保存这条记忆/);
    assert.doesNotMatch(conflictCard, /disabled=""[^>]*>不保存这项|MEMORY_REVISION_CONFLICT/);
    const rejected = await bridge.resolveMemoryCandidate(resolvePayload(conflictingPreview.value, "reject")); assert.ok(rejected.ok); assert.equal(rejected.value.status, "rejected");
    const remaining = await loadActionablePending(api, "pending-thread"); assert.ok(remaining.ok); assert.equal(remaining.value.candidates.length, 3);
    const oldDetail = await bridge.getMemoryCandidate(preview.value.candidate.id); assert.ok(oldDetail.ok); assert.equal(oldDetail.value.candidate.status, "accepted");
    const runs = await bridge.listRuns(); assert.ok(runs.ok); assert.equal(runs.runs.length, 0, "human review must not start a model Run");
  } finally { await bridge?.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test("pending read keeps capacity-limited reviews, filters foreign/stale detail, and fails closed on a broken page", async () => {
  const candidate = { id: "limited", originThreadId: "thread", status: "pending" } as import("@aisdk-agent/example-cli/dist/memory-candidates.js").MemoryCandidate;
  const preview = { candidate, current: null, proposed: null, applicable: false, unavailableReason: "MEMORY_LIMIT_EXCEEDED" } as import("@aisdk-agent/example-cli/dist/memory-candidates.js").CandidatePreview;
  const read = await loadActionablePending({ listMemoryCandidates: async () => ({ ok: true, value: { candidates: [candidate, { ...candidate, id: "foreign", originThreadId: "other" }, { ...candidate, id: "stale", status: "stale" }], nextOffset: null, truncated: false } }), getMemoryCandidate: async () => ({ ok: true, value: preview }) }, "thread");
  assert.ok(read.ok); assert.deepEqual(read.value.candidates.map(item => item.id), ["limited"]);
  for (const unavailableReason of ["expired", "target_changed", "target_missing", "MEMORY_REVISION_CONFLICT"]) {
    const pending = await loadActionablePending({ listMemoryCandidates: async () => ({ ok: true, value: { candidates: [candidate], nextOffset: null, truncated: false } }), getMemoryCandidate: async () => ({ ok: true, value: { ...preview, unavailableReason } }) }, "thread");
    assert.ok(pending.ok); assert.equal(pending.value.candidates.length, 1, `${unavailableReason} does not silently settle a pending review`);
  }
  const failed = await loadActionablePending({ listMemoryCandidates: async () => ({ ok: false, error: { code: "READ_FAILED", message: "fixture" } }), getMemoryCandidate: async () => ({ ok: true, value: preview }) }, "thread");
  assert.equal(failed.ok, false, "read failure is not zero pending");
});
