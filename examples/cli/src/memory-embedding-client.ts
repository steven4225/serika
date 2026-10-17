import type { TokenUsage } from "@serika/core";
import { MemoryEmbeddingError, type MemoryEmbeddingPort } from "./memory-semantic-index.js";

export interface LocalEmbeddingConfig { modelId: string; baseURL?: string }
export const DEFAULT_LOCAL_EMBEDDING_CONFIG = { modelId: "qwen3-embedding:0.6b", baseURL: "http://127.0.0.1:11434/v1" } as const;
export interface EmbeddingConfig { provider?: "local" | "dashscope"; modelId?: string; baseURL?: string }
export interface ResolvedEmbeddingConfig { provider: "local" | "dashscope"; modelId: string; baseURL: string }
export const DEFAULT_CLOUD_EMBEDDING_CONFIG = { modelId: "qwen3.7-text-embedding-flash", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" } as const;
interface ResponseIndexMapping {
  batchOffset: number;
  expectedCount: number;
  items: Array<{ field: "index" | "text_index" | "missing"; format: "number" | "string" | "null" | "missing" | "other"; value: number | null }>;
}
export interface LocalMemoryEmbedder extends MemoryEmbeddingPort {
  readonly requestMode: "batched" | "single-input";
  /** Aggregate for a completely successful embed only; failed/partial batches remain unknown. */
  readonly lastUsage: TokenUsage;
  /** Safe metadata from the latest batch, never vectors, raw strings or provider error text. */
  readonly lastResponseMapping: ResponseIndexMapping | undefined;
}
const MAX_BATCH = 10;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Normalize only an exact integer representation; never infer order from array position. */
function transportIndex(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.length <= 16 && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : undefined;
  return typeof number === "number" && Number.isSafeInteger(number) ? number : undefined;
}

/** Local-only service selection is trusted config, never inferred from memory or chat keys. */
export function normalizeLocalEmbeddingConfig(config: LocalEmbeddingConfig): Required<LocalEmbeddingConfig> {
  let url: URL;
  try { url = new URL(config.baseURL ?? DEFAULT_LOCAL_EMBEDDING_CONFIG.baseURL); }
  catch { throw Error("Embedding service must be an explicit loopback URL without credentials"); }
  if (!["127.0.0.1", "[::1]"].includes(url.hostname) || !["http:", "https:"].includes(url.protocol)
    || url.username || url.password || url.search || url.hash) throw Error("Embedding service must be an explicit loopback URL without credentials");
  if (typeof config.modelId !== "string" || !config.modelId.trim() || config.modelId.length > 256) throw Error("Embedding modelId is required");
  return { baseURL: url.toString().replace(/\/+$/, ""), modelId: config.modelId.trim() };
}

/** Missing provider preserves the old local boundary; cloud export must be explicitly selected. */
export function normalizeEmbeddingConfig(config: EmbeddingConfig): ResolvedEmbeddingConfig {
  if (config.provider === undefined || config.provider === "local") return {
    provider: "local", ...normalizeLocalEmbeddingConfig({ modelId: config.modelId ?? DEFAULT_LOCAL_EMBEDDING_CONFIG.modelId,
      ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }) }),
  };
  if (config.provider !== "dashscope") throw Error("Unsupported embedding provider");
  let url: URL;
  try { url = new URL(config.baseURL ?? DEFAULT_CLOUD_EMBEDDING_CONFIG.baseURL); }
  catch { throw Error("DashScope embedding requires an official HTTPS compatible-mode endpoint"); }
  const official = ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"].includes(url.hostname)
    || /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:cn-beijing|ap-southeast-1|cn-hongkong)\.maas\.aliyuncs\.com$/.test(url.hostname);
  if (!official || url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash
    || url.pathname.replace(/\/+$/, "") !== "/compatible-mode/v1") {
    throw Error("DashScope embedding requires an official HTTPS compatible-mode endpoint without credentials");
  }
  const modelId = config.modelId ?? DEFAULT_CLOUD_EMBEDDING_CONFIG.modelId;
  if (typeof modelId !== "string" || !modelId.trim() || modelId.length > 256) throw Error("Embedding modelId is required");
  return { provider: "dashscope", modelId: modelId.trim(), baseURL: url.toString().replace(/\/+$/, "") };
}

