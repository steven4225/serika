import React, { useEffect, useRef, useState } from "react";
import type { AppInfo } from "../../shared/ui-contract.js";
import type { MemoryMaintenance } from "@aisdk-agent/example-cli/dist/memory-controls.js";
import type { MemoryActionPreview } from "@aisdk-agent/example-cli/dist/memory-controls.js";
import type { FormalMemory } from "@aisdk-agent/example-cli/dist/memory-management.js";
import type { MemoryResult } from "@aisdk-agent/example-cli/dist/memory-candidates.js";
import type { MemoryConsolidationSource, MemoryConsolidationRequest } from "@aisdk-agent/example-cli/dist/memory-consolidation.js";
import { memoryConsolidationFailureText } from "@aisdk-agent/example-cli/dist/memory-failure.js";
import { memoryAutomaticUpgradeNeeded } from "./daily-setup.js";
import { MemoryActionPreviewDetails, MemorySources } from "./memory-temporal.js";
import { memoryAutomationLabel } from "./memory-copy.js";

const labels = { off: memoryAutomationLabel({ enabled: true, autoConsolidate: false }), backlog: "等待记忆整理", running: "正在整理记忆", failed: "记忆整理失败", awaiting_review: "等待你审核候选", idle: "没有待整理的新增记忆材料" };
type SavedMemoryReceipt = NonNullable<NonNullable<MemoryMaintenance["consolidation"]["lastAttempt"]>["accepted"]>[number] & {
  operation?: "add" | "update" | "correct" | "change" | "retract" | "disable";
};

export function memoryReceiptPresentation(receipt: SavedMemoryReceipt): { label: string; undoLabel: string | null } {
  switch (receipt.operation) {
    case "add": return { label: "已记住", undoLabel: "撤回…" };
    case "update": case "correct": case "change": return { label: "已更新", undoLabel: "撤回整条记忆…" };
    case "retract": return { label: "已撤回", undoLabel: null };
    case "disable": return { label: "已停用", undoLabel: null };
    default: return { label: "已处理", undoLabel: "撤回整条记忆…" };
  }
}

export function memoryReceiptSummary(accepted: readonly SavedMemoryReceipt[]): string {
  return accepted.every(receipt => receipt.operation === "add")
    ? `已记住 ${accepted.length} 条信息` : `已处理 ${accepted.length} 条记忆`;
}

/** Undo binds to the saved revision, never to whatever newer value now occupies that id. */
export async function previewAutomaticMemoryUndo(receipt: SavedMemoryReceipt, api: Pick<Window["runloom"], "getMemory" | "previewMemoryAction">): Promise<MemoryResult<MemoryActionPreview>> {
  if (memoryReceiptPresentation(receipt).undoLabel === null) return { ok: false, error: { code: "INVALID_INPUT", message: "这条记忆已经撤回或停用，请在记忆详情中查看历史；不会再次撤回。" } };
  const current = await api.getMemory(receipt.memoryId);
  if (!current.ok) return current;
  if (current.value.revision !== receipt.revision) return { ok: false, error: { code: "MEMORY_REVISION_CONFLICT", message: "这条记忆已有后续修改，请在记忆详情中核对当前版本；不会撤回新内容。" } };
  return api.previewMemoryAction({ operation: "retract", id: receipt.memoryId, expectedRevision: receipt.revision });
}

