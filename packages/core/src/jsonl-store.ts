import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { UIMessage } from "ai";
import { AgentError } from "./errors.js";
import type { AgentEvent } from "./events.js";
import {
  InMemoryAgentStore,
  type AgentStore,
  type ContextCompactionStore,
  type RunRecord,
  type ThreadContextCompactionRecord,
} from "./store.js";
import type { RunResult, RunStatus } from "./types.js";
import { encodeTranscriptUpdate, createThreadTranscriptReader, readThreadTranscript, MAX_TRANSCRIPT_RECORD_BYTES } from "./transcript-codec.js";

export interface JsonlAgentStoreOptions {
  directory: string;
  /** Host-owned cross-process lock, shared by every writer to this path.
   * Without it, automatic snapshot replacement is deliberately disabled.
   */
  acquireTranscriptLock?: (path: string) => Promise<{ release(): Promise<void> }>;
  snapshotCleanupThresholdBytes?: number;
}

interface CommittedMessagesRecord {
  v: 1;
  type: "thread.messages.committed";
  threadId: string;
  messages: UIMessage[];
}

// All instances addressing the same local transcript share one queue. External
// processes must still hold the embedding application's exclusive Thread lease.
const transcriptOperations = new Map<string, Promise<void>>();

function serializeTranscriptOperation<T>(
  path: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = transcriptOperations.get(path) ?? Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(() => undefined, () => undefined);
  transcriptOperations.set(path, settled);
  void settled.then(() => {
    if (transcriptOperations.get(path) === settled) {
      transcriptOperations.delete(path);
    }
  });
  return result;
}

// A newline is the commit boundary, including for otherwise valid JSON. Reads
// ignore the unfinished suffix without changing bytes an active writer may own.
function parseLine(line: string, threadId: string): unknown {
  try { return JSON.parse(line); } catch { throw storageCorrupt(threadId); }
}

function isJsonValue(value: unknown): value is ThreadContextCompactionRecord[string] {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      if (Array.isArray(value)) return value.every(isJsonValue);
      if (Object.getPrototypeOf(value) !== Object.prototype) return false;
      return Object.values(value as Record<string, unknown>).every(isJsonValue);
    default:
      return false;
  }
}

function isContextCompactionRecord(
  value: unknown,
): value is ThreadContextCompactionRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    !isJsonValue(value)
  ) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.v === "number" &&
    Number.isInteger(record.v) &&
    record.v > 0 &&
    record.type === "thread.context.compacted" &&
    typeof record.threadId === "string"
  );
}

function storageCorrupt(threadId: string): AgentError {
  return new AgentError({
    code: "STORAGE_CORRUPT",
    message: `Stored transcript is corrupt for thread: ${threadId}`,
    retryable: false,
    phase: "storage",
  });
}

function isCommittedMessagesRecord(
  value: unknown,
): value is CommittedMessagesRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "v" in value &&
    value.v === 1 &&
    "type" in value &&
    value.type === "thread.messages.committed" &&
    "threadId" in value &&
    typeof value.threadId === "string" &&
    "messages" in value &&
    Array.isArray(value.messages)
  );
}

export class JsonlAgentStore implements AgentStore, ContextCompactionStore {
  readonly #directory: string;
  readonly #memory = new InMemoryAgentStore();
  readonly #acquireLock: JsonlAgentStoreOptions["acquireTranscriptLock"];
  readonly #cleanupThreshold: number;
  readonly #readTranscript = createThreadTranscriptReader();
  readonly #runLeases = new Map<string, { runId: string; release(): Promise<void> }>();
  #commitUncertain = false;
  #writeFailed = false;

  constructor(options: JsonlAgentStoreOptions) {
    this.#directory = resolve(options.directory);
    this.#acquireLock = options.acquireTranscriptLock;
    this.#cleanupThreshold = options.snapshotCleanupThresholdBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#cleanupThreshold) || this.#cleanupThreshold < 1) throw new Error("Invalid transcript cleanup threshold");
  }

