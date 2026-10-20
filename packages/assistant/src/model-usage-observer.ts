import { randomUUID } from "node:crypto";
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";
import type { ExecutionRecordStore } from "./execution-record-store.js";
import type { ModelCallRecord, ModelPrice, ModelPurpose } from "./model-usage.js";
import { modelInputSegments, type FirstOutputTiming, type ModelCallLog } from "./model-call-log.js";

/** Observe the actual SDK provider boundary; retries enter again, local caches do not. No prompts/raw usage retained. */
export function observeModelUsage(model: LanguageModel, options: {
  records: ExecutionRecordStore; threadId: string; enabled: () => boolean;
  scope: () => { runId?: string; purpose: ModelPurpose };
  prices?: readonly ModelPrice[];
  callLog?: ModelCallLog;
}): LanguageModel {
  if (typeof model === "string") return model;
  const begin = async (input: { provider: string; modelId: string; signal?: AbortSignal; streaming?: boolean; params: Parameters<typeof modelInputSegments>[0] }) => {
    const { provider, modelId, signal } = input;
    signal?.throwIfAborted();
    if (!options.enabled()) return null;
    const started = performance.now();
    const call: ModelCallRecord = { id: randomUUID(), threadId: options.threadId, ...options.scope(),
      provider, modelId, startedAt: new Date().toISOString(), finishedAt: null, status: "pending", usage: {} };
    const price = options.prices?.find(item => item.provider === provider && item.modelId === modelId);
    if (price) call.price = structuredClone(price);
    await options.records.startModelCall(call);
    await options.callLog?.start(call, modelInputSegments(input.params));
    let resolution: Promise<void> | undefined;
    let dispatched = false;
    let dispatchedAt = started, firstOutput: FirstOutputTiming | null = null;
    const finish = async (status: ModelCallRecord["status"], usage: ModelCallRecord["usage"] = {}) => {
      if (resolution) return resolution;
      signal?.removeEventListener("abort", abort);
      resolution = options.records.finishModelCall(call.id, status, usage).then(() => options.callLog?.finish({
        id: call.id, status, usage, durationMs: performance.now() - started,
        ...(input.streaming ? { firstOutput } : {}),
      }));
      return resolution;
    };
    const abort = () => { void finish(dispatched ? "cancelled" : "not_dispatched").catch(() => {
      // An unresolved journal remains visibly pending/unknown; the store stops subsequent dispatch. Never replay the provider.
    }); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    return { finish, dispatch: () => { dispatched = true; dispatchedAt = performance.now(); },
      output: (kind: FirstOutputTiming["kind"]) => { firstOutput ??= { kind, ms: performance.now() - dispatchedAt }; } };
  };
  const middleware: LanguageModelMiddleware = {
    wrapGenerate: async ({ doGenerate, params, model: provider }) => {
      const call = await begin({ provider: provider.provider, modelId: provider.modelId, ...(params.abortSignal ? { signal: params.abortSignal } : {}), params });
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
      const call = await begin({ provider: provider.provider, modelId: provider.modelId, ...(params.abortSignal ? { signal: params.abortSignal } : {}), streaming: true, params });
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
              if (next.value.type === "text-delta" && next.value.delta.length > 0) call.output("text");
              if (next.value.type === "tool-input-start" || next.value.type === "tool-call" ||
                next.value.type === "tool-input-delta" && next.value.delta.length > 0) call.output("tool_call");
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
