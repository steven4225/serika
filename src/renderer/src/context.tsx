import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { contextPanelReducer, initialContextPanel, preparationLabel } from "../../shared/context-panel.js";

export function ContextPanel({ controllerIdle, refreshToken, hasCompaction }: {
  controllerIdle: boolean;
  refreshToken: number;
  hasCompaction: boolean;
}) {
  const [state, dispatch] = useReducer(contextPanelReducer, initialContextPanel);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [commandPending, setCommandPending] = useState(false);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    dispatch({ type: "start", request });
    try {
      const result = await window.runloom.getContextDiagnostics();
      dispatch({ type: "result", request, result });
    } catch (cause: unknown) {
      dispatch({ type: "result", request, result: { ok: false, error: { code: "IPC_FAILED", message: String(cause) } } });
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh, refreshToken]);

  const compact = async () => {
    if (!controllerIdle || commandPending || !hasCompaction) return;
    setCommandPending(true);
    setCommandError(null);
    try {
      const result = await window.runloom.command("/compact");
      if (!result.ok) setCommandError(result.reason === "failed" ? result.message : `压缩未完成：${result.reason}`);
    } catch (cause: unknown) {
      setCommandError(String(cause));
    } finally {
      setCommandPending(false);
      await refresh();
    }
  };
  const value = state.value;
  const latest = value?.latestValidCompaction;
  const preparation = value?.lastPreparation;
  return (
    <section className="card context">
      <div className="card-head">
        <span>上下文</span>
        <span className="hint">估算，不是模型实际窗口测量</span>
        <button className="ghost" disabled={state.loading} onClick={() => void refresh()}>刷新</button>
      </div>
      {state.error ? <div className="error">读取失败：{state.error}{value ? "（以下为上次成功读取，可能已过时）" : ""}</div> : null}
      {value ? (
        <div className="home-body">
          <div>{value.enabled ? "模型摘要压缩已启用" : "模型摘要压缩未启用"}</div>
          <div className="hint">Thread {value.threadId} · {value.estimatorVersion}</div>
          <div>窗口 {value.budget.contextWindowTokens} · 输出预留 {value.budget.maxOutputTokens} · 安全余量 {value.budget.safetyMarginTokens}</div>
          <div>保留近期 {value.budget.keepRecentTokens} · 摘要输出上限 {value.budget.summaryMaxOutputTokens}</div>
          {latest ? (
            <>
              <div>最近有效记录：{latest.id}</div>
              <div className="hint">{latest.createdAt} · {latest.modelId}</div>
              <div>保留边界：索引 {latest.firstKeptMessageIndex} · 消息 {latest.firstKeptMessageId ?? "无"}</div>
              <div>估算输入 {latest.metrics.estimatedInputBefore} → {latest.metrics.estimatedInputAfter} tokens</div>
              <div>耗时 {latest.metrics.durationMs} ms · 尝试 {latest.metrics.attempts} 次</div>
              <div>实际模型用量：{latest.metrics.usage ? `输入 ${latest.metrics.usage.inputTokens ?? "未报告"} · 输出 ${latest.metrics.usage.outputTokens ?? "未报告"} · 总计 ${latest.metrics.usage.totalTokens ?? "未报告"}` : "未报告"}</div>
              <div className="hint">历史有效记录不等于本进程已使用，也不证明工具成功或当前磁盘事实。</div>
            </>
          ) : <div>没有有效压缩记录</div>}
          {preparation ? (
            <>
              <div>本进程最近准备：{preparationLabel(preparation.outcome)}</div>
              <div className="hint">{preparation.at} · 记录 {preparation.compactionId ?? "无"} · 估算输入 {preparation.estimatedInputTokens ?? "未报告"}</div>
              {preparation.error ? <div className="error">{preparation.error.code}: {preparation.error.message}</div> : null}
            </>
          ) : <div className="hint">本进程尚无上下文准备结果（重启不会沿用上一进程的结果）。</div>}
          {!value.enabled ? <div className="hint">这不表示上下文完全不处理；仍沿用既有历史裁剪。</div> : null}
        </div>
      ) : <div className="muted">{state.loading ? "正在读取…" : "上下文诊断不可用"}</div>}
      {commandError ? <div className="error">{commandError}</div> : null}
      <div className="actions">
        <button className="ghost" disabled={!controllerIdle || commandPending || !hasCompaction || value?.enabled !== true} onClick={() => void compact()}>手动压缩 /compact</button>
      </div>
    </section>
  );
}
