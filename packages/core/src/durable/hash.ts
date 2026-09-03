import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { assertJsonValue } from "./json.js";
import type { JsonValue } from "./types.js";

export const CANONICAL_HASH_ALGORITHM = "jcs-sha256:v1";

export function hashCanonicalJson(value: JsonValue): string {
  assertJsonValue(value, "canonical hash input");
  const canonical = canonicalize(value);
  if (canonical === undefined) {
    throw new TypeError("RFC 8785 canonicalization produced no output");
  }
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `${CANONICAL_HASH_ALGORITHM}:${digest}`;
}

export interface ToolInputHashEnvelope {
  toolName: string;
  toolVersion: string;
  inputSchemaVersion: number;
  input: JsonValue;
}

export function hashToolInput(envelope: ToolInputHashEnvelope): string {
  return hashCanonicalJson({
    toolName: envelope.toolName,
    toolVersion: envelope.toolVersion,
    inputSchemaVersion: envelope.inputSchemaVersion,
    input: envelope.input,
  });
}
