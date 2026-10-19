import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UIMessage } from "ai";
import type { AgentEvent, RunResult } from "@serika/core";
import type { ExecutionRunRecord, ExecutionToolRecord, MainToRenderer, UiState } from "../../shared/ui-contract.js";
import { annotateHistoryTools, overlayExecutionReceipts, rowsFromHistory, type ConversationRow, type ToolRow } from "./conversation.js";
import { createRuntimeStore } from "./app/runtime-store.js";
import { Row } from "./app/conversation-row.js";
import { PersonalTool } from "./personal/conversation.js";
import { compactWorkSummary, toolPresentation } from "./ui-kit/conversation-data.js";

/**
 * Golden samples for tool previews (toolInputFields and the tool-name tables),
 * and the parity of the two paths that build a tool row:
 * - run events: store.onRunEvent → applyEvent, then store.finishPrimaryRun → finishRun (what App shows during a run);
 * - history: rowsFromHistory → annotateHistoryTools (what App shows after reloadHistory).
 * The same call (input + output, or the same host error) goes through both.
 * The only fields allowed to differ are listed in PATH_FIELDS.
 * After the run, App shows the history rows with the run's execution receipts laid over them
 * (overlayExecutionReceipts); that third path keeps the same detail and error code.
 */

// app/conversation-row.tsx relies on the automatic JSX runtime from tsconfig.web.json and has no
// React import; the test runner compiles with the classic runtime, so give it the global it expects.
Object.assign(globalThis, { React });

const THREAD = "thread-1";
const RUN = "run-1";
const REQUESTED_AT = "2026-10-16T00:00:00Z";
/** Fields that tell the paths apart on purpose: the row key and the history marker ("历史记录" / "本次调用"). */
const PATH_FIELDS = ["key", "historical"] as const;

type HostError = { code: string; message: string };
interface Case {
  readonly name: string;
  readonly toolName: string;
  readonly input: unknown;
  /** The tool returned (history: output-available; events: tool.call.completed). */
  readonly output?: unknown;
  /** The host failed the call (history: output-error with `${code}: ${message}`; events: tool.call.failed). */
  readonly error?: HostError;
  /** Golden visible facts, identical on both paths. */
  readonly golden: Partial<ToolRow>;
  readonly presentation: { name: string; status: string; classic: string };
  /** compactWorkSummary(...).facts for this one row. */
  readonly facts: string;
}

