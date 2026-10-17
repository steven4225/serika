import type { RegisteredTool } from "@serika/ai-sdk-adapter";

export type Dispose = () => void;

export interface ModuleCommand {
  /** The command name without the leading slash. */
  name: string;
  execute(args: string): void | Promise<void>;
}

export interface ModuleContext {
  registerTool(tool: RegisteredTool): void;
  registerCommand(command: ModuleCommand): void;
  notify(message: string): void;
}

export interface AgentModule {
  id: string;
  setup(context: ModuleContext): void | Dispose;
}

export interface ModuleHost {
  readonly tools: readonly RegisteredTool[];
  readonly commands: ReadonlyMap<string, ModuleCommand>;
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
    const moduleCommands = new Map<string, ModuleCommand>();
    let registrationOpen = true;

    const context: ModuleContext = {
      registerTool(tool) {
        if (!registrationOpen) {
          throw new Error(`Module registration is closed: ${module.id}`);
        }
        moduleTools.push(tool);
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
    for (const [name, command] of moduleCommands) commands.set(name, command);
    setupRecords.push({ dispose });
  }

  const exposedTools = Object.freeze([...tools]);
  const exposedCommands = new Map(commands);
  let disposed = false;

  return {
    tools: exposedTools,
    commands: exposedCommands,
    dispose() {
      if (disposed) return;
      disposed = true;
      const errors = disposeRecords([...setupRecords].reverse());
      const aggregate = aggregateErrors(errors, "Module host disposal failed");
      if (aggregate) throw aggregate;
    },
  };
}
