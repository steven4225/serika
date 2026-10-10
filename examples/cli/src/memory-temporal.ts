import type { MemorySource } from "./memory-store.js";
import { validateFactIdentity, type MemoryFactIdentity } from "./memory-fact-identity.js";

export const MEMORY_ASSERTIONS_MAX = 64;

export type MemoryKind = "preference" | "fact" | "event" | "note";

export interface MemoryValidTime {
  from: string | null;
  to: string | null;
  basis: "explicit" | "reported" | "unknown";
}

export interface MemoryAssertion {
  factIdentity?: MemoryFactIdentity;
  assertionId: string;
  text: string;
  kind: MemoryKind;
  recallTerms: string[];
  validTime: MemoryValidTime;
  systemTime: { from: string | null; to: string | null };
  state: "asserted" | "retracted";
  sources: MemorySource[];
}

export type TemporalMemoryErrorCode =
  | "MEMORY_TEMPORAL_INVALID"
  | "MEMORY_HISTORY_FULL"
  | "MEMORY_CLOCK_ROLLBACK"
  | "MEMORY_TEMPORAL_CONFLICT";

export class TemporalMemoryError extends Error {
  constructor(readonly code: TemporalMemoryErrorCode, message: string) {
    super(message);
    this.name = "TemporalMemoryError";
  }
}

function invalid(message: string): never {
  throw new TemporalMemoryError("MEMORY_TEMPORAL_INVALID", message);
}

function conflict(message: string): never {
  throw new TemporalMemoryError("MEMORY_TEMPORAL_CONFLICT", message);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function nonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) invalid(`${field} must be a non-blank string`);
  return value;
}

/** ISO date-times must include seconds and an explicit timezone; local dates are not evidence. */
export function validateTemporalTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") invalid(`${field} must be an ISO timestamp with a timezone`);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) invalid(`${field} must be an ISO timestamp with a timezone`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > (days[month - 1] ?? 0) || hour > 23 || minute > 59 || second > 59) {
    invalid(`${field} has an invalid calendar date or time`);
  }
  const timezone = match[8]!;
  if (timezone !== "Z" && (Number(timezone.slice(1, 3)) > 23 || Number(timezone.slice(4, 6)) > 59)) {
    invalid(`${field} has an invalid timezone offset`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) invalid(`${field} must be a valid timestamp`);
  return new Date(timestamp).toISOString();
}

function nullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : validateTemporalTimestamp(value, field);
}

export function validateValidTime(value: unknown): MemoryValidTime {
  const interval = object(value, "Memory validTime");
  const from = nullableTimestamp(interval.from, "Memory validTime.from");
  const to = nullableTimestamp(interval.to, "Memory validTime.to");
  if (interval.basis !== "explicit" && interval.basis !== "reported" && interval.basis !== "unknown") {
    invalid("Memory validTime.basis must be explicit, reported, or unknown");
  }
  if (from !== null && to !== null && Date.parse(from) >= Date.parse(to)) invalid("Memory validTime must be a non-empty half-open interval");
  if (interval.basis === "reported" && from === null) invalid("A reported validTime requires its observed starting timestamp");
  return { from, to, basis: interval.basis };
}

export function validateRecallTerms(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 3) invalid("Memory recallTerms must contain at most three strings");
  return value.map((term): string => {
    const result = nonBlank(term, "Memory recall term");
    if (Buffer.byteLength(result, "utf8") > 96) invalid("Memory recall term exceeds 96 UTF-8 bytes");
    return result;
  });
}

function validateKind(value: unknown): MemoryKind {
  if (value === "preference" || value === "fact" || value === "event" || value === "note") return value;
  invalid("Memory kind must be preference, fact, event, or note");
}

function validateSources(value: unknown): MemorySource[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) invalid("Memory assertion requires one to four sources");
  return value.map((item): MemorySource => {
    const source = object(item, "Memory source");
    if (source.kind === "manual" || source.kind === "legacy") return { kind: source.kind };
    if (source.kind !== "conversation") invalid("Memory source kind must be manual, legacy, or conversation");
    return {
      kind: "conversation",
      threadId: nonBlank(source.threadId, "Memory source Thread id"),
      messageId: nonBlank(source.messageId, "Memory source message id"),
      quote: nonBlank(source.quote, "Memory source quote"),
    };
  });
}

