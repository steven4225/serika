import type { PendingApproval } from "./ui-contract.js";
import type { ToolRowStatus } from "./tool-status.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function presentComputerResult(toolName: string, output: unknown): { status: ToolRowStatus; detail: string } | undefined {
  if (toolName !== "computer_action" && toolName !== "computer_observe") return undefined;
  const data = record(output);
  if (data?.ok === false) {
    const error = record(data.error);
    return { status: error?.code === "TOOL_DENIED" ? "denied" : "failed",
      detail: typeof error?.message === "string" ? error.message : "调用未成功；不能据此声称已操作应用" };
  }
  if (toolName === "computer_observe") return data?.ok === true
    ? { status: "observed", detail: "观察已返回；是观察时的 UI 参考，不是权限或业务验收" }
    : { status: "failed", detail: "观察回执不可用，不能据此执行动作" };
  if (data?.ok !== true || data.dispatched !== true || data.verified !== false ||
      !["confirmed", "unverifiable", "suspected_noop"].includes(String(data.effect))) {
    return { status: "unknown", detail: "动作回执无法确认，效果未知；请人工核对，不自动重试" };
  }
  return { status: "dispatched", detail: data.effect === "suspected_noop"
    ? "疑似未生效；已派发但效果待核对，不自动重试"
    : data.effect === "unverifiable" ? "驱动无法验证效果；请重新观察并人工核对，不自动重试"
    : "驱动回执已返回；效果待核对，不代表保存或业务完成" };
}

export interface ComputerApprovalView {
  title: string;
  allowLabel: string;
  bundleId: string;
  pid: number | null;
  windowId: number | null;
  text: string | null;
  observationId: string | null;
  elementToken: string | null;
}

export function describeComputerApproval(approval: PendingApproval): ComputerApprovalView | undefined {
  if (approval.toolName !== "computer_observe" && approval.toolName !== "computer_action") return undefined;
  const input = record(approval.input);
  if (typeof input?.bundleId !== "string" || input.bundleId.length === 0) return undefined;
  const positive = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  const exact = positive(input.pid) && positive(input.windowId);
  if (!exact && (approval.toolName === "computer_action" || input.pid !== undefined || input.windowId !== undefined)) return undefined;
  const action = approval.toolName === "computer_action" ? input.action : "observe";
  if (action !== "observe" && action !== "click" && action !== "type_text") return undefined;
  if (action === "type_text" && (typeof input.text !== "string" || input.text.length === 0 || input.text.length > 4096)) return undefined;
  if (action === "click" && input.text !== undefined) return undefined;
  if (action !== "observe" && (typeof input.observationId !== "string" || !input.observationId || typeof input.elementToken !== "string" || !input.elementToken)) return undefined;
  return {
    title: action === "observe" ? (exact ? "观察指定窗口" : "列出指定应用窗口") : action === "click" ? "点击指定控件" : "向指定控件输入文本",
    allowLabel: action === "observe" ? "允许本次观察" : action === "click" ? "允许本次点击" : "允许本次输入",
    bundleId: input.bundleId, pid: exact ? input.pid as number : null, windowId: exact ? input.windowId as number : null,
    text: action === "type_text" ? input.text as string : null,
    observationId: action === "observe" ? null : input.observationId as string,
    elementToken: action === "observe" ? null : input.elementToken as string,
  };
}
