import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CheckpointSnapshot } from "./checkpoint-store.js";
import type { TaskListInput, TaskListV3, TaskStoreResult } from "./task-store.js";
import { renderHome, type HomeOptions } from "./home.js";

const base: HomeOptions = {
  modelAlias: "deepseek",
  modelId: "deepseek-chat",
  workspaceRoot: "/tmp/work",
  directory: "/tmp/transcripts",
  threadId: "thread-new",
  temporaryDirectory: false,
  temporaryThread: false,
  checkpointEnabled: false,
  taskEnabled: false,
  now: new Date("2026-09-24T00:00:00.000Z"),
  timeZone: "Asia/Shanghai",
};

function checkpoint(overrides: Partial<CheckpointSnapshot> = {}): CheckpointSnapshot {
  return {
    id: "cp-1",
    version: 1,
    status: "active",
    goal: "完成 M7",
    currentPhase: "验证 Home",
    summary: "项目进度摘要",
    completed: [],
    inProgress: [],
    nextActions: ["核对真实任务"],
    blockers: [],
    artifacts: [],
    source: { threadId: "thread-old" },
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    ...overrides,
  };
}

describe("renderHome", () => {
  it("shows only enabled entrances and distinguishes temporary directory from Thread", async () => {
    const text = await renderHome({ ...base, temporaryThread: true });
    assert.match(text, /Serika Home/);
    assert.match(text, /deepseek-chat；配置值，不代表本次已联网验证/);
    assert.match(text, /Thread ID 为本次临时生成/);
    assert.doesNotMatch(text, /transcript 目录为本次临时生成/);
    assert.doesNotMatch(text, /\/resume|\/task inbox/);
    assert.match(text, /\/modules/);
    const other = await renderHome({ ...base, temporaryDirectory: true });
    assert.match(other, /transcript 目录为本次临时生成/);
    assert.doesNotMatch(other, /Thread ID 为本次临时生成/);
  });

  it("reads workspace checkpoint afresh, marks another Thread, and never calls disabled task store", async () => {
    let current: CheckpointSnapshot | null = null;
    const options: HomeOptions = {
      ...base,
      checkpointEnabled: true,
      checkpointStore: { getCurrent: async () => ({ ok: true, current }) },
      taskStore: { list: async () => { throw new Error("task store must not be read"); } },
    };
    const empty = await renderHome(options);
    assert.match(empty, /尚无保存的 checkpoint/);
    assert.match(empty, /本页未重新核对 Git/);
    assert.match(empty, /\/resume/);
    current = checkpoint({ source: { threadId: "other\nthread" } });
    const first = await renderHome(options);
    assert.match(first, /完成 M7/);
    assert.match(first, /来源 Thread：other thread（与当前 Thread 不同；不是这段对话的续接）/);
    assert.doesNotMatch(first, /other\nthread/);
    assert.match(first, /本页未重新核对 Git/);
    assert.match(first, /\/resume/);
    assert.doesNotMatch(first, /\/task inbox/);
    current = checkpoint({ version: 2, status: "completed", goal: "完成 M7 验收", source: { threadId: "thread-new" } });
    const refreshed = await renderHome(options);
    assert.match(refreshed, /上次完成的 checkpoint · v2/);
    assert.match(refreshed, /完成 M7 验收/);
    assert.match(refreshed, /来源 Thread：thread-new（当前 Thread）/);
    assert.doesNotMatch(refreshed, /不是这段对话的续接/);
  });

  it("keeps task section visible when checkpoint is corrupt and shows task status and truncation", async () => {
    const calls: TaskListInput[] = [];
    const list = async (input?: TaskListInput): Promise<TaskStoreResult<TaskListV3>> => {
      calls.push(input ?? {});
      if (input?.inbox) return {
        ok: true,
        value: {
          truncated: true,
          tasks: [
            { id: "done", status: "completed", promptPreview: "\x1b[31m喝水\x1b[0m", runAt: "2026-09-24T01:00:00Z", finishedAt: null, resultPreview: "Run 结束", error: null, acknowledgedAt: null },
            { id: "bad", status: "pending", settlement: "failed", promptPreview: "整理", runAt: "2026-09-24T02:00:00Z", finishedAt: null, resultPreview: null, error: { code: "MODEL_TIMEOUT", messagePreview: "超时" }, acknowledgedAt: null },
            { id: "stop", status: "pending", settlement: "interrupted", promptPreview: "计划", runAt: "2026-09-24T03:00:00Z", finishedAt: null, resultPreview: null, error: { code: "INTERRUPTED", messagePreview: "中断" }, acknowledgedAt: null },
          ],
        },
      };
      return { ok: true, value: { truncated: false, tasks: [] } };
    };
    const text = await renderHome({
      ...base,
      checkpointEnabled: true,
      taskEnabled: true,
      checkpointStore: { getCurrent: async () => ({ ok: false, error: { code: "CHECKPOINT_FILE_INVALID", message: "broken" } }) },
      taskStore: { list },
    });
    assert.match(text, /项目进度：读取失败（CHECKPOINT_FILE_INVALID: broken）/);
    assert.doesNotMatch(text, /本页未重新核对 Git/);
    assert.match(text, /\/resume/);
    assert.match(text, /completed · done/);
    assert.match(text, /喝水/);
    assert.doesNotMatch(text, /\x1b/);
    assert.match(text, /failed · bad/);
    assert.match(text, /interrupted · stop/);
    assert.match(text, /仅展示前 5 条，另有未展示/);
    assert.match(text, /最近创建的 pending\/running/);
    assert.match(text, /completed 只表示 worker Run 正常结束/);
    assert.deepEqual(calls, [{ inbox: true, limit: 5 }, { status: "pending", limit: 5 }, { status: "running", limit: 5 }]);
    assert.match(text, /\/task inbox/);
  });

  it("isolates thrown checkpoint and task errors without claiming no tasks exist", async () => {
    const text = await renderHome({
      ...base,
      checkpointEnabled: true,
      taskEnabled: true,
      checkpointStore: { getCurrent: async () => { throw new Error("invalid checkpoint"); } },
      taskStore: { list: async () => ({ ok: false, error: { code: "TASK_FILE_INVALID", message: "broken tasks" } }) },
    });
    assert.match(text, /项目进度：读取失败（invalid checkpoint）/);
    assert.doesNotMatch(text, /本页未重新核对 Git/);
    assert.match(text, /\/resume/);
    assert.match(text, /未确认终态记录：读取失败（TASK_FILE_INVALID/);
    assert.match(text, /最近创建的 pending\/running：读取失败（TASK_FILE_INVALID/);
    assert.doesNotMatch(text, /没有待办/);
  });
});
