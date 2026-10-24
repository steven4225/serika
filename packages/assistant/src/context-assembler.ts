import type { UIMessage } from "ai";
import { isAutoConsolidationRequest, withoutConsolidationTurns } from "./consolidation.js";
import { placeForegroundTaskReference } from "./foreground-autonomy.js";
import type { MemoryReferenceSnapshot, MemorySelection } from "./memory-snapshot.js";
import { MODEL_TIME_ZONE } from "./task-instructions.js";

/** Fixed slots precede conversation; all other slots travel with their user message. */
export const REFERENCE_SLOTS = [
  "task-time",
  "resume",
  "checkpoint",
  "memory",
  "learned-skills",
  "work-task",
  "memory-updates",
  "foreground-task",
] as const;
export type ReferenceSlot = typeof REFERENCE_SLOTS[number];

export interface ReferenceRequest {
  readonly messages: readonly UIMessage[];
  readonly signal: AbortSignal;
  /** The primary agent's own preparation, not a compaction/startup budget probe. */
  readonly primary: boolean;
  /** One clock reading shared by every source of this preparation. */
  readonly now: Date;
  readonly timeZone: string;
  /** Latest user message that is not an automatic consolidation request. */
  readonly user: UIMessage | undefined;
  /** Text of `user`, or an empty string. */
  readonly query: string;
}

export interface ReferenceContribution {
  readonly messages?: Partial<Record<ReferenceSlot, UIMessage | undefined>>;
  /** Only the memory source reports this; null means no reference was shown. */
  readonly memoryReference?: MemoryReferenceSnapshot | null;
}

export interface ReferenceSource {
  readonly name: string;
  /** Slots this source may fill. Each slot belongs to exactly one source. */
  readonly slots: readonly ReferenceSlot[];
  collect(request: ReferenceRequest): ReferenceContribution | Promise<ReferenceContribution>;
}

export interface ReferencePrefix {
  prefix: UIMessage[];
  memoryReference: MemoryReferenceSnapshot | null;
}

export type ReferenceAssembler = ((
  messages: readonly UIMessage[],
  signal: AbortSignal,
  primary?: boolean,
) => Promise<ReferencePrefix>) & {
  annotate(messages: readonly UIMessage[]): UIMessage[];
  restore(messages: readonly UIMessage[], snapshot?: readonly UIMessage[]): void;
  refresh(): () => void;
  invalidate(): void;
};

type MessageReferences = { contextReferences?: UIMessage[]; contextSnapshot?: UIMessage[] };
const metadata = (message: UIMessage): MessageReferences => (message.metadata ?? {}) as MessageReferences;
export function expandMessageReferences(messages: readonly UIMessage[], projectId?: string | null): UIMessage[] {
  const refreshedAt = messages.reduce((last, message, index) => metadata(message).contextSnapshot !== undefined ? index : last, -1);
  let sourceProject: unknown;
  return messages.flatMap((message, index) => {
    if (message.role === "user") sourceProject = (message.metadata as { memoryProjectId?: unknown } | undefined)?.memoryProjectId;
    const { contextReferences, contextSnapshot, ...rest } = metadata(message);
    const references = contextReferences?.filter(reference => (reference.id !== "memory-updates" || projectId === undefined || (reference.metadata as { memoryProjectId?: unknown } | undefined)?.memoryProjectId === projectId) && reference.id !== "runloom-foreground-task" &&
      (reference.id !== "memory-updates" || index > refreshedAt));
    const parts = projectId === undefined || sourceProject === projectId ? message.parts : message.parts.filter(part => {
      const name = part.type === "dynamic-tool" ? part.toolName : part.type.startsWith("tool-") ? part.type.slice(5) : undefined;
      return name !== "memory_read" && name !== "memory_write";
    });
    if (parts.length !== message.parts.length && !parts.some(part => part.type !== "step-start")) return [];
    const projected = contextReferences || contextSnapshot || parts !== message.parts ? { ...message, parts, metadata: rest } : message;
    return [!references?.length ? projected : { ...projected, parts: [...parts, { type: "text" as const,
      text: "Host context captured with this message:\n" + references.flatMap(reference => reference.parts.flatMap(part => part.type === "text" ? [part.text] : [])).join("\n") }] }];
  });
}

/**
 * Builds the reference prefix from sources.
 * - Sources are collected one after another in the given order (their reads and
 *   model calls keep that order); the prefix is emitted in `REFERENCE_SLOTS` order.
 * - A source that throws fails the whole preparation; nothing is skipped.
 * - A slot claimed by two sources, or filled by a source that did not claim it,
 *   is an assembly error.
 */
