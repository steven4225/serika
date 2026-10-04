import type { UIMessage } from "ai";

/**
 * The process-local work summary used when older completed turns are removed
 * from the model context. The transcript remains the source of truth; this is
 * only a bounded derived value for the current process.
 */
export const WORK_SUMMARY_VERSION = 1 as const;
export const WORK_SUMMARY_MAX_BYTES = 16_384;

export interface WorkSummaryCoverage {
  /** Stable transcript id of the last message represented by the summary. */
  messageId: string;
  /** Zero-based position in the transcript. */
  messageIndex: number;
  /** Zero-based turn containing `messageId`. */
  turn: number;
}

export interface WorkSummaryItem {
  text: string;
  /** Transcript message ids that support this statement. */
  evidenceMessageIds: string[];
}

export interface WorkSummary {
  version: typeof WORK_SUMMARY_VERSION;
  coveredThrough: WorkSummaryCoverage;
  goal: string;
  constraints: string[];
  completed: WorkSummaryItem[];
  unresolved: string[];
  failures: WorkSummaryItem[];
  unknowns: WorkSummaryItem[];
  nextStep: string | null;
}

export type WorkSummaryValidationCode =
  | "NOT_OBJECT"
  | "UNSUPPORTED_VERSION"
  | "INVALID_COVERAGE"
  | "EMPTY_TEXT"
  | "INVALID_LIST"
  | "INVALID_ITEM"
  | "COVERAGE_NOT_MONOTONIC"
  | "SUMMARY_TOO_LARGE";

export type WorkSummaryValidation =
  | { ok: true; bytes: number }
  | { ok: false; code: WorkSummaryValidationCode; message: string; bytes?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => isNonEmptyString(item))
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isCoverage(value: unknown): value is WorkSummaryCoverage {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.messageId) &&
    isNonNegativeSafeInteger(value.messageIndex) &&
    isNonNegativeSafeInteger(value.turn)
  );
}

function isEvidenceList(value: unknown): value is string[] {
  if (!isStringList(value)) return false;
  return value.length > 0 && new Set(value).size === value.length;
}

function isSummaryItem(value: unknown): value is WorkSummaryItem {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.text) && isEvidenceList(value.evidenceMessageIds);
}

function bytes(value: unknown): number | undefined {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined
      ? undefined
      : Buffer.byteLength(encoded, "utf8");
  } catch {
    return undefined;
  }
}

function invalid(
  code: WorkSummaryValidationCode,
  message: string,
  summaryBytes?: number,
): WorkSummaryValidation {
  return summaryBytes === undefined
    ? { ok: false, code, message }
    : { ok: false, code, message, bytes: summaryBytes };
}

/**
 * Validate an untrusted summary before it is installed in the model context.
 * No state is changed and the optional previous summary is only used to reject
 * moving the covered transcript position backwards.
 */
