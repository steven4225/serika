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