function AutomaticMemoryReceipts({ accepted, busy, refreshToken }: { accepted: readonly SavedMemoryReceipt[]; busy: boolean; refreshToken: number }) {
  const [current, setCurrent] = useState<FormalMemory | null>(null);
  const [preview, setPreview] = useState<MemoryActionPreview | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [undone, setUndone] = useState<string[]>([]);
  const generation = useRef(0);
  const receiptKey = accepted.map(receipt => `${receipt.memoryId}:${receipt.revision}:${receipt.operation ?? "unknown"}`).join("|");
  useEffect(() => { generation.current++; setPreview(null); setCurrent(null); setError(""); }, [refreshToken, receiptKey, busy]);
  const act = async (operation: (isCurrent: () => boolean) => Promise<void>) => {
    if (busy || working) return;
    const requestGeneration = generation.current;
    setWorking(true); setError(""); setPreview(null);
    try { await operation(() => generation.current === requestGeneration); } catch (cause) { if (generation.current === requestGeneration) setError(String(cause)); }
    finally { setWorking(false); }
  };
  if (!accepted.length) return null;
  return <section aria-label="最近一次自动处理的记忆">
    <div className="memory-label">最近处理的正式记忆</div>
    {accepted.map(receipt => <div className="memory-actions" key={`${receipt.memoryId}:${receipt.revision}`}>
      <span>{undone.includes(receipt.memoryId) ? "已撤回" : memoryReceiptPresentation(receipt).label} · <code>{receipt.memoryId}</code> · 版本 {receipt.revision}</span>
      <button className="ghost" disabled={busy || working} onClick={() => void act(async isCurrent => {
        const result = await window.runloom.getMemory(receipt.memoryId);
        if (!isCurrent()) return;
        if (result.ok) setCurrent(result.value); else setError(`${result.error.code}: ${result.error.message}`);
      })}>查看</button>
      {memoryReceiptPresentation(receipt).undoLabel !== null ? <button className="ghost" disabled={busy || working || undone.includes(receipt.memoryId)} onClick={() => void act(async isCurrent => {
        const result = await previewAutomaticMemoryUndo(receipt, window.runloom);
        if (!isCurrent()) return;
        if (result.ok) { setCurrent(result.value.current); setPreview(result.value); }
        else setError(`${result.error.code}: ${result.error.message}`);
      })}>{memoryReceiptPresentation(receipt).undoLabel}</button> : null}
    </div>)}
    {current && !preview ? <div className="memory-current-content"><pre className="memory-text">{current.text || "当前没有适用内容"}</pre>
      <p className="hint">当前版本 {current.revision}；此处读取的是当前正式记忆，不是历史写入回执。</p>
      <MemorySources sources={current.source ? [current.source] : []} />
    </div> : null}
    {preview ? <div role="group" aria-label="撤回自动记忆预览"><p className="hint">这会撤回当前整条记忆，不是恢复到修改前的版本。若要恢复旧内容，请在记忆详情中选择历史版本。</p><MemoryActionPreviewDetails preview={preview} />
      <div className="memory-actions"><button disabled={busy || working} onClick={() => {
        const input = preview.input;
        void act(async () => {
          const result = await window.runloom.applyMemoryAction(input);
          if (!result.ok) { setError(`${result.error.code}: ${result.error.message}`); return; }
          setCurrent(result.value); setUndone(previous => [...previous, input.id]);
        });
      }}>确认撤回</button><button className="ghost" disabled={working} onClick={() => setPreview(null)}>保留</button></div>
    </div> : null}
    {error ? <p className="error" role="alert">{error}</p> : null}
  </section>;
}

export function consolidationStatusLabel(enabled: boolean, maintenance: MemoryMaintenance | null, error: string): string {
  if (!enabled) return "记忆未启用";
  if (error) return "记忆整理状态读取失败";
  if (!maintenance) return "正在读取记忆状态…";
  const consolidation = maintenance.consolidation;
  const accepted = consolidation.lastAttempt?.accepted ?? [];
  const saved = accepted.length;
  if (consolidation.lastAttempt?.status === "completed" && saved > 0) {
    if (consolidation.state === "idle") return memoryReceiptSummary(accepted);
    if (consolidation.state === "awaiting_review") return `${memoryReceiptSummary(accepted)}；另有候选需要审核`;
  }
  if (consolidation.state === "idle" && consolidation.lastAttempt?.status === "completed" && consolidation.lastAttempt.candidateCount === 0 && saved === 0) return "记忆整理完成，没有新增候选";
  return labels[consolidation.state];
}

/** Saved receipts and unresolved proposals are distinct; saves do not require another approval. */
export function MemoryConsolidationNotice({ enabled, busy, running = false, quiet = false, refreshToken, onOpen }: {
  enabled: boolean; busy: boolean; running?: boolean; quiet?: boolean; refreshToken: number; onOpen: () => void;
}) {
  const [maintenance, setMaintenance] = useState<MemoryMaintenance | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setMaintenance(null);
    void window.runloom.getMemoryMaintenance().then(result => {
      if (cancelled) return;
      if (result.ok) { setMaintenance(result.value); setError(""); }
      else { setMaintenance(null); setError(`${result.error.code}: ${result.error.message}`); }
    }).catch(cause => { if (!cancelled) { setMaintenance(null); setError(String(cause)); } });
    return () => { cancelled = true; };
  }, [enabled, busy, refreshToken]);
  if (!enabled) return null;
  const c = maintenance?.consolidation;
  const accepted = c?.lastAttempt?.accepted ?? [];
  const emptyAttempt = c?.state === "idle" && c.lastAttempt?.status === "completed" && c.lastAttempt.candidateCount === 0;
  if (quiet && !running && !error && accepted.length === 0 && emptyAttempt) return null;
  if (!running && !error && !emptyAttempt && accepted.length === 0 && c?.state !== "failed" && c?.state !== "backlog" && c?.state !== "running") return null;
  const title = running ? labels.running : consolidationStatusLabel(enabled, maintenance, error);
  return <div className="memory-consolidation"><div className="attention-summary" role="status"><span>{title}{c?.state === "backlog" && c.backlogCount !== undefined ? `（${c.backlogCount} 条取材范围内消息）` : ""}</span><button className="ghost" onClick={onOpen}>查看记忆</button></div>
    <AutomaticMemoryReceipts accepted={accepted} busy={busy} refreshToken={refreshToken} />
  </div>;
}

