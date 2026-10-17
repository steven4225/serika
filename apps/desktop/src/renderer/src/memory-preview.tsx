// Isolated browser fixture; no Electron IPC, real model or user workspace.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type { FormalMemory } from "@serika/assistant";
import type { MemoryAssertion } from "@serika/assistant";
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

function remembered(input: { id: string; text: string; kind: "preference" | "fact" | "note"; updatedDays: number; sources: MemoryAssertion["sources"]; factIdentity?: NonNullable<FormalMemory["assertion"]>["factIdentity"] }): FormalMemory {
  for (const source of input.sources) if (source.kind === "conversation") quotes.set(`${input.id}:${source.messageId}`, source.quote);
  const updatedAt = daysAgo(input.updatedDays);
  const source = input.sources[0] ?? { kind: "manual" as const };
  return {
    id: input.id, text: input.text, revision: 2, enabled: true, status: "active", pinned: false, expiresAt: null,
    scope: { kind: "workspace" }, createdAt: daysAgo(input.updatedDays + 2), updatedAt, temporalState: "applicable", source,
    assertion: {
      assertionId: `${input.id}-assertion`, kind: input.kind, recallTerms: [], state: "asserted",
      ...(input.factIdentity ? { factIdentity: input.factIdentity } : {}),
      validTime: { from: null, to: null, basis: "unknown" }, systemTime: { from: updatedAt, to: null },
      sourceIds: input.sources.map(item => item.kind === "conversation" ? { kind: item.kind, threadId: item.threadId, messageId: item.messageId } : { kind: item.kind }),
    },
  };
}

const quote = (messageId: string, text: string) => ({ kind: "conversation" as const, threadId: "fixture-a", messageId, quote: text });
const quotes = new Map<string, string>();
let memories: FormalMemory[] = [
  remembered({ id: "fixture-writing", kind: "preference", updatedDays: 1, text: "复盘先给一行结论，再列两条可执行步骤。", sources: [quote("fixture-source", "我的复盘偏好是：先给一行结论，再列两条可执行步骤。")] }),
  remembered({ id: "fixture-coffee", kind: "fact", updatedDays: 3, text: "咖啡不加糖。", factIdentity: { attribute: "coffee", scenario: "personal", value: "unsweetened" }, sources: [quote("coffee-source", "咖啡不加糖。")] }),
  remembered({
    id: "fixture-background", kind: "note", updatedDays: 3,
    text: "## 教育背景\n- 宁波大学，计算机科学与技术\n\n## 编程语言\n- 主力：TypeScript（AI agent 运行时、Next.js 全栈）",
    sources: [quote("edu-source", "我是宁波大学计算机专业。"), { kind: "manual" }],
  }),
  remembered({ id: "fixture-work", kind: "fact", updatedDays: 0, text: "当前在做 Serika 桌面助手，主要写 TypeScript。", sources: [quote("work-source", "我现在主要在做桌面助手。")] }),
];
let changed = () => {};
const byId = (id: string) => memories.find(item => item.id === id) ?? memories[0]!;
const fixtureApi: Pick<RendererApi, "listMemories" | "getMemory" | "getMemoryHistory" | "getMemoryMaintenance" | "updateMemory" | "listMemoryCandidates" | "getMemoryReferences"> = {
  listMemories: async () => ({ ok: true, value: { entries: memories.map(item => { const { text, source: _source, ...rest } = item; return { ...rest, preview: Array.from(text).slice(0, 120).join(""), truncated: Array.from(text).length > 120 }; }), nextOffset: null } }),
  getMemory: async id => ({ ok: true, value: structuredClone(byId(id)) }),
  getMemoryHistory: async ({ id }) => {
    const item = byId(id);
    const sources = item.assertion?.sourceIds.map(source => source.kind === "conversation" ? quote(source.messageId, quotes.get(`${item.id}:${source.messageId}`) ?? "原话未附带") : source) ?? [];
    return { ok: true, value: { id: item.id, revision: item.revision ?? 1, historyCoverage: "complete", nextOffset: null, versions: [{ revision: item.revision ?? 1, assertionId: item.assertion?.assertionId ?? id, scope: { kind: "workspace" }, pinned: false, status: "active", expiresAt: null, changedAt: item.updatedAt ?? null }], assertions: [{ assertionId: item.assertion?.assertionId ?? id, text: item.text, kind: item.assertion?.kind ?? "note", recallTerms: [], validTime: { from: null, to: null, basis: "unknown" }, systemTime: { from: item.updatedAt ?? null, to: null }, state: "asserted", sources }] } };
  },
  getMemoryMaintenance: async () => ({ ok: true, value: { stored: memories.length, pending: 0, expired: 0, disabled: 0, duplicateSuggestions: 0, capacity: { entries: 512, bytes: 16 * 1024 * 1024, assertionsPerEntry: 64 }, consolidation: { enabled: true, state: "idle" } } }),
  updateMemory: async input => {
    const current = byId(input.id);
    if (input.expectedRevision !== current.revision) return { ok: false, error: { code: "MEMORY_REVISION_CONFLICT", message: "fixture conflict" } };
    const next = { ...current, ...input, revision: (current.revision ?? 1) + 1, ...(input.status === "disabled" ? { enabled: false } : {}), ...(input.text ? { source: { kind: "manual" as const } } : {}) };
    memories = memories.map(item => item.id === input.id ? next : item);
    changed();
    return { ok: true, value: structuredClone(next) };
  },
  listMemoryCandidates: async () => ({ ok: true, value: { candidates: [], nextOffset: null, truncated: false } }),
  getMemoryReferences: async () => ({ runId: "fixture-run", messageId: "fixture-user", preparedAt: daysAgo(0), temporalView: { validAt: daysAgo(0), knownAt: daysAgo(0) }, selected: [{ id: memories[0]!.id, revision: 1, text: memories[0]!.text, reason: "matched" }], rewrite: "off", truncated: false, queryTruncated: false }),
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
