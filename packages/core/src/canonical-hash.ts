import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

export type CanonicalJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

/** Versioned hash protocol: SHA-256 over RFC 8785 (JCS) canonical JSON. */
export const CANONICAL_HASH_ALGORITHM = "jcs-sha256:v1";

export function isCanonicalJsonValue(value: unknown): value is CanonicalJsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      if (Array.isArray(value)) return value.every(isCanonicalJsonValue);
      if (Object.getPrototypeOf(value) !== Object.prototype) return false;
      return Object.values(value as Record<string, unknown>).every(isCanonicalJsonValue);
    default:
      return false;
  }
}

/** Returns `jcs-sha256:v1:<hex>`; stored hashes depend on this exact format. */
export function hashCanonicalJson(value: CanonicalJsonValue): string {
  if (!isCanonicalJsonValue(value)) {
    throw new TypeError("canonical hash input must contain only JSON values");
  }
  const canonical = canonicalize(value);
  if (canonical === undefined) {
    throw new TypeError("RFC 8785 canonicalization produced no output");
  }
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `${CANONICAL_HASH_ALGORITHM}:${digest}`;
}
