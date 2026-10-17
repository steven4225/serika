import { createHash } from "node:crypto";

/** Stored beside the created entity in its existing atomic document. No second journal. */
export interface CreationReceipt { operationId: string; requestHash: string }
export function creationReceipt(operationId: unknown, input: unknown): CreationReceipt | undefined {
  if (operationId === undefined) return undefined;
  if (typeof operationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw new Error("Invalid creation operation ID");
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) :
    value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)])) : value;
  return { operationId, requestHash: createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex") };
}
export function readCreationReceipt(raw: unknown): CreationReceipt | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid creation receipt");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || typeof value.requestHash !== "string" || !/^[a-f0-9]{64}$/.test(value.requestHash)) throw new Error("Invalid creation receipt");
  creationReceipt(value.operationId, null);
  if (value.operationId === undefined) throw new Error("Missing creation operation ID");
  return { operationId: value.operationId as string, requestHash: value.requestHash };
}
