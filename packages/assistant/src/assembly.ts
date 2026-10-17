/**
 * How one assistant instance is assembled. Every value comes from the caller
 * (CLI flags, desktop identity, a test); nothing is read from process-wide
 * defaults. The module config stays a file path on purpose: its location is a
 * trust boundary (autonomy, sandbox, automatic memory and authorizations are
 * refused when the config sits inside the workspace the model can write).
 */
export interface AssistantAssembly {
  /** Thread to open. Omitted: a new Thread for this launch. */
  threadId?: string;
  /** Strict `version: 1` module config file. Cannot be combined with the shorthand below. */
  configPath?: string;
  /** Shorthand without a config file: read_file, memory and tasks in this workspace. */
  workspace?: string;
  /** Shorthand: automatic memory consolidation (requires `workspace`). */
  autoConsolidate?: boolean;
  /** Shorthand: Todoist read module. */
  todoistEnabled?: boolean;
}

/** Rejects combinations that would silently ignore part of the request. */
export function assertAssemblyCombination(assembly: AssistantAssembly): void {
  if (assembly.configPath === undefined) return;
  if (assembly.workspace !== undefined) throw new Error("--config cannot be combined with --workspace");
  if (assembly.todoistEnabled) throw new Error("--config cannot be combined with --todoist");
  if (assembly.autoConsolidate) throw new Error("--config cannot be combined with --auto-consolidate");
}
