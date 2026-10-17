import type { UIMessage } from "ai";
import { isAutoConsolidationRequest, withoutConsolidationTurns } from "./consolidation.js";
import { selectModelContext } from "./context-window.js";
import { placeForegroundTaskReference } from "./foreground-autonomy.js";
import type { MemoryReferenceSnapshot } from "./memory-query-rewrite.js";
import { placeCurrentMemoryReference } from "./memory-retrieval.js";

/**
 * Host reference messages placed before the conversation, in this order.
 * The order is part of current behavior; reordering for a stable prefix is step 4.
 */
export const REFERENCE_SLOTS = [
  "task-time",
  "resume",
  "checkpoint",
  "memory",
  "memory-context-view",
  "learned-skills",
  "work-task",
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

export type ReferenceAssembler = (
  messages: readonly UIMessage[],
  signal: AbortSignal,
  primary?: boolean,
) => Promise<ReferencePrefix>;

/**
 * Builds the reference prefix from sources.
 * - Sources are collected one after another in the given order (their reads and
 *   model calls keep that order); the prefix is emitted in `REFERENCE_SLOTS` order.
 * - A source that throws fails the whole preparation; nothing is skipped.
 * - A slot claimed by two sources, or filled by a source that did not claim it,
 *   is an assembly error.
 */
export function createReferenceAssembler(sources: readonly ReferenceSource[]): ReferenceAssembler {
  const owners = new Map<ReferenceSlot, string>();
  for (const source of sources) {
    for (const slot of source.slots) {
      const owner = owners.get(slot);
      if (owner !== undefined) throw new Error(`Context sources ${owner} and ${source.name} both claim ${slot}`);
      owners.set(slot, source.name);
    }
  }
  return async (messages, signal, primary = false) => {
    const now = new Date();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const user = [...messages].reverse().find(message => message.role === "user" && !isAutoConsolidationRequest(message));
    const query = user?.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") ?? "";
    const request: ReferenceRequest = { messages, signal, primary, now, timeZone, user, query };
    const filled = new Map<ReferenceSlot, UIMessage>();
    let memoryReference: MemoryReferenceSnapshot | null = null;
    for (const source of sources) {
      const contribution = await source.collect(request);
      for (const [slot, message] of Object.entries(contribution.messages ?? {}) as Array<[ReferenceSlot, UIMessage | undefined]>) {
        if (owners.get(slot) !== source.name) throw new Error(`Context source ${source.name} filled unclaimed ${slot}`);
        if (message !== undefined) filled.set(slot, message);
      }
      if (contribution.memoryReference !== undefined) memoryReference = contribution.memoryReference;
    }
    return { prefix: REFERENCE_SLOTS.flatMap(slot => filled.has(slot) ? [filled.get(slot)!] : []), memoryReference };
  };
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
 * Primary agent: reference prefix, then either the eight-turn selection or the
 * compactor, then the two placement rules (current memory reference before the
 * current user message; foreground task reference only when its request was dropped).
 * Every failure is reported to the observer and rethrown.
 */
export async function preparePrimaryContext(input: {
  messages: UIMessage[];
  signal: AbortSignal;
  currentUserId: string | undefined;
  references: ReferenceAssembler;
  compactor: PrimaryContextCompactor | undefined;
  observer: PrimaryContextObserver;
}): Promise<UIMessage[]> {
  const { messages, signal, currentUserId, compactor, observer } = input;
  let prepared: ReferencePrefix;
  try {
    prepared = await input.references(messages, signal, true);
    if (compactor === undefined) {
      const selected = selectModelContext(withoutConsolidationTurns(messages), [], {}, undefined, undefined, prepared.prefix);
      observer.passthrough();
      observer.published(prepared.memoryReference);
      return placeForegroundTaskReference(placeCurrentMemoryReference(selected, currentUserId));
    }
  } catch (error) {
    observer.referencesFailed(error);
    throw error;
  }
  try {
    const conversation = await compactor.prepare(messages, signal, false, prepared.prefix);
    observer.published(prepared.memoryReference);
    return placeForegroundTaskReference(placeCurrentMemoryReference([...compactor.effectiveReferencePrefix, ...conversation], currentUserId));
  } catch (error) {
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
 * - other agents: the eight-turn selection;
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
  if (agentId !== routes.primaryAgentId) return selectModelContext(messages);
  return routes.primary(messages, input.signal);
}
