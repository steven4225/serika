import { constants } from "node:fs";
import { mkdir, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { hashCanonicalJson, type CanonicalJsonValue } from "@serika/core";
import { estimateSerializedTokens } from "./context-budget.js";
import { acquireFlock } from "./flock.js";
import type { ModelCallRecord } from "./model-usage.js";

export interface ModelInputSegment {
  part: string;
  index: number;
  hash: string;
  bytes: number;
  estimatedTokens: number;
}

export interface FirstOutputTiming { kind: "text" | "tool_call"; ms: number }

/** Fingerprint the provider input, before any transport-specific encoding. */
export function modelInputSegments(input: { tools?: unknown; prompt: readonly { role: string }[] }): ModelInputSegment[] {
  return [{ part: "tools", value: input.tools ?? [] }, ...input.prompt.map(value => ({ part: value.role, value }))]
    .map(({ part, value }, index) => {
      const serialized = JSON.stringify(value);
      const json = JSON.parse(serialized) as CanonicalJsonValue;
      return { part, index, hash: hashCanonicalJson(json), bytes: Buffer.byteLength(serialized), estimatedTokens: estimateSerializedTokens(json) };
    });
}

const day = (at: Date) => new Date(at.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
const filePattern = /^model-calls-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** Content-free daily accounting, independent of the bounded execution journal. */
export class ModelCallLog {
  #writeFailures = 0;
  constructor(readonly directory: string, readonly now: () => Date = () => new Date()) {}

  get writeFailures(): number { return this.#writeFailures; }

  async start(call: ModelCallRecord, segments: ModelInputSegment[]): Promise<void> {
    const { id, threadId, runId, purpose, provider, modelId, startedAt } = call;
    await this.#append({ version: 1, event: "started", id, threadId, runId, purpose, provider, modelId, startedAt,
      estimator: "char-half/v1", segments });
  }

  async finish(input: { id: string; status: ModelCallRecord["status"]; usage: ModelCallRecord["usage"]; durationMs: number; firstOutput?: FirstOutputTiming | null }): Promise<void> {
    await this.#append({ version: 1, event: "finished", ...input, finishedAt: this.now().toISOString() });
  }

  async round(input: { threadId: string; messageId: string; runId?: string; receivedAt: string;
    firstVisibleTextMs: number | null; outcome: "text" | "tool_only" | "no_output" }): Promise<void> {
    await this.#append({ version: 1, event: "round", ...input, finishedAt: this.now().toISOString() });
  }

  async #append(event: object): Promise<void> {
    try {
      const today = this.now();
      await mkdir(this.directory, { recursive: true });
      const lock = await acquireFlock(join(this.directory, ".model-calls.lock"));
      try {
        const cutoff = day(new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000));
        for (const name of await readdir(this.directory)) {
          const match = filePattern.exec(name);
          if (match && match[1]! < cutoff) await unlink(join(this.directory, name));
        }
        const handle = await open(join(this.directory, `model-calls-${day(today)}.jsonl`),
          constants.O_APPEND | constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
        try {
          const { size } = await handle.stat();
          const tail = Buffer.alloc(1);
          if (size > 0) {
            await handle.read(tail, 0, 1, size - 1);
            // Preserve a crash-torn record while keeping the next event separately readable.
            if (tail[0] !== 10) await handle.writeFile("\n");
          }
          await handle.writeFile(`${JSON.stringify(event)}\n`); await handle.sync();
        }
        finally { await handle.close(); }
        const directory = await open(this.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      } finally { await lock.release(); }
    } catch { this.#writeFailures++; }
  }
}
