/**
 * Typed facts one module states for another (architecture-v2 §4.4,
 * cross-module interfaces). The provider builds the fact, the assembly entry
 * (`app.ts`) passes it to the consumer's factory once, and the consumer only
 * depends on this file — never on the provider module. There is no registry
 * and no lookup by name: a missing fact is simply an omitted option.
 *
 * Function-shaped dependencies that predate this file (checkpoint's
 * `getMemorySelection` and `captureGitPin`) already follow the same rule:
 * typed, passed at the assembly entry, owned by the host wiring.
 */

/** Todoist → task: whether a Todoist planning source can serve a todoist-brief arrangement. */
export interface TodoistPlanningFact {
  /** This process assembled Todoist. */
  readonly available: boolean;
  /**
   * Trusted re-check against the background service before saving. When
   * present its answer replaces `available`; a failure counts as unavailable.
   */
  readonly check?: () => Promise<boolean>;
}
