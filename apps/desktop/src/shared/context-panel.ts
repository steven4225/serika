import type { ContextDiagnostics, ContextResult } from "@serika/assistant";
import { contextBudgetStatus, contextBudgetThresholds } from "@serika/assistant/browser";
import type { ContextBudgetConfig } from "@serika/assistant";

export function contextInputBudget(budget: ContextBudgetConfig): number {
  return contextBudgetThresholds(budget).availableInputTokens;
}

export function contextErrorText(error: { code?: string; message?: string }): string {
  if (/CANCEL|ABORT/i.test(error.code ?? "")) return "上下文压缩已停止，未因此删除历史；可以继续聊天。";
  if (/TIMEOUT|TIMED_OUT/i.test(error.code ?? "") || /timed?\s*out|deadline/i.test(error.message ?? "")) return "上下文压缩超时，这次尚未完成；请稍后重试，完整历史仍保留。";
  if (/BUDGET|LIMIT|TOO_LARGE/i.test(error.code ?? "") || /budget|too (?:large|long)|exceed.*(?:tokens|window)/i.test(error.message ?? "")) return "本次内容超过可用上下文预算，尚未发送。请分段发送或先压缩历史；完整记录仍保留。";
  if (/READ|IPC|STORAGE/i.test(error.code ?? "")) return "上下文状态读取失败，请刷新核对；旧记录不代表这次成功。";
  return "上下文操作未确认完成，请刷新核对后再试；完整历史仍保留。";
}

export function contextUsageLabel(value: ContextDiagnostics): string {
  const prepared = value.lastPreparation;
  if (!prepared || prepared.estimatedInputTokens === null) return "尚无输入估算";
  if (prepared.outcome === "failed") return "上下文压缩失败，未证明本次输入可发送";
  const status = contextBudgetStatus(prepared.estimatedInputTokens, value.budget);
  return { normal: "上下文充足", compacting: "下次准备会检查是否需要压缩上下文", exceeded: "估算超过预算，不能作为发送成功依据" }[status];
}

export interface ContextPanelState {
  request: number;
  loading: boolean;
  value: ContextDiagnostics | null;
  error: string | null;
}

export const initialContextPanel: ContextPanelState = { request: 0, loading: false, value: null, error: null };

export function contextPanelReducer(state: ContextPanelState, action:
  | { type: "start"; request: number }
  | { type: "result"; request: number; result: ContextResult<ContextDiagnostics> }
): ContextPanelState {
  if (action.type === "start") {
    if (action.request <= state.request) return state;
    return { ...state, request: action.request, loading: true, error: null };
  }
  if (action.request !== state.request) return state;
  return action.result.ok
    ? { ...state, loading: false, value: action.result.value, error: null }
    : { ...state, loading: false, error: contextErrorText(action.result.error) };
}

export function preparationLabel(outcome: "passthrough" | "reused" | "written" | "noop" | "failed"): string {
  return {
    passthrough: "本次未使用摘要压缩",
    reused: "复用了已有压缩记录",
    written: "已写入并安装新压缩记录",
    noop: "无需新压缩",
    failed: "准备失败（未证明安装成功）",
  }[outcome];
}

/** User-facing status without turning missing preparation into a budget measurement. */
export function contextOverview(value: ContextDiagnostics): { title: string; description: string; failed: boolean } {
  if (value.lastPreparation?.outcome === "failed") return { title: "上次上下文准备失败", description: "上次发送前的上下文准备没有完成。请查看失败原因；旧的压缩记录不代表这次成功。", failed: true };
  if (!value.enabled) return { title: "自动压缩未开启", description: "目前会发送完整原文。较长对话可能超过模型窗口；完整记录不会删除。", failed: false };
  if (!value.lastPreparation) return { title: "自动压缩已开启", description: "继续聊天即可。对话变长时会自动压缩较早内容，并保留近期原文。完整历史不会删除。", failed: false };
  if (["written", "reused"].includes(value.lastPreparation.outcome)) return { title: "上次发送前已使用上下文摘要", description: "早期内容通过摘要提供，近期对话保留原文。完整历史仍在；摘要不保证包含每个细节。", failed: false };
  return { title: "上次发送前无需新增压缩", description: "继续聊天即可。系统会在需要时自动压缩上下文；一般不需要手动操作。", failed: false };
}
