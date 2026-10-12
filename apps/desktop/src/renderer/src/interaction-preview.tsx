// Browser-only interaction fixture. No Electron IPC, model or user workspace.
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { contextBudgetForMode } from "@aisdk-agent/example-cli/dist/context-budget.js";
import type { AppInfo, MainToRenderer, RendererApi, RssWorkerResponse, UiSnapshot } from "../../shared/ui-contract.js";
import type { WorkTask } from "../../shared/work-tasks.js";
import "./styles.css";
import type { ConversationDraft, ConversationDraftScope } from "../../shared/conversation-drafts.js";
import { WorkTaskFlowPreview, installWorkTaskFlowApi } from "./work-task-flow-preview.js";
const previewDrafts = new Map<string, ConversationDraft>();

let threadId = "preview-a";
let sequence = 0;
let memoryEnabled = false;
let contextMode: "daily" | "long-task" = "daily";
const listeners = new Set<(message: MainToRenderer) => void>();
const threads = [
  { threadId, title: "周末想把搜索做成聚光灯", transcriptDirectory: "/fixture/transcripts", messageCount: 2, preview: "周末想把搜索做成聚光灯，按消息找回以前聊过的话。" },
  { threadId: "preview-b", title: "明天早上提醒喝水", transcriptDirectory: "/fixture/transcripts", messageCount: 1, preview: "明天早上提醒我喝水。" },
];
const info = (): AppInfo => ({ entryMode: "test", configPath: "/fixture/config.json", threadId, directory: "/fixture/transcripts", workspaceRoot: "/fixture/workspace",
  modelAlias: "mock", modelId: "UI fixture", temporaryThread: false, temporaryDirectory: false, identitySource: "saved",
  computer: { enabled: false, allowedBundleIds: [] }, tuiMode: true, commands: [], hasCompaction: false, hasResume: false,
  totalTimeoutMs: 600000, shellTimeoutMs: 300000, memory: { enabled: memoryEnabled, autoConsolidate: memoryEnabled, queryRewriteEnabled: memoryEnabled }, workTasks: true,
  modules: [
    { id: "read-file", enabled: true }, { id: "web", enabled: true }, { id: "computer", enabled: false },
    { id: "memory", enabled: memoryEnabled }, { id: "task", enabled: true }, { id: "pomodoro", enabled: true }, { id: "shell", enabled: true },
  ] });
const snapshot: UiSnapshot = { state: { kind: "idle" }, canSubmit: true, canSteer: false, steers: [], pendingApproval: null, recentOutput: "", outputTruncated: false,
  toolActivity: [], lastPrimaryResult: null, lastConsolidationResult: null, resultTextTruncated: false, shellProgress: [] };
const changeThread = (id: string) => { threadId = id; for (const listener of [...listeners]) listener({ type: "identity-changed", info: info() }); };
const briefMode = new URLSearchParams(location.search).get("brief");
const taskFixture = new URLSearchParams(location.search).get("tasks") === "1";

