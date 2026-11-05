import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExecutionRunRecord, ExecutionToolRecord } from "@serika/assistant";
import { telegramRunResult } from "./telegram-run-result.js";

const tool: ExecutionToolRecord = { toolCallId: "fixture-tool", toolName: "read_file", status: "failed", requestedAt: "2026-11-05T00:00:00.000Z",
  startedAt: null, finishedAt: null, inputPreview: "sensitive input", inputTruncated: false, resultPreview: "sensitive result", resultTruncated: false,
  errorPreview: "sensitive error", shell: null };
const run: ExecutionRunRecord = { runId: "fixture-run", threadId: "fixture-thread", phase: "primary", status: "failed",
  startedAt: "2026-11-05T00:00:00.000Z", finishedAt: "2026-11-05T00:00:01.000Z", resultTextPreview: null, resultTextTruncated: false,
  errorPreview: "MODEL_TIMEOUT fake sensitive error", tools: [] };

it("TG failure reasons use structured host codes without reading arbitrary previews", () => {
  assert.equal(telegramRunResult({ run, task: false }).body, "本次请求未完成。\n本轮未执行工具操作。");
  const result = telegramRunResult({ run: { ...run, errorCode: "MODEL_TIMEOUT", tools: [{ ...tool, errorCode: "PATH_OUTSIDE_WORKSPACE" }] }, task: false });
  assert.equal(result.body, "模型回复超时，本次请求未完成。\n工具记录：失败 1 次。\n目标路径尚未授权");
  assert.doesNotMatch(result.body, /sensitive|fixture|read_file/);
});

it("TG operation summaries aggregate bounded receipts and never equate returned calls with task success", () => {
  const result = telegramRunResult({ run: { ...run, tools: Array.from({ length: 1024 }, (_, index) => ({ ...tool,
    toolCallId: `call-${index}`, status: "completed", errorCode: "untrusted error code" })) }, task: false });
  assert.equal(result.body, "本次请求未完成。\n工具记录：失败 1024 次。");
  assert.doesNotMatch(result.body, /成功|sensitive|untrusted/);
});

it("TG does not display unverified model prose when effects are unknown, including live output", () => {
  const result = telegramRunResult({ run: { ...run, status: "completed", tools: [{ ...tool, status: "unknown" }] }, text: "已经保存成功", task: false });
  assert.equal(result.uncertain, true);
  assert.equal(result.body, "有工具操作的效果尚未确认；不会自动重做。\n工具记录：效果未知 1 次。");
  assert.doesNotMatch(result.body, /已经保存成功/);
});

it("TG completed Runs still show host-recorded tool rejection beside ordinary model text", () => {
  const result = telegramRunResult({ run: { ...run, status: "completed", tools: [{ ...tool, status: "completed", errorCode: "PATH_OUTSIDE_WORKSPACE" }] },
    text: "请稍后再试", task: false });
  assert.equal(result.body, "工具记录：失败 1 次。\n目标路径尚未授权\n请稍后再试");
});
