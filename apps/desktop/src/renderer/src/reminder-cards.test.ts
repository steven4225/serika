import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createModuleHost, createTaskModule, formatReminderConfirmation } from "@serika/assistant/testing";
import type { PendingApproval } from "../../shared/ui-contract.js";
import { ApprovalCard } from "./approval.js";
import { presentReminderConfirmation } from "./reminder-copy.js";

/**
 * v2 pilot step 3 (reminder confirmation cards): every reminder y/n card the
 * task module can produce, with the card and markup the desktop shows for it.
 * `__baseline__/reminder-cards.json` was recorded with the text parser
 * (`presentReminderConfirmation` reading the preview). The module's card text
 * and the desktop card must stay exactly as recorded when the card moves to
 * structured fields. Record again with `RECORD_REMINDER_CARDS=1` only when
 * that is the intended change.
 */
const golden = fileURLToPath(new URL("./__baseline__/reminder-cards.json", import.meta.url));

const reminder = { kind: "reminder", source: "none", notification: "always", declarationVersion: 1 } as const;
const clock = { now: new Date("2026-10-10T02:00:00.000Z"), timeZone: "Asia/Shanghai" };
const daily = { kind: "daily", time: "09:00", utcOffset: "+08:00" } as const;
const weekly = { kind: "weekly", weekday: 7, time: "21:30", utcOffset: "+08:00" } as const;

type Status = { available: boolean; registered: boolean; running: boolean; todoistPlanningAvailable: boolean; message?: string };
type ModuleCase = {
  toolName: string;
  input: unknown;
  status?: Status | "throws";
  destination?: string;
};

const onceTasks: Record<string, { prompt: string; runAt: string }> = {
  "once-water": { prompt: "提醒我喝水", runAt: "2026-10-10T06:00:00.000Z" },
  "once-far": { prompt: "交房租", runAt: "2026-12-01T01:00:00.000Z" },
};
const series: Record<string, { prompt: string; recurrence: unknown }> = {
  "daily-standup": { prompt: "请提醒我 看 日程", recurrence: daily },
  "weekly-review": { prompt: "周复盘", recurrence: weekly },
};

function moduleFor(entry: ModuleCase) {
  const store = {
    get: async (id: string) => onceTasks[id]
      ? { ok: true, value: { id, status: "scheduled", arrangement: reminder, ...onceTasks[id] } }
      : { ok: false, error: { code: "TASK_NOT_FOUND", message: "missing" } },
    getRecurring: async (id: string) => series[id]
      ? { ok: true, value: { recurringTask: { id, status: "active", arrangement: reminder, ...series[id] } } }
      : { ok: false, error: { code: "TASK_NOT_FOUND", message: "missing" } },
  };
  const status = entry.status;
  return createModuleHost([createTaskModule(store as never, {
    now: () => clock.now,
    timeZone: clock.timeZone,
    ...(status === undefined ? {} : { automationStatus: async () => { if (status === "throws") throw new Error("down"); return status; } }),
    ...(entry.destination === undefined ? {} : { arrangementDestination: () => entry.destination! }),
  })], { notify() {} });
}

const running: Status = { available: true, registered: true, running: true, todoistPlanningAvailable: false };
const moduleCases: Record<string, ModuleCase> = {
  "save once, no background wiring": { toolName: "task_create", input: { prompt: "提醒我喝水", runAt: "2026-10-10T06:00:00.000Z", arrangement: reminder } },
  "save once tomorrow, background running, delivery destination": { toolName: "task_create", status: running, destination: "飞书群", input: { prompt: "开会", runAt: "2026-10-11T01:00:00.000Z", arrangement: reminder } },
  "save once this week, registered not running, two-line message": { toolName: "task_create", status: { ...running, running: false, message: "上次启动失败\n请检查权限" }, input: { prompt: "取快递", runAt: "2026-10-13T10:05:00.000Z", arrangement: reminder } },
  "save once far date, status read throws": { toolName: "task_create", status: "throws", input: { prompt: "交房租", runAt: "2026-12-01T01:00:00.000Z", arrangement: reminder } },
  "save once without runAt": { toolName: "task_create", status: running, input: { prompt: "  ", arrangement: reminder } },
  "save once, unparsable runAt": { toolName: "task_create", input: { prompt: "提醒一下 交周报", runAt: "下周某天", arrangement: reminder } },
  "save daily, not registered": { toolName: "task_repeat_create", status: { ...running, registered: false, running: false }, input: { prompt: "请提醒我 看 日程", recurrence: daily, arrangement: reminder } },
  "save weekly, background running, delivery destination": { toolName: "task_repeat_create", status: running, destination: "家庭群", input: { prompt: "周复盘", recurrence: weekly, arrangement: reminder } },
  "save repeat, invalid recurrence": { toolName: "task_repeat_create", input: { prompt: "浇花", recurrence: { kind: "monthly", time: "08:00" }, arrangement: reminder } },
  "reschedule today to tomorrow, with previous time": { toolName: "task_reschedule", input: { id: "once-water", runAt: "2026-10-11T00:30:00.000Z" } },
  "reschedule far date to this week, with previous time": { toolName: "task_reschedule", input: { id: "once-far", runAt: "2026-10-15T12:00:00.000Z" } },
  "cancel once": { toolName: "task_cancel", input: { id: "once-water" } },
  "cancel daily": { toolName: "task_repeat_cancel", input: { id: "daily-standup" } },
  "pause daily": { toolName: "task_repeat_pause", input: { id: "daily-standup" } },
  "pause weekly": { toolName: "task_repeat_pause", input: { id: "weekly-review" } },
  "resume weekly": { toolName: "task_repeat_resume", input: { id: "weekly-review" } },
};