function daysAgo(days: number, hour: number, minute: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

function shanghaiAt(hour: number, minute: number): string {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return new Date(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`).toISOString();
}

function fixtureTask(id: string, status: WorkTask["status"], goal: string, hour: number, minute: number): WorkTask {
  const updatedAt = shanghaiAt(hour, minute);
  return { id, revision: 1, threadId: "preview-a", goal, constraints: [], acceptance: [], status, runIds: [], delivery: null, reconciliations: [], createdAt: updatedAt, updatedAt };
}

function waveTask(id: string, status: WorkTask["status"], goal: string, days: number, hour: number, minute: number): WorkTask {
  const updatedAt = daysAgo(days, hour, minute);
  return {
    id, revision: 2, threadId: "thread_hidden_preview", goal, constraints: [], status, runIds: [], reconciliations: [],
    createdAt: updatedAt, updatedAt,
    acceptance: [{ id: "file", description: "留下今日说明", method: "automatic", verification: { kind: "artifact_exists", path: "notes/morning.md", requireReadback: true }, required: true, status: "passed", evidenceRefs: [], note: null }],
    delivery: id === "task_hidden_wake" ? { summary: "起床啦。先喝口水，慢慢坐起来，今天的事等清醒了再想。", artifactRefs: ["notes/morning.md"], evidence: [], unresolved: [] } : null,
  };
}

function briefTasks(): WorkTask[] {
  if (taskFixture) return [
    waveTask("task_hidden_wake", "awaiting_acceptance", "起床提醒", 1, 10, 53),
    waveTask("task_hidden_research", "paused", "三线关联分析：agent-memory-map × Runloom PR #113 × pi-learn", 3, 16, 5),
  ];
  if (briefMode === "empty" || briefMode === "degraded") return [];
  return [
    fixtureTask("fixture-review", "needs_review", "周末交付的成本说明", 8, 30),
    fixtureTask("fixture-paused", "paused", "长对话分页", 9, 10),
  ];
}

function briefWorker(): RssWorkerResponse {
  if (briefMode === "degraded") return { ok: false, message: "pid 4242 thread_abc12345 /tmp/runloom.sock" };
  if (briefMode === "empty") return { ok: true, registered: false, running: false, rssEnabled: false };
  return { ok: true, registered: true, running: true, rssEnabled: false, notifyEnabled: true, notificationRoutingEnabled: true };
}

function briefOverview() {
  if (taskFixture) return { tasksEnabled: true, diagnostics: { skills: [], hooks: [], recent: [] }, scheduled: [], recurring: [], truncated: false };
  const quiet = briefMode === "empty" || briefMode === "degraded";
  return {
    tasksEnabled: true,
    diagnostics: { skills: [], hooks: [], recent: [] },
    scheduled: quiet ? [] : [{
      id: "fixture-water",
      promptPreview: "喝水",
      runAt: shanghaiAt(20, 30),
      status: "scheduled" as const,
      finishedAt: null,
      resultPreview: null,
      error: null,
      acknowledgedAt: null,
      arrangement: { kind: "reminder" as const, source: "none" as const, notification: "always" as const, declarationVersion: 1 as const },
    }],
    recurring: [],
    truncated: false,
  };
}

function briefInbox() {
  if (taskFixture) return {
    tasks: [{
      id: "task_hidden_return", promptPreview: "起床提醒", runAt: daysAgo(0, 10, 53), status: "completed" as const,
      finishedAt: daysAgo(0, 10, 53), resultPreview: null, error: null, acknowledgedAt: null,
      arrangement: { kind: "reminder" as const, source: "none" as const, notification: "always" as const, declarationVersion: 1 as const },
    }],
    truncated: false,
  };
  if (briefMode === "empty" || briefMode === "degraded") return { tasks: [], truncated: false };
  const rows = [
    ["备份对话框", 8, 10],
    ["移动端确认", 8, 20],
    ["模型测试", 8, 40],
    ["真机通道", 9, 0],
  ] as const;
  return {
    tasks: rows.map(([subject, hour, minute], index) => ({
      id: `fixture-inbox-${index}`,
      promptPreview: subject,
      runAt: shanghaiAt(hour, minute),
      status: "interrupted" as const,
      finishedAt: shanghaiAt(hour, minute),
      resultPreview: null,
      error: null,
      acknowledgedAt: null,
      arrangement: { kind: "reminder" as const, source: "none" as const, notification: "always" as const, declarationVersion: 1 as const },
    })),
    truncated: false,
  };
}

const api = {
  loadConversationDraft: async (scope: ConversationDraftScope) => ({ draft: previewDrafts.get(JSON.stringify(scope)) ?? { text: "", excludeFromMemory: false }, uncertainSteer: null }),
  saveConversationDraft: async (scope: ConversationDraftScope, draft: ConversationDraft) => { previewDrafts.set(JSON.stringify(scope), draft); },
  saveTaskDraft: async () => {},
  info: async () => info(), snapshot: async () => structuredClone(snapshot), history: async () => [],
  historyPage: async () => ({ threadId: info().threadId, messages: [], beforeId: null }),
  listRuns: async () => ({ ok: true as const, runs: [] }), home: async () => ({ ok: true as const }),
  setContextMode: async (input: { mode: "daily" | "long-task" }) => { contextMode = input.mode; },
  onMessage: (listener: (message: MainToRenderer) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  listWorkTasks: async () => ({ ok: true as const, value: briefTasks().map(task => structuredClone(task)) }),
  getWorkTask: async (id: string) => {
    const task = briefTasks().find(item => item.id === id);
    return task ? { ok: true as const, value: structuredClone(task) } : { ok: false as const, error: { code: "WORK_TASK_NOT_FOUND" as const, message: "fixture 没有这件任务" } };
  },
  getAutomationOverview: async () => ({ ok: true as const, value: briefOverview() }),
  rssWorkerStatus: async () => briefWorker(),
  getScheduledTask: async (id: string) => ({
    ok: true as const,
    value: taskFixture ? {
      id, prompt: "起床提醒", runAt: daysAgo(0, 10, 53), status: "completed" as const,
      createdAt: daysAgo(0, 10, 53), startedAt: daysAgo(0, 10, 53), finishedAt: daysAgo(0, 10, 53),
      threadId: null, runId: null, resultText: "起床啦。先喝口水，慢慢坐起来。", error: null, recurringTaskId: null,
      acknowledgedAt: null, attempts: [], retryAt: null, notification: null, pendingOutcome: null,
      arrangement: { kind: "reminder" as const, source: "none" as const, notification: "always" as const, declarationVersion: 1 as const },
    } : {
      id, prompt: "喝水", runAt: shanghaiAt(20, 30), status: "interrupted" as const,
      createdAt: shanghaiAt(8, 10), startedAt: null, finishedAt: shanghaiAt(8, 10),
      threadId: null, runId: null, resultText: null, error: null, recurringTaskId: null,
      acknowledgedAt: shanghaiAt(8, 11), attempts: [], retryAt: null, notification: null, pendingOutcome: null,
    },
  }),
  takeTaskResultOpen: async () => null,
  getTaskInbox: async () => ({ ok: true as const, value: briefInbox() }),
  listThreads: async (query?: string) => {
    const needle = (query ?? "").trim().toLocaleLowerCase();
    return threads.map(item => ({ ...item, matchesQuery: !needle || `${item.title} ${item.preview}`.toLocaleLowerCase().includes(needle) }));
  },
  createThread: async () => { const id = `preview-${++sequence}`; threads.push({ threadId: id, title: "新对话", transcriptDirectory: "/fixture/transcripts", messageCount: 0, preview: "" }); changeThread(id); },
  selectThread: async (id: string) => { changeThread(id); },
  enableMemory: async () => { memoryEnabled = true; changeThread(threadId); },
  listMemoryCandidates: async () => ({ ok: true as const, value: { candidates: [], nextOffset: null, truncated: false } }),
  listMemories: async () => ({ ok: true as const, value: { entries: [], nextOffset: null } }),
  getMemoryReferences: async () => null,
  getMemoryMaintenance: async () => ({ ok: false as const, error: { code: "MEMORY_READ_FAILED" as const, message: "浏览器 fixture 不读取真实记忆" } }),
  getContextDiagnostics: async () => ({ ok: true as const, value: { threadId, enabled: true, budget: contextBudgetForMode(contextMode), estimatorVersion: "char-half/v1" as const, latestValidCompaction: null, lastPreparation: null } }),
  notificationStatus: async () => ({ helperConfigured: false, authorization: "unknown" as const, message: "通知未配置。" }),
} satisfies Partial<RendererApi>;
window.runloom = new Proxy(api as unknown as RendererApi, { get(target, property) {
  if (property in target) return Reflect.get(target, property);
  return async () => { throw new Error(`Isolated fixture does not implement ${String(property)}`); };
} });
if (new URLSearchParams(location.search).has("work-task-flow")) {
  installWorkTaskFlowApi();
  createRoot(document.getElementById("root")!).render(<WorkTaskFlowPreview />);
} else createRoot(document.getElementById("root")!).render(<App />);