export function validateAssertion(value: unknown): MemoryAssertion {
  const assertion = object(value, "Memory assertion");
  if (assertion.factIdentity !== undefined && assertion.kind !== "fact" && assertion.kind !== "preference") invalid("Only facts/preferences may carry an attribute identity");
  const text = nonBlank(assertion.text, "Memory assertion text");
  if (Buffer.byteLength(text, "utf8") > 2_048) invalid("Memory assertion text exceeds 2048 UTF-8 bytes");
  const systemTime = object(assertion.systemTime, "Memory systemTime");
  const from = nullableTimestamp(systemTime.from, "Memory systemTime.from");
  const to = nullableTimestamp(systemTime.to, "Memory systemTime.to");
  // Equal boundaries are legal when two commits share one clock tick. Revision still orders commits.
  if (from !== null && to !== null && Date.parse(from) > Date.parse(to)) invalid("Memory systemTime has inverted boundaries");
  if (assertion.state !== "asserted" && assertion.state !== "retracted") invalid("Memory assertion state must be asserted or retracted");
  return {
    ...(assertion.factIdentity === undefined ? {} : { factIdentity: validateFactIdentity(assertion.factIdentity) }),
    assertionId: nonBlank(assertion.assertionId, "Memory assertion id"),
    text,
    kind: validateKind(assertion.kind),
    recallTerms: validateRecallTerms(assertion.recallTerms),
    validTime: validateValidTime(assertion.validTime),
    systemTime: { from, to },
    state: assertion.state,
    sources: validateSources(assertion.sources),
  };
}

export interface CreateAssertionInput {
  factIdentity?: MemoryFactIdentity;
  text: string;
  kind?: MemoryKind;
  recallTerms?: string[];
  validTime?: MemoryValidTime;
  sources: MemorySource[];
}

export function createAssertion(input: CreateAssertionInput, assertionId: string, now: string): MemoryAssertion {
  return validateAssertion({
    ...(input.factIdentity === undefined ? {} : { factIdentity: input.factIdentity }),
    assertionId,
    text: input.text,
    kind: input.kind ?? "note",
    recallTerms: input.recallTerms ?? [],
    validTime: input.validTime ?? { from: null, to: null, basis: "unknown" },
    systemTime: { from: validateTemporalTimestamp(now, "Memory write time"), to: null },
    state: "asserted",
    sources: input.sources,
  });
}

function start(value: string | null): number {
  return value === null ? Number.NEGATIVE_INFINITY : Date.parse(value);
}

function end(value: string | null): number {
  return value === null ? Number.POSITIVE_INFINITY : Date.parse(value);
}

function overlaps(left: { from: string | null; to: string | null }, right: { from: string | null; to: string | null }): boolean {
  return Math.max(start(left.from), start(right.from)) < Math.min(end(left.to), end(right.to));
}

function isState(assertion: MemoryAssertion): boolean {
  return assertion.kind === "fact" || assertion.kind === "preference";
}

export function assertTemporalIntegrity(assertions: MemoryAssertion[]): void {
  if (!Array.isArray(assertions) || assertions.length === 0) invalid("A memory entry requires assertions");
  if (assertions.length > MEMORY_ASSERTIONS_MAX) throw new TemporalMemoryError("MEMORY_HISTORY_FULL", `Memory assertion history exceeds ${MEMORY_ASSERTIONS_MAX}`);
  const ids = new Set<string>();
  const normalized = assertions.map(validateAssertion);
  for (let index = 0; index < normalized.length; index++) {
    const assertion = normalized[index]!;
    if (ids.has(assertion.assertionId)) invalid("Duplicate memory assertion id");
    ids.add(assertion.assertionId);
    if (assertion.state !== "asserted" || !isState(assertion)) continue;
    for (let previous = 0; previous < index; previous++) {
      const other = normalized[previous]!;
      if (other.state === "asserted" && isState(other) && overlaps(assertion.validTime, other.validTime) && overlaps(assertion.systemTime, other.systemTime)) {
        conflict("Simultaneously known state assertions have overlapping validTime intervals");
      }
    }
  }
}

export interface ReviseAssertionsInput {
  operation: "change" | "correct" | "retract" | "support";
  factIdentity?: MemoryFactIdentity;
  text?: string;
  kind?: MemoryKind;
  recallTerms?: string[];
  validTime?: MemoryValidTime;
  effectiveAt?: string;
  sources: MemorySource[];
}