export function validateWorkSummary(
  value: unknown,
  previous?: Pick<WorkSummary, "coveredThrough">,
  maxBytes = WORK_SUMMARY_MAX_BYTES,
): WorkSummaryValidation {
  if (!isRecord(value)) return invalid("NOT_OBJECT", "Work summary must be an object");
  if (value.version !== WORK_SUMMARY_VERSION) {
    return invalid("UNSUPPORTED_VERSION", "Unsupported work summary version");
  }
  if (!isCoverage(value.coveredThrough)) {
    return invalid("INVALID_COVERAGE", "Summary coverage must identify a message and turn");
  }

  if (
    previous !== undefined &&
    (value.coveredThrough.turn < previous.coveredThrough.turn ||
      value.coveredThrough.messageIndex < previous.coveredThrough.messageIndex ||
      (value.coveredThrough.messageIndex === previous.coveredThrough.messageIndex &&
        value.coveredThrough.messageId !== previous.coveredThrough.messageId))
  ) {
    return invalid(
      "COVERAGE_NOT_MONOTONIC",
      "Summary coverage cannot move backwards or change the message at the same position",
    );
  }

  if (!isNonEmptyString(value.goal)) {
    return invalid("EMPTY_TEXT", "Summary goal must not be empty");
  }

  if (!isStringList(value.constraints) || !isStringList(value.unresolved)) {
    return invalid("INVALID_LIST", "Constraints and unresolved items must be string lists");
  }

  if (
    !Array.isArray(value.completed) ||
    !value.completed.every((item) => isSummaryItem(item)) ||
    !Array.isArray(value.failures) ||
    !value.failures.every((item) => isSummaryItem(item)) ||
    !Array.isArray(value.unknowns) ||
    !value.unknowns.every((item) => isSummaryItem(item))
  ) {
    return invalid("INVALID_ITEM", "Summary action lists must contain text and evidence");
  }

  if (value.nextStep !== null && !isNonEmptyString(value.nextStep)) {
    return invalid("EMPTY_TEXT", "Summary nextStep must be non-empty or null");
  }

  const summaryBytes = bytes(value);
  if (summaryBytes === undefined) {
    return invalid("NOT_OBJECT", "Work summary must be JSON serializable");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  if (summaryBytes > maxBytes) {
    return invalid(
      "SUMMARY_TOO_LARGE",
      `Work summary exceeds the ${maxBytes}-byte limit`,
      summaryBytes,
    );
  }

  return { ok: true, bytes: summaryBytes };
}

/** Return the UTF-8 size of a summary without mutating it. */
export function workSummaryBytes(summary: WorkSummary): number {
  const summaryBytes = bytes(summary);
  if (summaryBytes === undefined) throw new TypeError("Work summary must be JSON serializable");
  return summaryBytes;
}

function messageText(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<UIMessage["parts"][number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

type DynamicToolPart = Extract<
  UIMessage["parts"][number],
  { type: "dynamic-tool" }
>;

export type TranscriptToolStatus =
  | "completed"
  | "failed"
  | "not_executed"
  | "unknown";

export interface TranscriptToolFact {
  toolCallId: string;
  toolName: string;
  status: TranscriptToolStatus;
  text: string;
  evidenceMessageIds: string[];
  path?: string;
}

interface ClassifiedToolFacts {
  completed: WorkSummaryItem[];
  unresolved: string[];
  failures: WorkSummaryItem[];
  unknowns: WorkSummaryItem[];
}

const TOOL_STATUS_RANK: Record<TranscriptToolStatus, number> = {
  completed: 0,
  not_executed: 1,
  failed: 2,
  unknown: 3,
};

const SHORT_FACT_KEYS = [
  "path",
  "code",
  "bytes",
  "finalUrl",
  "truncated",
  "exitCode",
  "timedOut",
  "cancelled",
  "outcome",
] as const;

function scalarFact(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    return text.length > 0 ? text.slice(0, 120) : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return undefined;
}

function compactToolReceipt(value: unknown): string {
  if (typeof value === "string") {
    const firstLine = value.trim().split("\n")[0] ?? "";
    return firstLine.slice(0, 200);
  }
  if (!isRecord(value)) return "";

  const parts: string[] = [];
  if (typeof value.ok === "boolean") parts.push(`ok=${value.ok}`);
  for (const key of SHORT_FACT_KEYS) {
    const printed = scalarFact(value[key]);
    if (printed !== undefined) parts.push(`${key}=${printed}`);
  }
  if (isRecord(value.value)) {
    for (const key of ["path", "finalUrl", "truncated", "status"] as const) {
      const printed = scalarFact(value.value[key]);
      if (printed !== undefined && !parts.some((part) => part.startsWith(`${key}=`))) {
        parts.push(`${key}=${printed}`);
      }
    }
  } else {
    const printed = scalarFact(value.value);
    if (printed !== undefined) parts.push(`value=${printed}`);
  }
  if (isRecord(value.error)) {
    const code = scalarFact(value.error.code);
    if (code !== undefined && !parts.some((part) => part.startsWith("code="))) {
      parts.push(`code=${code}`);
    }
  }
  return parts.join(" ");
}

function toolFactText(
  toolName: string,
  status: "completed" | "failed" | "unknown",
  detail: unknown,
): string {
  const label = toolName.trim() || "unknown tool";
  const description =
    status === "completed"
      ? "completed"
      : status === "failed"
        ? "failed"
        : "returned an unclassified result";
  const receipt = compactToolReceipt(detail);
  return receipt.length > 0 ? `${label} ${description}: ${receipt}` : `${label} ${description}`;
}

function explicitOk(output: unknown): boolean | undefined {
  if (!isRecord(output) || typeof output.ok !== "boolean") return undefined;
  return output.ok;
}

function toolPath(part: DynamicToolPart): string | undefined {
  if (part.toolName !== "write_file" && part.toolName !== "edit_file" && part.toolName !== "read_file") {
    return undefined;
  }
  if (isRecord(part.input) && isNonEmptyString(part.input.path)) {
    return part.input.path.trim();
  }
  if (part.state === "output-available" && isRecord(part.output)) {
    if (isNonEmptyString(part.output.path)) return part.output.path.trim();
    if (isRecord(part.output.value) && isNonEmptyString(part.output.value.path)) {
      return part.output.value.path.trim();
    }
  }
  return undefined;
}

function classifyToolPart(
  part: DynamicToolPart,
  evidenceMessageId: string,
): TranscriptToolFact | undefined {
  const toolName = part.toolName.trim() || "unknown tool";
  const path = toolPath(part);
  const base = {
    toolCallId: part.toolCallId,
    toolName,
    evidenceMessageIds: [evidenceMessageId],
    ...(path === undefined ? {} : { path }),
  };

  if (part.state === "output-error") {
    if (part.errorText.startsWith("TOOL_DENIED")) {
      return {
        ...base,
        status: "not_executed",
        text: `${toolName} was denied: ${part.errorText}`,
      };
    }
    if (part.errorText.startsWith("TOOL_OUTCOME_UNKNOWN")) {
      return {
        ...base,
        status: "unknown",
        text: toolFactText(part.toolName, "unknown", part.errorText),
      };
    }
    return {
      ...base,
      status: "failed",
      text: toolFactText(part.toolName, "failed", part.errorText),
    };
  }

  if (part.state !== "output-available") return undefined;
  const ok = explicitOk(part.output);
  if (ok === true) {
    return {
      ...base,
      status: "completed",
      text: toolFactText(part.toolName, "completed", part.output),
    };
  }
  if (ok === false) {
    return {
      ...base,
      status: "failed",
      text: toolFactText(part.toolName, "failed", part.output),
    };
  }
  return {
    ...base,
    status: "unknown",
    text: toolFactText(part.toolName, "unknown", part.output),
  };
}

function mergeToolFacts(
  existing: TranscriptToolFact,
  incoming: TranscriptToolFact,
): TranscriptToolFact {
  const preferIncoming =
    TOOL_STATUS_RANK[incoming.status] >= TOOL_STATUS_RANK[existing.status];
  return {
    toolCallId: existing.toolCallId,
    toolName: existing.toolName,
    status: preferIncoming ? incoming.status : existing.status,
    text: preferIncoming ? incoming.text : existing.text,
    evidenceMessageIds: uniqueMessageIds([
      ...existing.evidenceMessageIds,
      ...incoming.evidenceMessageIds,
    ]),
    ...(existing.path ?? incoming.path
      ? { path: existing.path ?? incoming.path }
      : {}),
  };
}

/** Program facts for tool calls in a transcript slice. Used by R4 summaries and compaction. */
export function collectTranscriptToolFacts(
  messages: readonly UIMessage[],
): TranscriptToolFact[] {
  const facts = new Map<string, TranscriptToolFact>();
  for (const message of messages) {
    if (message.id.trim().length === 0) continue;
    for (const part of message.parts) {
      if (part.type !== "dynamic-tool") continue;
      const classified = classifyToolPart(part, message.id);
      if (classified === undefined) continue;
      const existing = facts.get(classified.toolCallId);
      facts.set(
        classified.toolCallId,
        existing === undefined ? classified : mergeToolFacts(existing, classified),
      );
    }
  }
  return [...facts.values()];
}

function collectToolFacts(messages: readonly UIMessage[]): ClassifiedToolFacts {
  const facts: ClassifiedToolFacts = {
    completed: [],
    unresolved: [],
    failures: [],
    unknowns: [],
  };
  for (const fact of collectTranscriptToolFacts(messages)) {
    const item = {
      text: fact.text,
      evidenceMessageIds: fact.evidenceMessageIds,
    };
    if (fact.status === "completed") facts.completed.push(item);
    else if (fact.status === "failed") facts.failures.push(item);
    else if (fact.status === "not_executed") facts.unresolved.push(fact.text);
    else facts.unknowns.push(item);
  }
  return facts;
}

function boundedItems(
  items: readonly WorkSummaryItem[],
  count: number,
  textLimit: number,
): WorkSummaryItem[] {
  return items.slice(0, count).map((item) => ({
    text: item.text.slice(0, textLimit).trim(),
    evidenceMessageIds: item.evidenceMessageIds,
  })).filter((item) => item.text.length > 0);
}

function boundedStrings(
  items: readonly string[],
  count: number,
  textLimit: number,
): string[] {
  return items
    .slice(0, count)
    .map((item) => item.slice(0, textLimit).trim())
    .filter((item) => item.length > 0);
}

const GOAL_FALLBACK = "Continue the prior work.";

function uniqueMessageIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => id.trim().length > 0))];
}

