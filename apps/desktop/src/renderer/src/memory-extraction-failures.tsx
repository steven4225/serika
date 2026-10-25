import React, { useEffect, useState } from "react";
import type { MemoryMaintenance } from "@serika/assistant";
const stages = { prepare: "准备", extract: "抽取", validate: "校验", save: "保存" };

export function MemoryExtractionFailures({ maintenance }: { maintenance: MemoryMaintenance | null }) {
  const failures = maintenance?.failures ?? [];
  if (!failures.length && !maintenance?.failureLogError && !maintenance?.storageError) return null;
  return <details className="memory-extraction-failures"><summary>记忆整理失败记录（{failures.length}）</summary>
    <p className="hint">当前对话、当前项目的本地记录，重启后仍可查看。</p>
    {maintenance?.storageError ? <p role="alert" className="error">记忆文件读取失败，条目数量未知：{maintenance.storageError.code} · {maintenance.storageError.message}</p> : null}
    {maintenance?.failureLogError ? <p role="alert" className="error">{maintenance.failureLogError}</p> : null}
    {[...failures].reverse().map((failure, index) => <section key={`${failure.at}:${index}`}>
      <p><time dateTime={failure.at}>{new Date(failure.at).toLocaleString()}</time> · {stages[failure.stage]}失败</p>
      <p>{failure.message}</p>
      <details><summary>诊断详情</summary><p>错误代码：<code>{failure.code}</code></p>
        <p>Thread：<code>{failure.threadId}</code></p><p>项目：<code>{failure.projectId ?? "无项目"}</code></p></details>
    </section>)}
  </details>;
}

export function MemoryExtractionFailureHistory({ enabled, refreshToken, busy }: { enabled: boolean; refreshToken: number; busy: boolean }) {
  const [maintenance, setMaintenance] = useState<MemoryMaintenance | null>(null);
  useEffect(() => {
    let current = true;
    if (!enabled) { setMaintenance(null); return; }
    void window.runloom.getMemoryMaintenance().then(result => {
      if (current) setMaintenance(result.ok ? result.value : null);
    }).catch(() => { if (current) setMaintenance(null); });
    return () => { current = false; };
  }, [enabled, refreshToken, busy]);
  return <MemoryExtractionFailures maintenance={maintenance} />;
}
