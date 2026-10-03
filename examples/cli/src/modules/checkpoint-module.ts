import { tool } from "ai";
import { z } from "zod";
import type { RegisteredTool } from "@aisdk-agent/ai-sdk-adapter";
import type { AgentModule } from "../module-host.js";
import {
  CHECKPOINT_LIMITS,
  CHECKPOINT_PREPARE_RESULT_MAX_BYTES,
  type CheckpointDraft,
  type CheckpointFailure,
  type CheckpointGitPin,
  type CheckpointSnapshot,
  type WorkspaceCheckpointStore,
} from "../checkpoint-store.js";
import { abortReason } from "../workspace-path.js";
import type { MemorySelection } from "../memory-retrieval.js";

export interface CheckpointMemoryView {
  id: string;
  text: string;
}

export interface CheckpointModuleOptions {
  threadId: string;
  getInjectableMemories?: (signal: AbortSignal) => Promise<CheckpointMemoryView[]>;
  getMemorySelection?: (signal: AbortSignal) => Promise<MemorySelection>;
  captureGitPin?: (signal: AbortSignal) => Promise<CheckpointGitPin | undefined>;
}

function utf8Text(maxBytes: number) {
  return z.string().min(1).superRefine((value, context) => {
    if (Buffer.byteLength(value, "utf8") > maxBytes) {
      context.addIssue({
        code: "custom",
        message: `exceeds the ${maxBytes}-byte UTF-8 limit`,
      });
    }
  });
}

const checkpointArtifactSchema = z.object({
  label: utf8Text(CHECKPOINT_LIMITS.artifactLabelBytes),
  path: utf8Text(CHECKPOINT_LIMITS.artifactPathBytes),
  note: utf8Text(CHECKPOINT_LIMITS.artifactNoteBytes).optional(),
}).strict();

const checkpointDraftSchema = z.object({
  status: z.enum(["active", "paused", "completed"]),
  goal: utf8Text(CHECKPOINT_LIMITS.goalBytes),
  currentPhase: utf8Text(CHECKPOINT_LIMITS.phaseBytes).optional(),
  summary: utf8Text(CHECKPOINT_LIMITS.summaryBytes),
  completed: z.array(utf8Text(CHECKPOINT_LIMITS.listItemBytes)),
  inProgress: z.array(utf8Text(CHECKPOINT_LIMITS.listItemBytes)),
  nextActions: z.array(utf8Text(CHECKPOINT_LIMITS.listItemBytes)),
  blockers: z.array(utf8Text(CHECKPOINT_LIMITS.listItemBytes)),
  artifacts: z.array(checkpointArtifactSchema).max(CHECKPOINT_LIMITS.artifactMaxEntries),
}).strict().superRefine((draft, context) => {
  if (draft.completed.length + draft.inProgress.length + draft.nextActions.length + draft.blockers.length > CHECKPOINT_LIMITS.listMaxItems) {
    context.addIssue({
      code: "custom",
      message: `The four checkpoint lists may contain at most ${CHECKPOINT_LIMITS.listMaxItems} items in total`,
      path: ["nextActions"],
    });
  }
});

const checkpointSnapshotSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  status: z.enum(["active", "paused", "completed"]),
  goal: z.string(),
  currentPhase: z.string().optional(),
  summary: z.string(),
  completed: z.array(z.string()),
  inProgress: z.array(z.string()),
  nextActions: z.array(z.string()),
  blockers: z.array(z.string()),
  artifacts: z.array(checkpointArtifactSchema),
  source: z.object({ threadId: z.string() }).strict(),
  createdAt: z.string(),
  updatedAt: z.string(),
  realityPins: z.object({
    git: z.object({
      head: z.string(),
      branch: z.string().nullable(),
      dirty: z.boolean(),
      observedAt: z.string(),
    }).strict(),
  }).strict().optional(),
}).strict();

const checkpointFailureSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }).strict(),
}).strict();

const checkpointCurrentOutputSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), checkpoint: checkpointSnapshotSchema.nullable() }).strict(),
  checkpointFailureSchema,
]);
const checkpointVersionOutputSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), checkpoint: checkpointSnapshotSchema }).strict(),
  checkpointFailureSchema,
]);
const checkpointPrepareOutputSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    current: checkpointSnapshotSchema.nullable(),
    memories: z.array(z.object({ id: z.string(), text: z.string() }).strict()),
    selection: z.object({
      bytes: z.number(), truncated: z.boolean(), queryTruncated: z.boolean(), eligibleCount: z.number(),
      selected: z.array(z.object({ id: z.string(), revision: z.number(), reason: z.enum(["pinned", "matched", "rewritten"]) }).strict()),
    }).strict().optional(),
  }).strict(),
  checkpointFailureSchema,
]);

const prepareInputSchema = z.object({}).strict();
const getInputSchema = z.object({ version: z.number().int().positive().optional() }).strict();
const saveInputSchema = z.object({
  expectedVersion: z.number().int().positive().nullable(),
  draft: checkpointDraftSchema,
}).strict();

