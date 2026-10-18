import { tool } from "ai";
import { z } from "zod";
import type { AgentModule } from "../module-host.js";

/**
 * Demo only (architecture-v2 cross-module interfaces): a new module needs this
 * file plus one assembly line; it declares its own instruction placement.
 * Reverted in the next commit.
 */
export function createDemoEchoModule(): AgentModule {
  return {
    id: "demo-echo",
    instructionPlacement: { section: "body", rank: 850 },
    setup(ctx) {
      ctx.addInstructions(" Demo only: demo_echo echoes text; never use it for real work.");
      ctx.registerTool({
        metadata: { name: "demo_echo", version: "1", risk: "read", timeoutMs: 1000, idempotent: true },
        tool: tool({
          description: "Demo only: echo the given text.",
          inputSchema: z.object({ text: z.string() }).strict(),
          execute: async ({ text }: { text: string }) => ({ text }),
        }),
      }, { defaults: { approval: "auto" } });
    },
  };
}
