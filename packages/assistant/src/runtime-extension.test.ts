import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AfterToolCallInput, BeforeToolExecute, BeforeToolExecuteInput } from "@serika/core";
import { composeExtensions } from "./runtime-extension.js";

const beforeInput = { toolName: "read_file", toolCallId: "c1", input: {}, signal: new AbortController().signal } as unknown as BeforeToolExecuteInput;
const afterInput = { toolName: "read_file", toolCallId: "c1", input: {}, output: {} } as unknown as AfterToolCallInput;

describe("composeExtensions", () => {
  it("uses a hook provided by a single extension as is", () => {
    const before: BeforeToolExecute = () => ({ allow: true });
    const after = () => undefined;
    const composed = composeExtensions([{ name: "a", beforeToolExecute: before }, { name: "b", afterToolCall: after }]);
    assert.equal(composed.beforeToolExecute, before);
    assert.equal(composed.afterToolCall, after);
  });

  it("omits hooks no extension provides", () => {
    const composed = composeExtensions([{ name: "a" }]);
    assert.equal(composed.beforeToolExecute, undefined);
    assert.equal(composed.afterToolCall, undefined);
    assert.deepEqual(composed.commands, []);
  });

  it("returns the first denial and does not ask later extensions", async () => {
    const asked: string[] = [];
    const composed = composeExtensions([
      { name: "a", beforeToolExecute: () => { asked.push("a"); return { allow: true }; } },
      { name: "b", beforeToolExecute: async () => { asked.push("b"); return { allow: false, reason: "no" }; } },
      { name: "c", beforeToolExecute: () => { asked.push("c"); return { allow: true }; } },
    ]);
    assert.deepEqual(await composed.beforeToolExecute!(beforeInput), { allow: false, reason: "no" });
    assert.deepEqual(asked, ["a", "b"]);
  });

  it("allows only when every extension allows", async () => {
    const composed = composeExtensions([
      { name: "a", beforeToolExecute: () => ({ allow: true }) },
      { name: "b", beforeToolExecute: async () => ({ allow: true }) },
    ]);
    assert.deepEqual(await composed.beforeToolExecute!(beforeInput), { allow: true });
  });

  it("passes a hook rejection through instead of turning it into a decision", async () => {
    const composed = composeExtensions([
      { name: "a", beforeToolExecute: () => ({ allow: true }) },
      { name: "b", beforeToolExecute: () => Promise.reject(new Error("aborted")) },
    ]);
    await assert.rejects(Promise.resolve(composed.beforeToolExecute!(beforeInput)), /aborted/);
  });

  it("uses the first after-call decision and skips later extensions", async () => {
    const called: string[] = [];
    const composed = composeExtensions([
      { name: "a", afterToolCall: () => { called.push("a"); return undefined; } },
      { name: "b", afterToolCall: async () => { called.push("b"); return { kind: "feedback", text: "slow down" }; } },
      { name: "c", afterToolCall: () => { called.push("c"); return { kind: "stop", message: "stop" }; } },
    ]);
    assert.deepEqual(await composed.afterToolCall!(afterInput), { kind: "feedback", text: "slow down" });
    assert.deepEqual(called, ["a", "b"]);
  });

  it("keeps command order and rejects duplicate names", () => {
    const execute = () => undefined;
    const composed = composeExtensions([
      { name: "a", commands: [{ name: "one", execute }, { name: "two", execute }] },
      { name: "b", commands: [{ name: "three", execute }] },
    ]);
    assert.deepEqual(composed.commands.map(command => command.name), ["one", "two", "three"]);
    assert.throws(() => composeExtensions([
      { name: "a", commands: [{ name: "one", execute }] },
      { name: "b", commands: [{ name: "one", execute }] },
    ]), /Extension b registers duplicate command \/one/);
  });
});
