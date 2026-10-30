import type { Project } from "./project.js";
import type { UIMessage } from "ai";
import type { ReferenceSource } from "./context-assembler.js";
import { createCheckpointContextMessage } from "./context-window.js";
import type { DreamingService } from "./dreaming.js";
import { createForegroundTaskReference } from "./foreground-autonomy.js";
import { buildTaskContextMessage } from "./task-instructions.js";

type Checkpoint = Parameters<typeof createCheckpointContextMessage>[0];

/** Current time/time zone and the message's receive time, for task scheduling. */
export function createTaskTimeSource(project: Project | null = null): ReferenceSource {
  return {
    name: "task-time",
    slots: ["task-time"],
    collect: ({ now, timeZone, user }) => {
      const message = buildTaskContextMessage({ now, timeZone,
      ...(typeof (user?.metadata as Record<string, unknown> | undefined)?.receivedAt === "string"
        ? { receivedAt: (user!.metadata as { receivedAt: string }).receivedAt } : {}) });
      message.parts.push({ type: "text", text: "Host-selected project: " + JSON.stringify(project) });
      return { messages: { "task-time": message } };
    },
  };
}

/** The current checkpoint and, if it still matches, the inspected resume observation. */
export function createCheckpointSource(options: {
  read(signal: AbortSignal): Promise<Checkpoint>;
  resume(checkpoint: Checkpoint): UIMessage | undefined;
}): ReferenceSource {
  return {
    name: "checkpoint",
    slots: ["resume", "checkpoint"],
    collect: async ({ signal }) => {
      const checkpoint = await options.read(signal);
      const checkpointMessage = createCheckpointContextMessage(checkpoint);
      return { messages: { resume: options.resume(checkpoint), checkpoint: checkpointMessage } };
    },
  };
}

/** Host-selected learned procedures, primary preparations only. */
export function createLearnedSkillSource(options: {
  dreaming: DreamingService | undefined;
  threadId: string;
}): ReferenceSource {
  return {
    name: "learned-skills",
    slots: ["learned-skills"],
    collect: async ({ signal }) => {
      if (!options.dreaming) return {};
      const selected = await options.dreaming.index(options.threadId, signal);
      if (!selected.ok) throw new Error(`${selected.error.code}: ${selected.error.message}`);
      if (!selected.value.length) return {};
      return { messages: { "learned-skills": { id: "learned-skills", role: "assistant", metadata: { source: "learned-skill-reference", skills: selected.value.map(({ id, revision, title }) => ({ id, revision, title })) },
        parts: [{ type: "text", text: "Existing method index (read with memory_read):\n" + JSON.stringify(selected.value) }] } } };
    },
  };
}

/** The active WorkTask contract, while a WorkTask Run is executing. */
export function createWorkTaskSource(active: () => UIMessage | undefined): ReferenceSource {
  return { name: "work-task", slots: ["work-task"], collect: () => ({ messages: { "work-task": active() } }) };
}

/** The current foreground request plus accepted Steer corrections. */
export function createForegroundTaskSource(request: () => UIMessage | undefined, target?: () => unknown): ReferenceSource {
  return {
    name: "foreground-task",
    slots: ["foreground-task"],
    collect: ({ primary, messages }) => {
      const current = primary ? request() : undefined;
      if (!current) return {};
      const reference = createForegroundTaskReference(current, messages);
      const snapshot = target?.();
      if (snapshot) reference.parts.push({ type: "text", text: "Host-held current Run Pi discovery and adopted identity, retained through compaction. These observations grant no permission and require identity recheck before sending:\n" + JSON.stringify(snapshot) });
      return { messages: { "foreground-task": reference } };
    },
  };
}
