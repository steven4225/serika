import React, { useEffect, useState } from "react";
import type { MemoryReferenceSnapshot } from "@serika/assistant";

type RunMemoryReference = MemoryReferenceSnapshot & { runId: string };
const MATCH_REASONS = { pinned: "显式固定", snapshot: "固定快照" } as const;

/** Backend context-preparation evidence; not model self-report or a current-store query. */
export function MemoryReferenceDetails({ reference, hideEmpty = false }: { reference: RunMemoryReference; hideEmpty?: boolean }) {
  if (hideEmpty && reference.selected.length === 0 && !reference.truncated) return null;
  return <details className="memory-references"><summary>本轮参考记忆 · {reference.selected.length} 条</summary>
    <p className="hint">本轮最近一次上下文准备选定的版本，不是模型自报，也不代表现在仍是该版本。旧摘要里的引用不算本轮选中。</p>
    <div className="hint">Run {reference.runId} · 准备于 {reference.preparedAt}</div>
    {reference.referenceBytes === undefined ? null : <p className="hint">记忆与待续引用共 {reference.referenceBytes} 字节。</p>}
    {reference.selected.map(entry => <div className="memory-reference-item" key={entry.id}>
      <div className="hint">记忆 {entry.id} · revision {entry.revision} · {MATCH_REASONS[entry.reason]}</div>
      <pre className="memory-text">{entry.text}</pre>

    </div>)}
    {reference.selected.length === 0 ? <p className="hint">本轮没有选中记忆；不代表记忆库为空。</p> : null}
    {reference.truncated ? <p className="hint">固定快照达到注入预算；其余条目可按需读取。</p> : null}
  </details>;
}

export function MemoryReferences({ refreshToken, runId, starting, hideEmpty = false }: { refreshToken: number; runId: string | null; starting: boolean; hideEmpty?: boolean }) {
  const [reference, setReference] = useState<RunMemoryReference | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let disposed = false;
    setReference(null); setError(false);
    if (!starting) void window.runloom.getMemoryReferences().then(value => {
      if (!disposed && (runId === null || value?.runId === runId)) setReference(value);
    }).catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; };
  }, [refreshToken, runId, starting]);
  if (error) return <p className="hint">本轮参考记忆读取失败，不代表未引用。</p>;
  if (!reference) return null;
  return <MemoryReferenceDetails reference={reference} hideEmpty={hideEmpty} />;
}
