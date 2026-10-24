import { memoryScopeSchema } from "./memory-types.js";
import { z } from "zod";

export const MEMORY_IMPORT_MAX_ENTRIES = 32;
export const MEMORY_IMPORT_MAX_RECEIPTS = 64;
const text = z.string().trim().min(1).refine(value => Buffer.byteLength(value, "utf8") <= 2048, "Each memory must be at most 2 KiB");
export const memoryImportEntriesSchema = z.array(z.object({ text, scope: memoryScopeSchema, kind: z.enum(["fact", "preference", "event", "note"]) }).strict()).min(1).max(MEMORY_IMPORT_MAX_ENTRIES);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const memoryImportConfirmSchema = z.object({ entries: memoryImportEntriesSchema, snapshot: hash, operationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict();
export const memoryImportReceiptSchema = z.object({ operationId: memoryImportConfirmSchema.shape.operationId, requestHash: hash, projectId: z.string().min(1).nullable(), threadId: z.string().min(1).max(256),
  items: z.array(z.object({ id: z.string().min(1).max(256), status: z.enum(["saved", "existing"]) }).strict()).min(1).max(MEMORY_IMPORT_MAX_ENTRIES),
  committedAt: z.string().datetime(),
}).strict();
export type MemoryImportEntry = z.infer<typeof memoryImportEntriesSchema>[number];
export type MemoryImportConfirm = z.infer<typeof memoryImportConfirmSchema>;
export type MemoryImportReceipt = z.infer<typeof memoryImportReceiptSchema>;
export interface MemoryImportPreview {
  entries: Array<MemoryImportEntry & { existingId: string | null }>;
  snapshot: string; stored: number; available: number;
}
