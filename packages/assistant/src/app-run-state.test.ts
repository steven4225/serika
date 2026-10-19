import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";
import { AUTO_CONSOLIDATION_AGENT_ID } from "./consolidation.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Expected state was not reached");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Locks current behavior (docs/v2-pilot/run-context.md §4): the memory source
 * a memory write may quote is cleared at the start of every model step of
 * every agent, not only the primary one. Foreground and background Runs do not
 * overlap in the controller today, so this is forced here with a direct
 * runtime call. Changing it is a behavior change that needs its own approval.
 */
it("any agent's model step clears the current memory source of a foreground Run", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-run-state-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true, autoConsolidate: true, writePolicy: "review" } } }));
  const text = "我喜欢喝美式。";
  let callTool = true;
  const model = new MockLanguageModelV3({ doStream: async () => {
    const invoke = callTool; callTool = false;
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] },
      ...(invoke ? [{ type: "tool-call" as const, toolCallId: "remember", toolName: "memory_add", input: JSON.stringify({ text }) }] : []),
      { type: "finish" as const, finishReason: { unified: invoke ? "tool-calls" as const : "stop" as const, raw: undefined }, usage },
    ] }) };
  } });
  const app = await createRuntimeApp({ assistant: { threadId: "run-state", configPath }, directory: join(root, "transcripts"),
    modelAlias: "mock", model, output: new PassThrough(), env: {}, cwd: root });
  const controller = createAssistantController(app);
  try {
    assert.ok((await controller.run(`记住${text}`)).ok);
    await waitFor(() => controller.getSnapshot().pendingApproval !== null);
    // While the foreground memory write waits for approval, another agent takes a model step.
    const background = await app.runtime.run({ agentId: AUTO_CONSOLIDATION_AGENT_ID, threadId: "run-state-background", messages: [{
      id: "background-user", role: "user", parts: [{ type: "text", text: "别的线程里的消息" }],
    }] });
    await background.result;
    assert.equal(controller.confirm({ approvalId: controller.getSnapshot().pendingApproval!.approvalId, decision: "allow" }), true);
    await waitFor(() => controller.getSnapshot().state.kind === "idle");
    const saved = await app.memoryStore!.list(); assert.ok(saved.ok);
    assert.equal(saved.entries.length, 0, "the write lost its source");
    assert.match(JSON.stringify(await controller.getHistory()), /没有可绑定的当前用户消息/);
  } finally { await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
});
