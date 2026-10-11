import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskRecordV4 } from "@aisdk-agent/example-cli/dist/task-store.js";
import { createTaskDesktopNotifier } from "@aisdk-agent/example-cli/dist/task-worker-entry.js";
import type { RendererApi } from "../../shared/ui-contract.js";
import { createSavedTaskNoticeReader, readSavedTaskNotice } from "../../shared/saved-task-result.js";
import { SavedTaskNoticeView } from "./saved-task-notice.js";

const saved = (override: Partial<TaskRecordV4> = {}): TaskRecordV4 => ({
  id: "task-water", prompt: "不是正文来源", status: "completed", acknowledgedAt: null, notification: null,
  finishedAt: "2026-10-11T12:00:00Z", resultText: "该喝水了，起来活动一下。",
  arrangement: { kind: "reminder", source: "none", notification: "always", declarationVersion: 1 }, ...override,
}) as TaskRecordV4;
const port = (tasks: TaskRecordV4[], get = async (id: string) => tasks.find(task => task.id === id)!): Pick<RendererApi, "getTaskInbox" | "getScheduledTask"> => ({
  async getTaskInbox() { return { ok: true, value: { tasks: tasks.map(task => ({ ...task, promptPreview: task.prompt, resultPreview: "不使用缓存预览" })), truncated: false } }; },
  async getScheduledTask(id) { return { ok: true, value: await get(id) }; },
});

test("saved task banner reads latest persisted terminal detail without executing or marking read", async () => {
  const old = saved({ id: "older", finishedAt: "2026-10-11T10:00:00Z" });
  const current = saved();
  const before = JSON.stringify([old, current]);
  const record = await readSavedTaskNotice(port([old, current]));
  assert.equal(record, current);
  assert.equal(JSON.stringify([old, current]), before);
  const markup = renderToStaticMarkup(React.createElement(SavedTaskNoticeView, { task: record!, onOpen() {}, onDismiss() {} }));
  assert.match(markup, /该喝水了，起来活动一下。/);
  assert.doesNotMatch(markup, /不是正文来源|已送达|已提醒|task-water/);
  assert.match(markup, /收起定时结果提示，不标为已读/);
});

test("saved task banner rereads acknowledge state and rejects a replaced or nonterminal record", async () => {
  for (const changed of [{ acknowledgedAt: "2026-10-11T12:01:00Z" }, { status: "scheduled" as const }, { id: "foreign" }]) {
    assert.equal(await readSavedTaskNotice(port([saved()], async () => saved(changed))), null);
  }
  assert.equal(await readSavedTaskNotice(port([saved({ status: "running" })])), null);
  assert.equal(await readSavedTaskNotice(port([])), null);
});

test("saved task banner disposal drops delayed old workspace results and overlapping refreshes", async () => {
  let finish!: (task: TaskRecordV4) => void;
  let reads = 0;
  const published: (TaskRecordV4 | null)[] = [];
  const reader = createSavedTaskNoticeReader(port([saved()], async () => {
    reads++;
    return new Promise<TaskRecordV4>(resolve => { finish = resolve; });
  }), value => published.push(value), () => {});
  const first = reader.refresh();
  await Promise.resolve();
  await reader.refresh();
  assert.equal(reads, 1);
  reader.dispose();
  finish(saved({ resultText: "旧工作区的私密内容" }));
  await first;
  assert.deepEqual(published, []);
  await reader.refresh();
  assert.equal(reads, 1);
});

test("saved task banner keeps failure and interrupted labels and clearly clips long persisted results", () => {
  const view = (task: TaskRecordV4) => renderToStaticMarkup(React.createElement(SavedTaskNoticeView, { task, onOpen() {}, onDismiss() {} }));
  assert.match(view(saved({ status: "failed", resultText: null })), /执行失败/);
  assert.match(view(saved({ status: "interrupted", resultText: null })), /不会自动重做/);
  const long = view(saved({ resultText: "水".repeat(281) }));
  assert.match(long, /正文已截短/);
  assert.doesNotMatch(long, /水{281}/);
});

test("saved task banner mounts once per workspace with one cleaned up read timer and leaves OS privacy intact", async () => {
  const component = await readFile(new URL("./saved-task-notice.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
  assert.match(app, /<SavedTaskNotice key=\{`\$\{info.configPath\}:\$\{info.workspaceRoot\}`\}/);
  assert.match(app, /<SavedTaskNotice[^\n]*enabled=\{!!info.workspaceRoot\}/);
  assert.match(app, /<TaskInbox[^\n]*enabled=\{!!info\?\.workspaceRoot\} canAcknowledge=/);
  assert.match(component, /window\.setInterval\(onFocus, 15_000\)/);
  assert.match(component, /reader\.dispose\(\); window\.clearInterval\(timer\)/);
  assert.match(component, /if \(!document\.hidden\)/);
  assert.doesNotMatch(component, /acknowledgeTaskResult|\.run\(|\.command\(|new Notification/);
  let submitted = "";
  const notifier = createTaskDesktopNotifier(() => {}, { platform: "darwin", submit: async script => { submitted = script; } });
  await notifier(saved());
  assert.match(submitted, /task-water/);
  assert.doesNotMatch(submitted, /该喝水了|不是正文来源/);
});
