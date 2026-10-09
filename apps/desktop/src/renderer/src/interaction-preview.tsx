// Browser-only interaction fixture. No Electron IPC, model or user workspace.
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import type { AppInfo, MainToRenderer, RendererApi, UiSnapshot } from "../../shared/ui-contract.js";
import "./styles.css";
import type { ConversationDraft, ConversationDraftScope } from "../../shared/conversation-drafts.js";
const previewDrafts = new Map<string, ConversationDraft>();
import { WorkTaskFlowPreview, installWorkTaskFlowApi } from "./work-task-flow-preview.js";

let threadId = "preview-a";
let sequence = 0;
let memoryEnabled = false;
const listeners = new Set<(message: MainToRenderer) => void>();
const threads = [{ threadId, title: "当前对话", transcriptDirectory: "/fixture/transcripts", messageCount: 0 }];
const info = (): AppInfo => ({ entryMode: "test", configPath: "/fixture/config.json", threadId, directory: "/fixture/transcripts", workspaceRoot: "/fixture/workspace",
  modelAlias: "mock", modelId: "UI fixture", temporaryThread: false, temporaryDirectory: false, identitySource: "saved",
  computer: { enabled: false, allowedBundleIds: [] }, tuiMode: true, commands: [], hasCompaction: false, hasResume: false,
  totalTimeoutMs: 600000, shellTimeoutMs: 300000, memory: { enabled: memoryEnabled, autoConsolidate: memoryEnabled, queryRewriteEnabled: memoryEnabled }, workTasks: true, modules: [] });
const snapshot: UiSnapshot = { state: { kind: "idle" }, canSubmit: true, canSteer: false, steers: [], pendingApproval: null, recentOutput: "", outputTruncated: false,
  toolActivity: [], lastPrimaryResult: null, lastConsolidationResult: null, resultTextTruncated: false, shellProgress: [] };
const changeThread = (id: string) => { threadId = id; for (const listener of [...listeners]) listener({ type: "identity-changed", info: info() }); };
const api = {
  loadConversationDraft: async (scope: ConversationDraftScope) => ({ draft: previewDrafts.get(JSON.stringify(scope)) ?? { text: "", excludeFromMemory: false }, uncertainSteer: null }),
  saveConversationDraft: async (scope: ConversationDraftScope, draft: ConversationDraft) => { previewDrafts.set(JSON.stringify(scope), draft); },
  saveTaskDraft: async () => {},
  info: async () => info(), snapshot: async () => structuredClone(snapshot), history: async () => [],
  listRuns: async () => ({ ok: true as const, runs: [] }), home: async () => ({ ok: true as const }),
  onMessage: (listener: (message: MainToRenderer) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  listWorkTasks: async () => ({ ok: true as const, value: [] }), listThreads: async () => structuredClone(threads),
  createThread: async () => { const id = `preview-${++sequence}`; threads.push({ threadId: id, title: "新对话", transcriptDirectory: "/fixture/transcripts", messageCount: 0 }); changeThread(id); },
  selectThread: async (id: string) => { changeThread(id); },
  enableMemory: async () => { memoryEnabled = true; changeThread(threadId); },
  listMemoryCandidates: async () => ({ ok: true as const, value: { candidates: [], nextOffset: null, truncated: false } }),
  listMemories: async () => ({ ok: true as const, value: { entries: [], nextOffset: null } }),
  getMemoryReferences: async () => null,
  getMemoryMaintenance: async () => ({ ok: false as const, error: { code: "MEMORY_READ_FAILED" as const, message: "浏览器 fixture 不读取真实记忆" } }),
  getContextDiagnostics: async () => ({ ok: false as const, error: { code: "IPC_FAILED" as const, message: "隔离 fixture 未准备上下文" } }),
} satisfies Partial<RendererApi>;
window.runloom = new Proxy(api as unknown as RendererApi, { get(target, property) {
  if (property in target) return Reflect.get(target, property);
  return async () => { throw new Error(`Isolated fixture does not implement ${String(property)}`); };
} });
if (new URLSearchParams(location.search).has("work-task-flow")) {
  installWorkTaskFlowApi();
  createRoot(document.getElementById("root")!).render(<WorkTaskFlowPreview />);
} else createRoot(document.getElementById("root")!).render(<App />);
