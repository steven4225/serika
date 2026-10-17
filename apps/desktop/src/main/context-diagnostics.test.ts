import assert from "node:assert/strict";
import { it } from "node:test";
import type { AssistantController } from "@serika/assistant";
import type { RuntimeApp } from "@serika/assistant";
import { RuntimeBridge, TeeOutput } from "./runtime-bridge.js";

it("forwards structured diagnostics unchanged, without running a command or preparing context", async () => {
  const result = { ok: false as const, error: { code: "CONTEXT_READ_FAILED", message: "unreadable transcript" } };
  let reads = 0;
  const controller = {
    subscribe: () => () => undefined,
    getContextDiagnostics: async () => { reads += 1; return result; },
    command: () => { throw new Error("query must not compact"); },
    run: () => { throw new Error("query must not run"); },
  } as unknown as AssistantController;
  const bridge = new RuntimeBridge({} as RuntimeApp, controller,
    { modelAlias: "test", temporaryThread: false, temporaryDirectory: false },
    new TeeOutput(() => undefined), () => undefined);
  assert.equal(await bridge.getContextDiagnostics(), result);
  assert.equal(reads, 1);
});
