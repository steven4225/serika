import type { UIMessage } from "ai";

export const MAX_CONSOLIDATION_TURNS = 8;
export const AUTO_CONSOLIDATION_SOURCE = "auto-consolidation";
export const AUTO_CONSOLIDATION_AGENT_ID = "memory-consolidator";
export const MAX_CONSOLIDATION_TOOL_EVIDENCE_BYTES = 4 * 1024;

/** A program-owned per-message opt-out, never a model interpretation of prose. */
export function isMemoryConsolidationExcluded(message: UIMessage): boolean {
  return message.role === "user" && typeof message.metadata === "object" && message.metadata !== null &&
    "memoryConsolidation" in message.metadata && message.metadata.memoryConsolidation === "exclude";
}

export function isAutoConsolidationRequest(message: UIMessage): boolean {
  if (
    message.role !== "user" ||
    typeof message.metadata !== "object" ||
    message.metadata === null
  ) {
    return false;
  }

  return (
    "source" in message.metadata &&
    message.metadata.source === AUTO_CONSOLIDATION_SOURCE
  );
}

export interface ConsolidationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface ConsolidationTurn {
  messages: ConsolidationMessage[];
}

export interface IncrementalConsolidationToolEvidence {
  toolCallId: string;
  toolName: string;
  outcome: "success" | "failed" | "denied";
  content: string;
  truncated: boolean;
}

export interface IncrementalConsolidationTurn {
  user: {
    messageId: string;
    text: string;
  };
  assistant: Array<{
    messageId: string;
    text: string;
  }>;
  tools: IncrementalConsolidationToolEvidence[];
}

export interface IncrementalConsolidationSelection {
  ok: true;
  turns: IncrementalConsolidationTurn[];
  bootstrap: boolean;
}

export interface ConsolidationSuccess {
  ok: true;
  turns: ConsolidationTurn[];
}

export interface ConsolidationFailure {
  ok: false;
  error: {
    code: "INVALID_INPUT";
    message: string;
  };
}

export type ConsolidationResult = ConsolidationSuccess | ConsolidationFailure;

function invalidInput(message: string): ConsolidationFailure {
  return { ok: false, error: { code: "INVALID_INPUT", message } };
}

