import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskRecordV4 } from "@serika/assistant";
import { createTaskDesktopNotifier } from "@serika/assistant/testing";
import type { RendererApi } from "../../shared/ui-contract.js";
import { createSavedTaskNoticeReader, createTaskNoticeDismissals, readSavedTaskNotice } from "../../shared/saved-task-result.js";
import { SavedTaskNoticeView } from "./saved-task-notice.js";

const saved = (override: Partial<TaskRecordV4> = {}): TaskRecordV4 => ({
  id: "task-water", prompt: "不是正文来源", status: "completed", acknowledgedAt: null, notification: null,
  runAt: "2026-10-11T11:59:00Z", finishedAt: "2026-10-11T12:00:00Z", resultText: "该喝水了，起来活动一下。",
  arrangement: { kind: "reminder", source: "none", notification: "always", declarationVersion: 1 }, ...override,
}) as TaskRecordV4;
const port = (tasks: TaskRecordV4[], get = async (id: string) => tasks.find(task => task.id === id)!): Pick<RendererApi, "getTaskInbox" | "getScheduledTask"> => ({
  async getTaskInbox() { return { ok: true, value: { tasks: tasks.map(task => ({ ...task, promptPreview: task.prompt, resultPreview: "不使用缓存预览" })), truncated: false } }; },
  async getScheduledTask(id) { return { ok: true, value: await get(id) }; },
});

test("saved banner surfaces persisted notification failure and an OS settings entry without rerunning", () => {
  const task = saved({ notification: { status: "failed", attempts: 1, submittedAt: null, error: { code: "NOTIFICATION_FAILED", message: "permission denied" } } as TaskRecordV4["notification"] });
  const before = JSON.stringify(task);
  const html = renderToStaticMarkup(React.createElement(SavedTaskNoticeView, { task, onOpen() {}, onDismiss() {} }));
  assert.match(html, /系统通知.*失败/);
  assert.match(html, /打开系统通知设置/);
  assert.doesNotMatch(html, /permission denied|NOTIFICATION_FAILED/);
  assert.equal(JSON.stringify(task), before);
});

