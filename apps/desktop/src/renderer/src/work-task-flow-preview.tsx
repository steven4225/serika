// Isolated interactive regression fixture: real renderer hook, fake IPC, no model or disk.
import React, { useEffect, useState } from "react";
import { useWorkTasks, WorkTasksPanel } from "./work-tasks.js";
import type { MainToRenderer, RendererApi } from "../../shared/ui-contract.js";
import type { WorkTask } from "../../shared/work-tasks.js";

let task: WorkTask = { id: "fixture-task", revision: 1, threadId: "fixture-thread", goal: "保留章节并修改下一步",
  constraints: [], acceptance: [{ id: "human", method: "human", verification: { kind: "human" }, required: true,
    description: "核对修改", status: "not_run", evidenceRefs: [], note: null }],
  status: "ready", runIds: [], delivery: null, reconciliations: [], createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z" };
const listeners = new Set<(message: MainToRenderer) => void>();
let attempts = 0;
let mode: "conflict" | "failed" | "lost" | "started" = "conflict";
function refresh() {
  task = { ...task, revision: task.revision + 1 };
  for (const listener of listeners) listener({ type: "work-task-updated", task });
}
export function WorkTaskFlowPreview() {
  const [version, setVersion] = useState(0);
  const [started, setStarted] = useState("");
  useEffect(() => {
    const notify = () => setVersion(value => value + 1);
    listeners.add(notify); return () => { listeners.delete(notify); };
  }, []);
  const view = useWorkTasks(true, false, version, text => setStarted(text), "fixture-task-identity");
  return <div style={{ padding: 24, height: "100vh", overflow: "auto" }}>
    <h1>隔离任务界面回归</h1>
    <p>模拟 IPC；不读取工作区、不运行模型、不代表原生验收。</p>
    <button onClick={() => refresh()}>模拟版本刷新</button>
    <button onClick={() => { task = { ...task, status: "paused" }; refresh(); }}>模拟本轮暂停</button>
    <select aria-label="模拟启动结果" value={mode} onChange={event => { mode = event.target.value as typeof mode; setVersion(value => value + 1); }}>
      <option value="conflict">版本冲突</option><option value="failed">启动失败</option><option value="lost">结果未收到</option><option value="started">启动成功</option>
    </select>
    <p role="status">启动请求次数：{attempts}；成功启动：{started || "无"}</p>
    <WorkTasksPanel view={view} onRun={() => undefined} />
  </div>;
}

export function installWorkTaskFlowApi() {
  const api = {
    listWorkTasks: async () => ({ ok: true as const, value: [structuredClone(task)] }),
    getWorkTask: async () => ({ ok: true as const, value: structuredClone(task) }),
    getWorkTaskContinuation: async () => ({ ok: false as const, error: { code: "WORK_TASK_NOT_FOUND", message: "fixture 没有回执" } }),
    getWorkTaskDeliveryDraft: async () => ({ ok: false as const, error: { code: "WORK_TASK_NOT_FOUND", message: "fixture 没有交付草稿" } }),
    getContextDiagnostics: async () => ({ ok: false as const, error: { code: "IPC_FAILED", message: "fixture 没有准备上下文" } }),
    runWorkTask: async () => {
      attempts += 1;
      await new Promise(resolve => setTimeout(resolve, 100));
      refresh();
      if (mode === "conflict") return { ok: false as const, reason: "starting" as const };
      if (mode === "failed") return { ok: false as const, reason: "starting" as const };
      if (mode === "lost") throw new Error("fixture transport lost");
      task = { ...task, status: "running", runIds: ["fixture-run"] };
      refresh();
      return { ok: true as const, runId: "fixture-run" };
    },
  } satisfies Partial<RendererApi>;
  window.runloom = api as unknown as RendererApi;
}