export function createReferenceAssembler(sources: readonly ReferenceSource[], projectId?: string | null): ReferenceAssembler {
  const owners = new Map<ReferenceSlot, string>();
  for (const source of sources) {
    for (const slot of source.slots) {
      const owner = owners.get(slot);
      if (owner !== undefined) throw new Error(`Context sources ${owner} and ${source.name} both claim ${slot}`);
      owners.set(slot, source.name);
    }
  }
  let fixed: UIMessage[] | undefined;
  let changed = true;
  let observedSelection: MemorySelection | undefined;
  const captured = new Map<string, MessageReferences>();
  const fixedSlot = (slot: ReferenceSlot) => slot === "memory" || slot === "learned-skills";
  const annotate = (messages: readonly UIMessage[]) => messages.map(message => captured.has(message.id)
    ? { ...message, metadata: { ...message.metadata as object, ...captured.get(message.id) } } : message);
  const assemble = async (messages: readonly UIMessage[], signal: AbortSignal, primary = false): Promise<ReferencePrefix> => {
    const now = new Date();
    const timeZone = MODEL_TIME_ZONE;
    const user = [...messages].reverse().find(message => message.role === "user" && !isAutoConsolidationRequest(message));
    const query = user?.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") ?? "";
    const request: ReferenceRequest = { messages, signal, primary, now, timeZone, user, query };
    const filled = new Map<ReferenceSlot, UIMessage>();
    let memoryReference: MemoryReferenceSnapshot | null = null;
    for (const source of sources) {
      if (fixed && source.slots.every(slot => fixedSlot(slot)) &&
        (source.name !== "memory" || !primary || !user || captured.has(user.id) || metadata(user).contextReferences)) continue;
      const contribution = await source.collect(request);
      for (const [slot, message] of Object.entries(contribution.messages ?? {}) as Array<[ReferenceSlot, UIMessage | undefined]>) {
        if (owners.get(slot) !== source.name) throw new Error(`Context source ${source.name} filled unclaimed ${slot}`);
        if (message !== undefined) filled.set(slot, message);
      }
      if (contribution.memoryReference !== undefined) memoryReference = contribution.memoryReference;
    }
    const freshMemory = filled.get("memory");
    if (freshMemory) observedSelection = (freshMemory.metadata as { selection: MemorySelection }).selection;
    const oldMemory = fixed?.find(message => message.id === "runloom-workspace-memory");
    if (freshMemory && oldMemory) {
      const entries = (message: UIMessage) => (message.metadata as { selection: MemorySelection }).selection.entries;
      const old = entries(oldMemory), fresh = entries(freshMemory);
      const previous = annotate(messages).flatMap(message => metadata(message).contextReferences ?? [])
        .filter(reference => reference.id === "memory-updates")
        .map(reference => (reference.metadata ?? {}) as { memoryEntryIds?: string[]; documentIndexChanged?: boolean });
      const invalidated = [...old.filter(entry => !fresh.some(value => value.id === entry.id && value.revision === entry.revision)).map(entry => entry.id),
        ...previous.flatMap(update => update.memoryEntryIds ?? []).filter(id => !fresh.some(entry => entry.id === id))];
      const updates = { invalidated: [...new Set(invalidated)],
        current: fresh.filter(entry => !old.some(value => value.id === entry.id && value.revision === entry.revision)),
        ...(JSON.stringify(oldMemory.parts[1]) === JSON.stringify(freshMemory.parts[1]) && !previous.some(update => update.documentIndexChanged) ? {} : { documentIndex: freshMemory.parts[1] }) };
      if (updates.invalidated.length || updates.current.length || updates.documentIndex) filled.set("memory-updates", {
        id: "memory-updates", role: "assistant", metadata: { memoryProjectId: projectId ?? null, memoryEntryIds: updates.current.map(entry => entry.id), documentIndexChanged: !!updates.documentIndex },
        parts: [{ type: "text", text: "Memory updates supersede the fixed snapshot:\n" + JSON.stringify(updates) }] });
    }
    fixed ??= REFERENCE_SLOTS.filter(fixedSlot).flatMap(slot => filled.has(slot) ? [filled.get(slot)!] : []);
    if (primary && user && !metadata(user).contextReferences && !captured.has(user.id)) {
      captured.set(user.id, { contextReferences: REFERENCE_SLOTS.filter(slot => !fixedSlot(slot)).flatMap(slot => filled.has(slot) ? [filled.get(slot)!] : []),
        ...(changed ? { contextSnapshot: fixed } : {}) });
      changed = false;
    } else if (primary && user && changed && captured.has(user.id)) {
      captured.get(user.id)!.contextSnapshot = fixed; changed = false;
    }
    const memory = fixed.find(message => message.id === "runloom-workspace-memory");
    const selection = (memory?.metadata as { selection?: MemorySelection } | undefined)?.selection;
    const currentSelection = observedSelection ?? selection;
    if (primary && user && currentSelection) memoryReference = { ...currentSelection, messageId: user.id, preparedAt: now.toISOString(),
      referenceBytes: Buffer.byteLength(JSON.stringify(memory)), selected: currentSelection.selected.map(item => ({ ...item, text: currentSelection.entries.find(entry => entry.id === item.id)!.text })) };
    return { prefix: fixed, memoryReference };
  };
  return Object.assign(assemble, { annotate, invalidate: () => { fixed = undefined; changed = true; observedSelection = undefined; captured.clear(); }, refresh: () => {
    const before = { fixed, changed, observedSelection, captured: structuredClone(captured) };
    fixed = undefined; changed = true; observedSelection = undefined;
    return () => { ({ fixed, changed, observedSelection } = before); captured.clear(); for (const [id, value] of before.captured) captured.set(id, value); };
  },
    restore: (messages: readonly UIMessage[], snapshot?: readonly UIMessage[]) => {
      const saved = [...messages].reverse().find(message => metadata(message).contextSnapshot)?.metadata as MessageReferences | undefined;
      const restored = snapshot ?? saved?.contextSnapshot;
      const memory = restored?.find(message => message.id === "runloom-workspace-memory");
      if (restored && (projectId === undefined || memory && (memory.metadata as { memoryProjectId?: unknown } | undefined)?.memoryProjectId === projectId)) { fixed = structuredClone([...restored]); changed = false; }
    } });
}

