import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { contextErrorText, contextInputBudget, contextModeLabel, contextOverview, contextPanelReducer, contextUsageLabel, initialContextPanel, preparationLabel } from "../../shared/context-panel.js";
import { contextBudgetThresholds } from "@serika/assistant/browser";
import type { ContextBudgetConfig } from "@serika/assistant";
import type { ModelCapacityEvidence } from "@serika/assistant";

export function ContextModeSelector({ budget, requestedBudget, modelCapacity, disabled, onSelect }: { budget: ContextBudgetConfig; requestedBudget?: ContextBudgetConfig; modelCapacity?: ModelCapacityEvidence; disabled: boolean; onSelect: (mode: "daily" | "long-task") => void }) {
  return <div className="context-mode">
    <div className="context-mode-picker" role="group" aria-label="上下文模式">
      {(["daily", "long-task"] as const).map(mode => <button key={mode} aria-pressed={budget.mode === mode} disabled={disabled} onClick={() => { if (budget.mode !== mode) onSelect(mode); }}>{mode === "daily" ? "日常" : "长任务"}</button>)}
    </div>
    <p className="context-actual-budget">{modelCapacity?.source === "unverified_fallback" ? "临时窗口上限（容量未核实）" : "实际窗口"} {budget.contextWindowTokens.toLocaleString()} tokens · 当前有效输入上限 {contextInputBudget(budget).toLocaleString()} tokens</p>
    {requestedBudget?.inputBudgetTokens !== undefined ? <p className="hint">档位目标上限 {requestedBudget.inputBudgetTokens.toLocaleString()} tokens，不是当前模型容量；实际使用以上有效上限。</p> : null}
    {modelCapacity?.source === "unverified_fallback" ? <p className="hint">未配置该模型的容量，暂用保守上限；这不证明供应商支持该窗口，请核对后配置。</p> : null}
    <p className="hint">当前：{contextModeLabel(budget)}。以上是本进程实际配置，不是供应商承诺。空闲时切换，下一次发送生效；换模型后重新计算预算。</p>
    {!budget.enabled ? <p className="hint">自动压缩尚未启用，选择模式不会自动开启它。</p> : null}
  </div>;
}

