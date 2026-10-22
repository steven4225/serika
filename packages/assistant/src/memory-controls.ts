import { z } from "zod";
import { MEMORY_FILE_MAX_BYTES, MEMORY_MAX_ENTRIES, type MemoryResult } from "./memory-types.js";
const identity = { id: z.string().min(1).max(256), expectedRevision: z.number().int().positive() };
const actionSchema = z.discriminatedUnion("operation", [
  z.object({ ...identity, operation: z.literal("correct"), text: z.string().trim().min(1).refine(text => Buffer.byteLength(text) <= 2048) }).strict(),
  z.object({ ...identity, operation: z.literal("metadata"), pinned: z.boolean().optional(), status: z.literal("disabled").optional() }).strict(),
  z.object({ ...identity, operation: z.literal("retract") }).strict(),
  z.object({ ...identity, operation: z.literal("undo") }).strict(),
  z.object({ ...identity, operation: z.literal("delete") }).strict(),
]);
export type MemoryAction = z.infer<typeof actionSchema>;
export interface MemoryMaintenance {
  conflicts?: string[][]; extraction?: import("./memory-extraction.js").ExtractionDiagnostics;
  stored: number; capacity: { entries: number; bytes: number }; disabled: number;
  consolidation: { enabled: boolean; state: "off" | "backlog" | "running" | "failed" | "idle"; error?: string; backlogCount?: number };
}
export const memoryCapacity: MemoryMaintenance["capacity"] = { entries: MEMORY_MAX_ENTRIES, bytes: MEMORY_FILE_MAX_BYTES };
export const memoryControlFailure = (code: string, message: string): { ok: false; error: { code: string; message: string } } => ({ ok: false, error: { code, message } });
export function validateMemoryAction(value: unknown): MemoryResult<MemoryAction> {
  const checked = actionSchema.safeParse(value);
  return checked.success ? { ok: true, value: checked.data } : memoryControlFailure("INVALID_INPUT", "Memory action requires a current revision and supported fields");
}
