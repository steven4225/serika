import React from "react";
import { estimatedModelCost, MODEL_PURPOSE_LABELS, type ModelCallRecord, type ModelUsagePage, type ModelPurpose } from "@aisdk-agent/example-cli/dist/model-usage.js";
import { formatRecordTime } from "../../shared/execution-records.js";

const token = (value: number | undefined) => value === undefined ? "未知" : value.toLocaleString("zh-CN");
const status: Record<ModelCallRecord["status"], string> = {
  pending: "等待结果", returned: "供应商已返回", failed: "调用失败", cancelled: "已取消 · 最终用量未知", unknown: "结果未知",
  not_dispatched: "派发前取消 · 未调用供应商",
};
export function costLabel(call: ModelCallRecord): string {
  const cost = estimatedModelCost(call);
  return cost === undefined ? call.price ? "费用未知（用量或缓存单价未完整报告）" : "费用未知（未配置价格）"
    : `估算 ${call.price!.currency} ${cost.toFixed(6)}（估算≠账单）`;
}
export function ModelUsagePanel({ page, runId }: { page?: ModelUsagePage | undefined; runId?: string }) {
  const calls = page?.calls.filter(call => runId === undefined || call.runId === runId) ?? [];
  return <section className="model-usage" aria-label="模型用量分项">
    <h3>模型用量 · {runId ? "本次 Run" : "当前对话"}</h3>
    <p className="hint">按供应商调用尝试记录，重试分别计；旧摘要复用、本地改写缓存不产生调用。不包含启用前的历史或独立后台 worker。未知不等于 0，估算≠账单。</p>
    {page === undefined ? <p className="muted">旧版本未记录分项用量。</p> : calls.length === 0 ? <p className="muted">尚无模型调用记录。</p> : null}
    {(Object.keys(MODEL_PURPOSE_LABELS) as ModelPurpose[]).map(purpose => {
      const group = calls.filter(call => call.purpose === purpose);
      if (group.length === 0) return null;
      return <details className="model-usage-group" key={purpose}>
        <summary>{MODEL_PURPOSE_LABELS[purpose]} · {group.filter(call => call.status !== "not_dispatched").length} 次调用尝试{group.some(call => call.status === "not_dispatched") ? "（另有派发前取消，不计调用）" : ""}</summary>
        {group.map(call => <article className="model-usage-call" key={call.id}>
          <div>{status[call.status]} · {call.provider} / {call.modelId}</div>
          <time dateTime={call.startedAt} className="hint">{formatRecordTime(call.startedAt)}</time>
          <div>输入 {token(call.usage.inputTokens)} / 输出 {token(call.usage.outputTokens)} / 总计 {token(call.usage.totalTokens)} tokens</div>
          <div>缓存读取 {token(call.usage.cacheReadTokens)} / 缓存写入 {token(call.usage.cacheWriteTokens)} tokens</div>
          <div>{costLabel(call)}</div>
        </article>)}
      </details>;
    })}
    {page && page.droppedCount > 0 ? <p className="hint">共享日志已有 {page.droppedCount} 条较早调用未保留；这里只展示近期记录，不是完整账单。</p> : null}
  </section>;
}
