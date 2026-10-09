import type { TokenUsage } from "@aisdk-agent/core";
import type { ExecutionRunRecord, ExecutionToolRecord } from "../../shared/ui-contract.js";
import { runStatusLabel, toolNote, toolStatusLabel, toolTone } from "../../shared/execution-records.js";

export interface TimelineNode {
  id: string;
  at: string;
  label: string;
  status: string;
  tone: "ok" | "fail" | "warn" | "muted" | "unknown";
  detail?: string;
  duration?: string;
  tool?: ExecutionToolRecord;
}
export function durationLabel(start: string, end: string | null): string {
  if (end === null) return "未记录结束时间";
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return "耗时不可用";
  return ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} 秒` : `${(ms / 60_000).toFixed(1)} 分钟`;
}
export function usageLabel(usage?: TokenUsage): string {
  return `输入 ${usage?.inputTokens ?? "未报告"} / 输出 ${usage?.outputTokens ?? "未报告"} / 总计 ${usage?.totalTokens ?? "未报告"} tokens`;
}
const reasons: Record<string, string> = { delivered: "程序验收通过", needs_confirmation: "需要确认", needs_information: "缺少信息", budget_exhausted: "预算耗尽", needs_review: "效果待核对" };

/** Projection only: missing events never manufacture model steps or approvals. */
export function runTimeline(run: ExecutionRunRecord): TimelineNode[] {
  const nodes: TimelineNode[] = [{ id: "start", at: run.startedAt, label: "开始处理", status: "Run 已创建", tone: "muted" }];
  for (const event of run.trace?.events ?? []) {
    const node: TimelineNode = { id: `event-${event.sequence}`, at: event.occurredAt, label: "", status: "", tone: "muted" };
    switch (event.type) {
      case "step.started": {
        const completed = run.trace?.events.find(e => e.type === "step.completed" && e.stepNumber === event.stepNumber && e.sequence > event.sequence);
        node.label = `模型步骤 ${event.stepNumber}`;
        node.status = completed ? "已返回" : run.status === "running" ? "处理中" : "结束未记录";
        node.tone = completed ? "ok" : run.status === "running" ? "warn" : "unknown";
        if (completed) node.duration = durationLabel(event.occurredAt, completed.occurredAt);
        node.detail = completed ? `${usageLabel(completed.usage)}\n结束类型：${completed.finishReason}\n耗时包含本步骤准备及模型重试，不包含后续工具执行。` : "没有本步骤的返回记录，不能推断模型已完成。";
        break;
      }
      case "step.completed": continue;
      case "model.retry.scheduled":
        node.label = `模型步骤 ${event.stepNumber} 等待重试`;
        node.status = `计划第 ${event.nextAttempt}/${event.maxAttempts} 次请求`;
        node.tone = "warn";
        node.detail = `${event.errorCode} · 等待 ${event.delayMs} ms；计划不证明下一次请求已发出。不重试工具。`;
        break;
      case "tool.call.approval_required": {
        const tool = run.tools.find(t => t.toolCallId === event.toolCallId);
        node.label = `工具确认${tool ? `：${tool.toolName}` : ""}`;
        node.status = tool?.startedAt ? "已进入执行" : tool?.status === "requested" && run.status === "running" ? "等待确认" : "未派发";
        node.tone = node.status === "等待确认" ? "warn" : "muted";
        if (tool?.startedAt) node.duration = durationLabel(event.occurredAt, tool.startedAt);
        node.detail = "只授权本次调用；批准或拒绝仍在对话确认卡操作。";
        break;
      }
      case "run.completion.checked":
        node.label = "任务完成检查";
        node.status = event.decision === "continue" ? "继续补齐证据" : reasons[event.reason ?? ""] ?? "停止本轮";
        node.tone = event.decision === "continue" ? "warn" : "muted";
        node.detail = `纠正 ${event.corrections} 次。程序条件与人工质量审核分开；此记录不授予工具权限。`;
        break;
    }
    nodes.push(node);
  }
  for (const tool of run.tools) {
    if (tool.approvalRequestedAt && !run.trace?.events.some(e => e.type === "tool.call.approval_required" && e.toolCallId === tool.toolCallId)) {
      nodes.push({ id: `approval-${tool.toolCallId}`, at: tool.approvalRequestedAt, label: `工具确认：${tool.toolName}`,
        status: tool.startedAt ? "已进入执行" : tool.status === "requested" && run.status === "running" ? "等待确认" : "未派发",
        tone: tool.status === "requested" && run.status === "running" ? "warn" : "muted",
        detail: "只授权本次调用；批准或拒绝仍在对话确认卡操作。",
        ...(tool.startedAt ? { duration: durationLabel(tool.approvalRequestedAt, tool.startedAt) } : {}) });
    }
    // Place execution after confirmation, retaining unstarted requests as visible nodes.
    const tone = toolTone(tool);
    const status = tool.status === "completed" && tone === "fail" ? "返回失败结果"
      : tool.status === "completed" && tone === "unknown" ? "效果待核对" : toolStatusLabel(tool.status);
    nodes.push({ id: `tool-${tool.toolCallId}`, at: tool.startedAt ?? tool.finishedAt ?? tool.requestedAt,
      label: tool.toolName, status, tone, tool,
      detail: toolNote(tool), ...(tool.startedAt && tool.finishedAt ? { duration: durationLabel(tool.startedAt, tool.finishedAt) } : {}) });
  }
  nodes.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (run.status !== "running") nodes.push({ id: "end", at: run.finishedAt ?? run.startedAt,
    label: run.status === "interrupted" ? "发现进程中断" : "本轮结束", status: runStatusLabel(run.status),
    tone: run.status === "completed" ? "muted" : run.status === "interrupted" ? "unknown" : "fail",
    detail: run.completion ? `${reasons[run.completion.reason]} · 纠正 ${run.completion.corrections} 次；任务是否完成以工作任务验收为准。` : "Run 结束不等于任务验收通过。" });
  return nodes;
}
