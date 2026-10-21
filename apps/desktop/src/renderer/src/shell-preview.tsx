// Browser-only fixture: example messages and confirmations, no real model,
// Electron IPC, credentials, disk access or daily-use data. The production App
// and layout are shared; this is not a second frontend or execution loop.
import React from "react";
import { createRoot } from "react-dom/client";
import type { UIMessage } from "ai";
import type { AgentEvent, AgentEventDataMap, AgentEventType, RunResult } from "@serika/core";
import type { AppInfo, ExecutionRunRecord, MainToRenderer, RendererApi, ThreadSummary, UiSnapshot } from "../../shared/ui-contract.js";
import { App } from "./App.js";
import "./styles.css";
import type { ConversationDraft, ConversationDraftScope } from "../../shared/conversation-drafts.js";
const previewDrafts = new Map<string, ConversationDraft>();

let threadId = "zcode-preview-plan";
let sequence = 0;
let activeText = "";
let currentRunId = "preview-run-0";
let startedAt = "";
const receipts = new Map<string, ExecutionRunRecord>();
const listeners = new Set<(message: MainToRenderer) => void>();
const threads: ThreadSummary[] = [
  { threadId: "preview-recap", title: "周复盘的写作格式", transcriptDirectory: "/preview/transcripts", messageCount: 2 },
  { threadId: "preview-rss", title: "整理今天的 RSS 资讯", transcriptDirectory: "/preview/transcripts", messageCount: 2 },
  { threadId: "preview-context", title: "长任务压缩后继续执行", transcriptDirectory: "/preview/transcripts", messageCount: 2 },
  { threadId, title: "Serika 的下一步计划", transcriptDirectory: "/preview/transcripts", messageCount: 2 },
];
const histories = new Map<string, UIMessage[]>([[threadId, [
  { id: "preview-user", role: "user", parts: [{ type: "text", text: "帮我整理一下 Serika 接下来要做的事，别再拆成一堆零碎修补。" }] },
  { id: "preview-assistant", role: "assistant", parts: [{ type: "text", text: "先把日用闭环跑顺，再决定是否增加新能力。\n\n### 接下来只做三件事\n\n1. **记忆真的用起来**：打开旧对话、让助手自动记住，再换一段对话验证召回。\n2. **长任务接得回来**：压缩后退出重开，先读取当前文件，再继续未完成的步骤。\n3. **结果说得清楚**：把已经完成的动作与仍需你确认的事项分开显示。\n\n先完成第一件，再推进第二件。记忆、任务和执行记录仍然可以从左侧打开。" }] },
]]]);
for (const thread of threads) {
  if (!histories.has(thread.threadId)) histories.set(thread.threadId, [
    { id: `${thread.threadId}-user`, role: "user", parts: [{ type: "text", text: thread.title }] },
    { id: `${thread.threadId}-assistant`, role: "assistant", parts: [{ type: "text", text: "这是一段用于比较历史切换布局的示例对话，不读取你的真实历史。切回 Serika 的下一步计划可以继续查看主屏效果。" }] },
  ]);
}
const snapshot: UiSnapshot = { state: { kind: "idle" }, canSubmit: true, canSteer: false, steers: [], pendingApproval: null, recentOutput: "", outputTruncated: false,
  toolActivity: [], lastPrimaryResult: null, lastConsolidationResult: null, resultTextTruncated: false, shellProgress: [] };
let infoPatch: Partial<AppInfo> = {};
const info = (): AppInfo => ({ entryMode: "test", configPath: "/preview/config.json", threadId,
  directory: "/preview/transcripts", workspaceRoot: "/preview/Serika", modelAlias: "mock", modelId: "界面示例（不调用模型）",
  temporaryThread: false, temporaryDirectory: false, identitySource: "saved", computer: { enabled: false, allowedBundleIds: [] },
  tuiMode: true, commands: [], hasResume: false, totalTimeoutMs: 600000, shellTimeoutMs: 300000,
  memory: { enabled: true, autoConsolidate: true }, workTasks: false,
  modules: [{ id: "memory", enabled: true }, { id: "read-file", enabled: true }, { id: "shell", enabled: false }, { id: "task", enabled: false }, { id: "pomodoro", enabled: false }], ...infoPatch });
