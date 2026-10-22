import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { reminderWhen } from "./reminder-speech.js";
import type { PendingToolApproval } from "./tool-confirmation.js";
import { createTaskStore } from "./task-store.js";

const reminder = {
  kind: "reminder",
  source: "none",
  notification: "always",
  declarationVersion: 1,
} as const;

function usage() {
  return {
    inputTokens: { total: 8, noCache: 8, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 4, text: 4, reasoning: undefined },
  };
}

function textResponse(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "answer" },
        { type: "text-delta" as const, id: "answer", delta: text },
        { type: "text-end" as const, id: "answer" },
        { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage: usage() },
      ],
    }),
  };
}

function toolResponse(toolName: string, input: unknown, toolCallId: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "tool-call" as const, toolCallId, toolName, input: JSON.stringify(input) },
        { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage: usage() },
      ],
    }),
  };
}

function findReadback(value: unknown, seen = new Set<unknown>()): string | undefined {
  if (typeof value === "string") {
    if (!value.includes("readback")) return undefined;
    try {
      return findReadback(JSON.parse(value), seen);
    } catch {
      const match = /"readback":"([^"]*)"/.exec(value);
      return match?.[1];
    }
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return undefined;
  seen.add(value);
  if ("readback" in value && typeof value.readback === "string") return value.readback;
  for (const item of Object.values(value)) {
    const found = findReadback(item, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function waitForCard(
  getPending: () => PendingToolApproval | undefined,
  signal?: AbortSignal,
) {
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    if (signal?.aborted) return undefined;
    const pending = getPending();
    if (pending && pending.preview.includes("时间：")) return pending;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  if (signal?.aborted) return undefined;
  throw new Error(`reminder card missing: ${JSON.stringify(getPending()?.preview ?? null)}`);
}

async function cardOrResult<T extends { status: string; text: string }>(
  label: string,
  handle: { result: Promise<T> },
  getPending: () => PendingToolApproval | undefined,
  calls: number,
) {
  const stop = new AbortController();
  try {
    const early = await Promise.race([
      waitForCard(getPending, stop.signal).then((card) => ({ kind: "card" as const, card })),
      handle.result.then((result) => ({ kind: "result" as const, result })),
    ]);
    if (early.kind === "result" || early.card === undefined) {
      const result = early.kind === "result" ? early.result : undefined;
      throw new Error(`${label} ended before confirmation: ${result?.status ?? "missing"} ${result?.text ?? ""} calls=${calls}`);
    }
    return early.card;
  } finally {
    stop.abort();
  }
}

describe("natural-language reminder path", () => {
  it("selects the task tool, confirms time/repeat/text, and reads the result back in Chinese", async () => {
    const root = await mkdtemp(join(tmpdir(), "serika-reminder-loop-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify({
      version: 1,
      workspace,
      modules: { task: { enabled: true } },
    }));
    let calls = 0;
    let firstPrompt = "";
    let script: { toolName: string; input: unknown } = {
      toolName: "task_create",
      input: {
        prompt: "开会",
        runAt: new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString(),
        arrangement: reminder,
      },
    };
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        // Historical tool results stay in the prompt. Only the latest message
        // is this step's tool result; an older readback must not skip the next tool.
        const latest = Array.isArray(prompt) ? prompt.at(-1) : prompt;
        const readback = findReadback(latest);
        if (readback !== undefined) return textResponse(readback);
        if (firstPrompt.length === 0) firstPrompt = JSON.stringify(prompt);
        calls += 1;
        return toolResponse(script.toolName, script.input, `call-${calls}`);
      },
    });
    const output = new PassThrough();
    const app = await createRuntimeApp({
      directory: join(root, "transcripts"), assistant: { dataDirectory: join(workspace, ".runloom"), threadId: "reminder", configPath },
      modelAlias: "scripted",
      model,
      output,
      env: {},
      cwd: root,
    });
    const confirmation = app.toolConfirmation;
    assert.ok(confirmation);
    const store = createTaskStore(join(workspace, ".runloom/tasks.json"));
    try {
      const runAt = (script.input as { runAt: string }).runAt;
      const clock = { now: new Date(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
      const spoken = reminderWhen({ runAt, clock });
      const handle = await app.runtime.run({
        agentId: app.agentId,
        threadId: app.threadId,
        messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "明早九点提醒我开会" }] }],
      });
      const card = await cardOrResult("create", handle, () => confirmation.getPending(), calls);
      assert.match(firstPrompt, /kind: \\"reminder\\"/);
      assert.match(firstPrompt, /Do not ask「你想几点」/);
      assert.match(firstPrompt, /not an automation Hook/);
      assert.match(firstPrompt, /task_create/);
      assert.match(card.preview, new RegExp(`时间：${spoken.time.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(card.preview, /重复：不重复/);
      assert.match(card.preview, /内容：开会/);
      assert.doesNotMatch(card.preview, /"kind"/);
      // The fields the preview text was built from travel with it (display only).
      assert.deepEqual({ ...card.reminder, footnote: undefined }, { action: "save", time: spoken.time, repeat: "不重复", subject: "开会", footnote: undefined });
      assert.equal(confirmation.resolveApproval({ approvalId: card.approvalId, decision: "allow" }), true);
      const created = await handle.result;
      assert.equal(created.status, "completed");
      assert.match(created.text, /^已记下：.+提醒开会。.*后台当前不可用或尚未就绪/);
      assert.doesNotMatch(created.text, /runAt|task-/);
      const listed = await store.list({});
      assert.ok(listed.ok);
      assert.equal(listed.value.tasks.length, 1);
      const saved = await store.get(listed.value.tasks[0]!.id);
      assert.ok(saved.ok);
      assert.equal(saved.value.arrangement?.kind, "reminder");
      assert.equal(saved.value.prompt, "开会");
      assert.equal(saved.value.status, "scheduled");

      const later = new Date(Date.parse(saved.value.runAt) + 60 * 60 * 1000).toISOString();
      script = { toolName: "task_reschedule", input: { id: saved.value.id, runAt: later } };
      const reschedule = await app.runtime.run({
        agentId: app.agentId,
        threadId: app.threadId,
        messages: [{ id: "user-2", role: "user", parts: [{ type: "text", text: "改到十点" }] }],
      });
      const moved = await cardOrResult("reschedule", reschedule, () => confirmation.getPending(), calls);
      assert.match(moved.preview, /重复：不重复/);
      assert.match(moved.preview, /内容：开会/);
      assert.match(moved.preview, /原时间：/);
      assert.match(moved.preview, /允许这次改期？/);
      assert.equal(moved.reminder?.action, "reschedule");
      assert.match(moved.reminder?.previous ?? "", /（预览，不锁定这条提醒）$/);
      assert.equal(confirmation.resolveApproval({ approvalId: moved.approvalId, decision: "allow" }), true);
      const rescheduled = await reschedule.result;
      assert.equal(rescheduled.status, "completed");
      assert.match(rescheduled.text, /^已改到：.+提醒开会。.*后台当前不可用或尚未就绪/);
      const afterMove = await store.get(saved.value.id);
      assert.ok(afterMove.ok);
      assert.equal(afterMove.value.id, saved.value.id);
      assert.notEqual(afterMove.value.runAt, saved.value.runAt);

      script = { toolName: "task_cancel", input: { id: saved.value.id } };
      const cancel = await app.runtime.run({
        agentId: app.agentId,
        threadId: app.threadId,
        messages: [{ id: "user-3", role: "user", parts: [{ type: "text", text: "取消那个提醒" }] }],
      });
      const dropped = await cardOrResult("cancel", cancel, () => confirmation.getPending(), calls);
      assert.match(dropped.preview, /重复：不重复/);
      assert.match(dropped.preview, /内容：开会/);
      assert.match(dropped.preview, /允许这次取消？/);
      assert.equal(dropped.reminder?.action, "cancel");
      assert.equal(confirmation.resolveApproval({ approvalId: dropped.approvalId, decision: "allow" }), true);
      const cancelled = await cancel.result;
      assert.equal(cancelled.status, "completed");
      assert.match(cancelled.text, /^已取消：.+提醒开会$/);
      const afterCancel = await store.get(saved.value.id);
      assert.ok(afterCancel.ok);
      assert.equal(afterCancel.value.status, "cancelled");

      script = {
        toolName: "task_repeat_create",
        input: {
          prompt: "喝水",
          recurrence: { kind: "daily", time: "09:00", utcOffset: "+08:00" },
          arrangement: reminder,
        },
      };
      const daily = await app.runtime.run({
        agentId: app.agentId,
        threadId: app.threadId,
        messages: [{ id: "user-4", role: "user", parts: [{ type: "text", text: "每天九点提醒我喝水" }] }],
      });
      const repeating = await cardOrResult("repeat", daily, () => confirmation.getPending(), calls);
      assert.match(repeating.preview, /时间：9:00/);
      assert.match(repeating.preview, /重复：每天/);
      assert.match(repeating.preview, /内容：喝水/);
      assert.equal(confirmation.resolveApproval({ approvalId: repeating.approvalId, decision: "allow" }), true);
      const repeated = await daily.result;
      assert.equal(repeated.status, "completed");
      assert.match(repeated.text, /^已记下：每天 9:00 提醒喝水。.*后台当前不可用或尚未就绪/);
      const series = await store.listRecurring({});
      assert.ok(series.ok);
      assert.equal(series.value.recurringTasks[0]?.arrangement?.kind, "reminder");
    } finally {
      app.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
