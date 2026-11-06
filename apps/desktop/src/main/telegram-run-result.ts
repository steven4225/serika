import type { AgentErrorData } from "@serika/core";
import type { ExecutionRunRecord, ExecutionToolRecord } from "@serika/assistant";
import { telegramBoundedText } from "./telegram-format.js";
import { TELEGRAM_DIRECTORY_AUTHORIZATION_USAGE } from "./telegram-directory-authorization.js";

function failureReason(code: AgentErrorData["code"] | undefined): string {
  switch (code) {
    case "MODEL_TIMEOUT": return "模型回复超时，本次请求未完成。";
    case "MODEL_AUTH": return "模型服务认证失败，本次请求未完成。";
    case "MODEL_RATE_LIMIT": return "模型服务限流，本次请求未完成。";
    case "MODEL_UNAVAILABLE": return "模型服务暂时不可用，本次请求未完成。";
    case "MODEL_BAD_RESPONSE": return "模型返回的内容无法处理，本次请求未完成。";
    case "CONTEXT_PREPARE_FAILED": return "对话上下文准备失败，本次请求未完成。";
    case "RUN_LIMIT_EXCEEDED": return "本轮执行步数已用完，请求未完成。";
    case "TOOL_NOT_FOUND": return "请求的工具当前不可用，本次请求未完成。";
    default: return "本次请求未完成。";
  }
}

function toolSummary(tools: readonly ExecutionToolRecord[]): string {
  if (!tools.length) return "本轮未执行工具操作。";
  const counts = { returned: 0, failed: 0, notStarted: 0, unknown: 0, writes: 0 };
  const reasons = new Set<string>();
  for (const tool of tools) {
    if (tool.status === "completed") { if (tool.errorCode) counts.failed++; else counts.returned++; if (tool.fileWrite) counts.writes++; }
    else if (tool.status === "failed") counts.failed++;
    else if (tool.status === "not_started" || tool.status === "requested") counts.notStarted++;
    else counts.unknown++;
    switch (tool.errorCode) {
      case "PATH_OUTSIDE_WORKSPACE": reasons.add("目标路径尚未授权"); break;
      case "DIRECTORY_SELECTION_REQUIRED": reasons.add("需要明确选择授权目录"); break;
      case "READ_ONLY_DIRECTORY": reasons.add("目标目录仅允许读取"); break;
      case "PROTECTED_PATH": reasons.add("目标属于受保护路径"); break;
      case "TOOL_DENIED": reasons.add("操作未获批准"); break;
    }
  }
  if (tools.some(tool => tool.errorCode === "PATH_OUTSIDE_WORKSPACE" || tool.errorCode === "READ_ONLY_DIRECTORY")) reasons.add(TELEGRAM_DIRECTORY_AUTHORIZATION_USAGE);
  const statuses = [counts.returned ? `已返回 ${counts.returned} 次` : "", counts.failed ? `失败 ${counts.failed} 次` : "",
    counts.notStarted ? `未执行 ${counts.notStarted} 次` : "", counts.unknown ? `效果未知 ${counts.unknown} 次` : "",
    counts.writes ? `文件写入回执成功 ${counts.writes} 次` : ""].filter(Boolean);
  return [`工具记录：${statuses.join("；")}。`, ...reasons].join("\n");
}

export function telegramRunResult(input: {
  run: ExecutionRunRecord; text?: string; task: boolean;
  reminders?: readonly { toolCallId: string; text: string }[];
}): { body: string; uncertain: boolean } {
  const { run, text, reminders } = input;
  const unknownTool = run.tools.some(tool => tool.status === "unknown" || tool.status === "started");
  const uncertain = run.status === "interrupted" || unknownTool;
  const label = unknownTool ? "有工具操作的效果尚未确认；不会自动重做。"
    : run.status === "interrupted" ? "执行中断；不会自动重做。"
    : run.status === "completed" ? input.task ? "结果仍需你在桌面验收。" : ""
    : run.status === "cancelled" ? "本轮已停止。"
    : run.status === "timed_out" ? "本轮执行时间已用完，请求未完成。"
    : failureReason(run.errorCode);
  const summary = run.status !== "completed" || uncertain || run.tools.some(tool => tool.errorCode || tool.status === "failed") ? toolSummary(run.tools) : "";
  const reply = reminders?.length ? reminders.map(receipt => run.tools.some(tool => tool.toolCallId === receipt.toolCallId && tool.status === "not_started")
    ? "这条提醒未保存（操作尚未开始）。" : receipt.text).join("\n") : uncertain ? "" : text ?? run.resultTextPreview ?? "";
  const body = telegramBoundedText([label, summary, reply.trim() ? reply : label ? "" : "这次没有可显示的回复，请查看桌面执行记录。",
    !uncertain && !reminders?.length && text === undefined && run.resultTextTruncated ? "[恢复的是回执预览，已截断；完整回复请看桌面]" : ""].filter(Boolean).join("\n"));
  return { body, uncertain };
}
