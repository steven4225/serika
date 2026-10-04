import React, { useEffect, useState } from "react";
import type { ContextDiagnostics } from "@aisdk-agent/example-cli/dist/context-diagnostics.js";
import type { WorkTask, WorkTaskContinuation } from "../../shared/work-tasks.js";
import { preparationLabel } from "../../shared/context-panel.js";

const toolStatus = { requested: "等待确认", not_started: "未执行", started: "执行中", completed: "调用结束", failed: "调用失败", unknown: "效果未知" };
const runStatus = { running: "正在执行", completed: "本轮正常结束", failed: "失败", cancelled: "已取消", timed_out: "超时", max_steps: "达到步数上限", interrupted: "已中断" };

/** Guidance is a projection, not execution permission or a replacement for acceptance. */
export function taskRecoveryGuidance(task: WorkTask, data: WorkTaskContinuation): string | null {
  if (task.status === "needs_review" || data.requiresReview) return "先核对实际效果：打开下方最新回执，对照文件或目标应用；说明哪些已生效、哪些未生效。仍不确定就保持暂停，不要重做。核对后还需另行开始下一轮。";
  if (data.receiptUnavailable) return "最新执行记录不可用。先检查当前文件或目标应用，不要根据上次回复认定成功，也不要直接重复操作。";
  if (task.status !== "paused" || !data.latestRun) return null;
  const run = data.latestRun;
  if (run.status === "interrupted") return "上次执行被中断，已恢复任务记录，但没有自动续跑。已记录的效果不重做；补充本轮要求后，点击下方“开始下一轮”，助手会先读取当前文件。";
  if (run.status === "timed_out" || run.completion?.reason === "budget_exhausted") return "本轮用完时间或步骤预算，还未完成验收。查看已完成部分，把剩余工作写入补充指令，再开始下一轮；不会自动增加预算。";
  if (run.status === "cancelled") return "本轮已停止，但停止不会撤回已发生的修改。先看回执和产物，需要继续时再开始下一轮。";
  if (run.status === "failed") return "本轮执行失败。先打开最新回执查看具体错误，修正缺失配置、材料或执行条件后再继续；不会自动重放。";
  switch (run.completion?.reason) {
    case "needs_confirmation": return "本轮有操作未获允许。先看最新回执，决定调整要求还是重新发起；下一轮工具仍会重新请求确认。";
    case "needs_information": return "现有材料、工具或验收条件不足。请补充缺失信息；若多条测试无法合并，需使用同一目录下的一条明确测试命令。只有人工标准的任务可先提交交付，再由你审核。";
    case "needs_review": return "结束检查发现执行记录需要核对。请先查看最新回执与实际效果，不要直接重复执行。";
    case "delivered": return "本轮结束检查通过，但任务尚未确认交付。查看产物并提交交付，重新核验程序项；不能把这条结束原因当作最终验收。";
    default: return "本轮已结束，任务尚未验收。已有产物可提交交付；还有工作则填写补充指令并开始下一轮。";
  }
}

