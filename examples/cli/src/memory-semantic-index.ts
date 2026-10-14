import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import type { MemoryEntry } from "./memory-store.js";
import { boundedMemoryQuery, memorySemanticTextHash, selectEligibleMemoryEntries } from "./memory-retrieval.js";
export { memorySemanticTextHash } from "./memory-retrieval.js";

/** Explicitly configured host port. Neither cache nor memory text supplies provider authority. */
export interface MemoryEmbeddingPort {
  readonly modelId: string;
  embed(texts: readonly string[], signal: AbortSignal): Promise<readonly (readonly number[])[]>;
}
/** Only host-owned categories/counts cross diagnostics; never upstream text or credentials. */
export interface MemoryEmbeddingFailure {
  code: "credentials_missing" | "input_invalid" | "transport_failed" | "redirect_forbidden" | "http_error"
    | "response_body_invalid" | "provider_error_response" | "response_shape_invalid" | "response_count_mismatch"
    | "response_index_invalid" | "response_vector_invalid" | "cache_read_failed" | "cache_write_failed"
    | "index_input_invalid" | "index_vector_invalid" | "dimension_changed" | "embedding_failed" | "deadline_exceeded";
  httpStatus?: number;
  expectedCount?: number;
  returnedCount?: number;
  vectorFormat?: "array" | "string" | "missing" | "other";
  dimension?: number;
  indexIssue?: "missing" | "non_integer" | "out_of_range" | "duplicate" | "ambiguous";
}
export class MemoryEmbeddingError extends Error {
  constructor(readonly failure: MemoryEmbeddingFailure, message: string) { super(message); }
}
export interface MemorySemanticHit { id: string; revision: number; textHash: string; score: number }
interface CachedVector { id: string; revision: number; textHash: string; vector: number[] }
interface Cache { version: 1; modelId: string; dimension: number; records: CachedVector[] }
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_DIMENSION = 4096;
const MAX_ENTRIES = 512;
/** Cold indexing advances during normal preparations, never a background model loop. */
export const MEMORY_SEMANTIC_WARMUP_BATCH = 20;
function validVector(value: unknown, dimension?: number): value is number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DIMENSION || (dimension !== undefined && value.length !== dimension)
    || !Array.from(value).every(item => typeof item === "number" && Number.isFinite(item))) return false;
  const normSquared = value.reduce((sum, item: number) => sum + item * item, 0);
  return normSquared > 0 && Number.isFinite(normSquared);
}
function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; aa += a[i]! * a[i]!; bb += b[i]! * b[i]!; }
  return Math.max(-1, Math.min(1, dot / Math.sqrt(aa) / Math.sqrt(bb)));
}
/** Every ancestor is a real directory; symlinks must not redirect read or atomic replacement. */
async function checkDirectory(directory: string): Promise<void> {
  const absolute = resolve(directory);
  let current = parse(absolute).root;
  for (const segment of absolute.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw Error("Unsafe semantic cache directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw Error("Unsafe semantic cache directory");
    }
  }
}
async function checkFile(file: string): Promise<void> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CACHE_BYTES) throw Error("Unsafe semantic cache file");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
async function readCache(file: string, modelId: string): Promise<Cache | undefined> {
  await checkDirectory(dirname(file));
  await checkFile(file);
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_CACHE_BYTES) throw Error("Unsafe semantic cache file");
    const bytes = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > info.size) throw Error("Semantic cache grew during read");
    let cache: Cache;
    try { cache = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) as Cache; } catch { return undefined; }
    if (cache?.version !== 1 || cache.modelId !== modelId || !Number.isInteger(cache.dimension) || cache.dimension < 1 || cache.dimension > MAX_DIMENSION
      || !Array.isArray(cache.records) || cache.records.length > MAX_ENTRIES) return undefined;
    const ids = new Set<string>();
    for (const record of cache.records) {
      if (typeof record?.id !== "string" || !record.id || ids.has(record.id) || !Number.isSafeInteger(record.revision) || record.revision < 1
        || !/^[a-f0-9]{64}$/.test(record.textHash) || !validVector(record.vector, cache.dimension)) return undefined;
      ids.add(record.id);
    }
    return cache;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  finally { await handle?.close(); }
}
async function writeCache(file: string, cache: Cache, signal: AbortSignal): Promise<void> {
  const text = JSON.stringify(cache);
  if (Buffer.byteLength(text) > MAX_CACHE_BYTES) throw Error("Semantic cache capacity exceeded");
  await checkDirectory(dirname(file));
  await checkFile(file);
  const temporary = join(dirname(file), `.memory-semantic-${randomUUID()}.tmp`);
  let handle;
  try {
    signal.throwIfAborted();
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close(); handle = undefined;
    signal.throwIfAborted();
    await checkFile(file);
    await rename(temporary, file);
    const directory = await open(dirname(file), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await handle?.close(); await unlink(temporary).catch(() => {}); }
}

/** Rebuildable vector cache only. Facts, scope and lifecycle always come from MemoryStore. */
export class LocalMemorySemanticIndex {
  readonly #file: string;
  readonly #embedding: MemoryEmbeddingPort;
  readonly #timeoutMs: number;
  #lastState: "ready" | "warming" | "degraded" = "ready";
  #lastFailure: MemoryEmbeddingFailure | undefined;
  get lastState(): "ready" | "warming" | "degraded" { return this.#lastState; }
  get lastFailure(): MemoryEmbeddingFailure | undefined { return this.#lastFailure ? { ...this.#lastFailure } : undefined; }
  constructor(input: { file: string; embedding: MemoryEmbeddingPort; timeoutMs?: number }) {
    this.#file = resolve(input.file);
    this.#embedding = input.embedding;
    this.#timeoutMs = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
      ? Math.max(1, Math.min(10_000, Math.floor(input.timeoutMs))) : 5_000;
  }
  async search(entries: readonly MemoryEntry[], input: { query: string; now: Date; threadId?: string; signal?: AbortSignal }): Promise<MemorySemanticHit[]> {
    input.signal?.throwIfAborted();
    this.#lastFailure = undefined;
    const stage: MemoryEmbeddingFailure = { code: "cache_read_failed" };
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error("Memory embedding deadline exceeded")), this.#timeoutMs);
    const signal = input.signal === undefined ? deadline.signal : AbortSignal.any([input.signal, deadline.signal]);
    let rejectAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(signal.reason);
        signal.addEventListener("abort", rejectAbort, { once: true });
      });
      const result = await Promise.race([this.#search(entries, input, signal, stage), aborted]);
      return result;
    } catch (error) {
      input.signal?.throwIfAborted();
      this.#lastState = "degraded";
      this.#lastFailure = deadline.signal.aborted ? { code: "deadline_exceeded" }
        : error instanceof MemoryEmbeddingError ? { ...error.failure } : { ...stage };
      return [];
    } finally { clearTimeout(timer); if (rejectAbort) signal.removeEventListener("abort", rejectAbort); }
  }
  async #search(entries: readonly MemoryEntry[], input: { query: string; now: Date; threadId?: string }, signal: AbortSignal,
    stage: MemoryEmbeddingFailure): Promise<MemorySemanticHit[]> {
    const query = boundedMemoryQuery(input.query).text.trim();
    const eligible = selectEligibleMemoryEntries(entries, input);
    if (!query || eligible.length === 0) { this.#lastState = "ready"; return []; }
    stage.code = "index_input_invalid";
    if (eligible.length > MAX_ENTRIES || !this.#embedding.modelId.trim()) throw Error("Invalid semantic index input");
    stage.code = "cache_read_failed";
    const cache = await readCache(this.#file, this.#embedding.modelId);
    signal.throwIfAborted();
    stage.code = "index_input_invalid";
    const cached = new Map(cache?.records.map(record => [record.id, record]) ?? []);
    const current = eligible.map(entry => ({ id: entry.id, revision: entry.revision ?? 1, textHash: memorySemanticTextHash(entry.text) }));
    if (new Set(current.map(item => item.id)).size !== current.length || current.some(item => !Number.isSafeInteger(item.revision) || item.revision < 1)) {
      throw Error("Invalid current semantic facts");
    }
    // Evict stale vectors first. Scope and lifecycle visibility come from today's facts.
    for (const [id, old] of cached) {
      const item = current.find(record => record.id === id);
      if (!item || old.revision !== item.revision || old.textHash !== item.textHash) cached.delete(id);
    }
    const missing = current.filter(item => {
      const old = cached.get(item.id);
      return old?.revision !== item.revision || old.textHash !== item.textHash;
    }).slice(0, MEMORY_SEMANTIC_WARMUP_BATCH);
    const textById = new Map(eligible.map(entry => [entry.id, entry.text]));
    stage.code = "embedding_failed";
    const vectors = await this.#embedding.embed([...missing.map(item => textById.get(item.id)!), query], signal);
    signal.throwIfAborted();
    stage.code = "index_vector_invalid";
    const dimension = vectors.at(-1)?.length;
    if (!Array.isArray(vectors) || vectors.length !== missing.length + 1 || !vectors.every(value => validVector(value, dimension))) throw Error("Invalid embedding vectors");
    // Changing dimensions under the same model identifier invalidates the entire cache.
    // No automatic second provider call: next preparation can rebuild it.
    if (cache && cache.dimension !== dimension) {
      stage.code = "cache_write_failed";
      await writeCache(this.#file, { version: 1, modelId: this.#embedding.modelId, dimension: dimension!, records: [] }, signal);
      throw new MemoryEmbeddingError({ code: "dimension_changed" }, "Embedding dimension changed");
    }
    for (let i = 0; i < missing.length; i++) cached.set(missing[i]!.id, { ...missing[i]!, vector: [...vectors[i]!] });
    const records = current.flatMap(item => { const record = cached.get(item.id); return record ? [record] : []; });
    stage.code = "cache_write_failed";
    await writeCache(this.#file, { version: 1, modelId: this.#embedding.modelId, dimension: dimension!, records }, signal);
    signal.throwIfAborted();
    this.#lastState = records.length < current.length ? "warming" : "ready";
    const queryVector = vectors.at(-1)!;
    return records.map(record => ({ id: record.id, revision: record.revision, textHash: record.textHash, score: cosine(record.vector, queryVector) }))
      .filter(hit => Number.isFinite(hit.score) && hit.score >= 0.5).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 12);
  }
}
