import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { contextErrorText, contextInputBudget, contextOverview, contextPanelReducer, contextUsageLabel, initialContextPanel, preparationLabel } from "../../shared/context-panel.js";
import { contextBudgetThresholds } from "@serika/assistant/browser";
import type { ContextBudgetConfig } from "@serika/assistant";
import type { ModelCapacityEvidence } from "@serika/assistant";

export function ContextPanel({ controllerIdle, refreshToken, initialError = null }: {
  controllerIdle: boolean;
  refreshToken: number;
  initialError?: string | null;
}) {
  const [state, dispatch] = useReducer(contextPanelReducer, initialContextPanel);
  const [commandError, setCommandError] = useState<string | null>(initialError ? contextErrorText({ message: initialError }) : null);
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

  const value = state.value;
  const latest = value?.latestValidCompaction;
  const preparation = value?.lastPreparation;
  const overview = value ? contextOverview(value) : null;
  return (
    <section className="context-page">
      <div className="context-status-head"><h2>{state.error ? "对话状态暂时不可用" : overview?.title ?? "正在读取对话状态…"}</h2><button className="ghost" disabled={state.loading} onClick={() => void refresh()}>刷新状态</button></div>
      {state.error ? <div className="error">读取失败：{state.error}{value ? "（以下为上次成功读取，可能已过时）" : ""}</div> : null}
      {overview ? <p className="context-explanation">{overview.description}</p> : null}
      {preparation?.error ? <div className="error" role="alert">{contextErrorText(preparation.error)}</div> : null}
      {value?.enabled && preparation?.estimatedInputTokens != null && preparation.outcome !== "failed" ? <div className="context-usage">
        <span>上次发送前的输入估算 · {contextUsageLabel(value)}</span><strong>{preparation.estimatedInputTokens.toLocaleString()} / {contextInputBudget(value.budget).toLocaleString()} tokens</strong>
        <p className="hint">包含提示词、工具、记忆和对话。这是估算，不是当前实时用量；回复与安全余量另行预留。</p>
      </div> : null}
      {value ? <div className="context-history-note">{latest ? `最近保存的上下文摘要：${new Date(latest.createdAt).toLocaleString()}。历史记录不代表这轮已经使用。` : "这段对话还没有生成上下文摘要。"}</div> : null}
      {commandNotice ? <p role="status" className="context-history-note">{commandNotice}</p> : null}
      {commandError ? <div className="error" role="alert">{commandError}</div> : null}
      <details className="context-technical"><summary>高级：预算与压缩详情</summary>
      {value ? (
        <div className="home-body">
          <div>{value.enabled ? "模型摘要压缩已启用" : "模型摘要压缩未启用"}</div>
          <div className="hint">估算方式：{value.estimatorVersion}</div>
          <div>窗口 {value.budget.contextWindowTokens} · 输出预留 {value.budget.maxOutputTokens} · 安全余量 {value.budget.safetyMarginTokens}</div>
          <div>保留近期 {value.budget.keepRecentTokens} · 摘要输出上限 {value.budget.summaryMaxOutputTokens}</div>
          <div>输入上限 {contextInputBudget(value.budget)} · 正常触发 {contextBudgetThresholds(value.budget).triggerTokens}</div>
          <div>摘要分块 {value.budget.summaryInputChunkTokens ?? value.budget.keepRecentTokens} · 预测增长预留 {contextBudgetThresholds(value.budget).predictedGrowthTokens}</div>
          {latest ? (
            <>
              <div>最近有效上下文摘要</div>
              <div className="hint">{latest.createdAt} · {latest.modelId}</div>
              <div>保留边界：从第 {latest.firstKeptMessageIndex + 1} 条消息开始保留原文</div>
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
              {preparation.error ? <div className="error">{contextErrorText(preparation.error)}</div> : null}
            </>
          ) : <div className="hint">本进程尚无上下文准备结果（重启不会沿用上一进程的结果）。</div>}
          {!value.enabled ? <div className="hint">完整原文保留；本配置未启用摘要压缩。</div> : null}
        </div>
      ) : <div className="muted">{state.loading ? "正在读取…" : "上下文诊断不可用"}</div>}
      </details>
    </section>
  );
}
