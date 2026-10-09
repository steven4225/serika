// Isolated browser fixture; no Electron IPC, real model or user workspace.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryPanel } from "./memory.js";
import { MemoryReferences } from "./memory-references.js";
import "./styles.css";
import type { RendererApi } from "../../shared/ui-contract.js";
import type { FormalMemory } from "@aisdk-agent/example-cli/dist/memory-management.js";
let changed = () => {};
let memory: FormalMemory = { id: "fixture-writing", text: "复盘先给一行结论，再列两条可执行步骤。", revision: 1, enabled: true, status: "active", scope: { kind: "workspace" }, pinned: false, expiresAt: null, source: { kind: "conversation", threadId: "fixture-a", messageId: "fixture-source", quote: "我的复盘偏好是：先给一行结论，再列两条可执行步骤。" } };
const fixtureApi: Pick<RendererApi, "listMemories" | "getMemory" | "updateMemory" | "listMemoryCandidates" | "getMemoryReferences"> = {
  listMemories: async () => ({ ok: true, value: { entries: [{ ...memory, preview: memory.text, truncated: false }], nextOffset: null } }),
  getMemory: async () => ({ ok: true, value: structuredClone(memory) }),
  updateMemory: async input => {
    if (input.expectedRevision !== memory.revision) return { ok: false, error: { code: "MEMORY_REVISION_CONFLICT", message: "fixture conflict" } };
    memory = { ...memory, ...input, revision: (memory.revision ?? 1) + 1, ...(input.status === "disabled" ? { enabled: false } : {}), ...(input.text ? { source: { kind: "manual" } } : {}) };
    changed();
    return { ok: true, value: structuredClone(memory) };
  },
  listMemoryCandidates: async () => ({ ok: true, value: { candidates: [], nextOffset: null, truncated: false } }),
  getMemoryReferences: async () => ({ runId: "fixture-run", messageId: "fixture-user", preparedAt: "2026-10-04T00:00:00Z", temporalView: { validAt: "2026-10-04T00:00:00Z", knownAt: "2026-10-04T00:00:00Z" }, selected: [{ id: memory.id, revision: 1, text: "复盘先给一行结论，再列两条可执行步骤。", reason: "matched" }], rewrite: "off", truncated: false, queryTruncated: false }),
};
window.runloom = fixtureApi as RendererApi;
function Preview() {
  const [refresh, setRefresh] = useState(0);
  changed = () => setRefresh(value => value + 1);
  return <main style={{ padding: 24, maxWidth: 680, margin: "0 auto", overflow: "auto", height: "100vh", boxSizing: "border-box" }}>
    <p className="hint">隔离 UI fixture · Mock 数据 · 不代表 Electron 或真实模型验收</p>
    <MemoryPanel memory={{ enabled: true, autoConsolidate: false }} temporaryThread={false} controllerIdle refreshToken={refresh} />
    <MemoryReferences refreshToken={refresh} runId="fixture-run" starting={false} />
    <button className="ghost" onClick={() => { memory = { ...memory, text: "外部更新的正文", revision: (memory.revision ?? 1) + 1 }; changed(); }}>模拟外部版本更新</button>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
