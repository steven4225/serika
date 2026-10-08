import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { contextOverview, contextPanelReducer, initialContextPanel, preparationLabel } from "../../shared/context-panel.js";

export function ContextPanel({ controllerIdle, refreshToken, hasCompaction }: {
  controllerIdle: boolean;
  refreshToken: number;
  hasCompaction: boolean;
}) {
  const [state, dispatch] = useReducer(contextPanelReducer, initialContextPanel);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [commandPending, setCommandPending] = useState(false);
  const [commandNotice, setCommandNotice] = useState<string | null>(null);
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
    if (!controllerIdle || commandPending || !hasCompaction || state.loading || state.error || state.value?.enabled !== true) return;
    setCommandPending(true);
    setCommandError(null);
    setCommandNotice(null);
    const beforeId = state.value?.latestValidCompaction?.id;
    try {
      const result = await window.runloom.command("/compact");
      if (!result.ok) setCommandError(result.reason === "failed" ? result.message : `压缩未完成：${result.reason}`);
      else {
        const diagnostics = await window.runloom.getContextDiagnostics();
        if (!diagnostics.ok) setCommandError(`整理命令已结束，但结果无法读取：${diagnostics.error.message}`);
        else setCommandNotice(diagnostics.value.latestValidCompaction?.id !== beforeId
          ? "已生成新的整理摘要。完整对话记录保留；下一次发送时会重新准备上下文。"
          : "这次无需生成新摘要，继续聊天即可。");
      }
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
  const overview = value ? contextOverview(value) : null;
  return (
    <section className="context-page">
      <div className="context-status-head"><h2>{commandPending ? "正在整理对话…" : state.error ? "对话状态暂时不可用" : overview?.title ?? "正在读取对话状态…"}</h2><button className="ghost" disabled={state.loading || commandPending} onClick={() => void refresh()}>刷新状态</button></div>
      {state.error ? <div className="error">读取失败：{state.error}{value ? "（以下为上次成功读取，可能已过时）" : ""}</div> : null}
      {overview ? <p className="context-explanation">{overview.description}</p> : null}
      {preparation?.error ? <div className="error" role="alert">{preparation.error.message}</div> : null}
      {value?.enabled && preparation?.estimatedInputTokens != null && preparation.outcome !== "failed" ? <div className="context-usage">
        <span>上次发送前的输入估算</span><strong>{preparation.estimatedInputTokens.toLocaleString()} / {(value.budget.contextWindowTokens - value.budget.maxOutputTokens - value.budget.safetyMarginTokens).toLocaleString()} tokens</strong>
        <p className="hint">已扣除回复预留和安全余量。这是估算，不是当前实时用量。</p>
      </div> : null}
      {value ? <div className="context-history-note">{latest ? `最近保存的整理摘要：${new Date(latest.createdAt).toLocaleString()}。历史记录不代表这轮已经使用。` : "这段对话还没有生成摘要。"}</div> : null}
      {commandNotice ? <p role="status" className="context-history-note">{commandNotice}</p> : null}
      {commandError ? <div className="error" role="alert">{commandError}</div> : null}
      <details className="context-manual"><summary>需要提前整理？</summary><p>手动整理早期对话，可能调用模型并产生费用，不会删除原始历史。摘要可能省略细节，重要偏好应保存在长期记忆中。</p>
        <button disabled={!controllerIdle || commandPending || state.loading || !!state.error || !hasCompaction || value?.enabled !== true} onClick={() => void compact()}>{commandPending ? "正在整理…" : "现在整理"}</button>
        {!controllerIdle ? <p className="hint">等待当前处理结束后可操作。</p> : null}
      </details>
      <details className="context-technical"><summary>技术详情</summary>
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
      </details>
    </section>
  );
}
