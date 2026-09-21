import type { UIMessage } from "ai";
import { AgentError } from "./errors.js";
import { terminalStatuses, type AgentEvent } from "./events.js";
import type { RunResult, RunStatus } from "./types.js";

export interface RunRecord {
  id: string;
  threadId: string;
  agentId: string;
  agentVersion: string;
  status: RunStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  result?: RunResult;
}

export interface RunStore {
  create(record: RunRecord): Promise<void>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  transition(
    runId: string,
    expectedVersion: number,
    status: RunStatus,
    result?: RunResult,
  ): Promise<RunRecord>;
}

export interface MessageStore {
  save(threadId: string, messages: UIMessage[]): Promise<void>;
  getMessages(threadId: string): Promise<UIMessage[]>;
}

/**
 * JSON values that may be carried by an opaque thread record.
 *
 * The core store deliberately does not know the schema of a context
 * compaction summary.  Consumers own the payload and may evolve it without
 * coupling the runtime store to a CLI-specific type.
 */
export type ThreadRecordJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly ThreadRecordJsonValue[]
  | { readonly [key: string]: ThreadRecordJsonValue };

export interface ThreadContextCompactionRecord {
  /** Envelope version; the core store does not interpret the payload. */
  readonly v: number;
  readonly type: "thread.context.compacted";
  readonly threadId: string;
  readonly [key: string]: ThreadRecordJsonValue;
}

/** Persistence for opaque context-compaction records. */
export interface ContextCompactionStore {
  appendContextCompaction(
    record: ThreadContextCompactionRecord,
  ): Promise<void>;
  getContextCompactions(
    threadId: string,
  ): Promise<ThreadContextCompactionRecord[]>;
}

export interface EventStore {
  append(event: AgentEvent): Promise<void>;
  list(runId: string, afterSequence?: number): Promise<AgentEvent[]>;
}

export interface AgentStore extends RunStore, MessageStore, EventStore {}

export class InMemoryAgentStore implements AgentStore {
  readonly #runs = new Map<string, RunRecord>();
  readonly #messages = new Map<string, UIMessage[]>();
  readonly #events = new Map<string, AgentEvent[]>();
  readonly #activeByThread = new Map<string, string>();

  async create(record: RunRecord): Promise<void> {
    if (this.#runs.has(record.id)) throw new Error(`Run already exists: ${record.id}`);
    const activeRunId = this.#activeByThread.get(record.threadId);
    if (activeRunId) {
      throw new AgentError({
        code: "RUN_CONFLICT",
        message: `Thread already has an active run: ${activeRunId}`,
        retryable: true,
        phase: "runtime",
      });
    }
    this.#runs.set(record.id, structuredClone(record));
    this.#activeByThread.set(record.threadId, record.id);
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    const record = this.#runs.get(runId);
    return record ? structuredClone(record) : undefined;
  }

  async transition(
    runId: string,
    expectedVersion: number,
    status: RunStatus,
    result?: RunResult,
  ): Promise<RunRecord> {
    const current = this.#runs.get(runId);
    if (!current) throw new Error(`Run not found: ${runId}`);
    if (current.version !== expectedVersion) {
      throw new Error(`Run version conflict: expected ${expectedVersion}, got ${current.version}`);
    }
    if (terminalStatuses.has(current.status)) {
      throw new Error(`Terminal run cannot transition: ${runId}`);
    }

    const updated: RunRecord = {
      ...current,
      status,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
      ...(result ? { result } : {}),
    };
    this.#runs.set(runId, updated);
    if (terminalStatuses.has(status)) this.#activeByThread.delete(current.threadId);
    return structuredClone(updated);
  }

  async save(threadId: string, messages: UIMessage[]): Promise<void> {
    this.#messages.set(threadId, structuredClone(messages));
  }

  async getMessages(threadId: string): Promise<UIMessage[]> {
    return structuredClone(this.#messages.get(threadId) ?? []);
  }

  async append(event: AgentEvent): Promise<void> {
    const events = this.#events.get(event.runId) ?? [];
    const previous = events.at(-1);
    if (previous && event.sequence !== previous.sequence + 1) {
      throw new Error(`Non-contiguous event sequence for run ${event.runId}`);
    }
    if (!previous && event.sequence !== 1) {
      throw new Error(`First event sequence must be 1 for run ${event.runId}`);
    }
    events.push(structuredClone(event));
    this.#events.set(event.runId, events);
  }

  async list(runId: string, afterSequence = 0): Promise<AgentEvent[]> {
    return structuredClone(
      (this.#events.get(runId) ?? []).filter(
        (event) => event.sequence > afterSequence,
      ),
    );
  }
}
