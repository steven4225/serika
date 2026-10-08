import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
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

export interface JsonlAgentStoreOptions {
  directory: string;
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
function committedLines(content: string): string[] {
  return content.slice(0, content.lastIndexOf("\n") + 1).split("\n");
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

  constructor(options: JsonlAgentStoreOptions) {
    this.#directory = resolve(options.directory);
  }

  create(record: RunRecord): Promise<void> {
    return this.#memory.create(record);
  }

  getRun(runId: string): Promise<RunRecord | undefined> {
    return this.#memory.getRun(runId);
  }

  transition(
    runId: string,
    expectedVersion: number,
    status: RunStatus,
    result?: RunResult,
  ): Promise<RunRecord> {
    return this.#memory.transition(runId, expectedVersion, status, result);
  }

  async save(threadId: string, messages: UIMessage[]): Promise<void> {
    const record: CommittedMessagesRecord = {
      v: 1,
      type: "thread.messages.committed",
      threadId,
      messages,
    };
    await this.#appendRecord(threadId, `${JSON.stringify(record)}\n`);
  }

  async appendContextCompaction(
    record: ThreadContextCompactionRecord,
  ): Promise<void> {
    await this.#appendRecord(record.threadId, `${JSON.stringify(record)}\n`);
  }

  async getContextCompactions(
    threadId: string,
  ): Promise<ThreadContextCompactionRecord[]> {
    const path = this.#pathFor(threadId);
    const content = await this.#readTranscript(path);
    const lines = committedLines(content);
    const records: ThreadContextCompactionRecord[] = [];

    for (const line of lines) {
      if (line.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw storageCorrupt(threadId);
      }

      // Invalid compaction records are ignored.  The compaction schema is
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

    return structuredClone(records);
  }

  async getMessages(threadId: string): Promise<UIMessage[]> {
    const path = this.#pathFor(threadId);
    const content = await this.#readTranscript(path);
    const lines = committedLines(content);
    let latest: UIMessage[] = [];

    for (const line of lines) {
      if (line.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw storageCorrupt(threadId);
      }

      if (
        typeof value === "object" &&
        value !== null &&
        "v" in value &&
        value.v !== 1
      ) {
        continue;
      }
      // Context summaries are an opaque companion record.  They must not
      // change the v1 committed-transcript semantics.
      if (
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        value.type === "thread.context.compacted"
      ) {
        continue;
      }
      if (!isCommittedMessagesRecord(value) || value.threadId !== threadId) {
        throw storageCorrupt(threadId);
      }
      latest = value.messages;
    }

    return structuredClone(latest);
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

  #readTranscript(path: string): Promise<string> {
    return serializeTranscriptOperation(path, async () => {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      }
    });
  }

  #appendRecord(threadId: string, serialized: string): Promise<void> {
    const path = this.#pathFor(threadId);
    return serializeTranscriptOperation(path, async () => {
      await mkdir(this.#directory, { recursive: true });
      const file = await open(path, "a+");
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
        await file.writeFile(serialized, "utf8");
      } finally {
        await file.close();
      }
    });
  }
}
