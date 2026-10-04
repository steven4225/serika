// Browser-only interaction fixture. No Electron IPC, model or user workspace.
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import type { AppInfo, MainToRenderer, RendererApi, UiSnapshot } from "../../shared/ui-contract.js";
import "./styles.css";

let threadId = "preview-a";
let sequence = 0;
const listeners = new Set<(message: MainToRenderer) => void>();
const threads = [{ threadId, title: "当前对话", transcriptDirectory: "/fixture/transcripts", messageCount: 0 }];
const info = (): AppInfo => ({ entryMode: "test", threadId, directory: "/fixture/transcripts", workspaceRoot: "/fixture/workspace",
  modelAlias: "mock", modelId: "UI fixture", temporaryThread: false, temporaryDirectory: false, identitySource: "saved",
  computer: { enabled: false, allowedBundleIds: [] }, tuiMode: true, commands: [], hasCompaction: false, hasResume: false,
  totalTimeoutMs: 600000, shellTimeoutMs: 300000, memory: { enabled: false, autoConsolidate: false }, workTasks: true, modules: [] });
const snapshot: UiSnapshot = { state: { kind: "idle" }, pendingApproval: null, recentOutput: "", outputTruncated: false,
  toolActivity: [], lastPrimaryResult: null, lastConsolidationResult: null, resultTextTruncated: false, shellProgress: [] };
const changeThread = (id: string) => { threadId = id; for (const listener of [...listeners]) listener({ type: "identity-changed", info: info() }); };
const api = {
  info: async () => info(), snapshot: async () => structuredClone(snapshot), history: async () => [],
  listRuns: async () => ({ ok: true as const, runs: [] }), home: async () => ({ ok: true as const }),
  onMessage: (listener: (message: MainToRenderer) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  listWorkTasks: async () => ({ ok: true as const, value: [] }), listThreads: async () => structuredClone(threads),
  createThread: async () => { const id = `preview-${++sequence}`; threads.push({ threadId: id, title: "新对话", transcriptDirectory: "/fixture/transcripts", messageCount: 0 }); changeThread(id); },
  selectThread: async (id: string) => { changeThread(id); },
  getContextDiagnostics: async () => ({ ok: false as const, error: { code: "IPC_FAILED" as const, message: "隔离 fixture 未准备上下文" } }),
} satisfies Partial<RendererApi>;
window.runloom = new Proxy(api as unknown as RendererApi, { get(target, property) {
  if (property in target) return Reflect.get(target, property);
  return async () => { throw new Error(`Isolated fixture does not implement ${String(property)}`); };
} });
createRoot(document.getElementById("root")!).render(<App />);
