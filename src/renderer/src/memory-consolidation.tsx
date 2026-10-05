import { useEffect, useState } from "react";
import type { AppInfo } from "../../shared/ui-contract.js";
import type { MemoryMaintenance } from "@aisdk-agent/example-cli/dist/memory-controls.js";
import type { MemoryConsolidationSource, MemoryConsolidationRequest } from "@aisdk-agent/example-cli/dist/memory-consolidation.js";
import { MemorySetup } from "./daily-setup-panel.js";

const labels = { off: "自动整理未启用", backlog: "等待整理", running: "正在整理记忆", failed: "整理失败", awaiting_review: "等待你审核候选", idle: "没有待整理的新增材料" };

export function consolidationStatusLabel(enabled: boolean, maintenance: MemoryMaintenance | null, error: string): string {
  if (!enabled) return "记忆未启用";
  if (error) return "记忆整理状态读取失败";
  if (!maintenance) return "正在读取记忆状态…";
  const consolidation = maintenance.consolidation;
  if (consolidation.state === "idle" && consolidation.lastAttempt?.status === "completed" && consolidation.lastAttempt.candidateCount === 0) return "整理完成，没有新增候选";
  return labels[consolidation.state];
}

/** Read-only status beside the conversation; reviewing remains an explicit action. */
export function MemoryConsolidationNotice({ enabled, busy, running = false, refreshToken, onOpen }: {
  enabled: boolean; busy: boolean; running?: boolean; refreshToken: number; onOpen: () => void;
}) {
  const [maintenance, setMaintenance] = useState<MemoryMaintenance | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void window.runloom.getMemoryMaintenance().then(result => {
      if (cancelled) return;
      if (result.ok) { setMaintenance(result.value); setError(""); }
      else { setMaintenance(null); setError(`${result.error.code}: ${result.error.message}`); }
    }).catch(cause => { if (!cancelled) { setMaintenance(null); setError(String(cause)); } });
    return () => { cancelled = true; };
  }, [enabled, busy, refreshToken]);
  if (!enabled) return null;
  const c = maintenance?.consolidation;
  const emptyAttempt = c?.state === "idle" && c.lastAttempt?.status === "completed" && c.lastAttempt.candidateCount === 0;
  if (!running && !error && !emptyAttempt && c?.state !== "failed" && c?.state !== "backlog" && c?.state !== "running") return null;
  const title = running ? labels.running : consolidationStatusLabel(enabled, maintenance, error);
  return <div className="attention-summary" role="status"><span>{title}{c?.state === "backlog" && c.backlogCount !== undefined ? `（${c.backlogCount} 条取材范围内消息）` : ""}</span><button className="ghost" onClick={onOpen}>查看记忆</button></div>;
}

export function MemoryConsolidationPanel({ info, busy, refreshToken }: { info: AppInfo; busy: boolean; refreshToken: number }) {
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
    else { setNotice("整理已开始。候选可以稍后审核，接受前不会保存为正式记忆。"); setSelected([]); setStatusRefresh(value => value + 1); }
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
      {info.memory.enabled && info.memory.autoConsolidate && (c?.state === "failed" || c?.state === "backlog") ? <button className="ghost" disabled={busy || working || maintenance === null || maintenance.pending >= 64} onClick={() => void consolidate({ mode: "incremental" })}>{c?.state === "failed" ? "重试整理" : "整理待处理材料"}</button> : null}
    </div>
    {c?.error ? <p className="error" role="alert">{c.error}。本次未成功推进整理游标。</p> : null}
    {maintenance && maintenance.pending >= 64 ? <p className="hint">待审核候选已达到上限，请先接受或拒绝候选，再整理新材料。暂时不审核不会丢弃候选。</p> : null}
    {statusError ? <><p className="error" role="alert">{statusError}。不能据此判断没有待整理材料或候选。</p><button className="ghost" disabled={working} onClick={() => setStatusRefresh(value => value + 1)}>重新读取整理状态</button></> : null}
    {error ? <p className="error" role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    <details className="memory-maintenance-disclosure">
      <summary>{!info.memory.enabled || !info.memory.autoConsolidate ? "设置记忆与自动整理" : "整理详情、设置与历史补整理"}</summary>
    {!info.memory.enabled || !info.memory.autoConsolidate ? <>
      <p className="hint">启用后，模型会整理已提交的用户消息并提出候选；接受前不会写入正式记忆。同义提问可额外发送一次有界查询。</p>
      {!info.workspaceRoot ? <p className="hint">当前配置没有 workspace，请先设置工作区。</p> : null}
    </> : <>
      <p className="hint">新对话成功结束后整理一次。首次最多取最近 8 条；更早的内容须由你选择补整理。</p>
    </>}
    <MemorySetup info={info} busy={busy || working} />
    {c?.state === "running" ? <p className="hint" role="status">整理与审核是两件事。整理失败可以重试，不会自动接受候选。</p> : null}
    {c?.backlogCount !== undefined ? <p className="hint">自动取材范围内待处理：{c.backlogCount} 条用户消息。这个数量不代表所有旧历史。</p> : null}
    {c?.lastSkippedReason ? <p className="hint">本轮未自动整理：{c.lastSkippedReason}。</p> : null}
    {c?.lastAttempt ? <p className="hint">最近一次{c.lastAttempt.mode === "history" ? "历史补整理" : "增量整理"}：{c.lastAttempt.status === "failed" ? "失败" : `核对 ${c.lastAttempt.processedCount} 条材料，返回 ${c.lastAttempt.candidateCount} 条候选引用`}。{c.lastAttempt.status === "completed" && c.lastAttempt.candidateCount === 0 ? "本次没有新增候选。" : ""}</p> : null}
    {info.memory.enabled && info.memory.autoConsolidate ? <details className="history-consolidation">
      <summary>选择历史消息补整理</summary><p className="hint">只处理当前 Thread 中勾选的 1–8 条用户消息，不移动自动整理游标。标记“不参与记忆”的内容不能选择。</p>
      <button className="ghost" disabled={busy || working} onClick={() => void loadSources()}>读取可选历史</button>
      {sourcesLoaded && sources.length === 0 ? <p className="hint">当前 Thread 没有可选的已提交用户消息。此处没有扫描其他会话。</p> : null}
      {sources.map(source => <label className="consolidation-source" key={source.messageId}><input type="checkbox" disabled={source.excluded || busy || working || !selected.includes(source.messageId) && selected.length >= 8} checked={selected.includes(source.messageId)} onChange={event => setSelected(current => event.target.checked ? [...current, source.messageId] : current.filter(id => id !== source.messageId))} />
        <span>{source.preview}{source.truncated ? "…（预览截断，整理读取原文）" : ""}{source.excluded ? " · 不参与整理" : ""}</span></label>)}
      {nextOffset !== null ? <button className="ghost" disabled={busy || working} onClick={() => void loadSources(nextOffset)}>更早的消息</button> : null}
      <button disabled={busy || working || !selected.length} onClick={() => void consolidate({ mode: "history", messageIds: selected })}>整理所选 {selected.length} 条</button>
    </details> : null}
    </details>
  </section>;
}
