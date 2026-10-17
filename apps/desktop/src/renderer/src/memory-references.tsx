import React, { useEffect, useState } from "react";
import type { MemoryReferenceSnapshot } from "@serika/assistant";
import { memoryKindLabel, systemTimeLabel, validTimeLabel } from "../../shared/memory-review.js";

type RunMemoryReference = MemoryReferenceSnapshot & { runId: string };
const MATCH_REASONS = {
  pinned: "显式固定",
  matched: "原问题与正文匹配",
  recall_term: "已审核检索词匹配",
  rewritten: "同义改写词匹配",
  semantic: "语义相似召回",
  hybrid: "关键词与语义融合",
  stable_profile: "当前有效稳定偏好",
  relevance: "相关性筛选通过",
} as const;

function semanticStatus(reference: RunMemoryReference): string | undefined {
  switch (reference.semantic?.state) {
    case "ready": return "本轮语义检索：就绪；相似召回不保证相关性。";
    case "warming": return "语义索引正在建立，本轮仅覆盖部分记忆；关键词检索仍保留。";
    case "degraded": return reference.relevance?.state === "succeeded"
      ? "语义检索暂不可用，本轮使用可用记忆的相关性筛选；请检查服务配置、专用 Key 或网络。"
      : "语义检索暂不可用，本轮已退回关键词检索；请检查服务配置、专用 Key 或网络。";
    case "off": return "语义检索未启用；本轮使用关键词检索。";
    case "not_applicable": return "本轮不适用语义检索。";
    default: return undefined;
  }
}

function rewriteStatus(reference: RunMemoryReference): string {
  if (reference.relevance) return reference.relevance.state === "not_applicable" ? "本轮不适用相关性筛选，未调用同义改写。"
    : "相关性筛选替代同义改写；本轮最多一次辅助模型调用，用量计入“查询改写”。";
  const semanticAvailable = reference.semantic?.state === "ready" || reference.semantic?.state === "warming";
  if (reference.rewrite === "degraded") return semanticAvailable
    ? "同义改写失败或超时；本轮保留语义与关键词检索路径。"
    : "同义改写失败或超时，已退回原词法检索。";
  if (reference.rewrite === "succeeded") return "使用有界同义查询改写；匹配不保证相关性。";
  if (reference.rewrite === "off") return semanticAvailable ? "同义查询改写未启用。" : "词法检索，同义改写未启用。";
  return "本轮不适用同义改写。";
}

function relevanceStatus(reference: RunMemoryReference): string | undefined {
  switch (reference.relevance?.state) {
    case "succeeded": return "本轮相关性筛选已完成；只引用筛选通过的当前版本，固定记忆除外。不保证判断正确。";
    case "degraded": return "相关性筛选失败或超时；本轮保留已启用的原有检索路径，未再次调用模型。";
    case "not_applicable": return "本轮不适用相关性筛选。";
    default: return undefined;
  }
}

/** Backend context-preparation evidence; not model self-report or a current-store query. */
export function MemoryReferenceDetails({ reference, hideEmpty = false }: { reference: RunMemoryReference; hideEmpty?: boolean }) {
  if (hideEmpty && reference.selected.length === 0 && !reference.truncated && !reference.queryTruncated
    && reference.rewrite !== "degraded" && reference.semantic?.state !== "degraded" && reference.semantic?.state !== "warming"
    && reference.relevance?.state !== "degraded" && !reference.relevance?.truncated
    && !reference.contextView?.continuationCount && !reference.contextView?.profileCount && !reference.contextView?.truncated) return null;
  return <details className="memory-references"><summary>本轮参考记忆 · {reference.selected.length} 条</summary>
    <p className="hint">本轮最近一次上下文准备选定的版本，不是模型自报，也不代表现在仍是该版本。旧摘要里的引用不算本轮选中。</p>
    <div className="hint">Run {reference.runId} · 准备于 {reference.preparedAt}</div>
    <div className="hint">事实视点 validAt：{reference.temporalView?.validAt ?? "未提供"}</div>
    <div className="hint">认知视点 knownAt：{reference.temporalView?.knownAt ?? "未提供"}</div>
    {reference.semantic ? <p className="hint">{semanticStatus(reference)}{reference.semantic.modelId ? ` 模型：${reference.semantic.modelId}` : ""}</p> : null}
    {reference.relevance ? <p className="hint">{relevanceStatus(reference)}{reference.relevance.truncated ? " 筛选材料达到上限，未覆盖的记忆不会自动引用。" : ""}</p> : null}
    <p className="hint">{rewriteStatus(reference)}</p>
    {reference.contextView ? <p className="hint">稳定偏好 {reference.contextView.profileCount} 条 · 当前对话待续任务 {reference.contextView.continuationCount} 条；仅引用已保存状态，不代表自动继续或恢复权限。</p> : null}
    {reference.referenceBytes === undefined ? null : <p className="hint">记忆与待续引用共 {reference.referenceBytes} 字节。</p>}
    {reference.selected.map(entry => <div className="memory-reference-item" key={entry.id}>
      <div className="hint">记忆 {entry.id} · revision {entry.revision} · {MATCH_REASONS[entry.reason]}</div>
      <pre className="memory-text">{entry.text}</pre>
      {entry.assertion ? <details>
        <summary className="hint">断言、时间与来源</summary>
        <div className="hint">断言 {entry.assertion.assertionId} · {memoryKindLabel(entry.assertion.kind)} · {entry.assertion.state === "retracted" ? "已撤回" : "认可"}</div>
        <div className="hint">事实适用时间：{validTimeLabel(entry.assertion.validTime)}</div>
        <div className="hint">系统认知时间：{systemTimeLabel(entry.assertion.systemTime)}</div>
        {entry.assertion.sourceIds.map((source, index) => <div className="hint" key={index}>
          来源 {index + 1}：{source.kind === "conversation" ? `Thread ${source.threadId} · 消息 ${source.messageId}` : source.kind === "manual" ? "人工录入" : "旧版迁入"}
        </div>)}
      </details> : <div className="hint">此版本未提供断言元数据，不能推断事实适用时间或来源。</div>}
    </div>)}
    {reference.selected.length === 0 ? <p className="hint">本轮没有选中记忆；不代表记忆库为空。</p> : null}
    {reference.truncated || reference.queryTruncated || reference.contextView?.truncated ? <p className="hint">本轮查询或引用达到有界预算。</p> : null}
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
