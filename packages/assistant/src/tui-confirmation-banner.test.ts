import { test } from "node:test";
import assert from "node:assert/strict";
import type { Writable } from "node:stream";
import type { BeforeToolExecuteInput, ToolExecutionDecision } from "@serika/core";
import { createToolConfirmation } from "./tui.js";

const BANNER = "[confirmation] Waiting for y/n; the tool has not run yet.";

function capture(): { output: Writable; text(): string } {
  let buffer = "";
  const output = {
    write(chunk: string | Uint8Array): boolean {
      buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
  } as unknown as Writable;
  return { output, text: () => buffer };
}

function toolInput(
  toolName: string,
  input: unknown,
  definitionId = "agent",
): BeforeToolExecuteInput {
  return {
    toolName,
    input,
    signal: new AbortController().signal,
    definition: { id: definitionId },
  } as unknown as BeforeToolExecuteInput;
}

test("real y/n wait: banner with 'has not run yet' is written before the preview", async () => {
  const { output, text } = capture();
  const confirmation = createToolConfirmation(output);

  const decision = confirmation.beforeToolExecute(
    toolInput("read_file", { path: "packages/assistant/src/tui.ts" }),
  ) as Promise<ToolExecutionDecision>;
  let settled = false;
  void decision.then(() => {
    settled = true;
  });
  await Promise.resolve();

  const written = text();
  assert.ok(written.includes(BANNER), `expected banner in output: ${JSON.stringify(written)}`);
  assert.ok(
    written.includes("Tool: read_file"),
    `expected tool preview in output: ${JSON.stringify(written)}`,
  );
  assert.ok(
    written.indexOf(BANNER) < written.indexOf("Tool: read_file"),
    `expected banner before preview: ${JSON.stringify(written)}`,
  );
  assert.equal(settled, false, "the tool must not have run before the answer");

  assert.equal(confirmation.handleLine("y"), true);
  assert.deepEqual(await decision, { allow: true });
});

test("pomodoro_start is auto-allowed: no 'has not run yet' banner and no confirmation output", async () => {
  const { output, text } = capture();
  const confirmation = createToolConfirmation(output);

  const decision = await (confirmation.beforeToolExecute(
    toolInput("pomodoro_start", { durationMinutes: 25 }),
  ) as Promise<ToolExecutionDecision>);

  assert.deepEqual(decision, { allow: true });
  assert.equal(text(), "", "pomodoro_start must not write confirmation output");
  assert.equal(confirmation.handleLine("y"), false, "no confirmation was pending");
});