/** Cards without a footnote: the module always adds one today, so these call the formatter directly. */
const bareCases: Record<string, { toolName: string; fields: Parameters<typeof formatReminderConfirmation>[0] }> = {
  "no footnote: save once": { toolName: "task_create", fields: { action: "save", prompt: "喝水", runAt: "2026-10-10T06:00:00.000Z", clock } },
  "no footnote: save daily": { toolName: "task_repeat_create", fields: { action: "save", prompt: "喝水", recurrence: daily, clock } },
  "no footnote: reschedule with previous time": { toolName: "task_reschedule", fields: { action: "reschedule", prompt: "开会", runAt: "2026-10-11T01:00:00.000Z", previousRunAt: "2026-10-10T06:00:00.000Z", clock } },
  "no footnote: cancel once": { toolName: "task_cancel", fields: { action: "cancel", prompt: "喝水", runAt: "2026-10-10T06:00:00.000Z", clock } },
  "no footnote: cancel weekly": { toolName: "task_repeat_cancel", fields: { action: "cancel", prompt: "周复盘", recurrence: weekly, clock } },
  "no footnote: pause daily": { toolName: "task_repeat_pause", fields: { action: "pause", prompt: "看日程", recurrence: daily, clock } },
  "no footnote: resume daily": { toolName: "task_repeat_resume", fields: { action: "resume", prompt: "看日程", recurrence: daily, clock } },
  "empty footnote: save once": { toolName: "task_create", fields: { action: "save", prompt: "喝水", runAt: "2026-10-10T06:00:00.000Z", clock, footnote: "" } },
};

type Recorded = { toolName: string; text: string; card: unknown; html: string };

function shown(toolName: string, input: unknown, text: string): Recorded {
  const approval: PendingApproval = { approvalId: "approval-golden", toolCallId: "call-golden", toolName, input, preview: text };
  const html = renderToStaticMarkup(createElement(ApprovalCard, { approval, deciding: false, onDecision: () => { throw new Error("render cannot authorize"); } }));
  return { toolName, text, card: presentReminderConfirmation(approval), html };
}

async function recordAll(): Promise<Record<string, Recorded>> {
  const actual: Record<string, Recorded> = {};
  for (const [name, entry] of Object.entries(moduleCases)) {
    const host = moduleFor(entry);
    const confirmation = host.toolPermissions.get(entry.toolName)?.confirmation;
    assert.ok(confirmation, `${name}: the task module declares a card for ${entry.toolName}`);
    const text = await confirmation({ toolName: entry.toolName, input: entry.input } as never);
    host.dispose();
    assert.equal(typeof text, "string", `${name}: a reminder card, not the generic one`);
    actual[name] = shown(entry.toolName, entry.input, text!);
  }
  for (const [name, entry] of Object.entries(bareCases)) {
    actual[name] = shown(entry.toolName, {}, formatReminderConfirmation(entry.fields));
  }
  return actual;
}

it("v2 pilot baseline: every reminder confirmation card matches the parser-era golden", async () => {
  const actual = await recordAll();
  if (process.env.RECORD_REMINDER_CARDS === "1") await writeFile(golden, `${JSON.stringify(actual, null, 2)}\n`);
  const expected = JSON.parse(await readFile(golden, "utf8")) as Record<string, Recorded>;
  assert.deepEqual(Object.keys(actual), Object.keys(expected));
  for (const [name, entry] of Object.entries(expected)) {
    assert.ok(entry.card, `${name}: the golden records a reminder card, not the generic fallback`);
    assert.deepEqual(actual[name], entry, name);
  }
});
