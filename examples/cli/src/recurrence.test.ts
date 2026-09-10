import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextOccurrence } from "./recurrence.js";

describe("nextOccurrence", () => {
  it("computes a daily occurrence in a positive offset", () => {
    assert.equal(
      nextOccurrence(
        { kind: "daily", time: "09:00", utcOffset: "+08:00" },
        "2026-09-10T00:30:00.000Z",
      ),
      "2026-09-10T01:00:00.000Z",
    );
  });

  it("moves to the next day when the local occurrence has passed exactly", () => {
    assert.equal(
      nextOccurrence(
        { kind: "daily", time: "09:00", utcOffset: "+08:00" },
        "2026-09-10T01:00:00.000Z",
      ),
      "2026-09-11T01:00:00.000Z",
    );
  });

  it("handles a negative offset across a UTC day boundary", () => {
    assert.equal(
      nextOccurrence(
        { kind: "daily", time: "00:30", utcOffset: "-05:00" },
        "2026-03-10T04:00:00.000Z",
      ),
      "2026-03-10T05:30:00.000Z",
    );
  });

  it("computes a weekly occurrence across the end of a week", () => {
    assert.equal(
      nextOccurrence(
        { kind: "weekly", weekday: 1, time: "09:00", utcOffset: "+08:00" },
        "2026-09-13T02:00:00.000Z",
      ),
      "2026-09-14T01:00:00.000Z",
    );
  });

  it("keeps a weekly occurrence on the same local day when it is still ahead", () => {
    assert.equal(
      nextOccurrence(
        { kind: "weekly", weekday: 4, time: "18:30", utcOffset: "-05:00" },
        "2026-09-10T22:00:00.000Z",
      ),
      "2026-09-10T23:30:00.000Z",
    );
  });

  it("advances a weekly occurrence by seven days at the exact instant", () => {
    assert.equal(
      nextOccurrence(
        { kind: "weekly", weekday: 4, time: "18:30", utcOffset: "-05:00" },
        "2026-09-10T23:30:00.000Z",
      ),
      "2026-09-17T23:30:00.000Z",
    );
  });

  it("accepts the time, offset, and weekday boundaries", () => {
    assert.equal(
      nextOccurrence(
        { kind: "daily", time: "23:59", utcOffset: "+14:00" },
        "2026-01-01T09:58:59.999Z",
      ),
      "2026-01-01T09:59:00.000Z",
    );
    assert.equal(
      nextOccurrence(
        { kind: "weekly", weekday: 7, time: "00:00", utcOffset: "-14:00" },
        "2026-01-04T13:59:59.999Z",
      ),
      "2026-01-04T14:00:00.000Z",
    );
  });

  it("rejects malformed times and offsets", () => {
    assert.throws(
      () => nextOccurrence({ kind: "daily", time: "9:00", utcOffset: "+00:00" }, "2026-01-01T00:00:00Z"),
      /HH:mm/,
    );
    assert.throws(
      () => nextOccurrence({ kind: "daily", time: "24:00", utcOffset: "+00:00" }, "2026-01-01T00:00:00Z"),
      /valid HH:mm/,
    );
    assert.throws(
      () => nextOccurrence({ kind: "daily", time: "12:00", utcOffset: "+14:01" }, "2026-01-01T00:00:00Z"),
      /between -14:00 and \+14:00/,
    );
    assert.throws(
      () => nextOccurrence({ kind: "daily", time: "12:00", utcOffset: "UTC" }, "2026-01-01T00:00:00Z"),
      /between -14:00 and \+14:00/,
    );
  });

  it("rejects an out-of-range weekly weekday and invalid afterUtc", () => {
    assert.throws(
      () => nextOccurrence({ kind: "weekly", weekday: 0, time: "12:00", utcOffset: "+00:00" }, "2026-01-01T00:00:00Z"),
      /weekday must be an integer from 1 to 7/,
    );
    assert.throws(
      () => nextOccurrence({ kind: "weekly", weekday: 8, time: "12:00", utcOffset: "+00:00" }, "2026-01-01T00:00:00Z"),
      /weekday must be an integer from 1 to 7/,
    );
    assert.throws(
      () => nextOccurrence({ kind: "daily", time: "12:00", utcOffset: "+00:00" }, "not-a-date"),
      /afterUtc must be a valid date-time/,
    );
  });
});
