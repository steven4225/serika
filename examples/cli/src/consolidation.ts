import type { UIMessage } from "ai";

export const MAX_CONSOLIDATION_TURNS = 8;
export const AUTO_CONSOLIDATION_SOURCE = "auto-consolidation";

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
    if (found !== undefined || message.role !== "user" || isAutoConsolidationRequest(message)) {
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

  const completeTurns: UIMessage[][] = [];
  let currentTurn: UIMessage[] | undefined;
  for (const message of committedMessages) {
    if (message.role === "user") {
      if (currentTurn !== undefined) completeTurns.push(currentTurn);
      currentTurn = [message];
      continue;
    }
    if (currentTurn !== undefined) currentTurn.push(message);
  }
  if (currentTurn !== undefined) completeTurns.push(currentTurn);

  const eligibleTurns = completeTurns.filter(
    (turn) => !isAutoConsolidationRequest(turn[0]!),
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
