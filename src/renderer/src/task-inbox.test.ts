import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskRecordV4 } from "@aisdk-agent/example-cli/dist/task-store.js";
import { taskResultPresentation } from "./task-inbox.js";

const task = (overrides: Partial<TaskRecordV4> = {}) => ({ status: "completed", notification: null, ...overrides }) as TaskRecordV4;
test("task inbox labels kinds without treating model completion or system submission as user receipt", () => {
  assert.equal(taskResultPresentation(task()).kind, "定时任务");
  assert.equal(taskResultPresentation(task({ arrangement: { kind: "reminder", source: "none", notification: "always", declarationVersion: 1 } })).kind, "提醒");
  assert.equal(taskResultPresentation(task({ arrangement: { kind: "todoist-brief", source: "todoist-planning", notification: "always", declarationVersion: 1 } })).kind, "Todoist 日报");
  assert.equal(taskResultPresentation(task({ arrangement: { kind: "rss-digest", source: "existing-rss-binding", notification: "new-items", declarationVersion: 1 } })).kind, "RSS 资讯");
  const submitted = taskResultPresentation(task({ notification: { status: "submitted", attempts: 1, nextAttemptAt: null, error: null } }));
  assert.equal(submitted.status, "执行结束");
  assert.match(submitted.notification, /不代表你已看到/);
  assert.match(taskResultPresentation(task({ status: "interrupted" })).status, /结果未确定/);
  assert.match(taskResultPresentation(task({ status: "failed" })).status, /失败/);
  assert.equal(taskResultPresentation(task()).notification, "未安排系统通知");
});
