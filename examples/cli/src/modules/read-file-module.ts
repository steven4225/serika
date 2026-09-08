import type { RegisteredTool } from "@aisdk-agent/ai-sdk-adapter";
import type { AgentModule } from "../module-host.js";
import { createReadFileTool } from "../read-file.js";

const readFileMetadata: RegisteredTool["metadata"] = {
  name: "read_file",
  version: "1",
  risk: "read",
  timeoutMs: 1_000,
  idempotent: true,
};

export function createReadFileModule(workspaceRoot: string): AgentModule {
  return {
    id: "read-file",
    setup(ctx) {
      ctx.registerTool({
        metadata: readFileMetadata,
        tool: createReadFileTool(workspaceRoot),
      });
      ctx.registerCommand({
        name: "workspace",
        execute(args) {
          ctx.notify(args === "" ? workspaceRoot : "Usage: /workspace");
        },
      });
    },
  };
}
