import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { readCommittedTranscriptLines } from "@aisdk-agent/core";
import type { DesktopThread } from "./desktop-identity.js";
import type { ThreadSummary } from "../shared/ui-contract.js";

// The safety bound applies to a single logical snapshot, not duplicated disk
// history. Large accumulated files can be searched without loading them whole.
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

/** Read-only discovery; never repairs tails or performs snapshot cleanup. */
export async function inspectThread(thread: DesktopThread, query = ""): Promise<ThreadSummary> {
  const path = join(thread.transcriptDirectory, `${createHash("sha256").update(thread.threadId).digest("hex")}.jsonl`);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Transcript is not a regular file");
    let messages: Array<{ role: string; parts: Array<{ type: string; text?: string }>; metadata?: { source?: string } }> = [];
    let incompleteTail = false;
    for await (const item of readCommittedTranscriptLines(path, { maxLineBytes: MAX_RECORD_BYTES })) {
      if (!("line" in item)) { incompleteTail = true; continue; }
      const { line } = item;
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (record !== null && typeof record === "object" && "v" in record && record.v !== 1) continue;
      if (record.threadId !== thread.threadId) throw new Error("Transcript Thread identity does not match the file");
      if (record.type === "thread.messages.committed" && record.v === 1 && Array.isArray(record.messages)) {
        if (record.messages.some((message: { role?: string; parts?: unknown }) => !["user", "assistant", "system"].includes(message.role ?? "") || !Array.isArray(message.parts))) throw new Error("Invalid committed messages");
        messages = record.messages;
      } else if (record.type !== "thread.context.compacted") throw new Error("Invalid transcript record");
    }
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
    return { ...thread, title, messageCount: messages.length, preview, matchesQuery: !query || !!matched,
      savedAt: stat.mtime.toISOString(), ...(incompleteTail ? { error: "末尾有未完成记录；这里只展示最近完整快照" } : {}) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...thread, title: "新对话", messageCount: 0 };
    return { ...thread, title: thread.threadId, messageCount: null, error: error instanceof Error ? error.message : "无法读取历史" };
  }
}

export async function discoverThreadDirectory(directory: unknown): Promise<ThreadSummary[]> {
  if (typeof directory !== "string" || !isAbsolute(directory)) throw new Error("请选择或输入历史目录的绝对路径");
  const resolved = await realpath(directory);
  const entries = await readdir(resolved, { withFileTypes: true });
  const files = entries.filter(entry => entry.isFile() && /^[a-f0-9]{64}\.jsonl$/.test(entry.name));
  if (files.length > 100) throw new Error("历史目录超过 100 个会话，请先选择较小的目录");
  const found: ThreadSummary[] = [];
  for (const file of files) {
    const path = join(resolved, file.name);
    let first = "";
    for await (const item of readCommittedTranscriptLines(path, { maxLineBytes: MAX_RECORD_BYTES })) {
      if ("line" in item) first = item.line;
      break;
    }
    if (!first) throw new Error(`没有完整历史记录：${file.name}`);
    const record = JSON.parse(first);
    if (typeof record.threadId !== "string" || !record.threadId || record.threadId.length > 256 || createHash("sha256").update(record.threadId).digest("hex") + ".jsonl" !== file.name) throw new Error(`无法核对会话身份：${file.name}`);
    found.push(await inspectThread({ threadId: record.threadId, transcriptDirectory: resolved }));
  }
  return found;
}
