import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MEMORY_ASSERTIONS_MAX,
  TemporalMemoryError,
  assertTemporalIntegrity,
  createAssertion,
  reviseAssertions,
  selectTemporalAssertions,
  validateAssertion,
  validateRecallTerms,
  validateTemporalTimestamp,
  validateValidTime,
  type MemoryAssertion,
} from "./memory-temporal.js";

const JAN = "2026-01-01T00:00:00.000Z";
const AUG = "2026-08-01T00:00:00.000Z";
const SEP = "2026-09-01T00:00:00.000Z";
const OCT = "2026-10-04T00:00:00.000Z";
const NOV = "2026-11-01T00:00:00.000Z";

function nextIds(): () => string {
  let next = 0;
  return () => `new-${++next}`;
}

function state(text = "resides in Shanghai", id = "original"): MemoryAssertion {
  return createAssertion({
    text,
    kind: "fact",
    recallTerms: ["residence"],
    validTime: { from: JAN, to: null, basis: "explicit" },
    sources: [{ kind: "conversation", threadId: "thread-a", messageId: "message-a", quote: text }],
  }, id, JAN);
}

function rejectsCode(action: () => unknown, code: TemporalMemoryError["code"]): void {
  assert.throws(action, (error: unknown) => error instanceof TemporalMemoryError && error.code === code);
}