export function reviseAssertions(assertions: MemoryAssertion[], input: ReviseAssertionsInput, now: string, newId: () => string): { assertions: MemoryAssertion[]; displayAssertionId: string } {
  assertTemporalIntegrity(assertions);
  const timestamp = validateTemporalTimestamp(now, "Memory write time");
  const next = assertions.map(validateAssertion);
  const latestBoundary = Math.max(...next.flatMap((assertion) => [assertion.systemTime.from, assertion.systemTime.to].filter((time): time is string => time !== null).map(Date.parse)));
  if (Date.parse(timestamp) < latestBoundary) throw new TemporalMemoryError("MEMORY_CLOCK_ROLLBACK", "Memory write time precedes the latest system-time boundary");
  const open = next.filter((assertion) => assertion.systemTime.to === null);
  const recognized = open.filter((assertion) => assertion.state === "asserted");
  const previous = recognized.at(-1) ?? open.at(-1);
  if (!previous) conflict("Memory entry has no open recognition to revise");
  const sources = validateSources(input.sources);
  let additions: MemoryAssertion[];
  let close = open;
  if (input.operation === "change") {
    if (input.effectiveAt === undefined || input.text === undefined) invalid("A state change requires text and effectiveAt");
    if (input.validTime !== undefined) invalid("A state change uses effectiveAt rather than a replacement validTime");
    const effectiveAt = validateTemporalTimestamp(input.effectiveAt, "Memory change effectiveAt");
    const effective = Date.parse(effectiveAt);
    const stateSegments = recognized.filter(isState);
    const affected = stateSegments.filter((assertion) => effective > start(assertion.validTime.from) && effective < end(assertion.validTime.to));
    if (affected.length !== 1 || stateSegments.some((assertion) => start(assertion.validTime.from) >= effective)) {
      conflict("A state change requires one applicable fact or preference and cannot overwrite an already-known later transition");
    }
    const segment = affected[0]!;
    close = [segment];
    const kind = input.kind ?? segment.kind;
    if (kind !== "fact" && kind !== "preference") invalid("A state change must remain a fact or preference");
    additions = [
      createAssertion({ ...segment, text: segment.text, kind: segment.kind, recallTerms: segment.recallTerms, validTime: { ...segment.validTime, to: effectiveAt }, sources: segment.sources }, newId(), timestamp),
      createAssertion({ ...(input.factIdentity === undefined ? {} : { factIdentity: input.factIdentity }), text: input.text, kind, recallTerms: input.recallTerms ?? segment.recallTerms, validTime: { from: effectiveAt, to: segment.validTime.to, basis: "explicit" }, sources }, newId(), timestamp),
    ];
  } else if (input.operation === "correct") {
    if (input.text === undefined) invalid("A correction requires replacement text");
    if (input.effectiveAt !== undefined) invalid("A correction uses validTime rather than effectiveAt");
    if (recognized.length > 1 && input.validTime === undefined) conflict("Correcting multiple open recognitions requires an explicit replacement validTime");
    additions = [createAssertion({
      text: input.text,
      ...(input.factIdentity === undefined ? {} : { factIdentity: input.factIdentity }),
      kind: input.kind ?? previous.kind,
      recallTerms: input.recallTerms ?? previous.recallTerms,
      validTime: input.validTime ?? previous.validTime,
      sources,
    }, newId(), timestamp)];
  } else if (input.operation === "support") {
    const matches = recognized.filter(assertion => assertion.text === input.text && JSON.stringify(assertion.validTime) === JSON.stringify(input.validTime));
    if (matches.length !== 1 || input.effectiveAt !== undefined) conflict("Source reuse requires one unchanged applicable assertion");
    const target = matches[0]!;
    close = [target];
    const combined = [...target.sources, ...sources].filter((source, index, all) => all.findIndex(other => JSON.stringify(other) === JSON.stringify(source)) === index);
    // Old exact evidence remains in historical assertions; retain at most four in the current version.
    additions = [createAssertion({ ...target, sources: combined.slice(-4) }, newId(), timestamp)];
  } else if (input.operation === "retract") {
    if (input.text !== undefined || input.kind !== undefined || input.recallTerms !== undefined || input.validTime !== undefined || input.effectiveAt !== undefined) invalid("Retraction only withdraws recognition; it cannot replace assertion contents or dates");
    if (recognized.length === 0) conflict("Memory recognition has already been retracted");
    additions = [{ ...createAssertion({ ...previous, sources }, newId(), timestamp), state: "retracted" }];
  } else {
    invalid("Memory revision operation must be change, correct, or retract");
  }
  if (next.length + additions.length > MEMORY_ASSERTIONS_MAX) throw new TemporalMemoryError("MEMORY_HISTORY_FULL", `Memory assertion history cannot exceed ${MEMORY_ASSERTIONS_MAX}; nothing was trimmed`);
  for (const assertion of close) assertion.systemTime.to = timestamp;
  next.push(...additions);
  assertTemporalIntegrity(next);
  return { assertions: next, displayAssertionId: additions.at(-1)!.assertionId };
}

export interface TemporalAssertionQuery {
  validAt?: string;
  knownAt?: string;
}

export function selectTemporalAssertions(assertions: MemoryAssertion[], query: TemporalAssertionQuery, now: string): { assertions: MemoryAssertion[]; validTimeUncertain: boolean; systemTimeUncertain: boolean } {
  assertTemporalIntegrity(assertions);
  const currentTime = validateTemporalTimestamp(now, "Memory query time");
  const knownAt = Date.parse(query.knownAt === undefined ? currentTime : validateTemporalTimestamp(query.knownAt, "Memory query knownAt"));
  const validAt = Date.parse(query.validAt === undefined ? currentTime : validateTemporalTimestamp(query.validAt, "Memory query validAt"));
  const selected = assertions.map(validateAssertion).filter((assertion) => {
    if (assertion.state !== "asserted" || knownAt < start(assertion.systemTime.from) || knownAt >= end(assertion.systemTime.to)) return false;
    // An occurrence or saved note remains useful after its date; explicit historical queries still filter it.
    return query.validAt === undefined && !isState(assertion) || validAt >= start(assertion.validTime.from) && validAt < end(assertion.validTime.to);
  });
  return {
    assertions: selected,
    validTimeUncertain: selected.some((assertion) => assertion.validTime.basis !== "explicit" || assertion.validTime.from === null),
    systemTimeUncertain: selected.some((assertion) => assertion.systemTime.from === null),
  };
}
