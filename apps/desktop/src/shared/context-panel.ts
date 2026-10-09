import type { ContextDiagnostics, ContextResult } from "@aisdk-agent/example-cli/dist/context-diagnostics.js";

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
    : { ...state, loading: false, error: `${action.result.error.code}: ${action.result.error.message}` };
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
  if (value.lastPreparation?.outcome === "failed") return { title: "上次对话准备失败", description: "上次发送前的上下文准备没有完成。请查看失败原因；旧的整理记录不代表这次成功。", failed: true };
  if (!value.enabled) return { title: "自动摘要整理未开启", description: "目前只保留有限的近期对话。较早内容可能不进入模型；完整对话记录不会因此删除。", failed: false };
  if (!value.lastPreparation) return { title: "自动管理已开启", description: "继续聊天即可。对话变长时会自动整理较早内容，并保留近期原文。完整历史不会删除。", failed: false };
  if (["written", "reused"].includes(value.lastPreparation.outcome)) return { title: "上次发送前已使用整理摘要", description: "早期内容通过摘要提供，近期对话保留原文。完整历史仍在；摘要不保证包含每个细节。", failed: false };
  return { title: "上次发送前无需新增整理", description: "继续聊天即可。系统会在需要时自动整理；一般不需要手动操作。", failed: false };
}
