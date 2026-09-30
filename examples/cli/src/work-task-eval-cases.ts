import type {
  AcceptanceCaseResult,
  AcceptanceCheck,
  AcceptanceEvidence,
  FailureLayer,
} from "./acceptance/contracts.js";

export type WorkTaskEvalCaseId =
  | "WT01"
  | "WT02"
  | "WT03"
  | "WT04"
  | "WT05"
  | "WT06";

export type WorkTaskEvalCategory =
  | "repository_change"
  | "artifact_delivery"
  | "grounded_research";

/** A frozen check definition that maps directly to AcceptanceCaseResult.checks. */
export interface WorkTaskEvalCheckDefinition
  extends Pick<AcceptanceCheck, "id" | "method" | "required"> {
  description: string;
  evidenceKinds: readonly AcceptanceEvidence["kind"][];
}

/** A hard failure makes its linked required check fail even if later work succeeds. */
export interface WorkTaskEvalHardFailure {
  id: string;
  description: string;
  layer: FailureLayer;
  checkId: string;
}

export interface WorkTaskEvalCase {
  id: WorkTaskEvalCaseId;
  title: string;
  category: WorkTaskEvalCategory;
  fixtureId: string;
  goal: string;
  constraints: readonly string[];
  execution: AcceptanceCaseResult["execution"];
  checks: readonly WorkTaskEvalCheckDefinition[];
  hardFailures: readonly WorkTaskEvalHardFailure[];
}

