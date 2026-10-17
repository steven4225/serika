import type { MemoryKind } from "@serika/assistant";

export function memoryKindLabel(kind: MemoryKind | undefined): string {
  switch (kind) {
    case "preference": return "偏好";
    case "fact": return "事实";
    case "event": return "事件";
    case "note": return "笔记";
    case undefined: return "未提供";
  }
}

/** Memory write failures in plain Chinese, never raw ids or codes. */
export function memoryErrorText(error: { code: string; message: string }): string {
  if (error.code === "MEMORY_DISABLED") return "记忆还没开启。";
  if (error.code === "MEMORY_ENTRY_NOT_FOUND") return "这条记忆已经不存在，请刷新。";
  if (error.code === "MEMORY_REVISION_CONFLICT") return "记忆已经变化，请刷新后再改；这次没有覆盖原内容。";
  if (error.code === "MEMORY_TEMPORAL_CONFLICT") return "同一场景已有不同的有效记忆，请先删除或修改其中一条；原记忆没有被覆盖。";
  if (error.code === "MEMORY_COMMIT_UNCERTAIN") return "这次是否保存尚未确认，请刷新核对。";
  return "这次没有完成记忆操作，请刷新后核对当前内容再试。";
}
