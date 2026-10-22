// Isolated browser fixture; no Electron IPC, real model or user workspace.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type { FormalMemory } from "@serika/assistant";
import type { MemorySource } from "@serika/assistant";
import type { RendererApi } from "../../shared/ui-contract.js";
import { MemoryPanel } from "./memory.js";
import { MemoryReferences } from "./memory-references.js";
import "./styles.css";
import "./personal/shell.css";
import "./personal/memory.css";

function daysAgo(days: number): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

function remembered(input: { id: string; text: string; kind: "preference" | "fact" | "note"; updatedDays: number; sources: MemorySource[] }): FormalMemory {
  for (const source of input.sources) if (source.kind === "conversation") quotes.set(`${input.id}:${source.messageId}`, source.quote);
  const updatedAt = daysAgo(input.updatedDays);
  const source = input.sources[0] ?? { kind: "manual" as const };
  return {
    id: input.id, text: input.text, revision: 2, enabled: true, status: "active", pinned: false, expiresAt: null,
    scope: { kind: "workspace" }, createdAt: daysAgo(input.updatedDays + 2), updatedAt, source,

  };
}

const quote = (messageId: string, text: string) => ({ kind: "conversation" as const, threadId: "fixture-a", messageId, quote: text, sentAt: null });
const quotes = new Map<string, string>();
let memories: FormalMemory[] = [
  remembered({ id: "fixture-writing", kind: "preference", updatedDays: 1, text: "复盘先给一行结论，再列两条可执行步骤。", sources: [quote("fixture-source", "我的复盘偏好是：先给一行结论，再列两条可执行步骤。")] }),
  remembered({ id: "fixture-coffee", kind: "fact", updatedDays: 3, text: "咖啡不加糖。", sources: [quote("coffee-source", "咖啡不加糖。")] }),
  remembered({
    id: "fixture-background", kind: "note", updatedDays: 3,
    text: "## 教育背景\n- 宁波大学，计算机科学与技术\n\n## 编程语言\n- 主力：TypeScript（AI agent 运行时、Next.js 全栈）",
    sources: [quote("edu-source", "我是宁波大学计算机专业。"), { kind: "manual" }],
  }),
  remembered({ id: "fixture-work", kind: "fact", updatedDays: 0, text: "当前在做 Serika 桌面助手，主要写 TypeScript。", sources: [quote("work-source", "我现在主要在做桌面助手。")] }),
];
let changed = () => {};
const byId = (id: string) => memories.find(item => item.id === id) ?? memories[0]!;
const fixtureApi: Pick<RendererApi, "listMemories" | "getMemory" | "getMemoryMaintenance" | "updateMemory" | "getMemoryReferences"> = {
  listMemories: async () => ({ ok: true, value: { entries: memories.map(item => { const { text, source: _source, ...rest } = item; return { ...rest, sourceKinds: item.source ? [{ kind: item.source.kind }] : [], preview: Array.from(text).slice(0, 120).join(""), truncated: Array.from(text).length > 120 }; }), nextOffset: null } }),
  getMemory: async id => ({ ok: true, value: structuredClone(byId(id)) }),
  getMemoryMaintenance: async () => ({ ok: true, value: { stored: memories.length, disabled: 0, capacity: { entries: 512, bytes: 16 * 1024 * 1024 }, consolidation: { enabled: true, state: "idle" } } }),
  updateMemory: async input => {
    const current = byId(input.id);
    if (input.expectedRevision !== current.revision) return { ok: false, error: { code: "MEMORY_REVISION_CONFLICT", message: "fixture conflict" } };
    const next = { ...current, ...input, revision: (current.revision ?? 1) + 1, ...(input.status === "disabled" ? { enabled: false } : {}), ...(input.text ? { source: { kind: "manual" as const } } : {}) };
    memories = memories.map(item => item.id === input.id ? next : item);
    changed();
    return { ok: true, value: structuredClone(next) };
  },
  getMemoryReferences: async () => ({ runId: "fixture-run", messageId: "fixture-user", preparedAt: daysAgo(0), selected: [{ id: memories[0]!.id, revision: 1, text: memories[0]!.text, reason: "snapshot" }], referenceBytes: 128, eligibleCount: 1, truncated: false }),
};
window.runloom = fixtureApi as RendererApi;
function Preview() {
  const [refresh, setRefresh] = useState(0);
  changed = () => setRefresh(value => value + 1);
  return <div className="serika-personal-shell" style={{ height: "100vh" }}>
    <main className="personal-layout" style={{ height: "100%", overflow: "auto", background: "var(--personal-today-background)" }}>
    <p className="hint" style={{ padding: "12px 24px 0" }}>隔离 UI fixture · Mock 数据 · 不代表 Electron 或真实模型验收</p>
    <section className="personal-dashboard" style={{ minHeight: "100%", background: "transparent", maxWidth: 520, width: "100%", margin: "0 auto" }}>
      <div className="inspector-pane">
        <MemoryPanel memory={{ enabled: true, autoConsolidate: true, writePolicy: "automatic" }} temporaryThread={false} controllerIdle refreshToken={refresh} />
        <MemoryReferences refreshToken={refresh} runId="fixture-run" starting={false} />
        <button className="ghost" onClick={() => { memories = memories.map(item => item.id === "fixture-writing" ? { ...item, text: "外部更新的正文", revision: (item.revision ?? 1) + 1 } : item); changed(); }}>模拟外部版本更新</button>
      </div>
    </section>
    </main>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
