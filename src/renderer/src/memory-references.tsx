import { useEffect, useState } from "react";
import type { MemoryReferenceSnapshot } from "@aisdk-agent/example-cli/dist/memory-query-rewrite.js";
export function MemoryReferences({ refreshToken, runId, starting }: { refreshToken: number; runId: string | null; starting: boolean }) {
  const [reference, setReference] = useState<(MemoryReferenceSnapshot & { runId: string }) | null>(null);
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
  return <details className="memory-references"><summary>本轮参考记忆 · {reference.selected.length} 条</summary>
    <p className="hint">本轮最近一次上下文准备选定的版本，不是模型自报，也不代表现在仍是该版本。</p>
    <div className="hint">Run {reference.runId} · {reference.preparedAt}</div>
    <p className="hint">{reference.rewrite === "degraded" ? "同义改写失败或超时，已退回原词法检索。" : reference.rewrite === "succeeded" ? "使用有界同义查询改写；匹配不保证相关性。" : reference.rewrite === "off" ? "词法检索，同义改写未启用。" : "本轮不适用同义改写。"}</p>
    {reference.selected.map(entry => <div className="memory-reference-item" key={entry.id}><div className="hint">{entry.id} · v{entry.revision} · {entry.reason === "pinned" ? "显式固定" : entry.reason === "rewritten" ? "改写词匹配" : "原问题匹配"}</div><pre className="memory-text">{entry.text}</pre></div>)}
    {reference.selected.length === 0 ? <p className="hint">本轮没有选中记忆；不代表记忆库为空。</p> : null}
    {reference.truncated || reference.queryTruncated ? <p className="hint">本轮查询或引用达到有界预算。</p> : null}
  </details>;
}
