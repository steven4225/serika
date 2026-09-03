import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, truncate } from "node:fs/promises";
import { join } from "node:path";
import type { UIMessage } from "ai";
import { AgentError } from "./errors.js";
import type { AgentEvent } from "./events.js";
import {
  InMemoryAgentStore,
  type AgentStore,
  type RunRecord,
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

export class JsonlAgentStore implements AgentStore {
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
}