const cases: readonly Case[] = [
  {
    name: "edit_file, returned ok",
    toolName: "edit_file",
    input: { path: "src/sum.js", oldText: "a - b", newText: "a + b" },
    output: { ok: true, path: "src/sum.js", bytes: 12 },
    golden: { inputPath: "src/sum.js", fileChange: { before: "a - b", after: "a + b", truncated: false }, status: "ok", outcomeSource: "full",
      receipt: { kind: "file", path: "src/sum.js", bytes: 12 } },
    presentation: { name: "编辑文件", status: "返回成功", classic: "编辑文件" },
    facts: "修改 1 个文件",
  },
  {
    name: "edit_file, long text: each side cut at 4000 characters without splitting a surrogate pair",
    toolName: "edit_file",
    input: { path: "big.txt", oldText: "o".repeat(4_001), newText: `${"n".repeat(3_999)}😀tail` },
    output: { ok: true, path: "big.txt", bytes: 4_005 },
    golden: { inputPath: "big.txt", fileChange: { before: "o".repeat(4_000), after: "n".repeat(3_999), truncated: true }, status: "ok",
      receipt: { kind: "file", path: "big.txt", bytes: 4_005 } },
    presentation: { name: "编辑文件", status: "返回成功", classic: "编辑文件" },
    facts: "修改 1 个文件",
  },
  {
    name: "write_file, returned ok: content only, no before",
    toolName: "write_file",
    input: { path: "notes/a.md", content: "# 标题\n内容" },
    output: { ok: true, path: "notes/a.md", bytes: 15 },
    golden: { inputPath: "notes/a.md", fileChange: { after: "# 标题\n内容", truncated: false }, status: "ok",
      receipt: { kind: "file", path: "notes/a.md", bytes: 15 } },
    presentation: { name: "写入文件", status: "返回成功", classic: "写入文件" },
    facts: "修改 1 个文件",
  },
  {
    name: "write_file, the tool returned a failure: intent kept, no receipt, no changed file",
    toolName: "write_file",
    input: { path: "bin.dat", content: "a\u0000b" },
    output: { ok: false, error: { code: "NOT_TEXT", message: "Content must not contain NUL bytes" } },
    golden: { inputPath: "bin.dat", fileChange: { after: "a\u0000b", truncated: false }, status: "failed", errorCode: "NOT_TEXT",
      detail: "NOT_TEXT: Content must not contain NUL bytes", receipt: undefined },
    presentation: { name: "写入文件", status: "失败", classic: "写入文件" },
    facts: "",
  },
  {
    name: "edit_file, denied by the host before it ran",
    toolName: "edit_file",
    input: { path: "src/sum.js", oldText: "a - b", newText: "a + b" },
    error: { code: "TOOL_DENIED", message: "用户拒绝了这次修改" },
    golden: { inputPath: "src/sum.js", fileChange: { before: "a - b", after: "a + b", truncated: false }, status: "denied", outcomeSource: "full", receipt: undefined, detail: "TOOL_DENIED: 用户拒绝了这次修改", errorCode: "TOOL_DENIED" },
    presentation: { name: "编辑文件", status: "已拒绝", classic: "编辑文件" },
    facts: "",
  },
  {
    name: "edit_file, denied with the host's default message",
    toolName: "edit_file",
    input: { path: "src/sum.js", oldText: "a - b", newText: "a + b" },
    error: { code: "TOOL_DENIED", message: "Tool execution denied: edit_file" },
    golden: { inputPath: "src/sum.js", fileChange: { before: "a - b", after: "a + b", truncated: false }, status: "denied", outcomeSource: "full", receipt: undefined, detail: "TOOL_DENIED: Tool execution denied: edit_file", errorCode: "TOOL_DENIED" },
    presentation: { name: "编辑文件", status: "已拒绝", classic: "编辑文件" },
    facts: "",
  },
  {
    name: "edit_file without newText: invalid input, no file-change preview",
    toolName: "edit_file",
    input: { path: "src/sum.js", oldText: "a - b" },
    error: { code: "TOOL_INVALID_INPUT", message: "Tool input is invalid: edit_file." },
    golden: { inputPath: "src/sum.js", fileChange: undefined, status: "failed", detail: "TOOL_INVALID_INPUT: Tool input is invalid: edit_file.", errorCode: "TOOL_INVALID_INPUT" },
    presentation: { name: "编辑文件", status: "失败", classic: "编辑文件" },
    facts: "",
  },
  {
    name: "write_file with non-string content: path only",
    toolName: "write_file",
    input: { path: "notes/a.md", content: 42 },
    error: { code: "TOOL_INVALID_INPUT", message: "Tool input is invalid: write_file." },
    golden: { inputPath: "notes/a.md", fileChange: undefined, status: "failed", detail: "TOOL_INVALID_INPUT: Tool input is invalid: write_file.", errorCode: "TOOL_INVALID_INPUT" },
    presentation: { name: "写入文件", status: "失败", classic: "写入文件" },
    facts: "",
  },
  {
    name: "write_file given edit_file fields: only content counts, never a before",
    toolName: "write_file",
    input: { path: "notes/a.md", content: "新内容", oldText: "旧内容", newText: "别的" },
    error: { code: "TOOL_INVALID_INPUT", message: "Tool input is invalid: write_file." },
    golden: { inputPath: "notes/a.md", fileChange: { after: "新内容", truncated: false }, status: "failed", detail: "TOOL_INVALID_INPUT: Tool input is invalid: write_file.", errorCode: "TOOL_INVALID_INPUT" },
    presentation: { name: "写入文件", status: "失败", classic: "写入文件" },
    facts: "",
  },
  {
    name: "read_file, returned ok: content preview and receipt, no file change",
    toolName: "read_file",
    input: { path: "notes/a.md" },
    output: { ok: true, path: "notes/a.md", content: "第一行\n第二行", bytes: 19 },
    golden: { inputPath: "notes/a.md", fileChange: undefined, fileContent: { text: "第一行\n第二行", truncated: false }, status: "ok",
      receipt: { kind: "file", path: "notes/a.md", bytes: 19 } },
    presentation: { name: "读取文件", status: "返回成功", classic: "读取文件" },
    facts: "",
  },
  {
    name: "read_file, file not found (returned by the tool)",
    toolName: "read_file",
    input: { path: "missing.md" },
    output: { ok: false, error: { code: "FILE_NOT_FOUND", message: "File not found: missing.md" } },
    golden: { inputPath: "missing.md", status: "failed", errorCode: "FILE_NOT_FOUND", detail: "FILE_NOT_FOUND: File not found: missing.md", fileContent: undefined, receipt: undefined },
    presentation: { name: "读取文件", status: "文件不存在", classic: "读取文件" },
    facts: "",
  },
  {
    name: "list_directory, returned ok: entries preview, no receipt",
    toolName: "list_directory",
    input: { path: "." },
    output: { ok: true, path: ".", entries: [{ name: "src", type: "directory" }, { name: "a.md", type: "file" }] },
    golden: { inputPath: ".", fileContent: { text: "▸ src\n  a.md", truncated: false }, status: "ok", receipt: undefined },
    // The classic layout's label table has no list_directory entry and shows the tool id (unchanged here).
    presentation: { name: "查看目录", status: "返回成功", classic: "list_directory" },
    facts: "",
  },
  {
    name: "search_files, returned ok: path scope only, no content preview, no receipt",
    toolName: "search_files",
    input: { query: "TODO", path: "src" },
    output: { ok: true, matches: [{ path: "src/a.ts", line: 3, text: "// TODO: tidy" }], truncated: false, skippedOversize: 0 },
    golden: { inputPath: "src", fileContent: undefined, fileChange: undefined, status: "ok", receipt: undefined },
    // The classic layout's label table has no search_files entry and shows the tool id (unchanged here).
    presentation: { name: "查找文件", status: "返回成功", classic: "search_files" },
    facts: "",
  },
  {
    name: "shell_exec, returned ok: command and cwd, never a path or file change",
    toolName: "shell_exec",
    input: { command: "pnpm test", cwd: "apps/desktop", path: "ignored.txt", content: "ignored" },
    output: { ok: true, exitCode: 0, timedOut: false, cancelled: false, output: "passed" },
    golden: { inputCommand: "pnpm test", inputCwd: "apps/desktop", inputPath: undefined, fileChange: undefined, status: "ok", output: "passed", exitCode: 0,
      timedOut: false, cancelled: false },
    presentation: { name: "运行命令", status: "返回成功", classic: "运行命令" },
    facts: "1 次命令",
  },
];

