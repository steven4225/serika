// Command and resume hooks a RuntimeApp hands to an interactive host
// (the terminal UI today). The host renders and sequences them; the assistant
// owns what they do.

/** An idle command handled directly by the terminal adapter. */
export interface TuiCommand {
  execute(args: string): void | Promise<void>;
}

/** /resume inspects without a Run; only the next primary Run can use its observation. */
export interface TuiResume {
  inspect(signal: AbortSignal): Promise<string>;
  clear(): void;
  beginRun(): void;
  endRun(): void;
}
