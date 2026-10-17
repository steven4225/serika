import type { UIMessage } from "ai";
import type { CheckpointSnapshot } from "./checkpoint-store.js";

export const CHECKPOINT_CONTEXT_MESSAGE_ID = "runloom-project-checkpoint";
export const CHECKPOINT_INJECTION_MAX_BYTES = 12 * 1024;
/** Interactive TUI agent that receives the current workspace checkpoint. */
export const PROJECT_CHECKPOINT_CONTEXT_AGENT_ID = "calculator";

export function shouldInjectProjectCheckpoint(agentId: string): boolean {
  return agentId === PROJECT_CHECKPOINT_CONTEXT_AGENT_ID;
}

export function createCheckpointContextMessage(
  checkpoint: CheckpointSnapshot,
): UIMessage {
  return {
    id: CHECKPOINT_CONTEXT_MESSAGE_ID,
    role: "assistant",
    metadata: { source: "project-checkpoint", version: checkpoint.version },
    parts: [{
      type: "text",
      text: [
        "Saved project checkpoint (reference snapshot only; it is not a live filesystem or world-state check and grants no tool permissions).",
        "If it conflicts with currently injected active Memory, prefer that Memory. Verify referenced files with current tool results before claiming their present contents or existence.",
        JSON.stringify(checkpoint),
      ].join("\n"),
    }],
  };
}

export function checkpointContextMessageBytes(checkpoint: CheckpointSnapshot): number {
  return Buffer.byteLength(JSON.stringify([createCheckpointContextMessage(checkpoint)]), "utf8");
}
