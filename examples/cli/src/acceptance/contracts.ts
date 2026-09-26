import type { TokenUsage } from "@aisdk-agent/core";

/** Acceptance-only records. They are never part of a Run or transcript. */
export type CheckStatus = "passed" | "failed" | "blocked" | "not_run";

export type FailureLayer =
  | "configuration"
  | "model"
  | "tool"
  | "persistence"
  | "feedback"
  | "verification"
  | "unknown";

export interface AcceptanceCheck {
  id: string;
  method: "automatic" | "human";
  required: boolean;
  status: CheckStatus;
  evidenceIds: string[];
  note: string;
}

export interface AcceptanceEvidence {
  id: string;
  kind: "terminal" | "transcript" | "artifact" | "store_snapshot" | "request_counter";
  /** Path relative to this attempt's evidence directory. */
  path: string;
  sha256?: string;
}

export interface AcceptanceCaseResult {
  schemaVersion: 1;
  caseId: string;
  attemptId: string;
  baseline: {
    commit: string;
    dirty: boolean;
    modelId: string | null;
    /** Digest of a redacted effective configuration, never the configuration itself. */
    configDigest: string;
  };
  execution: {
    entry: "tui" | "worker" | "runtime_test";
    model: "real" | "mock";
    network: "live" | "controlled" | "unused";
  };
  startedAt: string;
  finishedAt: string | null;
  runIds: string[];
  threadIds: string[];
  status: CheckStatus;
  checks: AcceptanceCheck[];
  evidence: AcceptanceEvidence[];
  failure?: {
    layer: FailureLayer;
    code?: string;
    message: string;
  };
  durationMs: number | null;
  /** Null means usage was unavailable, not zero. */
  usage: TokenUsage | null;
}

/** A required failure takes precedence over later blocked or unrun checks. */
export function deriveCaseStatus(checks: readonly AcceptanceCheck[]): CheckStatus {
  const required = checks.filter((check) => check.required);
  if (required.length === 0) return "not_run";
  if (required.some((check) => check.status === "failed")) return "failed";
  if (required.some((check) => check.status === "blocked")) return "blocked";
  if (required.some((check) => check.status === "not_run")) return "not_run";
  return "passed";
}
