import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, truncate } from "node:fs/promises";
import { join } from "node:path";
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
    this.#directory = options.directory;
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
    await mkdir(this.#directory, { recursive: true });
    const record: CommittedMessagesRecord = {
      v: 1,
      type: "thread.messages.committed",
      threadId,
      messages,
    };
    await appendFile(
      this.#pathFor(threadId),
      `${JSON.stringify(record)}\n`,
      "utf8",
    );
  }

  async appendContextCompaction(
    record: ThreadContextCompactionRecord,
  ): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    await appendFile(
      this.#pathFor(record.threadId),
      `${JSON.stringify(record)}\n`,
      "utf8",
    );
  }

  async getContextCompactions(
    threadId: string,
  ): Promise<ThreadContextCompactionRecord[]> {
    const path = this.#pathFor(threadId);
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const hasCompleteLastLine = content.endsWith("\n");
    const lines = content.split("\n");
    if (hasCompleteLastLine) lines.pop();
    const records: ThreadContextCompactionRecord[] = [];

    for (const [index, line] of lines.entries()) {
      if (line.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        if (index === lines.length - 1 && !hasCompleteLastLine) {
          await this.#truncateIncompleteTail(path, content);
          break;
        }
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
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const hasCompleteLastLine = content.endsWith("\n");
    const lines = content.split("\n");
    if (hasCompleteLastLine) lines.pop();
    let latest: UIMessage[] = [];

    for (const [index, line] of lines.entries()) {
      if (line.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        if (index === lines.length - 1 && !hasCompleteLastLine) {
          // M-Local has no multi-process readers; discard only the incomplete
          // tail so a later snapshot append starts on a fresh line.
          const validPrefix = content.slice(0, content.lastIndexOf("\n") + 1);
          await truncate(path, Buffer.byteLength(validPrefix));
          break;
        }
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

  async #truncateIncompleteTail(path: string, content: string): Promise<void> {
    const validPrefix = content.slice(0, content.lastIndexOf("\n") + 1);
    await truncate(path, Buffer.byteLength(validPrefix));
  }
}
