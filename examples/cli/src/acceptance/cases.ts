export type AcceptanceCaseId =
  | "A01" | "A02" | "A03" | "A04" | "A05"
  | "A06" | "A07" | "A08" | "A09";

export type AssertionKind =
  | "file_present"
  | "file_absent"
  | "file_sha256"
  | "json_equals"
  | "json_compare";

export interface AcceptanceCaseCheck {
  id: string;
  description: string;
  method: "automatic" | "human";
  required: true;
  /** Only automatic checks have accepted assertion kinds. */
  assertionKinds?: readonly AssertionKind[];
}

export interface AcceptanceCase {
  id: AcceptanceCaseId;
  title: string;
  checks: readonly AcceptanceCaseCheck[];
}

const cases: readonly AcceptanceCase[] = [
  {
    id: "A01", title: "Read, edit, and save a workspace file",
    checks: [
      { id: "artifact_hash", description: "The captured artifact matches the expected digest", method: "automatic", required: true, assertionKinds: ["file_sha256"] },
      { id: "file_content_and_scope", description: "The actual workspace file contains the requested edit and no out-of-scope change", method: "human", required: true },
    ],
  },
  {
    id: "A02", title: "Deny a write or execution",
    checks: [
      { id: "denied_target_state", description: "The captured denied target is absent or unchanged", method: "automatic", required: true, assertionKinds: ["file_absent", "file_sha256"] },
      { id: "denial_behavior", description: "The operator saw the denial; the agent did not bypass it or claim completion", method: "human", required: true },
    ],
  },
  {
    id: "A03", title: "Successful tool action followed by Run failure",
    checks: [
      { id: "completed_side_effect", description: "The captured output from the successful tool action exists", method: "automatic", required: true, assertionKinds: ["file_present"] },
      { id: "failure_receipt", description: "The TUI reported the completed action despite the later Run failure", method: "human", required: true },
    ],
  },
  {
    id: "A04", title: "Search, read the original source, and save a report",
    checks: [
      { id: "report_artifact", description: "The captured report matches the expected digest", method: "automatic", required: true, assertionKinds: ["file_sha256"] },
      { id: "source_grounding", description: "Factual claims use successfully fetched original pages and identify the actual final URLs", method: "human", required: true },
    ],
  },
  {
    id: "A05", title: "Bounded code fix and verification",
    checks: [
      { id: "check_exit", description: "The captured command result records a zero exit code", method: "automatic", required: true, assertionKinds: ["json_equals"] },
      { id: "fix_review", description: "The diff stays within scope and the reported checks were actually run", method: "human", required: true },
    ],
  },
  {
    id: "A06", title: "Reschedule a one-time task",
    checks: [
      { id: "task_id_stable", description: "Pre- and post-reschedule task IDs match", method: "automatic", required: true, assertionKinds: ["json_compare"] },
      { id: "run_at_changed", description: "The task's new runAt differs from the captured old runAt", method: "automatic", required: true, assertionKinds: ["json_compare"] },
      { id: "reschedule_behavior", description: "Confirmation, refusal, scheduling, and worker execution followed the real task path", method: "human", required: true },
    ],
  },
  {
    id: "A07", title: "Read RSS or Atom on demand",
    checks: [
      { id: "denied_request_count", description: "The captured request counter is zero after refusal", method: "automatic", required: true, assertionKinds: ["json_equals"] },
      { id: "feed_behavior", description: "Items retain document order, truncation is stated accurately, and summaries are not cited as opened articles", method: "human", required: true },
    ],
  },
  {
    id: "A08", title: "Workspace brief through worker, inbox, and acknowledgement",
    checks: [
      { id: "task_state", description: "The captured task record has the expected persisted status", method: "automatic", required: true, assertionKinds: ["json_equals"] },
      { id: "brief_delivery", description: "The TUI creation confirmation, current Memory ID and checkpoint version, inbox, and ack were observed", method: "human", required: true },
    ],
  },
  {
    id: "A09", title: "Memory and checkpoint across Threads",
    checks: [
      { id: "memory_and_checkpoint_use", description: "The new Thread used current Memory and treated checkpoint as a saved reference", method: "human", required: true },
    ],
  },
];

export function listAcceptanceCases(): readonly AcceptanceCase[] {
  return cases;
}

export function getAcceptanceCase(id: string): AcceptanceCase | undefined {
  return cases.find((item) => item.id === id);
}
