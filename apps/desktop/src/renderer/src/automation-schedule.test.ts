import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile } from "node:fs/promises";
import { skillSchedulePreview, automationStatuses, type SkillScheduleDraft } from "./automation-schedule.js";
import type { SkillSummary } from "@aisdk-agent/example-cli/dist/automation-execution.js";

const skill: SkillSummary = { id: "brief", description: "Short text", kind: "text",
  hash: "a".repeat(64), tools: [], limits: { maxSteps: 1, totalTimeoutMs: 120000, stepTimeoutMs: 30000 } } as unknown as SkillSummary;
const draft: SkillScheduleDraft = { skillId: "brief", input: "Make a brief", kind: "once", date: "2026-10-08", time: "21:30", weekday: 1, utcOffset: "+08:00" };

it("previews a pinned single occurrence without injecting context or permission fields", () => {
  const result = skillSchedulePreview([skill], draft, Date.parse("2026-10-07T00:00:00Z"));
  assert.deepEqual(result.input, { id: "brief", expectedHash: skill.hash, input: draft.input, runAt: "2026-10-08T21:30:00+08:00" });
  assert.match(result.label, /执行一次/);
  assert.throws(() => skillSchedulePreview([{ ...skill, kind: "memory-consolidate" }], draft), /记忆整理/);
  assert.throws(() => skillSchedulePreview([{ ...skill, tools: ["shell_exec"] }], draft), /无工具/);
  assert.throws(() => skillSchedulePreview([], draft), /请选择/);
});

it("uses fixed offsets for recurring plans and rejects impossible dates, input and stale times", () => {
  assert.deepEqual(skillSchedulePreview([skill], { ...draft, kind: "daily" }).input, { id: skill.id, expectedHash: skill.hash, input: draft.input, recurrence: { kind: "daily", time: "21:30", utcOffset: "+08:00" } });
  assert.deepEqual(skillSchedulePreview([skill], { ...draft, kind: "weekly", weekday: 7 }).input.recurrence, { kind: "weekly", weekday: 7, time: "21:30", utcOffset: "+08:00" });
  for (const invalid of [{ date: "2026-02-30" }, { input: "" }, { input: "中".repeat(1500) }, { utcOffset: "+14:01" }, { time: "24:00" }, { kind: "weekly" as const, weekday: 0 }]) assert.throws(() => skillSchedulePreview([skill], { ...draft, ...invalid }, 0));
  assert.throws(() => skillSchedulePreview([skill], draft, Date.parse("2026-10-09T00:00:00Z")), /未来/);
  assert.match(automationStatuses.interrupted!, /未确定/);
  assert.match(automationStatuses.scheduled!, /尚未执行/);
});

it("places unified arrangements in the existing workspace and invalidates stale workspace/Thread responses", async () => {
  const panel = await readFile(new URL("./automation-panel.tsx", import.meta.url), "utf8");
  const daily = await readFile(new URL("./daily-setup-panel.tsx", import.meta.url), "utf8");
  assert.match(daily, /<AutomationPanel.*info\.threadId/);
  assert.match(panel, /captured !== context\.current \|\| request !== generation\.current/);
  assert.match(panel, /message\.phase !== "primary"/);
  assert.match(panel, /重启后这里会清空/);
  assert.match(panel, /不会自动重试/);
  assert.match(panel, /href="#scheduled-results"/);
});
