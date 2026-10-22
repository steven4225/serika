import type { UIMessage } from "ai";
import { AUTO_CONSOLIDATION_SOURCE } from "./consolidation.js";

export function automaticConsolidationMessage(id: string): UIMessage {
  return {
    id, role: "user", metadata: { source: AUTO_CONSOLIDATION_SOURCE },
    parts: [{ type: "text", text: "请整理最近已提交的对话：先取材，再调用 memory_stage_candidates 提交有来源和资格分类的结构化提案；没有建议也提交空数组。正式写入或待审由程序按已配置策略处理，不直接调用 active 记忆工具，不在收到程序回执前宣称保存成功。" }],
  };
}

/** Cancellation must actually settle before another Run is allowed on the Thread. */
export async function waitForConsolidationHandoff(task: Promise<void>, timeoutMs = 5_000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task.then(() => true, () => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
