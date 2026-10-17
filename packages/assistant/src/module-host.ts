import type { RegisteredTool } from "@serika/ai-sdk-adapter";
import type { BeforeToolExecuteInput } from "@serika/core";

export type Dispose = () => void;

export interface ModuleCommand {
  /** The command name without the leading slash. */
  name: string;
  execute(args: string): void | Promise<void>;
}

/**
 * Facts a module states about one of its tools. The host's permission rules
 * read them instead of tool-name lists; the module never decides an approval.
 */
export interface ToolPermissionFacts {
  /**
   * Where a grant's scope comes from: the web origin of a URL argument, or a
   * workspace-relative path argument.
   */
  readonly scope?: { readonly kind: "origin" | "workspacePath"; readonly argument: string };
  readonly defaults?: {
    /** `auto`: calls run without y/n confirmation, for every agent. */
    readonly approval?: "auto";
    /** Calls made by these agents run without y/n confirmation. */
    readonly approvalAgents?: readonly string[];
    /**
     * `scope`: an approval may be remembered for this conversation, per scope
     * (an origin, or the directory of a workspace path without subdirectories).
     * `never`: an approval is never remembered, whatever the declared risk.
     */
    readonly remember?: "scope" | "never";
    /**
     * `scope`: a one-Run authorization may allow listed scopes (`/authorize-web`
     * for origins; `/authorize` and configured file rules for workspace paths).
     * `tool`: `/authorize-shell` may allow every call of the tool for one Run.
     */
    readonly runAuthorization?: "scope" | "tool";
    /** `allow`: an autonomous Run executes calls without y/n confirmation. */
    readonly autonomy?: "allow";
  };
  /** Denying this tool also denies these tools for the rest of the Run. */
  readonly denialBlocksForRun?: readonly string[];
  /**
   * The whole y/n card for this call, which may load asynchronously;
   * `undefined` falls back to the generic card.
   */
  confirmation?(input: BeforeToolExecuteInput): string | Promise<string | undefined> | undefined;
}

/** What module instructions may depend on for one Run. */
export interface InstructionRun {
  /** The Run executes host-authorized tools without y/n confirmation. */
  readonly autonomous: boolean;
}

export interface ModuleContext {
  registerTool(tool: RegisteredTool, permission?: ToolPermissionFacts): void;
  registerCommand(command: ModuleCommand): void;
  /**
   * Primary-agent instructions, included only because this module is
   * assembled. The function form words them for an autonomous Run.
   */
  addInstructions(text: string | ((run: InstructionRun) => string)): void;
  /** Whether another module is assembled in the same host (read-only). */
  isAssembled(moduleId: string): boolean;
  notify(message: string): void;
}

export interface AgentModule {
  id: string;
  setup(context: ModuleContext): void | Dispose;
}

export interface ModuleHost {
  readonly tools: readonly RegisteredTool[];
  readonly commands: ReadonlyMap<string, ModuleCommand>;
  /** Permission facts by tool name, for tools whose module declared them. */
  readonly toolPermissions: ReadonlyMap<string, ToolPermissionFacts>;
  /** The module that registered each tool. */
  readonly toolModules: ReadonlyMap<string, string>;
  /** One assembled module's instructions, or "" when it is not assembled or added none. */
  instructions(moduleId: string, run?: InstructionRun): string;
  dispose(): void;
}

interface SetupRecord {
  dispose: Dispose | undefined;
}

function aggregateErrors(errors: readonly unknown[], message: string): AggregateError | undefined {
  if (errors.length === 0) return undefined;
  return new AggregateError(errors, message);
}

function disposeRecords(records: readonly SetupRecord[]): unknown[] {
  const errors: unknown[] = [];
  for (const record of records) {
    if (!record.dispose) continue;
    try {
      record.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

export function createModuleHost(
  modules: readonly AgentModule[],
  options: {
    notify(moduleId: string, message: string): void;
  },
): ModuleHost {
  const moduleIds = new Set<string>();
  for (const module of modules) {
    if (moduleIds.has(module.id)) {
      throw new Error(`Module already registered: ${module.id}`);
    }
    moduleIds.add(module.id);
  }

  const tools: RegisteredTool[] = [];
  const commands = new Map<string, ModuleCommand>();
  const toolPermissions = new Map<string, ToolPermissionFacts>();
  const toolModules = new Map<string, string>();
  const instructions = new Map<string, ((run: InstructionRun) => string)[]>();
  const setupRecords: SetupRecord[] = [];

  const failStartup = (error: unknown, records: readonly SetupRecord[]): never => {
    const cleanupErrors = disposeRecords(records);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Module host startup failed",
      );
    }
    throw error;
  };

  for (const module of modules) {
    const moduleTools: RegisteredTool[] = [];
    const modulePermissions = new Map<string, ToolPermissionFacts>();
    const moduleCommands = new Map<string, ModuleCommand>();
    const moduleInstructions: ((run: InstructionRun) => string)[] = [];
    let registrationOpen = true;

    const context: ModuleContext = {
      registerTool(tool, permission) {
        if (!registrationOpen) {
          throw new Error(`Module registration is closed: ${module.id}`);
        }
        moduleTools.push(tool);
        if (permission !== undefined) modulePermissions.set(tool.metadata.name, permission);
      },
      registerCommand(command) {
        if (!registrationOpen) {
          throw new Error(`Module registration is closed: ${module.id}`);
        }
        if (moduleCommands.has(command.name)) {
          throw new Error(`Command already registered: ${command.name}`);
        }
        moduleCommands.set(command.name, command);
      },
      addInstructions(text) {
        if (!registrationOpen) {
          throw new Error(`Module registration is closed: ${module.id}`);
        }
        moduleInstructions.push(typeof text === "string" ? () => text : text);
      },
      isAssembled: (moduleId) => moduleIds.has(moduleId),
      notify(message) {
        options.notify(module.id, message);
      },
    };

    let dispose: Dispose | undefined;
    try {
      const setupResult = module.setup(context);
      dispose = typeof setupResult === "function" ? setupResult : undefined;
    } catch (error) {
      registrationOpen = false;
      // The failed module did not return a disposer. Its staged registrations
      // are intentionally discarded, while successful modules are cleaned up.
      failStartup(error, [...setupRecords].reverse());
    }
    registrationOpen = false;

    for (const commandName of moduleCommands.keys()) {
      if (commands.has(commandName)) {
        const current = { dispose };
        failStartup(
          new Error(`Command already registered: ${commandName}`),
          [current, ...[...setupRecords].reverse()],
        );
      }
    }

    tools.push(...moduleTools);
    for (const tool of moduleTools) toolModules.set(tool.metadata.name, module.id);
    for (const [name, permission] of modulePermissions) toolPermissions.set(name, permission);
    if (moduleInstructions.length > 0) instructions.set(module.id, moduleInstructions);
    for (const [name, command] of moduleCommands) commands.set(name, command);
    setupRecords.push({ dispose });
  }

  const exposedTools = Object.freeze([...tools]);
  const exposedCommands = new Map(commands);
  let disposed = false;

  return {
    tools: exposedTools,
    commands: exposedCommands,
    toolPermissions: new Map(toolPermissions),
    toolModules: new Map(toolModules),
    instructions: (moduleId, run = { autonomous: false }) =>
      (instructions.get(moduleId) ?? []).map(part => part(run)).join(""),
    dispose() {
      if (disposed) return;
      disposed = true;
      const errors = disposeRecords([...setupRecords].reverse());
      const aggregate = aggregateErrors(errors, "Module host disposal failed");
      if (aggregate) throw aggregate;
    },
  };
}
