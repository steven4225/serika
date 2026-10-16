import type { AssistantSteerRecord } from "./ui-contract.js";

/** Only controller records establish acceptance/application; never optimistic delivery. */
export function mergeSteerRecords(records: readonly AssistantSteerRecord[], next: AssistantSteerRecord, runId: string | null): readonly AssistantSteerRecord[] {
  if (next.runId !== runId) return records;
  const rank = { accepted: 0, applied: 1, not_applied: 1 } as const;
  const previous = records.find(record => record.id === next.id && record.runId === next.runId);
  if (previous && rank[next.status] < rank[previous.status]) return records;
  return [...records.filter(record => record.id !== next.id), next].slice(-8);
}

export function steerStatusLabel(record: AssistantSteerRecord): string {
  switch (record.status) {
    case "accepted": return "等待当前步骤结束后处理";
    case "applied": return "";
    case "not_applied": return "本轮未应用，消息已保留";
  }
}

export function steerFailureLabel(reason: string): string {
  switch (reason) {
    case "stale": case "closed": return "本轮已结束或正在收尾，补充要求未接入。草稿已保留。";
    case "busy": return "当前不是可补充的用户任务；不会排队或启动新一轮。";
    case "limit": return "本轮补充次数已到上限，草稿已保留。";
    case "conflict": return "这次补充请求的编号已被使用，请先核对执行记录。";
    case "invalid": return "补充要求不符合格式或长度限制，草稿已保留。";
    default: return "补充要求未成功接入，草稿已保留。";
  }
}
