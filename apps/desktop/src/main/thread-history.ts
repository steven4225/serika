import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { readCommittedTranscriptLines, createThreadTranscriptReader, MAX_TRANSCRIPT_RECORD_BYTES } from "@serika/core";
import type { DesktopThread } from "./desktop-identity.js";
import type { ThreadSummary } from "../shared/ui-contract.js";

// The safety bound applies to a single logical snapshot, not duplicated disk
// history. Large accumulated files can be searched without loading them whole.
const MAX_RECORD_BYTES = MAX_TRANSCRIPT_RECORD_BYTES;
const readHistory = createThreadTranscriptReader();
type SummaryProjection = Pick<ThreadSummary, "title" | "messageCount" | "preview" | "matchesQuery" | "savedAt" | "error">;
// Small projections let a 100-Thread list stay warm without retaining 100 full
// conversations. Search results are cached separately under the same stamp.
const summaries = new Map<string, { stamp: string; value: SummaryProjection }>();
const fileStamp = (stat: Awaited<ReturnType<typeof lstat>>) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

/** Read-only discovery; never repairs tails or performs snapshot cleanup. */
export async function inspectThread(thread: DesktopThread, query = ""): Promise<ThreadSummary> {
  const path = join(thread.transcriptDirectory, `${createHash("sha256").update(thread.threadId).digest("hex")}.jsonl`);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Transcript is not a regular file");
    const key = JSON.stringify([path, thread.threadId, query]);
    const cached = summaries.get(key);
    summaries.delete(key);
    if (cached?.stamp === fileStamp(stat)) {
      summaries.set(key, cached);
      return { ...thread, ...cached.value };
    }
    const transcript = await readHistory(path, thread.threadId);
    const messages = transcript.messages as Array<{ role: string; parts: Array<{ type: string; text?: string }>; metadata?: { source?: string } }>;
    const incompleteTail = transcript.incompleteTail;
    if (messages.some(message => !["user", "assistant", "system"].includes(message.role) || !Array.isArray(message.parts))) throw new Error("Invalid committed messages");
    let background = false;
    const conversation: Array<{ role: string; text: string }> = [];
    for (const message of messages) {
      if (message.role === "user") background = message.metadata?.source === "auto-consolidation";
      if (background || message.role === "system") continue;
      const text = message.parts.flatMap(part => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join(" ");
      if (text.trim()) conversation.push({ role: message.role, text });
    }
    const compact = (text: string) => text.replace(/\s+/g, " ").trim();
    const first = conversation.find(message => message.role === "user");
    const title = compact(first?.text.split("\n").find(line => line.trim()) ?? "").slice(0, 48) || "新对话";
    const matched = query ? [...conversation].reverse().find(message => message.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) : undefined;
    const previewText = compact(matched?.text ?? conversation.at(-1)?.text ?? "");
    const matchIndex = query ? previewText.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1;
    const start = Math.max(0, matchIndex - 30);
    const preview = `${start ? "…" : ""}${previewText.slice(start, start + 160)}${previewText.length > start + 160 ? "…" : ""}`;
    const value: SummaryProjection = { title, messageCount: messages.length, preview, matchesQuery: !query || !!matched,
      savedAt: stat.mtime.toISOString(), ...(incompleteTail ? { error: "末尾有未完成记录；这里只展示最近完整快照" } : {}) };
    if (fileStamp(await lstat(path)) === fileStamp(stat)) {
      summaries.set(key, { stamp: fileStamp(stat), value });
      while (summaries.size > 200) summaries.delete(summaries.keys().next().value!);
    }
    return { ...thread, ...value };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...thread, title: "新对话", messageCount: 0 };
    return { ...thread, title: thread.threadId, messageCount: null, error: error instanceof Error ? error.message : "无法读取历史" };
  }
}
