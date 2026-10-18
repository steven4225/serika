import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import type { HomeSnapshot } from "@serika/assistant";
import { EMPTY_HOME_VIEW, homeView, type HomeView } from "./home-view.js";
import { presentHomeTaskItem, type ReminderSpeechClock } from "./reminder-copy.js";

/**
 * v2 pilot step 3: the Home panel is built from the structured snapshot. The
 * golden `__baseline__/home-view.json` was recorded with the removed text
 * parser (commit "build Home as a structured snapshot…"); the structured path
 * must show exactly the same time, sections and items for every Home branch.
 */
const fixtures = fileURLToPath(new URL("../../../../../packages/assistant/src/__baseline__/home-snapshots.json", import.meta.url));
const golden = fileURLToPath(new URL("./__baseline__/home-view.json", import.meta.url));
const taskRowsGolden = fileURLToPath(new URL("./__baseline__/home-task-rows.json", import.meta.url));

/** The fields the parser-era golden recorded; task lines now also carry structured fields. */
function parserEraFields(view: HomeView): HomeView {
  return { ...view, sections: view.sections.map(section => ({ ...section, items: section.items.map(({ kind, text }) => ({ kind, text })) })) };
}

it("v2 pilot baseline: Home panel view for every Home branch matches the parser-era golden", async () => {
  const snapshots = JSON.parse(await readFile(fixtures, "utf8")) as Record<string, HomeSnapshot>;
  const expected = JSON.parse(await readFile(golden, "utf8")) as Record<string, { time: string | null; sections: unknown[]; unparsed: string[] }>;
  assert.deepEqual(Object.keys(snapshots), Object.keys(expected));
  for (const [name, snapshot] of Object.entries(snapshots)) {
    const { unparsed, ...view } = expected[name]!;
    assert.deepEqual(unparsed, [], `${name}: the parser left nothing unrecognised, so dropping that branch loses nothing`);
    assert.deepEqual(parserEraFields(homeView(snapshot)), view, name);
  }
});

it("a cleared Home shows the loading state", () => {
  assert.deepEqual(homeView(null), EMPTY_HOME_VIEW);
});

const clock: ReminderSpeechClock = { now: new Date("2026-09-23T04:00:00.000Z"), timeZone: "Asia/Shanghai" };

/**
 * State events: the 本地任务 rows come from structured task fields instead of
 * parsing the task line. `__baseline__/home-task-rows.json` was recorded with
 * the removed line parser (`presentHomeTaskItem(text)`) for every Home branch.
 */
it("Home task rows from structured fields match the parser-era golden", async () => {
  const snapshots = JSON.parse(await readFile(fixtures, "utf8")) as Record<string, HomeSnapshot>;
  const expected = JSON.parse(await readFile(taskRowsGolden, "utf8")) as Record<string, unknown>;
  const actual: Record<string, unknown> = {};
  for (const [name, snapshot] of Object.entries(snapshots)) {
    const section = homeView(snapshot).sections.find(entry => entry.title === "本地任务");
    if (section) actual[name] = section.items.map(item => presentHomeTaskItem(item, clock));
  }
  assert.deepEqual(actual, expected);
});

it("Home task rows for other statuses and read errors match the parser-era rows", () => {
  // Expected rows recorded with the removed line parser from the same texts.
  const cases = [
    { item: { text: "running · r1 · 写周报 · runAt 2026-09-23T03:00:00Z", task: { status: "running" as const, id: "r1", prompt: "写周报", runAt: "2026-09-23T03:00:00Z", detail: null } },
      row: { primary: "写周报 · 今天 11:00 · 正在执行", detail: "编号 r1" } },
    { item: { text: "cancelled · c1 · 取消的提醒 · runAt 2026-09-22T01:00:00Z · CANCELLED: 用户取消", task: { status: "cancelled" as const, id: "c1", prompt: "取消的提醒", runAt: "2026-09-22T01:00:00Z", detail: "CANCELLED: 用户取消" } },
      row: { primary: "取消的提醒 · 2026年9月22日 9:00 · 已取消", detail: "编号 c1 · CANCELLED: 用户取消" } },
    { item: { text: "scheduled · s1 · 带 · 分隔的提醒 · runAt 2026-09-25T13:30:00Z", task: { status: "scheduled" as const, id: "s1", prompt: "带 · 分隔的提醒", runAt: "2026-09-25T13:30:00Z", detail: null } },
      row: { primary: "带 · 分隔的提醒 · 周五 21:30 · 已设好，到点提醒", detail: "编号 s1" } },
    { item: { text: "最近创建的 scheduled/running：读取失败（TASK_STORE_UNAVAILABLE: 不可用）。", taskList: "pending" as const },
      row: { primary: "即将到来的提醒：读取失败（TASK_STORE_UNAVAILABLE: 不可用）。", detail: null } },
    { item: { text: "未确认终态记录：读取失败（TASK_STORE_UNAVAILABLE: 不可用）。", taskList: "inbox" as const },
      row: { primary: "未确认终态记录：读取失败（TASK_STORE_UNAVAILABLE: 不可用）。", detail: null } },
  ];
  for (const { item, row } of cases) assert.deepEqual(presentHomeTaskItem(item, clock), row, item.text);
});
