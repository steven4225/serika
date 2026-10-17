// Command, compaction and resume hooks a RuntimeApp hands to an interactive host
// (the terminal UI today). The host renders and sequences them; the assistant
// owns what they do.

/** An idle command handled directly by the terminal adapter. */
export interface TuiCommand {
  execute(args: string): void | Promise<void>;
}

/**
 * The TUI owns the lifecycle of a manual compaction, while the compactor owns
 * context selection, summary generation, and persistence. Keeping this
 * boundary callback-based means /compact never creates a user Run or a second
 * AgentLoop.
 */
export interface TuiCompaction {
  compact(
    signal: AbortSignal,
  ): Promise<{ message?: string } | void>;
}

/** /resume inspects without a Run; only the next primary Run can use its observation. */
export interface TuiResume {
  inspect(signal: AbortSignal): Promise<string>;
  clear(): void;
  beginRun(): void;
  endRun(): void;
}
