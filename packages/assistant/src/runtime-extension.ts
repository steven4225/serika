import type { AfterToolCall, BeforeToolExecute, ToolExecutionDecision } from "@serika/core";
import type { ModuleCommand } from "./module-host.js";

/**
 * Something the assembler attaches to the agent loop: tool-execution hooks and
 * idle commands. An extension owns its own state; the app only composes them.
 */
export interface RuntimeExtension {
  readonly name: string;
  /** Decides whether one tool call may run. Must not run the tool itself. */
  readonly beforeToolExecute?: BeforeToolExecute;
  /** Observes one completed tool call; may add feedback or stop the Run. */
  readonly afterToolCall?: AfterToolCall;
  readonly commands?: readonly ModuleCommand[];
}

export interface ComposedExtensions {
  beforeToolExecute?: BeforeToolExecute;
  afterToolCall?: AfterToolCall;
  commands: ModuleCommand[];
}

/**
 * Composes extensions in the given order.
 * - `beforeToolExecute`: each hook is awaited in order; the first denial is
 *   returned without asking later hooks; the call runs only if all allow.
 * - `afterToolCall`: the first hook that returns a decision wins; later hooks
 *   are not called for that tool call.
 * - Command names must be unique across extensions.
 * A hook provided by only one extension is used as is.
 */
export function composeExtensions(extensions: readonly RuntimeExtension[]): ComposedExtensions {
  const before = extensions.flatMap(extension => extension.beforeToolExecute ? [extension.beforeToolExecute] : []);
  const after = extensions.flatMap(extension => extension.afterToolCall ? [extension.afterToolCall] : []);
  const commands = new Map<string, ModuleCommand>();
  for (const extension of extensions) {
    for (const command of extension.commands ?? []) {
      if (commands.has(command.name)) throw new Error(`Extension ${extension.name} registers duplicate command /${command.name}`);
      commands.set(command.name, command);
    }
  }
  const composed: ComposedExtensions = { commands: [...commands.values()] };
  if (before.length === 1) composed.beforeToolExecute = before[0]!;
  else if (before.length > 1) {
    composed.beforeToolExecute = async (input): Promise<ToolExecutionDecision> => {
      for (const hook of before) {
        const decision = await hook(input);
        if (!decision.allow) return decision;
      }
      return { allow: true };
    };
  }
  if (after.length === 1) composed.afterToolCall = after[0]!;
  else if (after.length > 1) {
    composed.afterToolCall = async (input) => {
      for (const hook of after) {
        const decision = await hook(input);
        if (decision !== undefined) return decision;
      }
      return undefined;
    };
  }
  return composed;
}
