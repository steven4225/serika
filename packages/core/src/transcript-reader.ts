import { constants, type Stats } from "node:fs";
import { open } from "node:fs/promises";

/** A read-only snapshot of committed JSONL lines, never repairing a pending tail.
 * Memory is bounded by the largest record rather than accumulated snapshots.
 * A fixed open-file size and descriptor remain valid across atomic replacement.
 */
export async function* readCommittedTranscriptLines(
  path: string,
  options: { maxLineBytes?: number; onOpen?: (snapshot: Stats) => number } = {},
): AsyncGenerator<{ line: string; endByte: number } | { incompleteTail: true }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Transcript is not a regular file");
    const buffer = Buffer.alloc(64 * 1024);
    let position = options.onOpen?.(stat) ?? 0, length = 0;
    if (!Number.isSafeInteger(position) || position < 0 || position > stat.size) throw new Error("Invalid transcript read offset");
    let pending: Buffer[] = [];
    let oversized = false;
    while (position < stat.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (!bytesRead) break;
      position += bytesRead;
      let start = 0;
      while (start < bytesRead) {
        const newline = buffer.subarray(0, bytesRead).indexOf(0x0a, start);
        const end = newline < 0 ? bytesRead : newline;
        length += end - start;
        if (options.maxLineBytes !== undefined && length > options.maxLineBytes) {
          // An uncommitted EOF tail is not a record. Continue scanning without
          // retaining it; only a newline proves a complete oversized record.
          oversized = true;
          pending = [];
        }
        if (!oversized) pending.push(Buffer.from(buffer.subarray(start, end)));
        if (newline < 0) break;
        if (oversized) throw new Error(`单条历史记录超过 ${options.maxLineBytes} 字节；未删除或截断历史`);
        yield { line: Buffer.concat(pending, length).toString("utf8"), endByte: position - bytesRead + newline + 1 };
        pending = []; length = 0; oversized = false; start = newline + 1;
      }
    }
    if (length) yield { incompleteTail: true };
  } finally {
    await file.close();
  }
}
