import type { TokenUsage } from "@serika/core";
import { validTraceUsage } from "./execution-trace.js";

export type ModelPurpose = "chat" | "memory_consolidation" | "query_rewrite" | "context_compaction" | "skill";
export interface ModelPrice {
  provider: string; modelId: string; currency: string;
  /** Price for non-cached input / output / cache tokens, per million tokens. */
  inputPerMillion: number; outputPerMillion: number;
  cacheReadPerMillion?: number; cacheWritePerMillion?: number;
}
export interface ModelCallRecord {
  id: string; threadId: string; runId?: string; purpose: ModelPurpose;
  provider: string; modelId: string; startedAt: string; finishedAt: string | null;
  status: "pending" | "not_dispatched" | "returned" | "failed" | "cancelled" | "unknown";
  usage: TokenUsage;
  /** Snapshot of explicit trusted pricing, not a live provider price or invoice. */
  price?: ModelPrice;
}
export interface ModelUsagePage { calls: ModelCallRecord[]; droppedCount: number }
export const MODEL_CALL_LIMIT = 128;
export const MODEL_PURPOSE_LABELS: Record<ModelPurpose, string> = {
  chat: "聊天", memory_consolidation: "记忆沉淀", query_rewrite: "查询改写", context_compaction: "上下文压缩", skill: "Skill",
};

const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 256): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const date = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export function validModelPrice(v: unknown): v is ModelPrice {
  return object(v) && text(v.provider) && text(v.modelId) && typeof v.currency === "string" && /^[A-Z]{3}$/.test(v.currency) &&
    Object.keys(v).every(k => ["provider", "modelId", "currency", "inputPerMillion", "outputPerMillion", "cacheReadPerMillion", "cacheWritePerMillion"].includes(k)) &&
    ["inputPerMillion", "outputPerMillion", "cacheReadPerMillion", "cacheWritePerMillion"].every(k =>
      v[k] === undefined ? k.startsWith("cache") : typeof v[k] === "number" && Number.isFinite(v[k]) && v[k] >= 0);
}
export function validModelCall(v: unknown): v is ModelCallRecord {
  return object(v) && text(v.id) && text(v.threadId) && (v.runId === undefined || text(v.runId)) &&
    typeof v.purpose === "string" && Object.hasOwn(MODEL_PURPOSE_LABELS, v.purpose) && text(v.provider) && text(v.modelId) &&
    date(v.startedAt) && (v.finishedAt === null || date(v.finishedAt)) &&
    ["pending", "not_dispatched", "returned", "failed", "cancelled", "unknown"].includes(String(v.status)) &&
    (v.status === "pending") === (v.finishedAt === null) && validTraceUsage(v.usage) &&
    (v.price === undefined || validModelPrice(v.price) && v.price.provider === v.provider && v.price.modelId === v.modelId) &&
    Object.keys(v).every(k => ["id", "threadId", "runId", "purpose", "provider", "modelId", "startedAt", "finishedAt", "status", "usage", "price"].includes(k));
}

/** Missing cache accounting / rates or incomplete responses never become zero-cost. */
export function estimatedModelCost(call: ModelCallRecord): number | undefined {
  if (!call.price || call.status !== "returned") return undefined;
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = call.usage;
  if (inputTokens === undefined || outputTokens === undefined || cacheReadTokens === undefined || cacheWriteTokens === undefined) return undefined;
  if (cacheReadTokens + cacheWriteTokens > inputTokens ||
      cacheReadTokens > 0 && call.price.cacheReadPerMillion === undefined ||
      cacheWriteTokens > 0 && call.price.cacheWritePerMillion === undefined) return undefined;
  const cost = ((inputTokens - cacheReadTokens - cacheWriteTokens) * call.price.inputPerMillion + outputTokens * call.price.outputPerMillion +
    cacheReadTokens * (call.price.cacheReadPerMillion ?? 0) + cacheWriteTokens * (call.price.cacheWritePerMillion ?? 0)) / 1_000_000;
  return Number.isFinite(cost) ? cost : undefined;
}
