import React, { useEffect, useState } from "react";
import type { MemoryMaintenance } from "@serika/assistant";
import { memoryConsolidationFailureText } from "@serika/assistant/browser";
import { memoryAutomationLabel } from "./memory-copy.js";
const labels = { off: memoryAutomationLabel({ enabled: true, autoConsolidate: false }), backlog: "等待记忆整理", running: "正在整理记忆", failed: "记忆整理失败", idle: "没有待整理的新增记忆材料" };
export function consolidationStatusLabel(enabled: boolean, maintenance: MemoryMaintenance | null, error: string): string {
  if (!enabled) return "记忆未启用";
  if (error) return "记忆整理状态读取失败";
  if (!maintenance) return "正在读取记忆状态…";
  if (maintenance.extraction?.pendingSegments) return `有 ${maintenance.extraction.pendingSegments} 段没整理`;
  const consolidation = maintenance.consolidation;
  if (consolidation.state === "failed" && consolidation.error) return memoryConsolidationFailureText(consolidation.error);
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
  if (quiet && !running && !error && c?.state !== "failed") return null;
  if (!running && !error && c?.state !== "failed" && c?.state !== "backlog" && c?.state !== "running") return null;
  const title = running ? labels.running : consolidationStatusLabel(enabled, maintenance, error);
  return <div className="memory-consolidation"><div className="attention-summary" role="status"><span>{title}{c?.state === "backlog" && c.backlogCount !== undefined ? `（${c.backlogCount} 条取材范围内消息）` : ""}</span><button className="ghost" onClick={onOpen}>查看记忆</button></div>
    {c?.error ? <p className="error" role="alert">{memoryConsolidationFailureText(c.error)}</p> : null}
  </div>;
}
