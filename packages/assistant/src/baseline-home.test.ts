import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import type { CheckpointSnapshot } from "./checkpoint-store.js";
import { renderHome, type HomeOptions } from "./home.js";
import type { TaskListInput, TaskListV3, TaskStoreResult, TaskSummaryV3 } from "./task-store.js";

/**
 * v2 pilot step 1 baseline (docs/architecture-v2.md §4.4): the CLI Home text,
 * byte for byte, for every branch renderHome has today. Step 3 renders the
 * structured Home snapshot through the CLI and must reproduce this file.
 * Regenerate only for an explicitly confirmed wording change:
 * SERIKA_UPDATE_BASELINE_SNAPSHOT=1 node --test packages/assistant/dist/baseline-home.test.js
 */

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
    id: "cp-1", version: 1, status: "active", goal: "完成 M7", currentPhase: "验证 Home", summary: "项目进度摘要",
    completed: [], inProgress: [], nextActions: ["核对真实任务"], blockers: [], artifacts: [],
    source: { threadId: "thread-old" }, createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z",
    ...overrides,
  };
}

function withoutPhase(value: CheckpointSnapshot): CheckpointSnapshot {
  const { currentPhase: _phase, ...rest } = value;
  return rest;
}

function task(overrides: Partial<TaskSummaryV3>): TaskSummaryV3 {
  return { id: "t", status: "scheduled", promptPreview: "喝水", runAt: "2026-09-24T01:00:00Z", finishedAt: null,
    resultPreview: null, error: null, acknowledgedAt: null, ...overrides } as TaskSummaryV3;
}

function tasks(inbox: TaskStoreResult<TaskListV3>, pending: TaskStoreResult<TaskListV3>): Pick<NonNullable<HomeOptions["taskStore"]>, "list"> {
  return { list: async (input?: TaskListInput) => input?.inbox ? inbox : pending };
}

const SCENARIOS: ReadonlyArray<readonly [name: string, options: HomeOptions]> = [
  ["nothing enabled, temporary Thread", { ...base, temporaryThread: true }],
  ["temporary directory, no workspace, control characters", { ...base, workspaceRoot: null, temporaryDirectory: true,
    modelAlias: "deep\tseek\x1b[31m", modelId: "model\nid", threadId: "thread\x07id", directory: "/tmp/a  b" }],
  ["enabled without stores", { ...base, checkpointEnabled: true, taskEnabled: true }],
  ["no checkpoint saved, empty task lists", { ...base, checkpointEnabled: true, taskEnabled: true,
    checkpointStore: { getCurrent: async () => ({ ok: true, current: null }) },
    taskStore: tasks({ ok: true, value: { truncated: false, tasks: [] } }, { ok: true, value: { truncated: false, tasks: [] } }) }],
  ["active checkpoint from another Thread with more than three next actions", { ...base, checkpointEnabled: true,
    checkpointStore: { getCurrent: async () => ({ ok: true, current: checkpoint({ source: { threadId: "other\nthread" },
      nextActions: ["一", "二", "三", "四", "五"] }) }) } }],
  ["completed checkpoint from this Thread without a phase", { ...base, checkpointEnabled: true,
    checkpointStore: { getCurrent: async () => ({ ok: true, current: withoutPhase(checkpoint({ version: 2, status: "completed", goal: "完成 M7 验收",
      source: { threadId: "thread-new" } })) }) } }],
  ["checkpoint read error and task results", { ...base, checkpointEnabled: true, taskEnabled: true,
    checkpointStore: { getCurrent: async () => ({ ok: false, error: { code: "CHECKPOINT_FILE_INVALID", message: "broken\nfile" } }) },
    taskStore: tasks({ ok: true, value: { truncated: true, tasks: [
      task({ id: "done", status: "completed", promptPreview: "\x1b[31m喝水\x1b[0m", resultPreview: "Run 结束" }),
      task({ id: "bad", status: "failed", promptPreview: "整理", error: { code: "MODEL_TIMEOUT", messagePreview: "超时" } }),
      task({ id: "stop", status: "interrupted", promptPreview: "计划", error: { code: "INTERRUPTED", messagePreview: "中断" } }),
    ] } }, { ok: true, value: { truncated: false, tasks: [task({ id: "next", status: "scheduled", promptPreview: "开会" })] } }) }],
  ["thrown checkpoint error and task store errors", { ...base, checkpointEnabled: true, taskEnabled: true,
    checkpointStore: { getCurrent: async () => { throw new Error("invalid checkpoint"); } },
    taskStore: tasks({ ok: false, error: { code: "TASK_FILE_INVALID", message: "broken tasks" } } as TaskStoreResult<TaskListV3>,
      { ok: false, error: { code: "TASK_FILE_INVALID", message: "broken tasks" } } as TaskStoreResult<TaskListV3>) }],
  ["non-Error throws from both stores", { ...base, checkpointEnabled: true, taskEnabled: true,
    checkpointStore: { getCurrent: async () => { throw "nope"; } },
    taskStore: { list: async () => { throw 42; } } }],
];

const homeFile = () => fileURLToPath(new URL("../src/__baseline__/home.txt", import.meta.url));

describe("v2 pilot baseline: CLI Home text", () => {
  it("renderHome matches __baseline__/home.txt for every branch", async () => {
    const pages: string[] = [];
    for (const [name, options] of SCENARIOS) pages.push(`===== ${name}\n${await renderHome(options)}\n`);
    const actual = pages.join("\n");
    if (process.env.SERIKA_UPDATE_BASELINE_SNAPSHOT === "1") await writeFile(homeFile(), actual);
    assert.equal(actual, await readFile(homeFile(), "utf8"));
  });

  it("an assembled app writes the same Home text it renders, with live stores", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "serika-baseline-home-")));
    try {
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      const configPath = join(root, "config.json");
      await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { checkpoint: { enabled: true }, task: { enabled: true } } }));
      const output = new PassThrough();
      let written = "";
      output.on("data", chunk => { written += String(chunk); });
      const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { threadId: "home", configPath },
        modelAlias: "mock", model: new MockLanguageModelV3({ modelId: "mock-model" }), output, env: {}, cwd: root });
      try {
        await app.renderHome();
        const normalized = written.replaceAll(root, "<ROOT>")
          .replace(/^时间：.*$/m, "时间：<NOW>");
        const file = fileURLToPath(new URL("../src/__baseline__/home-app.txt", import.meta.url));
        if (process.env.SERIKA_UPDATE_BASELINE_SNAPSHOT === "1") await writeFile(file, normalized);
        assert.equal(normalized, await readFile(file, "utf8"));
      } finally { app.dispose(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
