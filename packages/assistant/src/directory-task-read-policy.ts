import type { RegisteredTool } from "@serika/ai-sdk-adapter";
import type { AgentModule } from "./module-host.js";

/**
 * Trusted embedding-only approval for the two built-in, directory-bound task
 * queries. Neither tool names nor risk metadata establish registration trust.
 * The caller must capture only the module constructed from its local TaskStore.
 */
export function createDirectoryTaskReadApproval(directory: string, primaryAgentId: string) {
  const trusted = new Map<string, RegisteredTool>();
  return {
    captureBuiltinModule(module: AgentModule): AgentModule {
      return {
        ...module,
        setup(context) {
          return module.setup({
            ...context,
            registerTool(registered, permission) {
              context.registerTool(registered, permission);
              if (registered.metadata.name === "task_list" || registered.metadata.name === "task_get") {
                trusted.set(registered.metadata.name, registered);
              }
            },
          });
        },
      };
    },
    allows(input: { agentId: string; directory: string | undefined; toolName: string; registeredTool: RegisteredTool | undefined }): boolean {
      return input.agentId === primaryAgentId && input.directory === directory &&
        (input.toolName === "task_list" || input.toolName === "task_get") &&
        input.registeredTool !== undefined && trusted.get(input.toolName) === input.registeredTool;
    },
  };
}
