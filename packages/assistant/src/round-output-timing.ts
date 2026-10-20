import type { AgentEvent } from "@serika/core";
import type { UIMessage } from "ai";
import type { ModelCallLog } from "./model-call-log.js";

/** Measure the visible body at the same event boundary used by the front end. */
export function beginRoundOutputTiming(input: { message: UIMessage; threadId: string; log: ModelCallLog }) {
  const metadata = input.message.metadata as Record<string, unknown> | undefined;
  const receivedAt = metadata?.receivedAt ?? metadata?.sentAt;
  const receipt = typeof receivedAt === "string" ? Date.parse(receivedAt) : NaN;
  const now = Date.now(), started = performance.now();
  const receiptDelay = Number.isFinite(receipt) ? Math.max(0, now - receipt) : 0;
  let firstVisibleTextMs: number | null = null, tool = false, runId: string | undefined;
  return {
    observe(event: AgentEvent): void {
      runId = event.runId;
      if (event.type === "tool.call.requested") tool = true;
      if (event.type === "message.delta" && event.data.text.length > 0 && firstVisibleTextMs === null) {
        firstVisibleTextMs = receiptDelay + performance.now() - started;
      }
    },
    finish: () => input.log.round({ threadId: input.threadId, messageId: input.message.id,
      ...(runId ? { runId } : {}), receivedAt: new Date(Number.isFinite(receipt) ? receipt : now).toISOString(),
      firstVisibleTextMs, outcome: firstVisibleTextMs !== null ? "text" : tool ? "tool_only" : "no_output" }),
  };
}