/** Credentials stay in host memory, never config, cache identity or reports. Missing keys degrade at preparation, not app startup. */
export function createMemoryEmbedder(config: EmbeddingConfig, env: Readonly<Record<string, string | undefined>> = process.env,
  request: typeof fetch = fetch): LocalMemoryEmbedder {
  const normalized = normalizeEmbeddingConfig(config);
  const authorization = (): Record<string, string> => {
    if (normalized.provider === "local") return {};
    const key = env.DASHSCOPE_API_KEY;
    if (!key || key.length > 4096 || !/^[\x21-\x7e]+$/.test(key)) throw new MemoryEmbeddingError({ code: "credentials_missing" }, "云端语义检索需要在宿主环境配置有效的 DASHSCOPE_API_KEY；本轮退回关键词检索。");
    return { Authorization: `Bearer ${key}` };
  };
  // The observed flash gateway returns index=0 for every batched item. Separate
  // requests bind each vector to its input without trusting response array order.
  return normalized.provider === "dashscope" && normalized.modelId === "qwen3.7-text-embedding-flash"
    ? createSingleInputMemoryEmbedder(normalized, request, authorization)
    : createCompatibleMemoryEmbedder(normalized, request, authorization);
}

function validateTexts(texts: readonly string[]): void {
  if (texts.length > 513 || texts.some(text => typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > 4096)) {
    throw new MemoryEmbeddingError({ code: "input_invalid" }, "Embedding input exceeds its budget");
  }
}

/** At most ten independent read requests, no retry or batch-then-single fallback. */
function createSingleInputMemoryEmbedder(normalized: Required<LocalEmbeddingConfig>, request: typeof fetch,
  authorization: () => Record<string, string>): LocalMemoryEmbedder {
  let lastUsage: TokenUsage = {};
  let lastResponseMapping: ResponseIndexMapping | undefined;
  return {
    modelId: JSON.stringify([normalized.baseURL, normalized.modelId]),
    requestMode: "single-input",
    get lastUsage() { return { ...lastUsage }; },
    get lastResponseMapping() { return lastResponseMapping ? { ...lastResponseMapping, items: lastResponseMapping.items.map(item => ({ ...item })) } : undefined; },
    async embed(texts, signal) {
      lastUsage = {}; lastResponseMapping = undefined;
      signal.throwIfAborted(); validateTexts(texts);
      const result: number[][] = [], usages: TokenUsage[] = [];
      let dimension: number | undefined;
      for (let offset = 0; offset < texts.length; offset += MAX_BATCH) {
        signal.throwIfAborted(); authorization();
        lastResponseMapping = undefined;
        const stop = new AbortController(), groupSignal = AbortSignal.any([signal, stop.signal]);
        let failureMapping: ResponseIndexMapping | undefined;
        const calls = texts.slice(offset, offset + MAX_BATCH).map(async (text, position) => {
          const client = createCompatibleMemoryEmbedder(normalized, request, authorization, true);
          try {
            const vectors = await client.embed([text], groupSignal);
            return { vector: [...vectors[0]!], usage: client.lastUsage,
              mapping: client.lastResponseMapping ? { ...client.lastResponseMapping, batchOffset: offset + position } : undefined };
          } catch (error) {
            if (!stop.signal.aborted) {
              failureMapping = client.lastResponseMapping ? { ...client.lastResponseMapping, batchOffset: offset + position } : undefined;
              stop.abort(error);
            }
            throw error;
          }
        });
        let completed;
        try { completed = await Promise.all(calls); }
        catch (error) { lastResponseMapping = failureMapping; throw error; }
        signal.throwIfAborted();
        lastResponseMapping = completed.at(-1)?.mapping;
        for (const item of completed) {
          if (dimension !== undefined && item.vector.length !== dimension) {
            throw new MemoryEmbeddingError({ code: "response_vector_invalid", dimension: item.vector.length }, "Inconsistent embedding dimensions");
          }
          dimension = item.vector.length;
          result.push(item.vector); usages.push(item.usage);
        }
      }
      for (const field of ["inputTokens", "totalTokens"] as const) {
        if (usages.length && usages.every(usage => usage[field] !== undefined)) {
          const total = usages.reduce((sum, usage) => sum + usage[field]!, 0);
          if (Number.isSafeInteger(total)) lastUsage[field] = total;
        }
      }
      return result;
    },
  };
}

