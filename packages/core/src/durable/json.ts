import { DurableDomainError } from "./errors.js";
import type { JsonValue } from "./types.js";

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      if (Array.isArray(value)) return value.every(isJsonValue);
      if (Object.getPrototypeOf(value) !== Object.prototype) return false;
      return Object.values(value as Record<string, unknown>).every(isJsonValue);
    default:
      return false;
  }
}

export function assertJsonValue(
  value: unknown,
  field = "value",
): asserts value is JsonValue {
  if (!isJsonValue(value)) {
    throw new DurableDomainError(
      "INVALID_COMMAND",
      `${field} must contain only JSON values`,
    );
  }
}
