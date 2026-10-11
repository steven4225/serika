import { randomUUID } from "node:crypto";
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";
import type { ExecutionRecordStore } from "./execution-record-store.js";
import type { ModelCallRecord, ModelPrice, ModelPurpose } from "./model-usage.js";

/** Observe the actual SDK provider boundary; retries enter again, local caches do not. No prompts/raw usage retained. */
export function observeModelUsage(model: LanguageModel, options: {
  records: ExecutionRecordStore; threadId: string; enabled: () => boolean;
  scope: () => { runId?: string; purpose: ModelPurpose };
  prices?: readonly ModelPrice[];
}): LanguageModel {
  if (typeof model === "string") return model;
  const begin = async (provider: string, modelId: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (!options.enabled()) return null;
    const call: ModelCallRecord = { id: randomUUID(), threadId: options.threadId, ...options.scope(),
      provider, modelId, startedAt: new Date().toISOString(), finishedAt: null, status: "pending", usage: {} };
    const price = options.prices?.find(item => item.provider === provider && item.modelId === modelId);
    if (price) call.price = structuredClone(price);
    await options.records.startModelCall(call);
    let resolution: Promise<void> | undefined;
    let dispatched = false;
    const finish = async (status: ModelCallRecord["status"], usage: ModelCallRecord["usage"] = {}) => {
      if (resolution) return resolution;
      signal?.removeEventListener("abort", abort);
      resolution = options.records.finishModelCall(call.id, status, usage);
      return resolution;
    };
    const abort = () => { void finish(dispatched ? "cancelled" : "not_dispatched").catch(() => {
      // An unresolved journal remains visibly pending/unknown; the store stops subsequent dispatch. Never replay the provider.
    }); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    return { finish, dispatch: () => { dispatched = true; } };
  };
  const middleware: LanguageModelMiddleware = {
    wrapGenerate: async ({ doGenerate, params, model: provider }) => {
      const call = await begin(provider.provider, provider.modelId, params.abortSignal);
      try {
        params.abortSignal?.throwIfAborted();
        call?.dispatch();
        const result = await doGenerate();
        params.abortSignal?.throwIfAborted();
        await call?.finish("returned", providerUsage(result.usage));
        return result;
      } catch (error) { await call?.finish(params.abortSignal?.aborted ? "cancelled" : "failed"); throw error; }
    },
    wrapStream: async ({ doStream, params, model: provider }) => {
      const call = await begin(provider.provider, provider.modelId, params.abortSignal);
      try {
        params.abortSignal?.throwIfAborted();
        call?.dispatch();
        const result = await doStream();
        params.abortSignal?.throwIfAborted();
        if (!call) return result;
        const reader = result.stream.getReader();
        return { ...result, stream: new ReadableStream({
          async pull(controller) {
            try {
              const next = await reader.read();
              params.abortSignal?.throwIfAborted();
              if (next.done) { await call.finish("unknown"); controller.close(); return; }
              if (next.value.type === "finish") await call.finish("returned", providerUsage(next.value.usage));
              if (next.value.type === "error") await call.finish("failed");
              controller.enqueue(next.value);
            } catch (error) { await call.finish("failed"); controller.error(error); }
          },
          async cancel(reason) { await call.finish("cancelled"); await reader.cancel(reason); },
        }) };
      } catch (error) { await call?.finish(params.abortSignal?.aborted ? "cancelled" : "failed"); throw error; }
    },
  };
  return wrapLanguageModel({ model, middleware });
}

function providerUsage(usage: { inputTokens: { total: number | undefined; cacheRead?: number | undefined; cacheWrite?: number | undefined }; outputTokens: { total: number | undefined } }): ModelCallRecord["usage"] {
  const result: ModelCallRecord["usage"] = {};
  const values = { inputTokens: usage.inputTokens.total, outputTokens: usage.outputTokens.total,
    cacheReadTokens: usage.inputTokens.cacheRead, cacheWriteTokens: usage.inputTokens.cacheWrite };
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) result[key as keyof typeof result] = value;
  }
  if (result.inputTokens !== undefined && result.outputTokens !== undefined) {
    const total = result.inputTokens + result.outputTokens;
    if (Number.isSafeInteger(total)) result.totalTokens = total;
  }
  return result;
}