  async create(record: RunRecord): Promise<void> {
    this.#assertWritable();
    if (!this.#acquireLock) return this.#memory.create(record);
    const path = this.#pathFor(record.threadId);
    if (this.#runLeases.has(path)) throw new AgentError({ code: "RUN_CONFLICT", message: "Thread already has an active transcript owner", retryable: false, phase: "runtime" });
    await this.#ensureDirectory();
    // Wait outside the process queue: its current owner must still be able
    // to save and finish the Run that will release this cross-process lease.
    const lease = await this.#acquireLock(path);
    try { await serializeTranscriptOperation(path, async () => {
      this.#assertWritable();
      if (this.#runLeases.has(path)) throw new AgentError({ code: "RUN_CONFLICT", message: "Thread already has an active transcript owner", retryable: false, phase: "runtime" });
      // Cleanup runs before Core creates a Run, never between its tool calls.
      await this.#cleanupSnapshots(record.threadId, path);
      await this.#memory.create(record);
      this.#runLeases.set(path, { runId: record.id, release: () => lease.release() });
    }); } catch (error) { await lease.release(); throw error; }
  }

  getRun(runId: string): Promise<RunRecord | undefined> {
    return this.#memory.getRun(runId);
  }

  async transition(
    runId: string,
    expectedVersion: number,
    status: RunStatus,
    result?: RunResult,
  ): Promise<RunRecord> {
    const updated = await this.#memory.transition(runId, expectedVersion, status, result);
    if (["completed", "failed", "cancelled", "timed_out"].includes(status)) {
      const path = this.#pathFor(updated.threadId);
      const lease = this.#runLeases.get(path);
      if (lease?.runId === runId) {
        // Await an already admitted append before giving another process ownership.
        await serializeTranscriptOperation(path, async () => {
          await lease.release(); this.#runLeases.delete(path);
        });
      }
    }
    return updated;
  }

  async save(threadId: string, messages: UIMessage[]): Promise<void> {
    // Capture the caller's data before awaiting the shared writer lock.
    const next = structuredClone(messages);
    await this.#appendRecord(threadId, previous => encodeTranscriptUpdate(threadId, previous, next).join(""));
  }

  async appendContextCompaction(
    record: ThreadContextCompactionRecord,
  ): Promise<void> {
    await this.#appendRecord(record.threadId, () => `${JSON.stringify(record)}\n`);
  }

  async getContextCompactions(
    threadId: string,
  ): Promise<ThreadContextCompactionRecord[]> {
    const path = this.#pathFor(threadId);
    const records: ThreadContextCompactionRecord[] = [];

    await serializeTranscriptOperation(path, async () => {
      const transcript = await this.#readMessages(path, threadId, true);
      for (const line of transcript.companions) {
        const value = parseLine(line, threadId);

        // Invalid compaction records are ignored. The compaction schema is
        // owned by the caller and is intentionally opaque to core.
        if (
          typeof value === "object" &&
          value !== null &&
          "type" in value &&
          value.type === "thread.context.compacted"
        ) {
          if (isContextCompactionRecord(value)) {
            if (value.threadId === threadId && value.v === 2) records.push(value);
          }
          continue;
        }

        if (
          typeof value === "object" &&
          value !== null &&
          "v" in value &&
          value.v !== 1
        ) {
          continue;
        }

        if (!isCommittedMessagesRecord(value) || value.threadId !== threadId) {
          throw storageCorrupt(threadId);
        }
      }
    });

    return structuredClone(records);
  }

  async getMessages(threadId: string): Promise<UIMessage[]> {
    const path = this.#pathFor(threadId);
    return serializeTranscriptOperation(path, async () => structuredClone((await this.#readMessages(path, threadId)).messages));
  }

  /** Physical maintenance only. A host lease is mandatory; active Runs reject
   * local maintenance and block another process at the same append lease.
   */
  async compactThread(threadId: string): Promise<void> {
    if (!this.#acquireLock) throw new AgentError({ code: "STORAGE_WRITE_FAILED", message: "Transcript cleanup requires the host cross-process append lease", retryable: false, phase: "storage" });
    const path = this.#pathFor(threadId);
    this.#assertWritable();
    if (this.#runLeases.has(path)) throw new AgentError({ code: "RUN_CONFLICT", message: "Cannot compact a Thread during an active Run", retryable: false, phase: "storage" });
    await this.#ensureDirectory();
    const lease = await this.#acquireLock(path);
    try { await serializeTranscriptOperation(path, async () => {
      this.#assertWritable(); await this.#cleanupSnapshots(threadId, path);
    }); } finally { await lease.release(); }
  }

  append(event: AgentEvent): Promise<void> {
    return this.#memory.append(event);
  }

  list(runId: string, afterSequence?: number): Promise<AgentEvent[]> {
    return this.#memory.list(runId, afterSequence);
  }

  #pathFor(threadId: string): string {
    const fileName = createHash("sha256").update(threadId).digest("hex");
    return join(this.#directory, `${fileName}.jsonl`);
  }

  async #readMessages(path: string, threadId: string, companions = false) {
    try { return await this.#readTranscript(path, threadId, { companions }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { messages: [] as UIMessage[], companions: [] as string[], incompleteTail: false };
    }
  }

  // Only redundant committed snapshots disappear. Full message IDs/content,
  // all opaque summaries and future-version records survive unchanged. This is
  // physical cleanup, not model compaction, memory pruning or tool recovery.
  async #cleanupSnapshots(threadId: string, path: string): Promise<void> {
    let size: number;
    try { size = (await stat(path)).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (size < this.#cleanupThreshold) return;
    // Maintenance verifies the complete file, never relying on a cached prefix.
    const transcript = await readThreadTranscript(path, threadId, { companions: true });
    // Delta chains can exceed the single-transaction limit. Optional physical
    // cleanup must not make such a readable Thread impossible to continue.
    if (Buffer.byteLength(JSON.stringify(transcript.messages)) > MAX_TRANSCRIPT_RECORD_BYTES) return;
    const checkpoint = [...encodeTranscriptUpdate(threadId, [], transcript.messages, true), ...transcript.companions.map(line => line + "\n")];
    if (checkpoint.reduce((bytes, line) => bytes + Buffer.byteLength(line), 0) > size * 0.75) return;
    const temporary = `${path}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      const target = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        for (const line of checkpoint) await target.writeFile(line, "utf8");
        await target.sync();
      } finally { await target.close(); }
      await rename(temporary, path); renamed = true;
      await this.#syncDirectory();
    } catch (error) {
      this.#writeFailed = true;
      if (renamed) {
        this.#commitUncertain = true;
        throw new AgentError({ code: "STORAGE_COMMIT_UNCERTAIN", message: "Transcript cleanup acknowledgement is uncertain; reread after restart before continuing", retryable: false, phase: "storage" }, { cause: error });
      }
      throw new AgentError({ code: "STORAGE_WRITE_FAILED", message: "Transcript cleanup failed before replacement; restart and reread before continuing", retryable: false, phase: "storage" }, { cause: error });
    } finally { if (!renamed) await rm(temporary, { force: true }).catch(() => undefined); }
  }

  async #syncDirectory(): Promise<void> {
    // Windows does not expose directory fsync through Node. File data is still
    // synced there; do not claim POSIX rename durability on that platform.
    if (process.platform === "win32") return;
    const directory = await open(this.#directory, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async #ensureDirectory(): Promise<void> {
    try { await mkdir(this.#directory, { recursive: true }); }
    catch (error) {
      this.#writeFailed = true;
      throw new AgentError({ code: "STORAGE_WRITE_FAILED", message: "Transcript directory unavailable; restart and reread before further dispatch", retryable: false, phase: "storage" }, { cause: error });
    }
  }

  #appendRecord(threadId: string, serialize: (previous: UIMessage[]) => string): Promise<void> {
    const path = this.#pathFor(threadId);
    const operation = async (lock?: { release(): Promise<void> }) => {
        this.#assertWritable();
        await this.#ensureDirectory();
        if (lock) await this.#cleanupSnapshots(threadId, path);
        const serialized = serialize((await this.#readMessages(path, threadId)).messages);
        let writeStarted = false;
        try {
          const file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
          try {
            // Check just the tail on the normal append path, not the whole history.
            // Only this serialized writer repairs bytes after the last newline.
            const { size } = await file.stat();
            let end = size;
            while (end > 0) {
              const start = Math.max(0, end - 8_192);
              const buffer = Buffer.alloc(end - start);
              const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
              const newline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
              if (newline >= 0) {
                const committedSize = start + newline + 1;
                if (committedSize !== size) await file.truncate(committedSize);
                break;
              }
              end = start;
              if (end === 0) await file.truncate(0);
            }
            writeStarted = true;
            await file.writeFile(serialized, "utf8");
            await file.sync();
            await this.#syncDirectory();
          } finally { await file.close(); }
        } catch (error) {
          this.#writeFailed = true;
          if (writeStarted) this.#commitUncertain = true;
          throw new AgentError({ code: writeStarted ? "STORAGE_COMMIT_UNCERTAIN" : "STORAGE_WRITE_FAILED",
            message: writeStarted ? "Transcript save acknowledgement is uncertain; reread before retrying" : "Transcript save failed before append",
            retryable: false, phase: "storage" }, { cause: error });
        }
    };
    // Register local admissions synchronously so a subsequent read sees every
    // earlier local append. Never wait for another Run's lease inside the queue.
    if (!this.#acquireLock || this.#runLeases.has(path)) return serializeTranscriptOperation(path, () => operation());
    return (async () => {
      this.#assertWritable();
      await this.#ensureDirectory();
      const lock = await this.#acquireLock!(path);
      try { await serializeTranscriptOperation(path, () => operation(lock)); }
      finally { await lock.release(); }
    })();
  }

  #assertWritable(): void {
    if (this.#commitUncertain) throw new AgentError({ code: "STORAGE_COMMIT_UNCERTAIN", message: "Transcript save acknowledgement is uncertain; restart and reread before further writes", retryable: false, phase: "storage" });
    if (this.#writeFailed) throw new AgentError({ code: "STORAGE_WRITE_FAILED", message: "Transcript storage failed; restart and reread before further dispatch", retryable: false, phase: "storage" });
  }
}