/** The current invocation only: from the last user message with this metadata source. */
export function latestInvocation(messages: readonly UIMessage[], source: string): UIMessage[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "user" && typeof message.metadata === "object" && message.metadata !== null &&
      "source" in message.metadata && message.metadata.source === source) return messages.slice(index);
  }
  return [];
}

export interface PrimaryContextObserver {
  /** References were built and no compactor is configured. */
  passthrough(): void;
  /** Building references (or the uncompacted selection) failed. */
  referencesFailed(error: unknown): void;
  /** Compaction failed after references were built. */
  compactionFailed(error: unknown): void;
  /** The memory reference actually shown to this preparation. */
  published(reference: MemoryReferenceSnapshot | null): void;
}

export interface PrimaryContextCompactor {
  prepare(messages: UIMessage[], signal: AbortSignal, force: boolean, referencePrefix?: readonly UIMessage[]): Promise<UIMessage[]>;
  readonly effectiveReferencePrefix: readonly UIMessage[];
}

/**
 * The compactor owns summary selection; the assembler freezes references and
 * expands only the model view, leaving committed message parts unchanged.
 * Every failure is reported to the observer and rethrown.
 */
export async function preparePrimaryContext(input: {
  messages: UIMessage[];
  signal: AbortSignal;
  currentUserId: string | undefined;
  references: ReferenceAssembler;
  compactor: PrimaryContextCompactor | undefined;
  observer: PrimaryContextObserver;
  projectId?: string | null;
}): Promise<UIMessage[]> {
  const { messages, signal, currentUserId, compactor, observer } = input;
  let prepared: ReferencePrefix;
  const foreground = () => input.references.annotate(messages).filter(message => message.id === currentUserId).flatMap(message => metadata(message).contextReferences ?? [])
    .filter(reference => reference.id === "runloom-foreground-task").at(-1);
  const placeForeground = (conversation: UIMessage[]) => {
    const reference = foreground();
    return placeForegroundTaskReference(reference ? [...conversation, reference] : conversation);
  };
  try {
    prepared = await input.references(messages, signal, true);
    if (compactor === undefined) {
      const selected = [...prepared.prefix, ...expandMessageReferences(withoutConsolidationTurns(input.references.annotate(messages)), input.projectId)];
      observer.passthrough();
      observer.published(prepared.memoryReference);
      return placeForeground(selected);
    }
  } catch (error) {
    observer.referencesFailed(error);
    throw error;
  }
  try {
    const conversation = await compactor.prepare(input.references.annotate(messages), signal, false, prepared.prefix);
    observer.published((await input.references(messages, signal, true)).memoryReference);
    return placeForeground([...compactor.effectiveReferencePrefix, ...expandMessageReferences(conversation, input.projectId)]);
  } catch (error) {
    observer.referencesFailed(error);
    observer.compactionFailed(error);
    throw error;
  }
}

export interface ModelContextRoutes {
  readonly primaryAgentId: string;
  readonly dreamingAgentId: string;
  readonly consolidationAgentId: string;
  isTextSkill(agentId: string): boolean;
  primary(messages: UIMessage[], signal: AbortSignal): Promise<UIMessage[]>;
}

/**
 * Chooses what each agent sees:
 * - dreaming: only its latest reflection batch (never older batches of its Thread);
 * - text Skill: only its current invocation, no conversation/Memory/checkpoint;
 * - automatic consolidation: only the current user message (the host already
 *   supplied exact sources; no other chat, summary or tool result is an input);
 * - other agents: their complete host-supplied messages;
 * - primary: `routes.primary`.
 */
export function routeModelContext(
  routes: ModelContextRoutes,
  input: { messages: UIMessage[]; signal: AbortSignal; agentId: string },
): UIMessage[] | Promise<UIMessage[]> {
  const { messages, agentId } = input;
  if (agentId === routes.dreamingAgentId) return latestInvocation(messages, "dreaming");
  if (routes.isTextSkill(agentId)) return latestInvocation(messages, "automation-skill");
  if (agentId === routes.consolidationAgentId) {
    const current = [...messages].reverse().find(message => message.role === "user");
    return current ? [current] : [];
  }
  if (agentId !== routes.primaryAgentId) return messages;
  return routes.primary(messages, input.signal);
}