const checkpointPrepareMetadata: RegisteredTool["metadata"] = {
  name: "checkpoint_prepare",
  version: "1",
  risk: "read",
  timeoutMs: 1_000,
  idempotent: true,
};
const checkpointGetMetadata: RegisteredTool["metadata"] = {
  name: "checkpoint_get",
  version: "1",
  risk: "read",
  timeoutMs: 1_000,
  idempotent: true,
};
const checkpointSaveMetadata: RegisteredTool["metadata"] = {
  name: "checkpoint_save",
  version: "1",
  risk: "write",
  timeoutMs: 5_000,
  idempotent: false,
};

const neverAborted = new AbortController().signal;

function prepareFailure(message: string): CheckpointFailure {
  return {
    ok: false,
    error: { code: "CHECKPOINT_READ_FAILED", message },
  };
}

function assertCurrentThread(threadId: string): void {
  if (threadId.trim().length === 0) {
    throw new Error("Checkpoint tools require the active TUI thread");
  }
}

export function createCheckpointModule(
  store: WorkspaceCheckpointStore,
  options: CheckpointModuleOptions,
): AgentModule {
  assertCurrentThread(options.threadId);
  return {
    id: "checkpoint",
    setup(context) {
      const prepareTool = tool({
        description:
          "Read the current checkpoint and a bounded pinned-only Memory selection (not the full store) to prepare an explicit user-requested checkpoint update. This tool does not inspect or summarize conversation messages and does not invoke a model. Use the current conversation already in context to draft fields for checkpoint_save. A successful read is included in this Run's model context and committed transcript.",
        inputSchema: prepareInputSchema,
        outputSchema: checkpointPrepareOutputSchema,
        execute: async (_input, { abortSignal }) => {
          const signal = abortSignal ?? neverAborted;
          const current = await store.getCurrent(signal);
          if (!current.ok) return current;
          let memories: CheckpointMemoryView[] = [];
          let selection: Omit<MemorySelection, "entries"> | undefined;
          if (options.getMemorySelection !== undefined || options.getInjectableMemories !== undefined) {
            try {
              if (options.getMemorySelection !== undefined) {
                const retrieved = await options.getMemorySelection(signal);
                memories = retrieved.entries.map(({ id, text }) => ({ id, text }));
                const { entries: _entries, ...metadata } = retrieved;
                selection = metadata;
              } else memories = await options.getInjectableMemories!(signal);
            } catch (error) {
              if (signal.aborted) throw abortReason(signal);
              return prepareFailure(error instanceof Error ? error.message : "Unable to read injectable memories");
            }
          }
          const prepared = { ok: true as const, current: current.current, memories, ...(selection === undefined ? {} : { selection }) };
          if (Buffer.byteLength(JSON.stringify(prepared), "utf8") > CHECKPOINT_PREPARE_RESULT_MAX_BYTES) {
            return {
              ok: false as const,
              error: {
                code: "CHECKPOINT_TOO_LARGE",
                message: `Checkpoint prepare result exceeds the ${CHECKPOINT_PREPARE_RESULT_MAX_BYTES}-byte limit`,
              },
            };
          }
          return prepared;
        },
      });

      const getTool = tool({
        description:
          "Read the current workspace checkpoint, or one retained version when version is supplied. This read requires the user's normal y/n confirmation and does not verify referenced files on disk.",
        inputSchema: getInputSchema,
        outputSchema: checkpointCurrentOutputSchema,
        execute: async ({ version }, { abortSignal }) => {
          const signal = abortSignal ?? neverAborted;
          if (version === undefined) {
            const result = await store.getCurrent(signal);
            if (!result.ok) return result;
            return { ok: true as const, checkpoint: result.current };
          }
          const result = await store.getVersion(version, signal);
          if (!result.ok) return result;
          return { ok: true as const, checkpoint: result.checkpoint };
        },
      });

      const saveTool = tool({
        description:
          "Save the user-confirmed project checkpoint draft as the next workspace version. Always include expectedVersion from checkpoint_prepare or checkpoint_get. The tool requires y/n confirmation showing that version and the complete draft. Do not call unless the user explicitly asked to save or update a checkpoint. The program supplies source thread, timestamps, and an optional observed Git pin; do not submit realityPins in the draft.",
        inputSchema: saveInputSchema,
        outputSchema: checkpointVersionOutputSchema,
        execute: async ({ expectedVersion, draft }, { abortSignal }) => {
          const signal = abortSignal ?? neverAborted;
          let gitPin: CheckpointGitPin | undefined;
          if (options.captureGitPin !== undefined) {
            try {
              gitPin = await options.captureGitPin(signal);
            } catch {
              if (signal.aborted) throw abortReason(signal);
            }
          }
          return store.saveNextVersion(
            {
              expectedVersion,
              draft: draft as CheckpointDraft,
              sourceThreadId: options.threadId,
              ...(gitPin === undefined ? {} : { realityPins: { git: gitPin } }),
            },
            signal,
          );
        },
      });

      context.registerTool({ metadata: checkpointPrepareMetadata, tool: prepareTool });
      context.registerTool({ metadata: checkpointGetMetadata, tool: getTool });
      context.registerTool({ metadata: checkpointSaveMetadata, tool: saveTool });
    },
  };
}