export function ContextPanel({ controllerIdle, refreshToken, hasCompaction, initialError = null }: {
  controllerIdle: boolean;
  refreshToken: number;
  hasCompaction: boolean;
  initialError?: string | null;
}) {
  const [state, dispatch] = useReducer(contextPanelReducer, initialContextPanel);
  const [commandError, setCommandError] = useState<string | null>(initialError ? contextErrorText({ message: initialError }) : null);
  const [commandPending, setCommandPending] = useState(false);
  const [modePending, setModePending] = useState(false);
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

  const selectMode = async (mode: "daily" | "long-task") => {
    if (!controllerIdle || commandPending || state.loading || state.error || !state.value || !window.runloom.setContextMode) return;
    setCommandPending(true); setModePending(true); setCommandError(null); setCommandNotice(null);
    try {
      await window.runloom.setContextMode({ mode, expectedBudget: state.value.requestedBudget ?? state.value.budget });
      setCommandNotice("模式已保存并应用，下一次发送使用新预算。完整对话记录保留。");
    } catch { setCommandError("模式未确认生效，请刷新核对；不会自动重做任务。"); }
    finally { setCommandPending(false); setModePending(false); await refresh(); }
  };

  const compact = async () => {
    if (!controllerIdle || commandPending || !hasCompaction || state.loading || state.error || state.value?.enabled !== true) return;
    setCommandPending(true);
    setCommandError(null);
    setCommandNotice(null);
    const beforeId = state.value?.latestValidCompaction?.id;
    try {
      const result = await window.runloom.command("/compact");
      if (!result.ok) setCommandError(result.reason === "busy" ? "当前正在处理其他内容，空闲后再压缩。" : contextErrorText({ code: result.reason, ...("message" in result ? { message: result.message } : {}) }));
      else {
        const diagnostics = await window.runloom.getContextDiagnostics();
        if (!diagnostics.ok) setCommandError(contextErrorText(diagnostics.error));
        else setCommandNotice(diagnostics.value.latestValidCompaction?.id !== beforeId
          ? "已生成新的上下文摘要。完整对话记录保留；下一次发送时会重新准备上下文。"
          : "这次无需生成新摘要，继续聊天即可。");
      }
    } catch {
      setCommandError(contextErrorText({ code: "IPC_FAILED" }));
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
      <div className="context-status-head"><h2>{modePending ? "正在切换模式…" : commandPending ? "正在压缩上下文…" : state.error ? "对话状态暂时不可用" : overview?.title ?? "正在读取对话状态…"}</h2><button className="ghost" disabled={state.loading || commandPending} onClick={() => void refresh()}>刷新状态</button></div>
      {state.error ? <div className="error">读取失败：{state.error}{value ? "（以下为上次成功读取，可能已过时）" : ""}</div> : null}
      {value ? <ContextModeSelector budget={value.budget} {...(value.requestedBudget ? { requestedBudget: value.requestedBudget } : {})} {...(value.modelCapacity ? { modelCapacity: value.modelCapacity } : {})} disabled={!controllerIdle || commandPending || state.loading || !!state.error || !window.runloom.setContextMode} onSelect={mode => void selectMode(mode)} /> : null}
      {overview ? <p className="context-explanation">{overview.description}</p> : null}
      {preparation?.error ? <div className="error" role="alert">{contextErrorText(preparation.error)}</div> : null}
      {value?.enabled && preparation?.estimatedInputTokens != null && preparation.outcome !== "failed" ? <div className="context-usage">
        <span>上次发送前的输入估算 · {contextUsageLabel(value)}</span><strong>{preparation.estimatedInputTokens.toLocaleString()} / {contextInputBudget(value.budget).toLocaleString()} tokens</strong>
        <p className="hint">包含提示词、工具、记忆和对话。这是估算，不是当前实时用量；回复与安全余量另行预留。</p>
      </div> : null}
      {value ? <div className="context-history-note">{latest ? `最近保存的上下文摘要：${new Date(latest.createdAt).toLocaleString()}。历史记录不代表这轮已经使用。` : "这段对话还没有生成上下文摘要。"}</div> : null}
      {commandNotice ? <p role="status" className="context-history-note">{commandNotice}</p> : null}
      {commandError ? <div className="error" role="alert">{commandError}</div> : null}
      <details className="context-manual"><summary>需要提前压缩上下文？</summary><p>手动压缩早期对话，可能调用模型并产生费用，不会删除原始历史。摘要可能省略细节，重要偏好应保存在长期记忆中。</p>
        <button disabled={!controllerIdle || commandPending || state.loading || !!state.error || !hasCompaction || value?.enabled !== true} onClick={() => void compact()}>{commandPending && !modePending ? "正在压缩上下文…" : "现在压缩上下文"}</button>
        {!controllerIdle ? <p className="hint">等待当前处理结束后可操作。</p> : null}
      </details>
      <details className="context-technical"><summary>高级：预算与压缩详情</summary>
      {value ? (
        <div className="home-body">
          <div>{value.enabled ? "模型摘要压缩已启用" : "模型摘要压缩未启用"}</div>
          <div className="hint">估算方式：{value.estimatorVersion}</div>
          <div>窗口 {value.budget.contextWindowTokens} · 输出预留 {value.budget.maxOutputTokens} · 安全余量 {value.budget.safetyMarginTokens}</div>
          <div>保留近期 {value.budget.keepRecentTokens} · 摘要输出上限 {value.budget.summaryMaxOutputTokens}</div>
          <div>输入上限 {contextInputBudget(value.budget)} · 预警 {contextBudgetThresholds(value.budget).warningTokens} · 正常触发 {contextBudgetThresholds(value.budget).triggerTokens}</div>
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
          {!value.enabled ? <div className="hint">这不表示上下文完全不处理；仍沿用既有历史裁剪。</div> : null}
        </div>
      ) : <div className="muted">{state.loading ? "正在读取…" : "上下文诊断不可用"}</div>}
      </details>
    </section>
  );
}
