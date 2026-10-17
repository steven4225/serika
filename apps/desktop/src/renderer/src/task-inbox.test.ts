import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import type { TaskRecordV4 } from "@serika/assistant";
import { taskResultPresentation } from "./task-inbox.js";

const task = (overrides: Partial<TaskRecordV4> = {}) => ({ status: "completed", notification: null, ...overrides }) as TaskRecordV4;
test("saved reminder banner presentation contains the persisted result instead of only task id and completion", () => {
  const saved = task({ id: "task-water", prompt: "不是横幅来源", resultText: "该喝水了，起来活动一下。", acknowledgedAt: null,
    arrangement: { kind: "reminder", source: "none", notification: "always", declarationVersion: 1 } });
  assert.match(JSON.stringify(taskResultPresentation(saved)), /该喝水了，起来活动一下。/);
});
test("task inbox labels kinds without treating model completion or system submission as user receipt", () => {
  assert.equal(taskResultPresentation(task()).kind, "定时任务");
  assert.equal(taskResultPresentation(task({ arrangement: { kind: "reminder", source: "none", notification: "always", declarationVersion: 1 } })).kind, "提醒");
  assert.equal(taskResultPresentation(task({ arrangement: { kind: "todoist-brief", source: "todoist-planning", notification: "always", declarationVersion: 1 } })).kind, "Todoist 日报");
  assert.equal(taskResultPresentation(task({ arrangement: { kind: "rss-digest", source: "existing-rss-binding", notification: "new-items", declarationVersion: 1 } })).kind, "RSS 资讯");
  const skill = taskResultPresentation(task({ arrangement: { kind: "skill", source: "none", notification: "always", declarationVersion: 1, skillId: "brief", skillHash: "a".repeat(64) } }));
  assert.equal(skill.kind, "Skill brief");
  assert.doesNotMatch(skill.kind, /a{12}/);
  const submitted = taskResultPresentation(task({ notification: { status: "submitted", attempts: 1, nextAttemptAt: null, error: null } }));
  assert.equal(submitted.status, "执行结束");
  assert.match(submitted.notification, /已提交系统通知/);
  assert.match(submitted.notification, /不代表你已看到/);
  const omitted = taskResultPresentation(task({ notification: { status: "omitted", attempts: 1, nextAttemptAt: null, error: null } }));
  assert.match(omitted.notification, /前台省略/);
  assert.match(omitted.notification, /未向系统提交/);
  assert.doesNotMatch(omitted.notification, /已提交系统通知/);
  assert.match(taskResultPresentation(task({ status: "interrupted" })).status, /结果未确定/);
  assert.match(taskResultPresentation(task({ status: "failed" })).status, /失败/);
  assert.equal(taskResultPresentation(task()).notification, "未安排系统通知");
});

test("successful inbox/detail reads refresh the same workspace arrangements without polling or execution", async () => {
  const inbox = await readFile(new URL("./task-inbox.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
  const arrangements = await readFile(new URL("./automation-panel.tsx", import.meta.url), "utf8");
  assert.match(inbox, /if \(request !== generation\.current\) return;\s+if \(result\.ok\) \{ setPage\(result\.value\); onResultsRead\?\.\(\); \}/);
  assert.match(inbox, /if \(request !== generation\.current\) return;\s+if \(result\.ok\) \{ setDetail\(result\.value\); onResultOpened\?\.\(result\.value\); onResultsRead\?\.\(\); \}/);
  assert.match(app, /<TaskInbox key=\{`\$\{info\?\.configPath\}:\$\{info\?\.workspaceRoot\}`\}.*onResultsRead=\{\(\) => setAutomationRefresh\(value => value \+ 1\)\}/);
  assert.match(app, /<AutomationPanel.*refreshSequence=\{automationRefresh\}/);
  assert.match(arrangements, /lastRefresh\.current = refreshSequence;\s+void reload\(\);\s+\}, \[refreshSequence\]\)/);
  assert.match(arrangements, /setLoading\(true\); setError\(""\); setPreview\(null\)/);
  assert.doesNotMatch(inbox + arrangements, /setInterval\(/);
  assert.match(inbox, /提醒、日报、资讯和定时 Skill/);
});