const emit = (message: MainToRenderer) => { for (const listener of [...listeners]) listener(message); };
const event = <T extends AgentEventType>(type: T, data: AgentEventDataMap[T]) => emit({ type: "event", phase: "primary",
  event: { id: `preview-event-${++sequence}`, runId: currentRunId, threadId, sequence, occurredAt: new Date().toISOString(), type, data } as AgentEvent });
function finish(allowed: boolean) {
  const text = allowed ? "示例确认已接受。这里展示的是界面回执，没有读取真实文件，也没有调用模型。" : "已拒绝这次示例调用，没有读取任何真实文件。";
  const parts: UIMessage["parts"] = allowed
    ? [{ type: "dynamic-tool", toolCallId: "preview-read", toolName: "read_file", state: "output-available", input: { path: "notes/work-plan.md" }, output: { ok: true, content: "示例计划正文" } }, { type: "text", text }]
    : [{ type: "dynamic-tool", toolCallId: "preview-read", toolName: "read_file", state: "output-error", input: { path: "notes/work-plan.md" }, errorText: "TOOL_DENIED: 示例调用被拒绝" }, { type: "text", text }];
  histories.set(threadId, [...histories.get(threadId) ?? [], { id: `preview-user-${sequence}`, role: "user", parts: [{ type: "text", text: activeText }] }, { id: `preview-response-${sequence}`, role: "assistant", parts }]);
  const result: RunResult = { runId: currentRunId, threadId, status: "completed", text, steps: 1, usage: {} };
  const finishedAt = new Date().toISOString();
  receipts.set(currentRunId, { runId: currentRunId, threadId, phase: "primary", status: "completed", startedAt, finishedAt,
    resultTextPreview: text, resultTextTruncated: false, errorPreview: null,
    tools: [{ toolCallId: "preview-read", toolName: "read_file", status: allowed ? "completed" : "not_started",
      requestedAt: startedAt, startedAt: allowed ? startedAt : null, finishedAt,
      inputPreview: JSON.stringify({ path: "notes/work-plan.md" }), inputTruncated: false,
      resultPreview: allowed ? JSON.stringify({ ok: true, content: "示例计划正文" }) : null,
      resultTruncated: false, errorPreview: allowed ? null : "TOOL_DENIED: 示例调用被拒绝", shell: null }] });
  snapshot.pendingApproval = null; snapshot.state = { kind: "idle" }; snapshot.lastPrimaryResult = result;
  emit({ type: "approval-cleared", approvalId: "preview-approval" });
  if (allowed) event("tool.call.completed", { toolCallId: "preview-read", toolName: "read_file", output: { ok: true, content: "示例计划正文" } });
  else event("tool.call.failed", { toolCallId: "preview-read", toolName: "read_file", error: { code: "TOOL_DENIED", message: "示例调用被拒绝", retryable: false, phase: "tool" } });
  emit({ type: "result", phase: "primary", result }); emit({ type: "state", state: snapshot.state });
}
const api = {
  loadConversationDraft: async (scope: ConversationDraftScope) => ({ draft: previewDrafts.get(JSON.stringify(scope)) ?? { text: "", excludeFromMemory: false }, uncertainSteer: null }),
  saveConversationDraft: async (scope: ConversationDraftScope, draft: ConversationDraft) => { previewDrafts.set(JSON.stringify(scope), draft); },
  saveTaskDraft: async () => {},
  info: async () => info(), snapshot: async () => structuredClone(snapshot), history: async () => structuredClone(histories.get(threadId) ?? []),
  historyPage: async () => ({ threadId, messages: structuredClone(histories.get(threadId) ?? []), beforeId: null }),
  listRuns: async () => ({ ok: true as const, runs: [...receipts.values()].filter(run => run.threadId === threadId) }),
  getRun: async (id: string) => ({ ok: true as const, run: receipts.get(id) ?? null }),
  home: async () => ({ ok: true as const }), listThreads: async () => structuredClone(threads),
  onMessage: (listener: (message: MainToRenderer) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  selectThread: async (id: string) => { threadId = id; snapshot.lastPrimaryResult = null; emit({ type: "identity-changed", info: info() }); },
  createThread: async () => { threadId = `preview-new-${++sequence}`; threads.push({ threadId, title: "新对话", transcriptDirectory: "/preview/transcripts", messageCount: 0, emptyVerified: true }); snapshot.lastPrimaryResult = null; emit({ type: "identity-changed", info: info() }); },
  listWorkTasks: async () => ({ ok: true as const, value: [] }),
  listMemories: async () => ({ ok: true as const, value: { entries: [], nextOffset: null } }),
  getMemoryReferences: async () => null,
  getMemoryMaintenance: async () => ({ ok: true as const, value: { stored: 0, pending: 0, expired: 0, disabled: 0, duplicateSuggestions: 0,
    capacity: { entries: 512, bytes: 16 * 1024 * 1024, assertionsPerEntry: 64 }, consolidation: { enabled: true, state: "idle" as const } } }),
  getContextDiagnostics: async () => ({ ok: false as const, error: { code: "IPC_FAILED" as const, message: "浏览器预览不准备真实上下文" } }),
  run: async (text: string) => {
    if (snapshot.state.kind !== "idle") return { ok: false as const, reason: "busy" as const };
    activeText = text;
    currentRunId = `preview-run-${++sequence}`;
    startedAt = new Date().toISOString();
    snapshot.lastPrimaryResult = null;
    emit({ type: "state", state: { kind: "running", runId: null, phase: "primary" } });
    snapshot.state = { kind: "running", runId: currentRunId, phase: "primary" };
    snapshot.pendingApproval = { approvalId: "preview-approval", toolCallId: "preview-read", toolName: "read_file", input: { path: "notes/work-plan.md" }, preview: "界面演示：读取 notes/work-plan.md\n不会读取磁盘；本次允许／拒绝只改变示例界面状态。" };
    emit({ type: "state", state: snapshot.state });
    event("tool.call.requested", { toolCallId: "preview-read", toolName: "read_file", input: { path: "notes/work-plan.md" } });
    emit({ type: "approval", approval: snapshot.pendingApproval });
    return { ok: true as const, runId: currentRunId };
  },
  confirm: async (input: { approvalId: string; decision: "allow" | "deny"; remember?: true }) => {
    if (input.approvalId !== snapshot.pendingApproval?.approvalId) return { accepted: false };
    finish(input.decision === "allow"); return { accepted: true };
  },
  cancel: async () => { if (snapshot.pendingApproval) finish(false); },
} satisfies Partial<RendererApi>;
window.runloom = new Proxy(api as unknown as RendererApi, { get(target, property) {
  if (property in target) return Reflect.get(target, property);
  return async () => { throw new Error(`浏览器界面预览不执行 ${String(property)}；请在 Electron 中使用真实功能。`); };
} });
// Browser regression control (?lifecycle): scripted run/approval/steer/thread flows for the
// App.tsx split checks. Never loaded by Electron.
if (new URLSearchParams(location.search).has("lifecycle")) Object.assign(window, {
  previewFixture: { api, snapshot, emit, event, receipts, runId: () => currentRunId, threadId: () => threadId,
    patchInfo: (patch: Partial<AppInfo>) => { infoPatch = patch; emit({ type: "identity-changed", info: info() }); } },
});
createRoot(document.getElementById("root")!).render(<App initialLayout="serika" />);
