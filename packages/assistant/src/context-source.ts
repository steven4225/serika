import type { UIMessage } from "ai";
import { formatLocalTaskTime } from "./task-instructions.js";
import { collectTranscriptToolFacts } from "./work-summary.js";

/** The same original-block prefix feeds compaction and extraction. */
export function originalBlock(messages: readonly UIMessage[], location: { threadId?: string; project?: string } = {}): string {
  return "Original block:\n" + JSON.stringify(messages.map(message => {
    const metadata = (message.metadata ?? {}) as Record<string, unknown>;
    const facts = collectTranscriptToolFacts([message]);
    const stamp = metadata.receivedAt ?? metadata.sentAt;
    const localTime = typeof stamp === "string" && Number.isFinite(Date.parse(stamp)) ? formatLocalTaskTime(new Date(stamp), "Asia/Shanghai") : null;
    return { id: message.id, role: message.role, ...location,
      metadata: { time: localTime, channel: metadata.channel ?? "desktop", ...(metadata.transcriptExcluded ? { transcriptExcluded: true } : {}) },
      text: message.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n"),
      tools: facts.map(fact => ({ name: fact.toolName, status: fact.status })),
      attachments: message.parts.filter(part => part.type === "file").map(part => ({ name: part.filename ?? "attachment", mediaType: part.mediaType, note: "Do not infer its contents." })),
    };
  }));
}
