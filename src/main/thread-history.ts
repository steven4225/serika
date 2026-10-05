import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { DesktopThread } from "./desktop-identity.js";
import type { ThreadSummary } from "../shared/ui-contract.js";

const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

/** Read-only discovery; do not use JsonlAgentStore here because its tail repair mutates files. */
export async function inspectThread(thread: DesktopThread): Promise<ThreadSummary> {
  const path = join(thread.transcriptDirectory, `${createHash("sha256").update(thread.threadId).digest("hex")}.jsonl`);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TRANSCRIPT_BYTES) throw new Error("Transcript is not a regular bounded file");
    const raw = await readFile(path, "utf8");
    if (Buffer.byteLength(raw) > MAX_TRANSCRIPT_BYTES) throw new Error("Transcript exceeds the discovery limit");
    let messages: Array<{ role: string; parts: Array<{ type: string; text?: string }>; metadata?: { source?: string } }> = [];
    const lines = raw.split("\n");
    const incompleteTail = lines.pop() !== "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (record.threadId !== thread.threadId) throw new Error("Transcript Thread identity does not match the file");
      if (record.type === "thread.messages.committed" && record.v === 1 && Array.isArray(record.messages)) {
        if (record.messages.some((message: { role?: string; parts?: unknown }) => !["user", "assistant", "system"].includes(message.role ?? "") || !Array.isArray(message.parts))) throw new Error("Invalid committed messages");
        messages = record.messages;
      } else if (record.type !== "thread.context.compacted") throw new Error("Invalid transcript record");
    }
    const user = messages.find(message => message.role === "user" && message.metadata?.source !== "auto-consolidation");
    const title = user?.parts.flatMap(part => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join(" ").slice(0, 64) || "新对话";
    return { ...thread, title, messageCount: messages.length, savedAt: stat.mtime.toISOString(), ...(incompleteTail ? { error: "末尾有未完成记录；这里只展示最近完整快照" } : {}) };
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
    const stat = await lstat(path);
    if (stat.size > MAX_TRANSCRIPT_BYTES) throw new Error(`历史文件超过 16 MiB：${file.name}`);
    const raw = await readFile(path, "utf8");
    const first = raw.slice(0, raw.indexOf("\n") < 0 ? 0 : raw.indexOf("\n"));
    if (!first) throw new Error(`没有完整历史记录：${file.name}`);
    const record = JSON.parse(first);
    if (typeof record.threadId !== "string" || !record.threadId || record.threadId.length > 256 || createHash("sha256").update(record.threadId).digest("hex") + ".jsonl" !== file.name) throw new Error(`无法核对会话身份：${file.name}`);
    found.push(await inspectThread({ threadId: record.threadId, transcriptDirectory: resolved }));
  }
  return found;
}
