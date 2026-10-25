import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { acquireFlock } from "./flock.js";
import { MemoryStoreError } from "./memory-types.js";

export class MemoryExtractionError extends MemoryStoreError {
  constructor(code: string, message: string) { super(code, message); this.name = code; }
}

export type MemoryExtractionStage = "prepare" | "extract" | "validate" | "save";
const failureSchema = z.object({ version: z.literal(1), stage: z.enum(["prepare", "extract", "validate", "save"]),
  code: z.string(), message: z.string(), threadId: z.string(), projectId: z.string().nullable(), at: z.iso.datetime() }).strict();
export type MemoryExtractionFailure = z.infer<typeof failureSchema>;

export function memoryExtractionFailure(options: { stage: MemoryExtractionStage; error: unknown; threadId: string; projectId: string | null; at: Date }): MemoryExtractionFailure {
  const { stage, error, threadId, projectId, at } = options;
  // Provider exceptions may embed request/response bodies; only host-owned errors retain their text.
  return { version: 1, stage, code: error instanceof MemoryStoreError ? error.code : "MEMORY_EXTRACTION_FAILED",
    message: error instanceof MemoryStoreError ? error.message : "记忆整理调用失败；外部错误正文未记录", threadId, projectId, at: at.toISOString() };
}

export async function appendMemoryExtractionFailure(path: string, failure: MemoryExtractionFailure): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const lock = await acquireFlock(`${path}.lock`);
  try {
    const handle = await open(path, constants.O_APPEND | constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      const { size } = await handle.stat(), tail = Buffer.alloc(1);
      if (size) { await handle.read(tail, 0, 1, size - 1); if (tail[0] !== 10) await handle.writeFile("\n"); }
      await handle.writeFile(`${JSON.stringify(failure)}\n`); await handle.sync();
    } finally { await handle.close(); }
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await lock.release(); }
}

export async function readMemoryExtractionFailures(path: string, scope: { threadId: string; projectId: string | null }): Promise<MemoryExtractionFailure[]> {
  let text: string;
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { text = await handle.readFile("utf8"); } finally { await handle.close(); }
  } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return []; throw error; }
  return text.split("\n").flatMap(line => {
    if (!line) return [];
    let value: unknown; try { value = JSON.parse(line); } catch { return []; }
    const row = failureSchema.safeParse(value);
    return row.success && row.data.threadId === scope.threadId && row.data.projectId === scope.projectId ? [row.data] : [];
  });
}
