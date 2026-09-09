import type { RegisteredTool } from "@aisdk-agent/ai-sdk-adapter";
import type { AgentModule } from "../module-host.js";
import { createListDirectoryTool } from "../list-directory.js";
import { createReadFileTool } from "../read-file.js";
import { createSearchFilesTool } from "../search-files.js";

const readFileMetadata: RegisteredTool["metadata"] = {
  name: "read_file",
  version: "1",
  risk: "read",
  timeoutMs: 1_000,
  idempotent: true,
};

const listDirectoryMetadata: RegisteredTool["metadata"] = {
  name: "list_directory",
  version: "1",
  risk: "read",
  timeoutMs: 1_000,
  idempotent: true,
};

const searchFilesMetadata: RegisteredTool["metadata"] = {
  name: "search_files",
  version: "1",
  risk: "read",
  timeoutMs: 5_000,
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
      ctx.registerTool({
        metadata: listDirectoryMetadata,
        tool: createListDirectoryTool(workspaceRoot),
      });
      ctx.registerTool({
        metadata: searchFilesMetadata,
        tool: createSearchFilesTool(workspaceRoot),
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