async function boundedJSON(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    if (!response.ok) throw Error(`Embedding returned HTTP ${response.status}`);
    throw Error("Embedding response exceeds its budget");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => { void reader.cancel().catch(() => {}); reject(signal.reason); };
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw Error("Embedding response exceeds its budget");
      chunks.push(next.value);
    }
    try { return JSON.parse(Buffer.concat(chunks, size).toString("utf8")); }
    catch { throw Error("Invalid embedding JSON response"); }
  } catch {
    void reader.cancel().catch(() => {});
    signal.throwIfAborted();
    throw Error("Invalid embedding response or response budget exceeded");
  }
  finally { if (rejectAbort) signal.removeEventListener("abort", rejectAbort); reader.releaseLock(); }
}

/** Mirrors Shiori's compatible /embeddings batching and index ordering; no provider retries or text clipping. */
export function createLocalMemoryEmbedder(config: LocalEmbeddingConfig, request: typeof fetch = fetch): LocalMemoryEmbedder {
  return createCompatibleMemoryEmbedder(normalizeLocalEmbeddingConfig(config), request, () => ({}));
}

function createCompatibleMemoryEmbedder(normalized: Required<LocalEmbeddingConfig>, request: typeof fetch,
  authorization: () => Record<string, string>, singleText = false): LocalMemoryEmbedder {
  let lastUsage: TokenUsage = {};
  let lastResponseMapping: ResponseIndexMapping | undefined;
  return {
    modelId: JSON.stringify([normalized.baseURL, normalized.modelId]),
    requestMode: singleText ? "single-input" : "batched",
    get lastUsage() { return { ...lastUsage }; },
    get lastResponseMapping() { return lastResponseMapping ? { ...lastResponseMapping, items: lastResponseMapping.items.map(item => ({ ...item })) } : undefined; },
    async embed(texts, signal) {
      lastUsage = {};
      lastResponseMapping = undefined;
      signal.throwIfAborted();
      validateTexts(texts);
      const result: number[][] = [];
      let inputTokens = 0, totalTokens = 0;
      let allInputKnown = true, allTotalKnown = true;
      let dimension: number | undefined;
      for (let offset = 0; offset < texts.length; offset += MAX_BATCH) {
        signal.throwIfAborted();
        const input = texts.slice(offset, offset + MAX_BATCH);
        const headers = { "Content-Type": "application/json", ...authorization() };
        let response: Response;
        try {
          response = await request(`${normalized.baseURL}/embeddings`, {
            method: "POST", redirect: "error", signal, headers,
            body: JSON.stringify({ model: normalized.modelId, input: singleText ? input[0] : input, encoding_format: "float" }),
          });
        } catch {
          signal.throwIfAborted();
          throw new MemoryEmbeddingError({ code: "transport_failed" }, "Embedding transport failed; no retry was performed");
        }
        if (response.redirected) {
          void response.body?.cancel().catch(() => {});
          throw new MemoryEmbeddingError({ code: "redirect_forbidden" }, "Embedding redirects are forbidden");
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new MemoryEmbeddingError({ code: "http_error", httpStatus: response.status }, `Embedding returned HTTP ${response.status}`);
        }
        let raw: unknown;
        try { raw = await boundedJSON(response, signal); }
        catch {
          signal.throwIfAborted();
          throw new MemoryEmbeddingError({ code: "response_body_invalid" }, "Invalid embedding response body or response budget exceeded");
        }
        if (raw && typeof raw === "object" && "error" in raw) throw new MemoryEmbeddingError({ code: "provider_error_response" }, "Embedding provider returned an error object");
        if (!raw || typeof raw !== "object" || !Array.isArray((raw as { data?: unknown }).data)) throw new MemoryEmbeddingError({ code: "response_shape_invalid" }, "Invalid embedding response shape");
        const data = (raw as { data: Array<{ index?: unknown; text_index?: unknown; embedding: unknown }> }).data;
        lastResponseMapping = { batchOffset: offset, expectedCount: input.length, items: data.slice(0, MAX_BATCH).map(item => {
          const value = item?.index === undefined ? item?.text_index : item.index;
          return { field: item?.index !== undefined ? "index" : item?.text_index !== undefined ? "text_index" : "missing",
            format: value === undefined ? "missing" : value === null ? "null" : typeof value === "number" ? "number" : typeof value === "string" ? "string" : "other",
            value: transportIndex(value) ?? null };
        }) };
        if (data.length !== input.length) throw new MemoryEmbeddingError({ code: "response_count_mismatch", expectedCount: input.length, returnedCount: data.length }, "Embedding response count mismatch");
        const ordered: number[][] = new Array(input.length);
        for (const item of data) {
          const vector = item?.embedding;
          const rawIndex = item?.index === undefined ? item?.text_index : item.index;
          const index = transportIndex(rawIndex);
          const ambiguous = item?.index !== undefined && item?.text_index !== undefined && transportIndex(item.text_index) !== index;
          if (index === undefined || index < 0 || index >= input.length || ordered[index] || ambiguous) {
            throw new MemoryEmbeddingError({ code: "response_index_invalid",
              indexIssue: ambiguous ? "ambiguous" : rawIndex === undefined ? "missing" : index === undefined ? "non_integer"
                : index < 0 || index >= input.length ? "out_of_range" : "duplicate" }, "Invalid embedding index");
          }
          if (!Array.isArray(vector) || !vector.length || vector.length > 4096
            || !vector.every(value => typeof value === "number" && Number.isFinite(value))
            || !(vector.reduce((sum, value: number) => sum + value * value, 0) > 0)
            || !Number.isFinite(vector.reduce((sum, value: number) => sum + value * value, 0))
            || dimension !== undefined && dimension !== vector.length) throw new MemoryEmbeddingError({ code: "response_vector_invalid",
              vectorFormat: Array.isArray(vector) ? "array" : typeof vector === "string" ? "string" : vector === undefined ? "missing" : "other",
              ...(Array.isArray(vector) ? { dimension: vector.length } : {}) }, "Invalid embedding vector or index");
          dimension = vector.length;
          ordered[index] = vector as number[];
        }
        result.push(...ordered);
        const usage = (raw as { usage?: { prompt_tokens?: unknown; total_tokens?: unknown } }).usage;
        const known = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
        if (known(usage?.prompt_tokens)) inputTokens += usage.prompt_tokens; else allInputKnown = false;
        if (known(usage?.total_tokens)) totalTokens += usage.total_tokens; else allTotalKnown = false;
        signal.throwIfAborted();
      }
      if (texts.length && allInputKnown && Number.isSafeInteger(inputTokens)) lastUsage.inputTokens = inputTokens;
      if (texts.length && allTotalKnown && Number.isSafeInteger(totalTokens)) lastUsage.totalTokens = totalTokens;
      return result;
    },
  };
}