/** Display only. A foreign or previous preparation must never look like this task's proof. */
export function ContinuationSummary({ task, data, diagnostics, onRun }: {
  task: WorkTask; data: WorkTaskContinuation; diagnostics: ContextDiagnostics | null; onRun: (id: string) => void;
}) {
  const source = diagnostics?.lastPreparationSource;
  const preparation = source?.workTaskId === task.id && source.runId === task.runIds.at(-1)
    ? diagnostics?.lastPreparation : null;
  const guidance = taskRecoveryGuidance(task, data);
  return <section className="task-continuation" aria-label="从这里继续">
    <h3>从这里继续</h3>
    {guidance ? <p className="work-task-notice" role="status">{guidance}</p> : null}
    {data.requiresReview ? <p className="work-task-warning">有一笔效果还没核对，不会自动重做。请先阅读回执并报告实际观察。</p> : null}
    {data.receiptUnavailable ? <p className="work-task-notice">最新回执缺失或归属不符，没有用旧 Run 代替。下一轮须重新核对当前文件。</p> : null}
    {data.latestRun ? <>
      <p>{runStatus[data.latestRun.status]} <button className="ghost" onClick={() => onRun(data.latestRun!.runId)}>查看最新回执</button></p>
      {data.latestRun.conclusion ? <details><summary>上轮助手结论{data.latestRun.conclusionTruncated ? "（截断）" : ""} · 尚非验收</summary><pre>{data.latestRun.conclusion}</pre></details> : null}
      {data.latestRun.tools.length ? <ul className="continuation-receipts">{data.latestRun.tools.map(tool => <li key={tool.toolCallId}><code>{tool.toolName}</code><span>{toolStatus[tool.status]}</span>{tool.path ? <small>{tool.path}</small> : null}</li>)}</ul> : null}
      {data.latestRun.toolsTruncated ? <p className="hint">这里只列最后 8 次调用，完整结果见回执。调用结束不等于业务成功。</p> : <p className="hint">调用结束不等于业务成功，详细结果见回执。</p>}
    </> : !data.receiptUnavailable ? <p className="hint">还没有执行记录。首次启动不会恢复工具授权。</p> : null}
    {data.previousDelivery ? <>
      <details><summary>上次提交的交付 · 历史参考</summary><pre>{data.previousDelivery.summary}</pre>{data.previousDelivery.truncated ? <p className="hint">预览已截断，完整内容见下方交付。</p> : null}</details>
      {data.previousDelivery.unresolved.length ? <div className="work-task-warning"><strong>未解决事项</strong><ul>{data.previousDelivery.unresolved.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null}
    </> : null}
    <details><summary>这轮是否用过压缩摘要</summary>
      {preparation ? <><p>{preparationLabel(preparation.outcome)}</p><p className="hint">Run {source!.runId} · 记录 {preparation.compactionId ?? "无"}</p>{preparation.error ? <p className="error">{preparation.error.code}: {preparation.error.message}</p> : null}</>
        : <p className="hint">本进程没有与此任务最新 Run 对得上的准备结果；重启不恢复使用证明。</p>}
      {diagnostics?.latestValidCompaction ? <p className="hint">当前 Thread 的历史有效记录：{diagnostics.latestValidCompaction.id}。不等于这轮已经使用。</p> : null}
    </details>
    <p className="hint">继续会开新 Run，先读当前文件再修改。交付和摘要不是磁盘事实；关窗不保证继续执行。</p>
  </section>;
}

export function TaskContinuation({ task, onRun }: { task: WorkTask; onRun: (id: string) => void }) {
  const [data, setData] = useState<WorkTaskContinuation | null>(null);
  const [diagnostics, setDiagnostics] = useState<ContextDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setData(null); setDiagnostics(null); setError(null); setContextError(null);
    void window.runloom.getWorkTaskContinuation({ id: task.id, expectedRevision: task.revision }).then(result => {
      if (!active) return;
      if (result.ok) setData(result.value);
      else setError(`${result.error.code}: ${result.error.message}`);
    }).catch(() => { if (active) setError("续做信息读取失败，请重新读取任务；不会自动执行。"); });
    void window.runloom.getContextDiagnostics().then(result => {
      if (!active) return;
      if (result.ok) setDiagnostics(result.value);
      else setContextError(`${result.error.code}: ${result.error.message}`);
    }).catch(() => { if (active) setContextError("压缩诊断读取失败，不能据此判断摘要已使用。"); });
    return () => { active = false; };
  }, [task.id, task.revision]);
  return <>{data ? <ContinuationSummary task={task} data={data} diagnostics={diagnostics} onRun={onRun} />
    : <p className={error ? "error" : "hint"} role="status">{error ?? "正在读取续做信息…"}</p>}
    {contextError ? <p className="error" role="status">压缩诊断不可用：{contextError}</p> : null}</>;
}