/**
 * Build a bounded, auditable summary from complete messages that are about to
 * be omitted from the model prompt. This is intentionally deterministic: R4a
 * keeps the summary process-local and does not add another model call.
 * Oversized candidates shrink until they fit; they are not dropped.
 */
export function createWorkSummaryFromMessages(
  messages: readonly UIMessage[],
  messageIndices: readonly number[],
): WorkSummary | undefined {
  const indices = [...new Set(messageIndices)]
    .filter((index) => Number.isSafeInteger(index) && index >= 0 && index < messages.length)
    .sort((left, right) => left - right);
  if (indices.length === 0) return undefined;

  const coveredMessages = indices.map((index) => messages[index]!);
  const allEvidenceIds = uniqueMessageIds(coveredMessages.map((message) => message.id));
  if (allEvidenceIds.length === 0) return undefined;

  const firstUser = coveredMessages.find((message) => message.role === "user");
  const rawGoal = messageText(firstUser ?? coveredMessages[0]!) || GOAL_FALLBACK;
  const rawConstraints = coveredMessages
    .filter((message) => message.role === "user")
    .slice(1)
    .map((message) => messageText(message))
    .filter((text) => text.length > 0);
  const toolFacts = collectToolFacts(coveredMessages);
  const turn = coveredMessages.reduce(
    (count, message) => count + (message.role === "user" ? 1 : 0),
    0,
  ) - (firstUser?.role === "user" ? 1 : 0);
  const lastIndex = indices.at(-1)!;
  const lastId = uniqueMessageIds([coveredMessages.at(-1)!.id]).at(-1) ?? allEvidenceIds.at(-1)!;

  let constraintLimit = 800;
  let constraintCount = 8;
  let goalLimit = 2_000;
  let factTextLimit = 1_000;
  let factCount = 16;

  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate: WorkSummary = {
      version: WORK_SUMMARY_VERSION,
      coveredThrough: {
        messageId: lastId,
        messageIndex: lastIndex,
        turn: Math.max(0, turn),
      },
      goal: rawGoal.slice(0, goalLimit).trim() || GOAL_FALLBACK,
      constraints: boundedStrings(rawConstraints, constraintCount, constraintLimit),
      completed: boundedItems(toolFacts.completed, factCount, factTextLimit),
      unresolved: boundedStrings(toolFacts.unresolved, factCount, factTextLimit),
      failures: boundedItems(toolFacts.failures, factCount, factTextLimit),
      unknowns: boundedItems(toolFacts.unknowns, factCount, factTextLimit),
      nextStep: null,
    };
    const validation = validateWorkSummary(candidate);
    if (validation.ok) return candidate;
    if (validation.code !== "SUMMARY_TOO_LARGE") return undefined;

    if (factTextLimit > 200) {
      factTextLimit = Math.max(200, Math.floor(factTextLimit / 2));
      continue;
    }
    if (factCount > 2) {
      factCount = Math.max(2, Math.floor(factCount / 2));
      continue;
    }
    if (constraintCount > 0) {
      constraintCount = 0;
      continue;
    }
    if (goalLimit > 80) {
      goalLimit = 80;
      continue;
    }
    return undefined;
  }
  return undefined;
}

