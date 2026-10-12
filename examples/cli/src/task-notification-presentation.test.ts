import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TaskRecord } from "./task-store.js";
import { taskNotificationCopy } from "./task-notification-copy.js";
import { readDesktopFrontmost, writeDesktopFrontmost } from "./task-notification-presentation.js";

const task = (override: Partial<TaskRecord> = {}): TaskRecord => ({
  id: "task-water", prompt: "sensitive preference", runAt: "2026-10-11T11:59:00.000Z", status: "completed",
  createdAt: "2026-10-11T11:00:00.000Z", startedAt: "2026-10-11T12:00:00.000Z", finishedAt: "2026-10-11T12:00:00.000Z",
  threadId: "thread", runId: null, resultText: "private workspace memory", error: null, ...override,
});

describe("task notification copy", () => {
  it("keeps reminder prompt and saved result private on the lock screen", () => {
    for (const resultText of ["私密用药内容", null]) {
      const copy = taskNotificationCopy(task({ prompt: "私密银行内容", resultText,
        arrangement: { kind: "reminder", source: "none", notification: "always", declarationVersion: 1 } }));
      assert.deepEqual(copy, { title: "提醒时间到了", body: "提醒已到，详情在收件箱。" });
      assert.doesNotMatch(JSON.stringify(copy), /私密|task-water|sensitive preference|private workspace memory/);
    }
  });

  it("uses a reminder status title and keeps all results out of the lock screen", () => {
    const reminder = taskNotificationCopy(task({
      prompt: "不是通知来源", resultText: "该喝水了，起来活动一下。",
      arrangement: { kind: "reminder", source: "none", notification: "always", declarationVersion: 1 },
    }));
    assert.equal(reminder.title, "提醒时间到了");
    assert.equal(reminder.body, "提醒已到，详情在收件箱。");
    assert.doesNotMatch(`${reminder.title}\n${reminder.body}`, /task-water|该喝水了|不是通知来源|private workspace memory|已完成/);

    const report = taskNotificationCopy(task({
      id: "task-brief-91f3", prompt: "生成日报", resultText: "私密日程".repeat(40),
      arrangement: { kind: "todoist-brief", source: "todoist-planning", notification: "always", declarationVersion: 1 },
    }));
    assert.equal(report.title, "Todoist 日报已保存");
    assert.equal(report.body, "详情在收件箱。");
    assert.doesNotMatch(`${report.title}\n${report.body}`, /task-brief|私密日程|生成日报/);

    assert.equal(taskNotificationCopy(task({
      arrangement: { kind: "rss-digest", source: "existing-rss-binding", notification: "new-items", declarationVersion: 1 },
    })).title, "资讯检查已结束");
    assert.equal(taskNotificationCopy(task()).title, "定时结果已保存");
  });

  it("omits a long reminder from both title and body instead of treating clipping as privacy", () => {
    const copy = taskNotificationCopy(task({
      resultText: "水".repeat(80),
      arrangement: { kind: "reminder", source: "none", notification: "always", declarationVersion: 1 },
    }));
    assert.equal(copy.title, "提醒时间到了");
    assert.doesNotMatch(copy.title + copy.body, /水|…/);
    assert.equal(copy.body, "提醒已到，详情在收件箱。");
  });

  it("uses a status sentence when the run did not complete", () => {
    const failed = taskNotificationCopy(task({ status: "failed", resultText: null }));
    assert.equal(failed.title, "这次安排没有完成");
    assert.match(failed.body, /不会自动重做/);
    const interrupted = taskNotificationCopy(task({ status: "interrupted", resultText: "该喝水了" }));
    assert.equal(interrupted.title, "安排中断，不会自动重做");
    assert.doesNotMatch(`${interrupted.title}\n${interrupted.body}`, /该喝水了|task-water/);
    assert.equal(taskNotificationCopy(task({ status: "cancelled" })).title, "这次安排已取消");
  });
});

describe("desktop frontmost hint", () => {
  it("suppresses only a fresh hint and ignores a missing, expired, or far-future file", async () => {
    const root = await mkdtemp(join(tmpdir(), "serika-frontmost-"));
    const now = Date.now();
    assert.equal(await readDesktopFrontmost(root, now), false);
    await writeDesktopFrontmost(root, true, now);
    assert.equal(await readDesktopFrontmost(root, now + 1_000), true);
    assert.equal(await readDesktopFrontmost(root, now + 9_000), false);
    await writeDesktopFrontmost(root, false, now);
    assert.equal(await readDesktopFrontmost(root, now), false);
    await mkdir(join(root, ".runloom"), { recursive: true });
    await writeFile(join(root, ".runloom/desktop-frontmost.json"), `${JSON.stringify({ until: now + 10 * 60_000 })}\n`);
    assert.equal(await readDesktopFrontmost(root, now), false);
    await writeFile(join(root, ".runloom/desktop-frontmost.json"), "not-json");
    assert.equal(await readDesktopFrontmost(root, now), false);
  });
});
