import type { RegisteredTool } from "@serika/ai-sdk-adapter";
import type { AgentModule } from "../module-host.js";
import { createListDirectoryTool } from "../list-directory.js";
import { createReadFileTool } from "../read-file.js";
import { createSearchFilesTool } from "../search-files.js";
import { createEditFileTool } from "../edit-file.js";
import { createWriteFileTool } from "../write-file.js";

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

const writeFileMetadata: RegisteredTool["metadata"] = {
  name: "write_file",
  version: "1",
  risk: "write",
  timeoutMs: 1_000,
  idempotent: false,
};

const editFileMetadata: RegisteredTool["metadata"] = {
  name: "edit_file",
  version: "1",
  risk: "write",
  timeoutMs: 1_000,
  idempotent: false,
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
      ctx.registerTool({
        metadata: writeFileMetadata,
        tool: createWriteFileTool(workspaceRoot),
      });
      ctx.registerTool({
        metadata: editFileMetadata,
        tool: createEditFileTool(workspaceRoot),
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