test("saved task banner reads latest persisted terminal detail without executing or marking read", async () => {
  const old = saved({ id: "older", finishedAt: "2026-10-11T10:00:00Z" });
  const current = saved();
  const before = JSON.stringify([old, current]);
  const record = await readSavedTaskNotice(port([old, current]));
  assert.equal(record, current);
  assert.equal(JSON.stringify([old, current]), before);
  const markup = renderToStaticMarkup(React.createElement(SavedTaskNoticeView, { task: record!, onOpen() {}, onDismiss() {} }));
  assert.match(markup, /saved-task-notice-title">该喝水了，起来活动一下。</);
  assert.match(markup, /saved-task-notice-meta">提醒 · 执行结束 · 结束时间 <time datetime="2026-10-11T12:00:00Z">/i);
  assert.match(markup, /class="allow">查看</);
  assert.match(markup, /收起定时结果提示，不标为已读/);
  assert.doesNotMatch(markup, /不是正文来源|已送达|已提醒|task-water|查看结果/);
});

test("saved task banner renders persisted end time with year for each actual terminal status", () => {
  for (const status of ["completed", "failed", "interrupted"] as const) {
    const task = saved({ status, finishedAt: "2027-01-01T00:01:00Z" });
    const before = JSON.stringify(task);
    const markup = renderToStaticMarkup(React.createElement(SavedTaskNoticeView, { task, onOpen() {}, onDismiss() {} }));
    assert.match(markup, /结束时间/);
    const renderedTime = markup.match(/<time datetime="2027-01-01T00:01:00Z">([^<]*)<\/time>/i)?.[1];
    assert.ok(renderedTime);
    const local = new Date(task.finishedAt!);
    assert.ok(renderedTime.includes(String(local.getFullYear())));
    assert.ok(renderedTime.includes([local.getHours(), local.getMinutes(), local.getSeconds()]
      .map(value => String(value).padStart(2, "0")).join(":")));
    assert.doesNotMatch(markup, /计划时间|2026-10-11T11:59:00Z/);
    assert.equal(JSON.stringify(task), before);
  }
});

test("saved task banner labels scheduled fallback honestly instead of inventing completion time", () => {
  const view = (task: TaskRecordV4) => renderToStaticMarkup(React.createElement(SavedTaskNoticeView, { task, onOpen() {}, onDismiss() {} }));
  for (const finishedAt of [null, "invalid"]) {
    const markup = view(saved({ finishedAt }));
    assert.match(markup, /计划时间/);
    assert.match(markup, /<time datetime="2026-10-11T11:59:00Z">[^<]*2026[^<]*<\/time>/i);
    assert.match(markup, /结束时间未记录/);
  }
  const missing = view(saved({ finishedAt: null, runAt: "invalid" }));
  assert.match(missing, /时间未记录/);
  assert.doesNotMatch(missing, /<time|Invalid Date|NaN/);
});

test("saved task banner rereads acknowledge state and rejects a replaced or nonterminal record", async () => {
  for (const changed of [{ acknowledgedAt: "2026-10-11T12:01:00Z" }, { status: "scheduled" as const }, { id: "foreign" }]) {
    assert.equal(await readSavedTaskNotice(port([saved()], async () => saved(changed))), null);
  }
  assert.equal(await readSavedTaskNotice(port([saved({ status: "running" })])), null);
  assert.equal(await readSavedTaskNotice(port([])), null);
});

test("a dismissed result stays out of the banner without changing its unread record", async () => {
  const task = saved();
  const before = JSON.stringify(task);
  assert.equal(await readSavedTaskNotice(port([task]), () => true), null);
  assert.equal(JSON.stringify(task), before);
});

test("banner dismissal survives remount, is workspace scoped, and does not hide a later occurrence", async () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const task = saved();
  const before = JSON.stringify(task);
  const alreadyMounted = createTaskNoticeDismissals(storage, "/workspace-a");
  createTaskNoticeDismissals(storage, "/workspace-a").dismiss(task);
  assert.equal(alreadyMounted.has(task), true, "opening from the inbox updates an already mounted banner");
  const reopened = createTaskNoticeDismissals(storage, "/workspace-a");
  assert.equal(await readSavedTaskNotice(port([task]), reopened.has), null);
  assert.equal(createTaskNoticeDismissals(storage, "/workspace-b").has(task), false);
  const later = saved({ finishedAt: "2026-10-12T12:00:00Z" });
  assert.equal(await readSavedTaskNotice(port([later]), reopened.has), later);
  assert.equal(JSON.stringify(task), before);
  assert.doesNotMatch(JSON.stringify([...values]), /该喝水了|不是正文来源/);
});

test("unavailable preference storage still permits window-local dismissal", () => {
  const dismissals = createTaskNoticeDismissals({ getItem() { throw new Error("unavailable"); }, setItem() { throw new Error("unavailable"); } }, "/workspace");
  assert.equal(dismissals.has(saved()), false);
  dismissals.dismiss(saved());
  assert.equal(dismissals.has(saved()), true);
});

test("viewing the result also dismisses its banner without executing the task", () => {
  const actions: string[] = [];
  const view = SavedTaskNoticeView({ task: saved(), onOpen: id => { actions.push(id); }, onDismiss: () => { actions.push("dismiss"); } });
  const buttons = view.props.children.at(-1).props.children;
  buttons[0].props.onClick();
  assert.deepEqual(actions, ["task-water", "dismiss"]);
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

test("saved task banner keeps failure and interrupted titles and leaves long results for the inbox", () => {
  const view = (task: TaskRecordV4) => renderToStaticMarkup(React.createElement(SavedTaskNoticeView, { task, onOpen() {}, onDismiss() {} }));
  const failed = view(saved({ status: "failed", resultText: null }));
  assert.match(failed, /这次安排没有完成/);
  assert.match(failed, /执行失败/);
  const interrupted = view(saved({ status: "interrupted", resultText: null }));
  assert.match(interrupted, /安排中断，不会自动重做/);
  assert.match(interrupted, /执行中断，结果未确定/);
  const long = view(saved({ resultText: "水".repeat(281) }));
  assert.doesNotMatch(long, /task-water/);
  assert.match(long, /saved-task-notice-title">水{41}…</);
  assert.doesNotMatch(long, /水{42}/);
  assert.match(long, /class="allow">查看</);
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
  assert.match(submitted, /with title "提醒时间到了"/);
  assert.doesNotMatch(submitted, /该喝水了|起来活动一下/);
  assert.match(submitted, /提醒已到，详情在收件箱。/);
  assert.doesNotMatch(submitted, /task-water|不是正文来源/);
});
