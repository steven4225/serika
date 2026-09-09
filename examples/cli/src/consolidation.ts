import type { UIMessage } from "ai";

export const MAX_CONSOLIDATION_TURNS = 8;

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

function messageOf(message: UIMessage): ConsolidationMessage | undefined {
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  const text = textOf(message);
  return text === undefined ? undefined : { id: message.id, role: message.role, text };
}

/**
 * Select recent complete user-started turns from a committed transcript.
 * Prefix messages before the first user message are not a consolidation turn.
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

  return {
    ok: true,
    turns: completeTurns.slice(-turns).flatMap((turn) => {
      const messages = turn.flatMap((message) => {
        const selected = messageOf(message);
        return selected === undefined ? [] : [selected];
      });
      return messages.length === 0 ? [] : [{ messages }];
    }),
  };
}