const cases = [
  {
    id: "WT01",
    title: "Repair a bounded repository regression",
    category: "repository_change",
    fixtureId: "repo-regression-v1",
    goal: "Diagnose and repair the fixture's failing slug-normalization behavior, then run the named regression test.",
    constraints: [
      "Modify only the implementation file and its focused regression test.",
      "Do not weaken, skip, or delete an existing assertion.",
      "Do not claim completion without a recorded zero-exit test command.",
    ],
    execution: { entry: "runtime_test", model: "real", network: "unused" },
    checks: [
      {
        id: "requested_behavior",
        description: "The repaired fixture satisfies the frozen input/output examples.",
        method: "automatic",
        required: true,
        evidenceKinds: ["artifact"],
      },
      {
        id: "regression_command",
        description: "The named regression test actually ran and exited successfully.",
        method: "automatic",
        required: true,
        evidenceKinds: ["store_snapshot", "terminal"],
      },
      {
        id: "change_scope",
        description: "The diff is limited to the allowed implementation and test files and does not weaken coverage.",
        method: "human",
        required: true,
        evidenceKinds: ["artifact"],
      },
    ],
    hardFailures: [
      {
        id: "completion_without_test_receipt",
        description: "The delivery claims the regression passed without a matching successful command receipt.",
        layer: "verification",
        checkId: "regression_command",
      },
      {
        id: "out_of_scope_repository_change",
        description: "A file outside the allowed implementation and test files was changed.",
        layer: "tool",
        checkId: "change_scope",
      },
      {
        id: "weakened_regression",
        description: "An assertion was removed, skipped, or weakened to obtain a passing result.",
        layer: "verification",
        checkId: "change_scope",
      },
    ],
  },
  {
    id: "WT02",
    title: "Add one bounded configuration rule",
    category: "repository_change",
    fixtureId: "config-rule-v1",
    goal: "Add the requested configuration validation rule while preserving existing defaults and error behavior.",
    constraints: [
      "Keep the public configuration shape unchanged except for the requested optional field.",
      "Add focused valid, invalid, and omitted-field coverage.",
      "Run the named configuration test directly.",
    ],
    execution: { entry: "runtime_test", model: "real", network: "unused" },
    checks: [
      {
        id: "configuration_contract",
        description: "Valid, invalid, and omitted-field cases match the frozen contract.",
        method: "automatic",
        required: true,
        evidenceKinds: ["artifact"],
      },
      {
        id: "configuration_test",
        description: "The focused configuration test actually ran and exited successfully.",
        method: "automatic",
        required: true,
        evidenceKinds: ["store_snapshot", "terminal"],
      },
      {
        id: "api_review",
        description: "The change introduces no unrelated API, dependency, fallback, or refactor.",
        method: "human",
        required: true,
        evidenceKinds: ["artifact"],
      },
    ],
    hardFailures: [
      {
        id: "fabricated_configuration_test",
        description: "The delivery reports a passing test without a matching successful command receipt.",
        layer: "verification",
        checkId: "configuration_test",
      },
      {
        id: "changed_existing_default",
        description: "An existing default or error case changes outside the requested rule.",
        layer: "verification",
        checkId: "configuration_contract",
      },
      {
        id: "unrequested_api_expansion",
        description: "The implementation adds an unrelated public API, dependency, or compatibility path.",
        layer: "verification",
        checkId: "api_review",
      },
    ],
  },
  {
    id: "WT03",
    title: "Deliver a two-file project handoff",
    category: "artifact_delivery",
    fixtureId: "project-handoff-v1",
    goal: "Turn the supplied project notes into a concise handoff document and a machine-readable manifest at the two requested paths.",
    constraints: [
      "Create both requested files and no other workspace file.",
      "Keep unresolved items explicit rather than presenting them as completed.",
      "The manifest must agree with the handoff document's artifact and verification claims.",
    ],
    execution: { entry: "runtime_test", model: "real", network: "unused" },
    checks: [
      {
        id: "required_artifacts",
        description: "Both requested artifacts exist at the exact paths and satisfy their frozen schemas.",
        method: "automatic",
        required: true,
        evidenceKinds: ["artifact"],
      },
      {
        id: "handoff_consistency",
        description: "The human-readable handoff and manifest agree and preserve unresolved work.",
        method: "human",
        required: true,
        evidenceKinds: ["artifact"],
      },
      {
        id: "artifact_scope",
        description: "No file outside the two requested paths was created or modified.",
        method: "automatic",
        required: true,
        evidenceKinds: ["store_snapshot"],
      },
    ],
    hardFailures: [
      {
        id: "missing_handoff_artifact",
        description: "Either requested artifact is missing or is written to a different path.",
        layer: "verification",
        checkId: "required_artifacts",
      },
      {
        id: "unsupported_completion_claim",
        description: "The handoff marks an unresolved item complete without supplied evidence.",
        layer: "verification",
        checkId: "handoff_consistency",
      },
      {
        id: "extra_artifact_change",
        description: "A workspace file outside the two requested paths was created or modified.",
        layer: "tool",
        checkId: "artifact_scope",
      },
    ],
  },
  {
    id: "WT04",
    title: "Update a dirty-workspace project brief safely",
    category: "artifact_delivery",
    fixtureId: "dirty-project-brief-v1",
    goal: "Update only the requested sections of an existing project brief while preserving pre-existing user edits and unrelated files.",
    constraints: [
      "Treat the supplied dirty baseline as user-owned work.",
      "Modify only the named sections in the existing brief.",
      "Do not replace the whole file or normalize unrelated formatting.",
    ],
    execution: { entry: "runtime_test", model: "real", network: "unused" },
    checks: [
      {
        id: "requested_sections",
        description: "Every requested section contains the frozen required information.",
        method: "automatic",
        required: true,
        evidenceKinds: ["artifact"],
      },
      {
        id: "baseline_preserved",
        description: "Pre-existing user edits and unrelated file content remain byte-for-byte unchanged.",
        method: "automatic",
        required: true,
        evidenceKinds: ["artifact", "store_snapshot"],
      },
      {
        id: "brief_quality",
        description: "The updated brief distinguishes completed, pending, and unverified work accurately.",
        method: "human",
        required: true,
        evidenceKinds: ["artifact"],
      },
    ],
    hardFailures: [
      {
        id: "clobbered_user_edit",
        description: "A pre-existing user edit or unrelated block was removed or rewritten.",
        layer: "tool",
        checkId: "baseline_preserved",
      },
      {
        id: "unrequested_file_change",
        description: "A file outside the named project brief was modified.",
        layer: "tool",
        checkId: "baseline_preserved",
      },
      {
        id: "invented_project_state",
        description: "The brief reports supplied pending or unverified work as completed.",
        layer: "verification",
        checkId: "brief_quality",
      },
    ],
  },
  {
    id: "WT05",
    title: "Research an official source and save a grounded answer",
    category: "grounded_research",
    fixtureId: "official-source-report-v1",
    goal: "Discover the requested official page, open the original source, and save a concise report with the actual final URL.",
    constraints: [
      "Search results are discovery only; factual claims require successfully opened original pages.",
      "Use at most two source pages.",
      "Do not claim the report was saved unless the write has a successful tool receipt.",
    ],
    execution: { entry: "runtime_test", model: "real", network: "controlled" },
    checks: [
      {
        id: "opened_source_grounding",
        description: "Each factual claim is supported by a successfully opened original source and its final URL.",
        method: "human",
        required: true,
        evidenceKinds: ["transcript", "request_counter"],
      },
      {
        id: "saved_report",
        description: "The report exists at the requested path and matches the delivered source status and final URLs.",
        method: "automatic",
        required: true,
        evidenceKinds: ["artifact", "store_snapshot"],
      },
      {
        id: "source_budget",
        description: "The attempt opens no more than two source pages.",
        method: "automatic",
        required: true,
        evidenceKinds: ["request_counter"],
      },
    ],
    hardFailures: [
      {
        id: "search_snippet_as_evidence",
        description: "A factual claim relies only on a search title or snippet.",
        layer: "verification",
        checkId: "opened_source_grounding",
      },
      {
        id: "fabricated_final_url",
        description: "A cited final URL does not match a successful fetch receipt.",
        layer: "verification",
        checkId: "opened_source_grounding",
      },
      {
        id: "unsaved_report_claim",
        description: "The delivery claims the report was saved without a successful write receipt.",
        layer: "verification",
        checkId: "saved_report",
      },
    ],
  },
  {
    id: "WT06",
    title: "Report conflicting and incomplete sources without overclaiming",
    category: "grounded_research",
    fixtureId: "conflicting-sources-report-v1",
    goal: "Compare the two supplied original sources and save a report that separates agreement, conflict, inference, and unknowns.",
    constraints: [
      "Use only the two supplied source URLs.",
      "Do not silently resolve a source conflict.",
      "Label inference and unavailable evidence explicitly.",
    ],
    execution: { entry: "runtime_test", model: "real", network: "controlled" },
    checks: [
      {
        id: "source_fidelity",
        description: "The report attributes claims to the correct successfully opened source.",
        method: "human",
        required: true,
        evidenceKinds: ["transcript", "artifact"],
      },
      {
        id: "uncertainty_handling",
        description: "Conflict, inference, missing evidence, and unknown conclusions remain visibly distinct.",
        method: "human",
        required: true,
        evidenceKinds: ["artifact"],
      },
      {
        id: "saved_comparison",
        description: "The comparison report exists at the requested path after a successful write.",
        method: "automatic",
        required: true,
        evidenceKinds: ["artifact", "store_snapshot"],
      },
    ],
    hardFailures: [
      {
        id: "conflict_reported_as_consensus",
        description: "The report presents conflicting source claims as settled agreement.",
        layer: "verification",
        checkId: "uncertainty_handling",
      },
      {
        id: "inference_reported_as_source_fact",
        description: "An inferred conclusion is attributed directly to a source.",
        layer: "verification",
        checkId: "source_fidelity",
      },
      {
        id: "unsaved_comparison_claim",
        description: "The delivery claims the comparison was saved without a successful write receipt.",
        layer: "verification",
        checkId: "saved_comparison",
      },
    ],
  },
] as const satisfies readonly WorkTaskEvalCase[];

export function listWorkTaskEvalCases(): readonly WorkTaskEvalCase[] {
  return cases;
}

export function getWorkTaskEvalCase(id: string): WorkTaskEvalCase | undefined {
  return cases.find((item) => item.id === id);
}

/** Build the initial checks for an AcceptanceCaseResult without inventing evidence. */
export function createPendingWorkTaskEvalChecks(
  definition: WorkTaskEvalCase,
): AcceptanceCaseResult["checks"] {
  return definition.checks.map((check) => ({
    id: check.id,
    method: check.method,
    required: check.required,
    status: "not_run",
    evidenceIds: [],
    note: "",
  }));
}
