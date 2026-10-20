import type { ModelMessage } from "ai";
import { hashCanonicalJson, type CanonicalJsonValue } from "@serika/core";
import { estimateSerializedTokens } from "./context-budget.js";

/** Order already-prepared material; refreshing snapshots and masking blocks belong to the caller. */
export function assembleFiveLayerContext(input: {
  instructions: string; tools: unknown; reference: readonly ModelMessage[];
  summary: readonly ModelMessage[]; recent: readonly ModelMessage[]; current: readonly ModelMessage[];
}) {
  const layers = [input.instructions ? [{ role: "system" as const, content: input.instructions }] : [],
    input.reference, input.summary, input.recent, input.current];
  return { tools: input.tools, messages: layers.flat(), layers };
}

export function contextFingerprint(value: unknown) {
  const serialized = JSON.stringify(value), json = JSON.parse(serialized) as CanonicalJsonValue;
  return { hash: hashCanonicalJson(json), bytes: Buffer.byteLength(serialized), estimatedTokens: estimateSerializedTokens(json) };
}

/** Only an uninterrupted identical prefix is reusable; equal later segments cannot repair a miss. */
export function commonContextPrefix(input: {
  previous: readonly ReturnType<typeof contextFingerprint>[];
  current: readonly ReturnType<typeof contextFingerprint>[];
}) {
  let segments = 0, estimatedTokens = 0, bytes = 0;
  for (const segment of input.current) {
    if (input.previous[segments]?.hash !== segment.hash) break;
    segments++; estimatedTokens += segment.estimatedTokens; bytes += segment.bytes;
  }
  return { segments, estimatedTokens, bytes };
}
