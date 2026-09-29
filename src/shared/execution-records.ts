import type {
  ExecutionRunRecord,
  ExecutionRunStatus,
  ExecutionToolRecord,
  ExecutionToolStatus,
  GetRunResponse,
  ListRunsResponse,
  RunPhase,
} from "./ui-contract.js";

export const EXECUTION_RECORDS_UNAVAILABLE = "执行记录不可用 / 被其他进程占用";

export async function wrapExecutionQuery<T>(
  query: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; reason: "unavailable"; message: string }> {
  try {
    return { ok: true, value: await query() };
  } catch (error) {
    return { ok: false, reason: "unavailable", message: String(error) };
  }
}

export function toListRunsResponse(
  result: Awaited<ReturnType<typeof wrapExecutionQuery<ExecutionRunRecord[]>>>,
): ListRunsResponse {
  if (!result.ok) return { ok: false, reason: "unavailable", message: result.message };
  return { ok: true, runs: result.value };
}

export function toGetRunResponse(
  result: Awaited<ReturnType<typeof wrapExecutionQuery<ExecutionRunRecord | null>>>,
): GetRunResponse {
  if (!result.ok) return { ok: false, reason: "unavailable", message: result.message };
  return { ok: true, run: result.value };
}

export function runStatusLabel(status: ExecutionRunStatus): string {
  switch (status) {
    case "running":
      return "进行中";
    case "interrupted":
      return "已中断";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    case "timed_out":
      return "超时";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export function runPhaseLabel(phase: RunPhase): string {
  switch (phase) {
    case "primary":
      return "主任务";
    case "consolidation":
      return "整理";
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}

export function toolStatusLabel(status: ExecutionToolStatus): string {
  switch (status) {
    case "requested":
      return "待开始";
    case "not_started":
      return "未执行";
    case "started":
      return "执行中";
    case "completed":
      return "已返回";
    case "failed":
      return "失败";
    case "unknown":
      return "需人工核对";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export function parsePreviewJson(preview: string | null): unknown {
  if (preview === null) return undefined;
  try {
    return JSON.parse(preview) as unknown;
  } catch {
    return undefined;
  }
}

/** `completed` means the tool function returned. Business success is a separate preview/shell read. */
export function completedOutcome(tool: ExecutionToolRecord): string {
  if (tool.shell !== null) {
    const parts = [`exit ${String(tool.shell.exitCode)}`];
    if (tool.shell.timedOut) parts.push("Shell 超时");
    if (tool.shell.cancelled) parts.push("已取消");
    return parts.join(" · ");
  }
  const parsed = parsePreviewJson(tool.resultPreview);
  if (typeof parsed === "object" && parsed !== null && "ok" in parsed) {
    return (parsed as { ok: unknown }).ok === true ? "ok:true" : "ok:false";
  }
  return "函数已返回";
}

export function toolTone(tool: ExecutionToolRecord): "ok" | "fail" | "warn" | "muted" | "unknown" {
  switch (tool.status) {
    case "not_started":
    case "requested":
      return "muted";
    case "started":
      return "warn";
    case "unknown":
      return "unknown";
    case "failed":
      return "fail";
    case "completed": {
      if (tool.shell?.timedOut === true || tool.shell?.cancelled === true) return "warn";
      if (typeof tool.shell?.exitCode === "number" && tool.shell.exitCode !== 0) return "fail";
      const parsed = parsePreviewJson(tool.resultPreview);
      if (typeof parsed === "object" && parsed !== null && "ok" in parsed && (parsed as { ok: unknown }).ok === false) {
        return "fail";
      }
      return "ok";
    }
    default: {
      const exhaustive: never = tool.status;
      return exhaustive;
    }
  }
}

export function toolNote(tool: ExecutionToolRecord): string {
  switch (tool.status) {
    case "not_started":
      return "还没 started，不能当成已经改过文件。";
    case "requested":
      return "尚未写入 started；若进程在确认中退出，应显示为未执行。";
    case "started":
      return "本进程内已进入 execute。";
    case "unknown":
      return "已 started，没有最终回执。请核对磁盘或外部系统。不会自动重试。";
    case "failed":
      return tool.errorPreview ?? "明确失败（含用户拒绝）。";
    case "completed":
      return completedOutcome(tool);
    default: {
      const exhaustive: never = tool.status;
      return exhaustive;
    }
  }
}

export function runSummary(run: ExecutionRunRecord): string {
  const unknown = run.tools.filter((tool) => tool.status === "unknown").length;
  const completed = run.tools.filter((tool) => tool.status === "completed").length;
  const parts = [runStatusLabel(run.status), runPhaseLabel(run.phase)];
  if (unknown > 0) parts.push(`${unknown} 需核对`);
  if (completed > 0) parts.push(`${completed} 已返回`);
  if (run.tools.length > 0) parts.push(`${run.tools.length} 工具`);
  return parts.join(" · ");
}

export function formatRecordTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", { hour12: false });
}
