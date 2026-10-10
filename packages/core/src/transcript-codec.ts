import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import type { UIMessage } from "ai";
import { AgentError } from "./errors.js";
import { readCommittedTranscriptLines } from "./transcript-reader.js";

const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const CHUNK_BYTES = 192 * 1024;
// Bounds a single legacy record/transaction, not an entire conversation file.
export const MAX_TRANSCRIPT_RECORD_BYTES = 128 * 1024 * 1024;
const fail = (threadId: string): never => { throw new AgentError({ code: "STORAGE_CORRUPT", message: `Stored transcript is corrupt for thread: ${threadId}`, retryable: false, phase: "storage" }); };

/** v3 appends only the changed suffix. A newline-terminated commit authenticates
 * every chunk and the previous prefix; chunks without a commit are not messages.
 * A checkpoint has keep=0, so it also works without the original delta chain.
 */
export function encodeTranscriptUpdate(threadId: string, previous: UIMessage[], next: UIMessage[], checkpoint = false): string[] {
  let keep = 0;
  if (!checkpoint) while (keep < previous.length && keep < next.length && JSON.stringify(previous[keep]) === JSON.stringify(next[keep])) keep++;
  const payload = Buffer.from(JSON.stringify(next.slice(keep)));
  if (payload.length > MAX_TRANSCRIPT_RECORD_BYTES) throw new Error("单次对话保存超过 128 MiB；未截断历史");
  const transactionId = randomUUID(), lines: string[] = [];
  for (let offset = 0; offset < payload.length; offset += CHUNK_BYTES) lines.push(JSON.stringify({ v: 3, type: "thread.messages.chunk", threadId, transactionId,
    index: lines.length, data: payload.subarray(offset, offset + CHUNK_BYTES).toString("base64") }) + "\n");
  lines.push(JSON.stringify({ v: 3, type: "thread.messages.committed", threadId, transactionId, keep,
    baseHash: hash(JSON.stringify(previous.slice(0, keep))), chunks: lines.length, payloadHash: hash(payload) }) + "\n");
  return lines;
}

type ReadOptions = { maxLineBytes?: number; companions?: boolean };
type DecoderState = { messages: UIMessage[]; companions: string[]; pending?: { id: string; chunks: Buffer[]; bytes: number } | undefined };
type Checkpoint = { state: DecoderState; stamp: Stats; offset: number; incompleteTail: boolean };

async function decodeTranscript(path: string, threadId: string, options: ReadOptions, cached?: Checkpoint) {
  let state: DecoderState = { messages: [], companions: [] };
  let offset = 0, stamp!: Stats;
  let incompleteTail = false;
  for await (const item of readCommittedTranscriptLines(path, {
    maxLineBytes: options.maxLineBytes ?? MAX_TRANSCRIPT_RECORD_BYTES,
    onOpen(snapshot) {
      stamp = snapshot;
      // The owned protocol only appends or atomically replaces. A replacement,
      // truncation or same-size edit invalidates this process-local projection.
      if (cached && snapshot.dev === cached.stamp.dev && snapshot.ino === cached.stamp.ino &&
          (snapshot.size > cached.stamp.size || snapshot.size === cached.stamp.size &&
            snapshot.mtimeMs === cached.stamp.mtimeMs && snapshot.ctimeMs === cached.stamp.ctimeMs)) {
        state = { messages: cached.state.messages, companions: [...cached.state.companions],
          ...(cached.state.pending ? { pending: { ...cached.state.pending, chunks: [...cached.state.pending.chunks] } } : {}) };
        offset = cached.offset;
        if (snapshot.size === cached.stamp.size) { incompleteTail = cached.incompleteTail; return snapshot.size; }
        return offset;
      }
      return 0;
    },
  })) {
    if (!("line" in item)) { incompleteTail = true; continue; }
    offset = item.endByte;
    if (!item.line.trim()) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(item.line); } catch { fail(threadId); }
    if (!record! || typeof record! !== "object") fail(threadId);
    const value = record!;
    if (value.v === 3 && (value.type === "thread.messages.chunk" || value.type === "thread.messages.committed")) {
      if (value.threadId !== threadId || typeof value.transactionId !== "string" || !value.transactionId) fail(threadId);
      if (value.type === "thread.messages.chunk") {
        if (!Number.isSafeInteger(value.index) || (value.index as number) < 0 || typeof value.data !== "string" || value.data.length > CHUNK_BYTES * 4 / 3 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) fail(threadId);
        if (value.index === 0) state.pending = { id: value.transactionId as string, chunks: [], bytes: 0 };
        const pending = state.pending;
        if (!pending || pending.id !== value.transactionId || pending.chunks.length !== value.index) fail(threadId);
        const chunk = Buffer.from(value.data as string, "base64");
        pending!.bytes += chunk.length;
        if (pending!.bytes > MAX_TRANSCRIPT_RECORD_BYTES) fail(threadId);
        pending!.chunks.push(chunk);
      } else {
        const pending = state.pending;
        if (!pending || pending.id !== value.transactionId || pending.chunks.length !== value.chunks || !Number.isSafeInteger(value.keep) || (value.keep as number) < 0 || (value.keep as number) > state.messages.length) fail(threadId);
        const payload = Buffer.concat(pending!.chunks, pending!.bytes), keep = value.keep as number;
        if (hash(payload) !== value.payloadHash || hash(JSON.stringify(state.messages.slice(0, keep))) !== value.baseHash) fail(threadId);
        let suffix: UIMessage[];
        try { suffix = JSON.parse(payload.toString("utf8")); } catch { fail(threadId); }
        if (!Array.isArray(suffix!) || suffix!.some(message => !message || typeof message.id !== "string" || !["user", "assistant", "system"].includes(message.role) || !Array.isArray(message.parts))) fail(threadId);
        state.messages = [...state.messages.slice(0, keep), ...suffix!]; state.pending = undefined;
      }
    } else if (value.type === "thread.context.compacted" || "v" in value && value.v !== 1) {
      if (options.companions) state.companions.push(item.line);
    } else {
      if (value.v !== 1 || value.type !== "thread.messages.committed" || value.threadId !== threadId || !Array.isArray(value.messages)) fail(threadId);
      state.messages = value.messages as UIMessage[]; state.pending = undefined;
    }
  }
  return { state, stamp, offset, incompleteTail: incompleteTail || state.pending !== undefined };
}

const result = (checkpoint: Checkpoint) => ({ messages: checkpoint.state.messages,
  companions: checkpoint.state.companions, incompleteTail: checkpoint.incompleteTail });

/** Stateless full validation, used for offline inspection and exports. */
export async function readThreadTranscript(path: string, threadId: string, options: ReadOptions = {}) {
  return result(await decodeTranscript(path, threadId, options));
}

/** Read-only, bounded-count cache for an append/replace-only owned transcript.
 * No on-disk index, remembered permission, cursor mutation or tail repair.
 * Pending chunks and the last newline offset survive a later appended commit.
 */
export function createThreadTranscriptReader(maxEntries = 4) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("Invalid transcript cache capacity");
  const cache = new Map<string, Checkpoint>();
  return async (path: string, threadId: string, options: ReadOptions = {}) => {
    const key = JSON.stringify([path, threadId, options.companions === true, options.maxLineBytes ?? MAX_TRANSCRIPT_RECORD_BYTES]);
    const cached = cache.get(key);
    cache.delete(key);
    const checkpoint = await decodeTranscript(path, threadId, options, cached);
    cache.set(key, checkpoint);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
    // Never let callers mutate a cached source, including message metadata.
    return structuredClone(result(checkpoint));
  };
}