export type TranscriptLookupResult =
  | { ok: true; messages: UIMessage[] }
  | { ok: false; error: "INVALID_SELECTOR" | "MESSAGE_NOT_FOUND" | "TURN_NOT_FOUND" };

/** Read-only local lookup used to inspect the source messages behind a summary. */
export function lookupTranscript(
  messages: readonly UIMessage[],
  selector: string,
): TranscriptLookupResult {
  const value = selector.trim();
  if (value.length === 0) return { ok: false, error: "INVALID_SELECTOR" };

  if (value.startsWith("turn:")) {
    const parsed = Number(value.slice("turn:".length));
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      return { ok: false, error: "INVALID_SELECTOR" };
    }
    const userStarts = messages.flatMap((message, index) =>
      message.role === "user" ? [index] : [],
    );
    const start = userStarts[parsed];
    if (start === undefined) return { ok: false, error: "TURN_NOT_FOUND" };
    const end = userStarts[parsed + 1] ?? messages.length;
    return { ok: true, messages: messages.slice(start, end) };
  }

  const index = messages.findIndex((message) => message.id === value);
  if (index < 0) return { ok: false, error: "MESSAGE_NOT_FOUND" };
  const start = messages
    .slice(0, index + 1)
    .map((message, position) => (message.role === "user" ? position : -1))
    .filter((position) => position >= 0)
    .at(-1);
  if (start === undefined) return { ok: true, messages: [messages[index]!] };
  const nextUser = messages.findIndex(
    (message, position) => position > start && message.role === "user",
  );
  return {
    ok: true,
    messages: messages.slice(start, nextUser < 0 ? messages.length : nextUser),
  };
}
