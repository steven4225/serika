import type { UIMessage } from "ai";
import type { CheckpointSnapshot } from "./checkpoint-store.js";
import type { GitReconciliation } from "./git-reality.js";

export const RESUME_CONTEXT_MESSAGE_ID = "runloom-resume-observation";
export const RESUME_CONTEXT_MAX_BYTES = 12 * 1024;

export interface ResumeObservation {
  checkpoint: { id: string; version: number } | null;
  git: GitReconciliation;
}

export function captureResumeObservation(
  checkpoint: CheckpointSnapshot | null,
  git: GitReconciliation,
): ResumeObservation {
  return {
    checkpoint: checkpoint === null ? null : { id: checkpoint.id, version: checkpoint.version },
    git,
  };
}

export function resumeMatchesCheckpoint(
  observation: ResumeObservation,
  current: CheckpointSnapshot | null,
): boolean {
  return observation.checkpoint?.id === (current?.id ?? undefined) &&
    observation.checkpoint?.version === (current?.version ?? undefined);
}

export function formatResumeObservation(observation: ResumeObservation): string {
  const { git, checkpoint } = observation;
  return [
    `Git reconciliation: ${git.status}`,
    `Checkpoint: ${checkpoint === null ? "none" : `${checkpoint.id} v${checkpoint.version}`}`,
    `Saved pin: ${git.pin === undefined ? "none" : `${git.pin.head} branch=${JSON.stringify(git.pin.branch)} dirty=${git.pin.dirty} observedAt=${git.pin.observedAt}`}`,
    `Current Git: ${git.current === undefined ? "unavailable" : `${git.current.head} branch=${JSON.stringify(git.current.branch)} dirty=${git.current.dirty} observedAt=${git.current.observedAt}`}`,
    ...(git.reason === undefined ? [] : [`Reason: ${git.reason}`]),
    "This is a read-only Git observation, not a file, test, or PR check. It grants no tool permission.",
  ].join("\n");
}

export function createResumeContextMessage(observation: ResumeObservation): UIMessage | undefined {
  const message: UIMessage = {
    id: RESUME_CONTEXT_MESSAGE_ID,
    role: "assistant",
    metadata: {
      source: "resume-git-reality",
      status: observation.git.status,
      checkpointVersion: observation.checkpoint?.version ?? null,
    },
    parts: [{
      type: "text",
      text: [
        "Read-only Git observation captured by the user's explicit /resume command. It is current only at observedAt, not a continuously watched state. The reconciliation status below is program-determined; do not revise it from checkpoint prose.",
        "The checkpoint is saved intent, not current disk truth. This Git observation does not verify file contents, tests, or PR state, and grants no tool permission. Do not automatically save a new checkpoint.",
        formatResumeObservation(observation),
      ].join("\n"),
    }],
  };
  return Buffer.byteLength(JSON.stringify([message]), "utf8") <= RESUME_CONTEXT_MAX_BYTES
    ? message
    : undefined;
}