function textOf(message: UIMessage): string | undefined {
  const text = message.parts
    .filter((part): part is Extract<UIMessage["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return text.trim().length === 0 ? undefined : text;
}

/**
 * True when quote is a non-blank exact substring of the user message text.
 * Matching does not trim, collapse whitespace, or otherwise normalize either side.
 */
export function isExactUserQuote(text: string, quote: string): boolean {
  return quote.trim().length > 0 && text.includes(quote);
}

/** Resolve provenance only from one committed, ordinary user message. */
export function findCommittedUserMessage(
  committedMessages: readonly UIMessage[],
  messageId: string,
): ConsolidationMessage | undefined {
  if (messageId.length === 0) return undefined;
  let found: ConsolidationMessage | undefined;
  for (const message of committedMessages) {
    if (message.id !== messageId) continue;
    if (found !== undefined || message.role !== "user" || isAutoConsolidationRequest(message) || isMemoryConsolidationExcluded(message)) {
      return undefined;
    }
    found = messageOf(message);
    if (found === undefined) return undefined;
  }
  return found;
}

function messageOf(message: UIMessage): ConsolidationMessage | undefined {
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  const text = textOf(message);
  return text === undefined ? undefined : { id: message.id, role: message.role, text };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toolPart(part: UIMessage["parts"][number]): Record<string, unknown> | undefined {
  const candidate = part as unknown as Record<string, unknown>;
  if (
    typeof candidate.toolCallId !== "string" ||
    typeof candidate.state !== "string"
  ) {
    return undefined;
  }
  const toolName = candidate.type === "dynamic-tool"
    ? candidate.toolName
    : typeof candidate.type === "string" && candidate.type.startsWith("tool-")
      ? candidate.type.slice("tool-".length)
      : undefined;
  return typeof toolName === "string" && toolName.length > 0
    ? { ...candidate, toolName }
    : undefined;
}

export function hasMemoryTool(turn: readonly UIMessage[]): boolean {
  return turn.some((message) => message.parts.some((part) => {
    const selected = toolPart(part);
    return selected !== undefined &&
      typeof selected.toolName === "string" &&
      selected.toolName.startsWith("memory_");
  }));
}

function isSuccessfulAutoConsolidationTurn(turn: readonly UIMessage[]): boolean {
  if (!isAutoConsolidationRequest(turn[0]!)) return false;
  const calls = turn.slice(1).flatMap((message) => message.role === "assistant"
    ? message.parts.flatMap((part) => {
        const selected = toolPart(part);
        return selected?.toolName === "memory_prepare_consolidation" ? [selected] : [];
      })
    : []);
  const call = calls[0];
  return calls.length === 1 && call !== undefined &&
    call.state === "output-available" &&
    record(call.output) &&
    call.output.ok === true;
}

function serializedToolContent(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncateUtf8(value: string): { content: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= MAX_CONSOLIDATION_TOOL_EVIDENCE_BYTES) {
    return { content: value, truncated: false };
  }
  let content = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > MAX_CONSOLIDATION_TOOL_EVIDENCE_BYTES) break;
    content += character;
    bytes += characterBytes;
  }
  return { content, truncated: true };
}

function evidenceOf(part: UIMessage["parts"][number]): IncrementalConsolidationToolEvidence | undefined {
  const selected = toolPart(part);
  if (selected === undefined) return undefined;
  const { state, toolCallId, toolName } = selected;
  let outcome: IncrementalConsolidationToolEvidence["outcome"];
  let rawContent: unknown;
  if (state === "output-available") {
    rawContent = selected.output;
    outcome = record(rawContent) && rawContent.ok === false ? "failed" : "success";
  } else if (state === "output-error") {
    rawContent = selected.errorText;
    outcome = typeof rawContent === "string" && rawContent.startsWith("TOOL_DENIED")
      ? "denied"
      : "failed";
  } else if (state === "output-denied") {
    rawContent = selected.errorText ?? "Tool call denied";
    outcome = "denied";
  } else {
    return undefined;
  }
  const { content, truncated } = truncateUtf8(serializedToolContent(rawContent));
  return {
    toolCallId: toolCallId as string,
    toolName: toolName as string,
    outcome,
    content,
    truncated,
  };
}

export function userStartedTurns(committedMessages: readonly UIMessage[]): UIMessage[][] {
  const turns: UIMessage[][] = [];
  let current: UIMessage[] | undefined;
  for (const message of committedMessages) {
    if (message.role === "user") {
      if (current !== undefined) turns.push(current);
      current = [message];
    } else if (current !== undefined) {
      current.push(message);
    }
  }
  if (current !== undefined) turns.push(current);
  return turns;
}

/**
 * Select ordinary turns not yet covered by a committed auto-consolidation turn
 * with exactly one successful preparation result.
 * Without such a marker, only the latest eight eligible turns are bootstrapped.
 * Assistant and tool text are evidence only; provenance remains bound to the
 * ordinary user message through findCommittedUserMessage/isExactUserQuote.
 */
export function selectIncrementalConsolidationTurns(
  committedMessages: readonly UIMessage[],
): IncrementalConsolidationSelection {
  const turns = userStartedTurns(committedMessages);
  let lastMarker = -1;
  for (let index = 0; index < turns.length; index += 1) {
    if (isSuccessfulAutoConsolidationTurn(turns[index]!)) lastMarker = index;
  }
  const bootstrap = lastMarker === -1;
  const eligible = turns
    .slice(lastMarker + 1)
    .filter((turn) => !isAutoConsolidationRequest(turn[0]!) && !isMemoryConsolidationExcluded(turn[0]!) && !hasMemoryTool(turn));
  const selected = bootstrap ? eligible.slice(-MAX_CONSOLIDATION_TURNS) : eligible;
  return {
    ok: true,
    bootstrap,
    turns: selected.flatMap((turn) => {
      const userMessage = messageOf(turn[0]!);
      if (userMessage?.role !== "user") return [];
      return [{
        user: { messageId: userMessage.id, text: userMessage.text },
        assistant: turn.flatMap((message) => {
          if (message.role !== "assistant") return [];
          const selectedMessage = messageOf(message);
          return selectedMessage?.role === "assistant"
            ? [{ messageId: selectedMessage.id, text: selectedMessage.text }]
            : [];
        }),
        tools: turn.flatMap((message) => message.parts.flatMap((part) => {
          const evidence = evidenceOf(part);
          return evidence === undefined ? [] : [evidence];
        })),
      }];
    }),
  };
}

/**
 * Select recent complete user-started turns from a committed transcript.
 * Only ordinary user text is returned. Assistant replies, tool results, and
 * auto-consolidation turns are omitted, and prefix messages before the first
 * user message are not a consolidation turn.
 */
export function consolidateMessages(
  committedMessages: readonly UIMessage[],
  turns: number = MAX_CONSOLIDATION_TURNS,
): ConsolidationResult {
  if (!Number.isInteger(turns) || turns < 1 || turns > MAX_CONSOLIDATION_TURNS) {
    return invalidInput(`turns must be an integer from 1 to ${MAX_CONSOLIDATION_TURNS}`);
  }

  const completeTurns = userStartedTurns(committedMessages);

  const eligibleTurns = completeTurns.filter(
    (turn) => !isAutoConsolidationRequest(turn[0]!) && !isMemoryConsolidationExcluded(turn[0]!),
  );

  return {
    ok: true,
    turns: eligibleTurns.slice(-turns).flatMap((turn) => {
      const messages = turn.flatMap((message) => {
        if (message.role !== "user" || isAutoConsolidationRequest(message)) return [];
        const selected = messageOf(message);
        return selected?.role === "user" ? [selected] : [];
      });
      return messages.length === 0 ? [] : [{ messages }];
    }),
  };
}