describe("memory temporal domain", () => {
  it("records an actual transition separately from the date on which it was learned", () => {
    const original = state();
    const result = reviseAssertions([original], { operation: "change", text: "resides in Hangzhou", effectiveAt: SEP, sources: [{ kind: "manual" }] }, OCT, nextIds());
    assert.equal(result.assertions.length, 3);
    assert.equal(result.displayAssertionId, "new-2");
    assert.equal(original.systemTime.to, null, "caller input is not mutated");
    assert.deepEqual(result.assertions[0]?.systemTime, { from: JAN, to: OCT });
    assert.deepEqual(result.assertions[1]?.validTime, { from: JAN, to: SEP, basis: "explicit" });
    assert.deepEqual(result.assertions[1]?.sources, original.sources);
    assert.deepEqual(result.assertions[2]?.sources, [{ kind: "manual" }]);
    assert.equal(selectTemporalAssertions(result.assertions, { validAt: AUG }, OCT).assertions[0]?.text, "resides in Shanghai");
    assert.equal(selectTemporalAssertions(result.assertions, { validAt: SEP }, OCT).assertions[0]?.text, "resides in Hangzhou");
    assert.equal(selectTemporalAssertions(result.assertions, { validAt: OCT, knownAt: SEP }, OCT).assertions[0]?.text, "resides in Shanghai");
    assert.equal(selectTemporalAssertions(result.assertions, {}, OCT).assertions[0]?.text, "resides in Hangzhou");
  });

  it("correction does not turn the wrong former belief into a real historical fact", () => {
    const original = state();
    const result = reviseAssertions([original], { operation: "correct", text: "has always resided in Hangzhou", sources: [{ kind: "manual" }] }, OCT, nextIds());
    assert.equal(result.assertions.length, 2);
    assert.equal(selectTemporalAssertions(result.assertions, { validAt: AUG, knownAt: OCT }, OCT).assertions[0]?.text, "has always resided in Hangzhou");
    assert.equal(selectTemporalAssertions(result.assertions, { validAt: AUG, knownAt: SEP }, OCT).assertions[0]?.text, "resides in Shanghai");
  });

  it("allows successive changes while preserving already-known historical segments", () => {
    const ids = nextIds();
    const first = reviseAssertions([state()], { operation: "change", text: "resides in Hangzhou", effectiveAt: SEP, sources: [{ kind: "manual" }] }, OCT, ids);
    const second = reviseAssertions(first.assertions, { operation: "change", text: "resides in Nanjing", effectiveAt: OCT, sources: [{ kind: "manual" }] }, NOV, ids);
    assert.equal(second.assertions.length, 5);
    assert.deepEqual(second.assertions[1], first.assertions[1], "the historical Shanghai segment is not closed or rewritten");
    assert.equal(selectTemporalAssertions(second.assertions, { validAt: AUG }, NOV).assertions[0]?.text, "resides in Shanghai");
    assert.equal(selectTemporalAssertions(second.assertions, { validAt: SEP }, NOV).assertions[0]?.text, "resides in Hangzhou");
    assert.equal(selectTemporalAssertions(second.assertions, { validAt: OCT }, NOV).assertions[0]?.text, "resides in Nanjing");
    assert.equal(selectTemporalAssertions(second.assertions, { validAt: OCT, knownAt: OCT }, NOV).assertions[0]?.text, "resides in Hangzhou");
    const before = structuredClone(second.assertions);
    rejectsCode(() => reviseAssertions(second.assertions, { operation: "change", text: "resides in Beijing", effectiveAt: "2026-08-15T00:00:00Z", sources: [{ kind: "manual" }] }, NOV, ids), "MEMORY_TEMPORAL_CONFLICT");
    assert.deepEqual(second.assertions, before, "a backdated change cannot overwrite the later known Hangzhou/Nanjing transitions");
  });

  it("retraction preserves old knowledge but current queries never fall back to it", () => {
    const result = reviseAssertions([state()], { operation: "retract", sources: [{ kind: "manual" }] }, OCT, nextIds());
    assert.equal(result.assertions[1]?.state, "retracted");
    assert.deepEqual(selectTemporalAssertions(result.assertions, {}, OCT).assertions, []);
    assert.deepEqual(selectTemporalAssertions(result.assertions, { validAt: AUG }, NOV).assertions, []);
    assert.equal(selectTemporalAssertions(result.assertions, { validAt: AUG, knownAt: SEP }, NOV).assertions[0]?.text, "resides in Shanghai");
    rejectsCode(() => reviseAssertions(result.assertions, { operation: "retract", sources: [{ kind: "manual" }] }, NOV, nextIds()), "MEMORY_TEMPORAL_CONFLICT");
    const restored = reviseAssertions(result.assertions, { operation: "correct", text: "resides in Hangzhou", validTime: { from: NOV, to: null, basis: "reported" }, sources: [{ kind: "manual" }] }, NOV, () => "restore");
    assert.equal(selectTemporalAssertions(restored.assertions, {}, NOV).assertions[0]?.text, "resides in Hangzhou");
    assert.deepEqual(selectTemporalAssertions(restored.assertions, { validAt: AUG }, NOV).assertions, []);
  });

  it("future transitions keep the current fact until the future half-open boundary", () => {
    const result = reviseAssertions([state()], { operation: "change", text: "resides in Hangzhou", effectiveAt: NOV, sources: [{ kind: "manual" }] }, OCT, nextIds());
    assert.equal(selectTemporalAssertions(result.assertions, {}, OCT).assertions[0]?.text, "resides in Shanghai");
    assert.equal(selectTemporalAssertions(result.assertions, {}, NOV).assertions[0]?.text, "resides in Hangzhou");
    const before = structuredClone(result.assertions);
    rejectsCode(() => reviseAssertions(result.assertions, { operation: "change", text: "resides in Beijing", effectiveAt: "2026-10-15T00:00:00Z", sources: [{ kind: "manual" }] }, OCT, nextIds()), "MEMORY_TEMPORAL_CONFLICT");
    assert.deepEqual(result.assertions, before);
    rejectsCode(() => reviseAssertions(result.assertions, { operation: "correct", text: "resides in Beijing", sources: [{ kind: "manual" }] }, OCT, nextIds()), "MEMORY_TEMPORAL_CONFLICT");
  });

  it("rejects boundary transitions and contradictory replacement fields", () => {
    rejectsCode(() => reviseAssertions([state()], { operation: "change", text: "Hangzhou", effectiveAt: JAN, sources: [{ kind: "manual" }] }, OCT, nextIds()), "MEMORY_TEMPORAL_CONFLICT");
    const bounded = state();
    bounded.validTime.to = SEP;
    rejectsCode(() => reviseAssertions([bounded], { operation: "change", text: "Hangzhou", effectiveAt: SEP, sources: [{ kind: "manual" }] }, OCT, nextIds()), "MEMORY_TEMPORAL_CONFLICT");
    rejectsCode(() => reviseAssertions([state()], { operation: "change", text: "Hangzhou", sources: [{ kind: "manual" }] }, OCT, nextIds()), "MEMORY_TEMPORAL_INVALID");
    rejectsCode(() => reviseAssertions([state()], { operation: "change", text: "Hangzhou", kind: "note", effectiveAt: SEP, sources: [{ kind: "manual" }] }, OCT, nextIds()), "MEMORY_TEMPORAL_INVALID");
    rejectsCode(() => reviseAssertions([state()], { operation: "retract", text: "replacement", sources: [{ kind: "manual" }] }, OCT, nextIds()), "MEMORY_TEMPORAL_INVALID");
  });

  it("allows repeated commits at one timestamp while rejecting clock rollback", () => {
    const first = reviseAssertions([state()], { operation: "correct", text: "Hangzhou", sources: [{ kind: "manual" }] }, OCT, nextIds());
    const second = reviseAssertions(first.assertions, { operation: "correct", text: "Beijing", sources: [{ kind: "manual" }] }, OCT, () => "same-tick");
    assert.deepEqual(second.assertions[1]?.systemTime, { from: OCT, to: OCT });
    assert.equal(selectTemporalAssertions(second.assertions, {}, OCT).assertions[0]?.text, "Beijing");
    rejectsCode(() => reviseAssertions(second.assertions, { operation: "correct", text: "Shenzhen", sources: [{ kind: "manual" }] }, SEP, nextIds()), "MEMORY_CLOCK_ROLLBACK");
  });

  it("fails at history capacity without dropping or modifying input", () => {
    const history: MemoryAssertion[] = Array.from({ length: MEMORY_ASSERTIONS_MAX - 1 }, (_, index) => ({ ...state(`old-${index}`, `old-${index}`), systemTime: { from: JAN, to: JAN } }));
    history.push(state());
    const before = structuredClone(history);
    rejectsCode(() => reviseAssertions(history, { operation: "correct", text: "Hangzhou", sources: [{ kind: "manual" }] }, OCT, nextIds()), "MEMORY_HISTORY_FULL");
    assert.deepEqual(history, before);
    const spare = history.slice(1);
    const corrected = reviseAssertions(spare, { operation: "correct", text: "Hangzhou", sources: [{ kind: "manual" }] }, OCT, nextIds());
    assert.equal(corrected.assertions.length, MEMORY_ASSERTIONS_MAX);
    rejectsCode(() => reviseAssertions(spare, { operation: "change", text: "Hangzhou", effectiveAt: SEP, sources: [{ kind: "manual" }] }, OCT, nextIds()), "MEMORY_HISTORY_FULL");
  });

  it("rejects simultaneous bitemporal state overlaps but permits adjacent rectangles", () => {
    const first = state();
    const overlapping = state("Hangzhou", "other");
    overlapping.systemTime.from = SEP;
    rejectsCode(() => assertTemporalIntegrity([first, overlapping]), "MEMORY_TEMPORAL_CONFLICT");
    first.systemTime.to = SEP;
    assertTemporalIntegrity([first, overlapping]);
    first.systemTime.to = null;
    first.validTime.to = SEP;
    overlapping.validTime.from = SEP;
    assertTemporalIntegrity([first, overlapping]);
    overlapping.kind = "preference";
    overlapping.validTime.from = AUG;
    rejectsCode(() => assertTemporalIntegrity([first, overlapping]), "MEMORY_TEMPORAL_CONFLICT");
  });

  it("keeps unrelated notes and past events without forcing state-fact uniqueness", () => {
    const event = createAssertion({ text: "attended a conference", kind: "event", validTime: { from: JAN, to: AUG, basis: "explicit" }, sources: [{ kind: "manual" }] }, "event", JAN);
    const note = createAssertion({ text: "conference notes", kind: "note", validTime: { from: JAN, to: AUG, basis: "explicit" }, sources: [{ kind: "manual" }] }, "note", JAN);
    assertTemporalIntegrity([event, note]);
    assert.equal(selectTemporalAssertions([event, note], {}, OCT).assertions.length, 2);
    assert.equal(selectTemporalAssertions([event, note], { validAt: OCT }, OCT).assertions.length, 0);
    assert.equal(selectTemporalAssertions([event, note], { validAt: JAN }, OCT).assertions.length, 2);
    rejectsCode(() => reviseAssertions([event], { operation: "change", text: "different event", effectiveAt: SEP, sources: [{ kind: "manual" }] }, OCT, nextIds()), "MEMORY_TEMPORAL_CONFLICT");
  });

  it("preserves unknown historical coverage and does not backdate a reported start", () => {
    const unknown = createAssertion({ text: "legacy fact", kind: "fact", sources: [{ kind: "legacy" }] }, "legacy", OCT);
    unknown.systemTime.from = null;
    const historic = selectTemporalAssertions([unknown], { validAt: AUG, knownAt: SEP }, OCT);
    assert.equal(historic.assertions.length, 1);
    assert.equal(historic.validTimeUncertain, true);
    assert.equal(historic.systemTimeUncertain, true);
    const reported = createAssertion({ text: "reported current fact", kind: "fact", validTime: { from: OCT, to: null, basis: "reported" }, sources: [{ kind: "manual" }] }, "reported", OCT);
    assert.deepEqual(selectTemporalAssertions([reported], { validAt: AUG }, OCT).assertions, []);
    assert.equal(selectTemporalAssertions([reported], {}, OCT).validTimeUncertain, true);
    assert.equal(selectTemporalAssertions([state()], {}, OCT).validTimeUncertain, false);
    assert.equal(selectTemporalAssertions([state()], {}, OCT).systemTimeUncertain, false);
  });

  it("normalizes timezone timestamps and rejects ambiguous dates or invalid calendars", () => {
    assert.equal(validateTemporalTimestamp("2026-10-04T08:00:00+08:00", "test"), OCT);
    assert.equal(validateTemporalTimestamp("2024-02-29T00:00:00.1Z", "test"), "2024-02-29T00:00:00.100Z");
    for (const value of ["2026-10-04", "2026-10-04T00:00:00", "2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-10-04T24:00:00Z", "2026-10-04T00:00:60Z", "2026-10-04T00:00:00+24:00", "2026-10-04T00:00:00+08:60", "2026-10-04T00:00:00.0001Z"]) {
      rejectsCode(() => validateTemporalTimestamp(value, "test"), "MEMORY_TEMPORAL_INVALID");
    }
    rejectsCode(() => validateValidTime({ from: OCT, to: SEP, basis: "explicit" }), "MEMORY_TEMPORAL_INVALID");
    rejectsCode(() => validateValidTime({ from: OCT, to: OCT, basis: "explicit" }), "MEMORY_TEMPORAL_INVALID");
    rejectsCode(() => validateValidTime({ from: null, to: null, basis: "reported" }), "MEMORY_TEMPORAL_INVALID");
  });

  it("enforces byte bounds and sources without sharing mutable inputs", () => {
    const terms = ["a".repeat(96), "偏好", "test"];
    assert.deepEqual(validateRecallTerms(terms), terms);
    rejectsCode(() => validateRecallTerms(["汉".repeat(33)]), "MEMORY_TEMPORAL_INVALID");
    rejectsCode(() => validateRecallTerms(["a", "b", "c", "d"]), "MEMORY_TEMPORAL_INVALID");
    rejectsCode(() => validateRecallTerms([" "]), "MEMORY_TEMPORAL_INVALID");
    rejectsCode(() => createAssertion({ text: "汉".repeat(683), sources: [{ kind: "manual" }] }, "too-long", OCT), "MEMORY_TEMPORAL_INVALID");
    rejectsCode(() => createAssertion({ text: "test", sources: [] }, "no-source", OCT), "MEMORY_TEMPORAL_INVALID");
    rejectsCode(() => createAssertion({ text: "test", sources: Array.from({ length: 5 }, () => ({ kind: "manual" })) }, "many-sources", OCT), "MEMORY_TEMPORAL_INVALID");
    rejectsCode(() => validateAssertion({ ...state(), sources: [{ kind: "conversation", threadId: "a", messageId: "b", quote: " " }] }), "MEMORY_TEMPORAL_INVALID");
    rejectsCode(() => assertTemporalIntegrity([state(), state("same id")]), "MEMORY_TEMPORAL_INVALID");
    const assertion = state();
    const selected = selectTemporalAssertions([assertion], {}, OCT).assertions[0]!;
    selected.recallTerms.push("new");
    selected.sources[0]!.kind = "manual";
    assert.deepEqual(assertion.recallTerms, ["residence"]);
    assert.equal(assertion.sources[0]?.kind, "conversation");
  });
});