const event = (sequence: number, type: string, data: unknown): MainToRenderer =>
  ({ type: "event", phase: "primary", event: { id: `e${sequence}`, type, occurredAt: REQUESTED_AT, runId: RUN, threadId: THREAD, sequence, data } as unknown as AgentEvent });

/** Run-event path, through the runtime store as App uses it. */
function eventRow(sample: Case): ToolRow {
  const store = createRuntimeStore({ bridge: () => ({ snapshot: () => new Promise(() => {}), getRun: async () => ({ ok: true, run: null }) }) });
  store.onRunState({ kind: "running", runId: RUN, phase: "primary" } as UiState, () => true);
  const call = { toolCallId: "call-1", toolName: sample.toolName };
  for (const message of [
    event(1, "tool.call.requested", { ...call, input: sample.input }),
    sample.error ? event(2, "tool.call.failed", { ...call, error: { ...sample.error, retryable: false, phase: "tool" } }) : event(2, "tool.call.completed", { ...call, output: sample.output }),
  ]) if (message.type === "event") store.onRunEvent(message);
  store.finishPrimaryRun({ runId: RUN, threadId: THREAD, status: "completed", text: "", steps: 1, usage: {} as RunResult["usage"] });
  return onlyTool(store.getState().live.rows);
}

/** The execution receipt for the call: a failed call keeps the message only, plus errorCode for TOOL_DENIED (execution-record-store). */
function receiptRun(sample: Case): ExecutionRunRecord {
  const path = (sample.input as { path?: unknown }).path;
  const tool = { toolCallId: "call-1", toolName: sample.toolName, status: sample.error ? "failed" : "completed", requestedAt: REQUESTED_AT, startedAt: null, finishedAt: null,
    inputPreview: JSON.stringify(sample.input), inputTruncated: false, resultPreview: null, resultTruncated: false, errorPreview: sample.error?.message ?? null, shell: null,
    ...(sample.error?.code === "TOOL_DENIED" ? { errorCode: "TOOL_DENIED" } : {}),
    ...(typeof path === "string" && sample.toolName !== "shell_exec" ? { fileInput: { path } } : {}) } as ExecutionToolRecord;
  return { runId: RUN, threadId: THREAD, phase: "primary", status: "completed", startedAt: REQUESTED_AT, finishedAt: REQUESTED_AT,
    resultTextPreview: null, resultTextTruncated: false, errorPreview: null, tools: [tool] } as ExecutionRunRecord;
}