export function MemoryConsolidationPanel({ info, busy, refreshToken, onSettings }: { info: AppInfo; busy: boolean; refreshToken: number; onSettings?: () => void }) {
  const [maintenance, setMaintenance] = useState<MemoryMaintenance | null>(null);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState(false);
  const [sources, setSources] = useState<MemoryConsolidationSource[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [sourcesLoaded, setSourcesLoaded] = useState(false);
  const [statusRefresh, setStatusRefresh] = useState(0);
  useEffect(() => {
    if (!info.memory.enabled) return;
    let cancelled = false;
    setMaintenance(null);
    void window.runloom.getMemoryMaintenance().then(result => {
      if (cancelled) return;
      if (result.ok) { setMaintenance(result.value); setStatusError(""); }
      else { setMaintenance(null); setStatusError(`${result.error.code}: ${result.error.message}`); }
    }).catch(cause => { if (!cancelled) { setMaintenance(null); setStatusError(String(cause)); } });
    return () => { cancelled = true; };
  }, [info.memory.enabled, refreshToken, busy, statusRefresh]);
  const act = async (operation: () => Promise<void>) => {
    if (busy || working) return;
    setWorking(true); setError(""); setNotice("");
    try { await operation(); } catch (cause) { setError(String(cause)); } finally { setWorking(false); }
  };
  const consolidate = (request: MemoryConsolidationRequest) => act(async () => {
    const result = await window.runloom.consolidateMemory(request);
    if (!result.ok) setError(`${result.error.code}: ${result.error.message}`);
    else { setNotice(info.memory.writePolicy === "automatic" ? "记忆整理已开始。明确、可溯源的普通信息会自动保存；有歧义的候选仍需审核。" : "记忆整理已开始。当前为人工审核模式，接受候选前不会保存为正式记忆。"); setSelected([]); setStatusRefresh(value => value + 1); }
  });
  const loadSources = (offset = 0) => act(async () => {
    const result = await window.runloom.listMemoryConsolidationSources(offset);
    if (!result.ok) { setError(`${result.error.code}: ${result.error.message}`); return; }
    setSources(previous => offset ? [...previous, ...result.value.sources] : result.value.sources);
    setNextOffset(result.value.nextOffset);
    setSourcesLoaded(true);
    if (!offset) setSelected([]);
  });
  const c = maintenance?.consolidation;
  return <section className="card memory-consolidation" aria-label="记忆整理状态">
    <div className="card-head"><span>{consolidationStatusLabel(info.memory.enabled, maintenance, statusError)}</span>
      {info.memory.enabled && info.memory.autoConsolidate && (c?.state === "failed" || c?.state === "backlog") ? <button className="ghost" disabled={busy || working || maintenance === null || maintenance.pending >= 64} onClick={() => void consolidate({ mode: "incremental" })}>{c?.state === "failed" ? "重试记忆整理" : "整理待处理记忆材料"}</button> : null}
    </div>
    {c?.state !== "off" ? <p className="hint">{memoryAutomationLabel(info.memory)}</p> : null}
    {info.memory.enabled && info.memory.autoConsolidate ? <p className="hint">{info.memory.writePolicy === "automatic" ? "明确偏好会自动记住；有歧义才需要你点一下。" : "当前为人工审核模式，确认后才会记住。"}</p> : null}
    {memoryAutomaticUpgradeNeeded(info) ? <button className="ghost" disabled={!onSettings} onClick={onSettings}>在工作区设置</button> : null}
    {c?.error ? <><p className="error" role="alert">{memoryConsolidationFailureText(c.error)}</p><details><summary>技术详情</summary><pre>{c.error}</pre></details></> : null}
    {maintenance && maintenance.pending >= 64 ? <p className="hint">待审核候选已达到上限，请先接受或拒绝候选，再整理新材料。暂时不审核不会丢弃候选。</p> : null}
    {statusError ? <><p className="error" role="alert">{statusError}。不能据此判断没有待整理记忆材料或候选。</p><button className="ghost" disabled={working} onClick={() => setStatusRefresh(value => value + 1)}>重新读取记忆整理状态</button></> : null}
    {error ? <p className="error" role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    <details className="memory-maintenance-disclosure">
      <summary>高级：记忆整理与历史补整理</summary>
    <AutomaticMemoryReceipts accepted={c?.lastAttempt?.accepted ?? []} busy={busy || working} refreshToken={refreshToken} />
    {!info.memory.enabled || !info.memory.autoConsolidate ? <>
      <p className="hint">可在工作区开启记忆自动整理：从已提交原话保存明确的普通长期信息，有歧义的建议留待审核。同义提问可额外发送一次有界查询。</p>
      {!info.workspaceRoot ? <p className="hint">当前配置没有 workspace，请先设置工作区。</p> : null}
    </> : <>
      <p className="hint">新对话成功结束后在空闲时整理记忆，新的聊天优先。首次最多取最近 8 条；更早的内容须由你选择补整理记忆。当前{info.memory.writePolicy === "automatic" ? "明确事实自动保存，有歧义的候选才需审核" : "所有候选接受后才保存"}。</p>
    </>}
    {!memoryAutomaticUpgradeNeeded(info) ? <button className="ghost" disabled={!onSettings} onClick={onSettings}>在工作区设置</button> : null}
    {c?.state === "running" ? <p className="hint" role="status">正在从已提交的用户原话整理记忆，新的对话可以优先处理。失败可以重试，不会批量接受旧候选。</p> : null}
    {c?.backlogCount !== undefined ? <p className="hint">自动取材范围内待处理：{c.backlogCount} 条用户消息。这个数量不代表所有旧历史。</p> : null}
    {c?.lastSkippedReason ? <p className="hint">本轮未整理记忆：{c.lastSkippedReason}。</p> : null}
    {c?.lastAttempt ? <p className="hint">最近一次{c.lastAttempt.mode === "history" ? "历史记忆补整理" : "增量记忆整理"}：{c.lastAttempt.status === "failed" ? "失败" : `核对 ${c.lastAttempt.processedCount} 条材料，自动处理 ${c.lastAttempt.accepted?.length ?? 0} 条正式记忆，待审候选 ${c.lastAttempt.candidateCount} 条`}。{c.lastAttempt.status === "completed" && c.lastAttempt.candidateCount === 0 && !c.lastAttempt.accepted?.length ? "本次没有新增记忆或候选。" : ""}</p> : null}
    {info.memory.enabled && info.memory.autoConsolidate ? <details className="history-consolidation">
      <summary>选择历史消息补整理记忆</summary><p className="hint">只处理当前 Thread 中勾选的 1–8 条用户消息，不移动记忆整理游标。标记“不参与记忆”的内容不能选择。</p>
      <button className="ghost" disabled={busy || working} onClick={() => void loadSources()}>读取可选历史</button>
      {sourcesLoaded && sources.length === 0 ? <p className="hint">当前 Thread 没有可选的已提交用户消息。此处没有扫描其他会话。</p> : null}
      {sources.map(source => <label className="consolidation-source" key={source.messageId}><input type="checkbox" disabled={source.excluded || busy || working || !selected.includes(source.messageId) && selected.length >= 8} checked={selected.includes(source.messageId)} onChange={event => setSelected(current => event.target.checked ? [...current, source.messageId] : current.filter(id => id !== source.messageId))} />
        <span>{source.preview}{source.truncated ? "…（预览截断，整理读取原文）" : ""}{source.excluded ? " · 不参与整理" : ""}</span></label>)}
      {nextOffset !== null ? <button className="ghost" disabled={busy || working} onClick={() => void loadSources(nextOffset)}>更早的消息</button> : null}
      <button disabled={busy || working || !selected.length} onClick={() => void consolidate({ mode: "history", messageIds: selected })}>整理所选 {selected.length} 条记忆材料</button>
    </details> : null}
    </details>
  </section>;
}