/** History path, as reloadHistory builds it (with the matching execution receipt). */
function historyRows(sample: Case): ConversationRow[] {
  const part = sample.error
    ? { type: "dynamic-tool", toolName: sample.toolName, toolCallId: "call-1", state: "output-error", input: sample.input, errorText: `${sample.error.code}: ${sample.error.message}` }
    : { type: "dynamic-tool", toolName: sample.toolName, toolCallId: "call-1", state: "output-available", input: sample.input, output: sample.output };
  const messages = [{ id: "m1", role: "assistant", parts: [part] }] as unknown as UIMessage[];
  return annotateHistoryTools(rowsFromHistory(messages), [receiptRun(sample)], THREAD);
}
const historyRow = (sample: Case): ToolRow => onlyTool(historyRows(sample));

/** After the run: App's rows, the reread history with this completed run's receipts laid over it. */
function afterRunRow(sample: Case): ToolRow {
  return onlyTool(overlayExecutionReceipts(historyRows(sample), receiptRun(sample).tools, { reuseHistory: true, runId: RUN }));
}

function onlyTool(rows: readonly ConversationRow[]): ToolRow {
  const tools = rows.filter((row): row is ToolRow => row.kind === "tool");
  assert.equal(tools.length, 1);
  return tools[0]!;
}

/** Drop the path fields; undefined-valued keys count as absent. */
function comparable(row: ToolRow): Record<string, unknown> {
  const skip = new Set<string>(PATH_FIELDS);
  return Object.fromEntries(Object.entries(row).filter(([key, value]) => !skip.has(key) && value !== undefined));
}

const pick = (row: ToolRow, keys: readonly string[]) => Object.fromEntries(keys.map(key => [key, (row as unknown as Record<string, unknown>)[key]]));
const html = (row: ToolRow) => [
  renderToStaticMarkup(createElement(Row, { row })),
  renderToStaticMarkup(createElement(PersonalTool, { row })),
].join("\n");

describe("tool preview golden samples: run events and history give the same row", () => {
  for (const sample of cases) {
    it(sample.name, () => {
      const live = eventRow(sample);
      const saved = historyRow(sample);

      // The path fields, exactly.
      assert.equal(live.key, "t:call-1");
      assert.equal(saved.key, "h:m1:call-1");
      assert.equal(live.historical, undefined);
      assert.equal(saved.historical, true);
      // Run ownership and time: from the event on one path, from the unique matching receipt on the other.
      for (const row of [live, saved]) {
        assert.equal(row.runId, RUN);
        assert.equal(row.recordedAt, REQUESTED_AT);
        assert.equal(row.toolName, sample.toolName);
      }

      // Golden facts, on both paths.
      const goldenKeys = Object.keys(sample.golden);
      assert.deepEqual(pick(live, goldenKeys), sample.golden, "run-event path");
      assert.deepEqual(pick(saved, goldenKeys), sample.golden, "history path");

      // Parity: every other field is equal.
      assert.deepEqual(comparable(saved), comparable(live));
      // After the run, the receipts overlay keeps the same status, detail and error code.
      assert.deepEqual(pick(afterRunRow(sample), ["status", "detail", "errorCode"]), pick(saved, ["status", "detail", "errorCode"]), "after-run receipts overlay");
      // A denied call is still denied when only its receipt is left (no history row to keep).
      if (sample.error?.code === "TOOL_DENIED") {
        assert.equal(onlyTool(overlayExecutionReceipts([], receiptRun(sample).tools, { reuseHistory: false, runId: RUN })).status, "denied", "receipt only");
      }

      // Tool-name tables, on both paths.
      for (const row of [live, saved]) {
        const presented = toolPresentation(row);
        assert.deepEqual({ name: presented.name, status: presented.status }, { name: sample.presentation.name, status: sample.presentation.status });
        assert.match(renderToStaticMarkup(createElement(Row, { row })), new RegExp(`<strong>${sample.presentation.classic}</strong>|>${sample.presentation.classic}<`));
        assert.equal(compactWorkSummary([row], false, false).facts, sample.facts);
      }

      // Rendered HTML (classic, personal): equal apart from the history marker.
      assert.equal(html(saved), html(live).replaceAll("本次调用", "历史记录"));
    });
  }

  it("file-change preview wording: before/after for edit_file, content only for write_file, truncation notice", () => {
    const [edit, long, write] = cases.map(eventRow);
    const personal = (row: ToolRow) => renderToStaticMarkup(createElement(PersonalTool, { row }));
    assert.match(personal(edit!), /<small>替换前<\/small><pre class="change-before">a - b<\/pre><small>替换后<\/small><pre class="change-after">a \+ b<\/pre>/);
    assert.doesNotMatch(personal(edit!), /修改预览已截断/);
    assert.match(personal(long!), /修改预览已截断/);
    assert.match(personal(write!), /<small>写入内容<\/small><pre class="change-after"># 标题\n内容<\/pre>/);
    assert.doesNotMatch(personal(write!), /替换前/);
  });
});
