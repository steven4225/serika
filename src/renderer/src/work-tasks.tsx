import React, { useCallback, useEffect, useRef, useState } from "react";
import type { RunResponse } from "../../shared/ui-contract.js";
import type { WorkTask, WorkTaskInputs, WorkTaskObservedOutcome, WorkTaskResult, WorkTaskArtifactPreview, WorkTaskDeliveryDraft } from "../../shared/work-tasks.js";
import { criterionStatusLabels, isTaskRun, lines, selectCurrentTask, taskActions, taskStatusLabels, taskNextAction, readTaskSelection, saveTaskSelection, TASK_TEMPLATES, type TaskTemplateId } from "./work-task-data.js";
import { formatRecordTime } from "../../shared/execution-records.js";
import { Icon } from "./icons.js";

export function useWorkTasks(enabled: boolean, busy: boolean, refreshToken: number, onRunStarted: (text: string) => void, selectionKey: string | null = null) {
  const [tasks, setTasks] = useState<WorkTask[]>([]);
  const [task, setTask] = useState<WorkTask | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const request = useRef(0);
  const selected = useRef<string | null>(null);
  const inFlight = useRef(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    try { selected.current = selectionKey ? readTaskSelection(window.localStorage, selectionKey) : null; }
    catch { selected.current = null; }
    setTask(null); setTasks([]); setError(null);
  }, [selectionKey]);
  const remember = useCallback((id: string | null) => {
    selected.current = id;
    try { if (selectionKey) saveTaskSelection(window.localStorage, selectionKey, id); } catch { /* Optional preference. */ }
  }, [selectionKey]);

  const reread = useCallback(() => setRefresh(value => value + 1), []);
  useEffect(() => {
    if (!enabled) return;
    const current = ++request.current;
    setLoading(true);
    void (async () => {
      try {
        const list = await window.runloom.listWorkTasks();
        if (current !== request.current) return;
        if (!list.ok) { setError(`${list.error.code}: ${list.error.message}`); return; }
        setTasks(list.value);
        const id = selected.current ?? selectCurrentTask(list.value)?.id ?? null;
        if (id === null) { setTask(null); setError(null); return; }
        const detail = await window.runloom.getWorkTask(id);
        if (current !== request.current) return;
        if (!detail.ok) {
          if (detail.error.code === "WORK_TASK_NOT_FOUND" && selected.current !== null) {
            remember(null); setTask(null); setNotice("上次选中的任务不可用，已取消该选择；不会自动执行其他任务。"); reread(); return;
          }
          setError(`${detail.error.code}: ${detail.error.message}`); return;
        }
        remember(detail.value.id);
        setTask(detail.value);
        setError(null);
      } catch { if (current === request.current) setError("任务读取失败；旧内容不能用于操作，请重新读取。"); }
      finally { if (current === request.current) setLoading(false); }
    })();
    return () => { request.current += 1; };
  }, [enabled, refreshToken, refresh, remember]);

  const select = (id: string) => {
    if (id === selected.current) return;
    ++request.current; remember(id); setTask(null); setNotice(null); reread();
  };
  const locked = !enabled || busy || acting || loading || error !== null;
  async function change(action: () => Promise<WorkTaskResult<WorkTask> | RunResponse>, success: string, runText?: string): Promise<boolean> {
    if (locked || inFlight.current) return false;
    inFlight.current = true;
    ++request.current;
    setActing(true);
    setNotice(null);
    let ok = false;
    try {
      const result = await action();
      ok = result.ok;
      if (result.ok) {
        if ("value" in result) { remember(result.value.id); setTask(result.value); }
        if (runText !== undefined) onRunStarted(runText);
        setNotice(success);
      } else if ("error" in result) {
        setNotice(result.error.code === "WORK_TASK_REVISION_CONFLICT"
          ? "任务已变化，本次未重试。重新读取后请核对新内容，再操作。"
          : `${result.error.code}: ${result.error.message}`);
      } else setNotice("本轮未启动（状态或版本已变化，或当前忙）。重新读取后再决定，不会自动重发。");
    } catch {
      setNotice("操作结果未收到，可能已生效。只重新读取，不自动重发；请核对当前任务。");
    } finally {
      inFlight.current = false;
      setActing(false);
      setLoading(true);
      reread();
    }
    return ok;
  }

  return { tasks, task, enabled, loading, error, notice, locked, acting, select, reread,
    create: (input: WorkTaskInputs["createWorkTask"]) => change(() => window.runloom.createWorkTask(input), "任务已创建；尚未执行。"),
    run: (instruction: string) => task ? change(() => window.runloom.runWorkTask({ id: task.id, expectedRevision: task.revision, ...(instruction.trim() ? { instruction: instruction.trim() } : {}) }), "本轮已启动；Run 结束后仍须交付与验收。", instruction.trim() || task.goal) : Promise.resolve(false),
    deliver: (summary: string, artifacts: string[], unresolved: string[]) => task ? change(() => window.runloom.submitWorkTaskDelivery({ id: task.id, expectedRevision: task.revision, summary, artifactRefs: artifacts, unresolved }), "交付已提交。自动项由后端核验，人工项等待你判断。") : Promise.resolve(false),
    accept: (criterionId: string, decision: "passed" | "failed", note: string) => task ? change(() => window.runloom.recordHumanAcceptance({ id: task.id, expectedRevision: task.revision, criterionId, decision, ...(note.trim() ? { note: note.trim() } : {}) }), "人工验收已记录；任务是否完成以全部必需项为准。") : Promise.resolve(false),
    reconcile: (observedOutcome: WorkTaskObservedOutcome, decision: "continue" | "cancel", note: string) => task ? change(() => window.runloom.reconcileWorkTask({ id: task.id, expectedRevision: task.revision, observedOutcome, decision, note }), decision === "continue" ? "核对已记录，任务回到暂停。须另外点击开始下一轮；工具仍需重新确认。" : "核对已记录，任务已取消。已发生的效果不会撤回。") : Promise.resolve(false),
    cancel: () => task ? change(() => window.runloom.cancelWorkTask({ id: task.id, expectedRevision: task.revision }), "任务已取消；已发生的效果不会撤回。") : Promise.resolve(false),
    rework: () => task ? change(() => window.runloom.requestWorkTaskChanges({ id: task.id, expectedRevision: task.revision }), "已退回修改，验收已清空；下一轮需要单独启动。") : Promise.resolve(false),
  };
}

export type WorkTaskView = ReturnType<typeof useWorkTasks>;

export function CurrentTask({ view, onOpen }: { view: WorkTaskView; onOpen: () => void }) {
  if (!view.enabled || (!view.task && !view.error)) return null;
  return <button className={`current-work-task ${view.task ? `task-${view.task.status}` : ""}`} onClick={onOpen}>
    <Icon name="activity" size={16} /><span className="current-task-copy"><strong>{view.error ? "工作任务暂不可用" : view.task?.goal}</strong><small>{view.error ? "查看原因" : view.loading ? "正在刷新" : taskStatusLabels[view.task!.status]}</small></span>
    <span className="current-task-action">{view.task && !view.error ? taskNextAction(view.task) : "查看详情"}</span><Icon name="chevron" size={14} />
  </button>;
}

function CreateTask({ view, onClose }: { view: WorkTaskView; onClose: () => void }) {
  const [goal, setGoal] = useState("");
  const [constraints, setConstraints] = useState("");
  const [artifacts, setArtifacts] = useState("");
  const [human, setHuman] = useState("");
  const [template, setTemplate] = useState<TaskTemplateId | null>(null);
  const chooseTemplate = (id: TaskTemplateId) => {
    const draft = TASK_TEMPLATES[id].draft;
    setGoal(draft.goal); setConstraints(draft.constraints); setArtifacts(draft.artifacts); setHuman(draft.human); setTemplate(id);
  };
  const create = async () => {
    const paths = lines(artifacts);
    const descriptions = lines(human);
    if (await view.create({ goal: goal.trim(), constraints: lines(constraints), acceptance: [
      ...paths.map((path, index) => ({ id: `artifact-${index + 1}`, description: `产物存在且有本任务写入回执：${path}`, required: true, method: "automatic" as const, verification: { kind: "artifact_exists" as const, path } })),
      ...descriptions.map((description, index) => ({ id: `human-${index + 1}`, description, required: true, method: "human" as const, verification: { kind: "human" as const } })),
    ] })) onClose();
  };
  return <form className="work-task-form" onSubmit={event => { event.preventDefault(); void create(); }}>
    <div className="task-template-picker" role="group" aria-label="任务起点">
      {(Object.keys(TASK_TEMPLATES) as TaskTemplateId[]).map(id => <button type="button" className={template === id ? "selected" : ""} key={id} disabled={view.locked} onClick={() => chooseTemplate(id)}>{TASK_TEMPLATES[id].label}</button>)}
    </div>
    <p className="hint">模板只填写草稿。请调整材料、产物路径和要求；选择模板不会创建或执行任务。自定义子目录必须已存在，文件工具不会创建目录。</p>
    <label>任务目标<textarea aria-label="任务目标" value={goal} onChange={event => setGoal(event.target.value)} rows={2} required /></label>
    <label>约束 <small>每行一条，可留空</small><textarea aria-label="任务约束" value={constraints} onChange={event => setConstraints(event.target.value)} rows={2} /></label>
    <label>产物路径 <small>相对工作区，每行一个，可留空</small><textarea aria-label="验收产物路径" placeholder="notes/work-plan.md" value={artifacts} onChange={event => setArtifacts(event.target.value)} rows={2} /></label>
    <label>人工验收项 <small>每行一条，可留空</small><textarea aria-label="人工验收项" placeholder="计划中的步骤能直接执行" value={human} onChange={event => setHuman(event.target.value)} rows={2} /></label>
    <p className="hint">至少填写一项验收；所有项均为必需项。产物验收会核对最新关联 Run 的写入回执及当前磁盘文件，不判断内容质量。普通聊天不会自动成为任务。</p>
    <div className="work-task-buttons"><button className="allow" type="submit" disabled={view.locked || !goal.trim() || (!lines(artifacts).length && !lines(human).length)}>创建任务，不执行</button><button type="button" onClick={onClose} disabled={view.acting}>关闭</button></div>
  </form>;
}

function TaskDetail({ task, view, onRun }: { task: WorkTask; view: WorkTaskView; onRun: (id: string) => void }) {
  const [instruction, setInstruction] = useState("");
  const [summary, setSummary] = useState(task.delivery?.summary ?? "");
  const [artifacts, setArtifacts] = useState(task.delivery?.artifactRefs.join("\n") ?? "");
  const [unresolved, setUnresolved] = useState(task.delivery?.unresolved.join("\n") ?? "");
  const [observed, setObserved] = useState<WorkTaskObservedOutcome>("still_unknown");
  const [note, setNote] = useState("");
  const [receiptRead, setReceiptRead] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [cancelPreview, setCancelPreview] = useState(false);
  const [reworkPreview, setReworkPreview] = useState(false);
  const [humanPreview, setHumanPreview] = useState<{ id: string; decision: "passed" | "failed" } | null>(null);
  const [draft, setDraft] = useState<WorkTaskDeliveryDraft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const edited = useRef({ summary: false, artifacts: false });
  const actions = taskActions(task);
  const latest = task.runIds.at(-1);
  useEffect(() => {
    let active = true;
    if (!latest || task.status === "running") return;
    void window.runloom.getWorkTaskDeliveryDraft({ id: task.id, expectedRevision: task.revision }).then(result => {
      if (!active) return;
      if (!result.ok) { setDraftError(`${result.error.code}: ${result.error.message}`); return; }
      setDraft(result.value);
      // Only fill an untouched, new delivery. Rework retains an explicitly labeled old draft.
      if (task.delivery === null && actions.delivery) {
        if (!edited.current.summary) setSummary(result.value.summary);
        if (!edited.current.artifacts) setArtifacts(result.value.artifacts.map(item => item.path).join("\n"));
      }
    }).catch(() => { if (active) setDraftError("本轮草稿读取失败，可以手动填写；不会使用旧 Run 代替。"); });
    return () => { active = false; };
  }, [task.id, task.revision, latest, task.status, task.delivery, actions.delivery]);
  // Opening a receipt is not proof. It only makes the user aware of the record
  // (including missing/unavailable); a separate explicit report is still required.
  const inspectLatest = async () => {
    if (!latest) { setReceiptError("没有关联 Run 回执；请核对磁盘或外部应用后报告。"); setReceiptRead(true); return; }
    try {
      const response = await window.runloom.getRun(latest);
      if (!response.ok) { setReceiptError(`回执不可用：${response.message}。请直接核对实际效果。`); setReceiptRead(true); return; }
      if (!response.run || !isTaskRun(task, response.run)) {
        setReceiptError("回执缺失或归属不符，不能作为本任务证据；请核对实际效果。"); setReceiptRead(true); return;
      }
      setReceiptRead(true);
      onRun(latest);
    } catch { setReceiptError("未读到回执，请重新读取；也可以直接核对实际效果并报告。"); setReceiptRead(true); }
  };
  return <div className="work-task-detail">
    <div className="work-task-title"><h2>{task.goal}</h2><span className={`work-task-status task-${task.status}`}>{taskStatusLabels[task.status]}</span></div>
    <p className="task-next-step">下一步：{taskNextAction(task)}。{task.status === "paused" ? "需要继续时另开一轮；本轮结束不代表交付通过。" : ""}</p>
    <div className="hint">版本 {task.revision} · 更新于 {formatRecordTime(task.updatedAt)}<br /><code>{task.id}</code></div>
    {task.constraints.length ? <section><h3>约束</h3><ul>{task.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul></section> : null}
    <TaskArtifacts task={task} draft={draft} onRun={onRun} locked={view.locked} />
    <section><h3>验收标准</h3><ul className="work-task-criteria">{task.acceptance.map(criterion => <li key={criterion.id}>
      <div><strong>{criterion.description}</strong><span>{criterionStatusLabels[criterion.status]}</span></div>
      <small>{criterion.method === "human" ? "人工判断" : "程序核验"} · {criterion.required ? "必需" : "可选"}{criterion.verification.kind === "artifact_exists" ? ` · ${criterion.verification.path}` : criterion.verification.kind === "shell_exit_zero" ? ` · ${criterion.verification.command} (${criterion.verification.cwd})` : ""}</small>
      {criterion.note ? <p className="hint">{criterion.note}</p> : null}
      {criterion.evidenceRefs.length ? <details><summary>验收证据</summary><pre className="record-preview">{JSON.stringify(task.delivery?.evidence.filter(evidence => criterion.evidenceRefs.includes(evidence.id)) ?? [], null, 2)}</pre></details> : null}
      {actions.accept && criterion.method === "human" ? <div className="work-task-buttons"><button disabled={view.locked} onClick={() => setHumanPreview({ id: criterion.id, decision: "passed" })}>通过此项</button><button disabled={view.locked} onClick={() => setHumanPreview({ id: criterion.id, decision: "failed" })}>此项未通过</button></div> : null}
    </li>)}</ul>
    {humanPreview ? <form className="work-task-form work-task-confirm" onSubmit={event => { event.preventDefault(); void view.accept(humanPreview.id, humanPreview.decision, note); }}>
      <p>确认将「{task.acceptance.find(item => item.id === humanPreview.id)?.description}」记为{humanPreview.decision === "passed" ? "人工通过" : "未通过"}？这不是程序核验。</p>
      <label>验收说明 <small>可留空</small><textarea value={note} onChange={event => setNote(event.target.value)} rows={2} /></label>
      <div className="work-task-buttons"><button className="allow" disabled={view.locked} type="submit">确认验收决定</button><button type="button" onClick={() => setHumanPreview(null)}>返回</button></div>
    </form> : null}</section>
    {actions.run ? <form className="work-task-form" onSubmit={event => { event.preventDefault(); void view.run(instruction); }}>
      <label>本轮补充指令 <small>可留空，默认使用任务目标</small><textarea aria-label="本轮任务指令" rows={2} value={instruction} onChange={event => setInstruction(event.target.value)} /></label>
      <div className="work-task-buttons"><button className="allow" disabled={view.locked} type="submit">{task.status === "ready" ? "开始执行" : "开始下一轮"}</button></div>
      <p className="hint">开启新 Run，不重放之前的工具。工具仍需逐次确认；本轮结束不会自动标为验收通过。</p>
    </form> : null}
    {task.delivery ? <section><h3>{["paused", "running", "needs_review"].includes(task.status) ? "上次交付（已退回，需重新提交）" : "当前交付"}</h3><pre>{task.delivery.summary}</pre>{task.delivery.artifactRefs.length ? <ul>{task.delivery.artifactRefs.map((ref, index) => <li key={index}><code>{ref}</code></li>)}</ul> : null}{task.delivery.unresolved.length ? <div className="work-task-warning"><strong>未解决事项</strong><ul>{task.delivery.unresolved.map((item, index) => <li key={index}>{item}</li>)}</ul></div> : null}</section> : null}
    {actions.rework ? <button disabled={view.locked} onClick={() => setReworkPreview(true)}>退回修改…</button> : null}
    {reworkPreview ? <div className="work-task-confirm" role="group" aria-label="退回修改确认"><p>清空本轮所有验收结论，保留上次交付与执行回执，仅回到暂停。不调用模型、不重放工具；下一轮要单独启动，交付后重新验收。</p><div className="work-task-buttons"><button disabled={view.locked} onClick={() => void view.rework()}>确认退回修改</button><button onClick={() => setReworkPreview(false)}>返回验收</button></div></div> : null}
    {actions.delivery ? <details className="work-task-delivery" open={task.delivery === null}>
      <summary>{task.delivery ? "重新提交交付（重置验收）" : "提交交付与验收"}</summary>
      <form className="work-task-form" onSubmit={event => { event.preventDefault(); void view.deliver(summary.trim(), lines(artifacts), lines(unresolved)); }}>
        {draft ? <div className="delivery-draft-note">
          <p>本轮文件路径来自成功回执；结论是助手声明，仍需你核对。</p>
          {draft.summaryTruncated ? <p className="work-task-notice">助手结论预览已截断，请补全后提交。</p> : null}
          {draft.warning ? <p className="work-task-notice">{draft.warning}</p> : null}
          <button type="button" className="ghost" disabled={view.locked || (!draft.summary && !draft.artifacts.length)} onClick={() => { edited.current = { summary: true, artifacts: true }; setSummary(draft.summary); setArtifacts(draft.artifacts.map(item => item.path).join("\n")); }}>用本轮草稿替换表单</button>
        </div> : null}
        {draftError ? <p className="work-task-notice" role="status">{draftError}</p> : null}
        <label>交付结论<textarea aria-label="交付结论" rows={3} value={summary} onChange={event => { edited.current.summary = true; setSummary(event.target.value); }} required /></label>
        <label>产物引用 <small>每行一条，仅作交付声明</small><textarea aria-label="交付产物引用" rows={2} value={artifacts} onChange={event => { edited.current.artifacts = true; setArtifacts(event.target.value); }} /></label>
        <label>未解决事项 <small>每行一条，可留空</small><textarea aria-label="未解决事项" rows={2} value={unresolved} onChange={event => setUnresolved(event.target.value)} /></label>
        <p className="hint">{task.status === "paused" && task.delivery ? "以上沿用上次交付作为草稿，请按本轮实际结果核对。" : ""}不从助手文本生成证据。提交后后端核验自动项；再次提交会清空之前的验收结果。</p>
        <button className="allow" disabled={view.locked || !summary.trim()} type="submit">{task.delivery ? "重置验收并提交" : "提交交付，核验自动项"}</button>
      </form>
    </details> : null}
    {actions.reconcile ? <section className="work-task-warning"><h3>先核对未知效果</h3><p>不会自动重做。先阅读最新回执，再自行核对文件或外部应用；下面记录的是你的报告，不是程序验证或工具授权。</p>
      <button disabled={view.loading} onClick={() => void inspectLatest()}>阅读最新回执</button>
      {receiptError ? <p role="status">{receiptError}</p> : null}
      <form className="work-task-form" onSubmit={event => event.preventDefault()}>
        <label>实际观察<select aria-label="效果核对结论" value={observed} onChange={event => setObserved(event.target.value as WorkTaskObservedOutcome)}><option value="still_unknown">仍然不确定</option><option value="applied">已生效</option><option value="partially_applied">部分生效</option><option value="not_applied">未生效（我的判断）</option></select></label>
        <label>核对说明<textarea aria-label="效果核对说明" rows={3} value={note} onChange={event => setNote(event.target.value)} placeholder="核对了什么、看到了什么、还不确定什么" required /></label>
        <div className="work-task-buttons"><button className="allow" disabled={view.locked || !receiptRead || !note.trim() || observed === "still_unknown"} onClick={() => void view.reconcile(observed, "continue", note.trim())}>记录核对，回到暂停</button><button disabled={view.locked || !receiptRead || !note.trim()} onClick={() => setCancelPreview(true)}>记录核对并取消…</button></div>
        <p className="hint">仍然不确定时不能继续。回到暂停后不会启动模型，要另外点击开始下一轮。</p>
      </form>
    </section> : null}
    {task.runIds.length ? <section><h3>关联执行</h3><div className="work-task-run-list">{[...task.runIds].reverse().map(id => <button className="ghost" key={id} onClick={() => onRun(id)}>{id}{id === latest ? "（最新）" : ""}<Icon name="chevron" size={12} /></button>)}</div></section> : null}
    {task.reconciliations.length ? <details><summary>人工核对历史 · 不作为自动验收证据</summary>{task.reconciliations.map(report => <div className="work-task-report" key={report.id}><strong>{({ applied: "已生效", partially_applied: "部分生效", not_applied: "报告未生效", still_unknown: "仍未知" })[report.observedOutcome]}</strong><p>{report.note}</p><small>{report.decision === "continue" ? "决定回到暂停" : "决定取消"} · {formatRecordTime(report.confirmedAt)}</small><code>{report.runId}</code></div>)}</details> : null}
    {actions.cancel ? <button className="ghost" disabled={view.locked} onClick={() => setCancelPreview(true)}>取消此任务…</button> : null}
    {cancelPreview ? <div className="work-task-confirm" role="group" aria-label="取消任务确认"><p>确认取消这项任务？已发生的效果不会撤回。{actions.reconcile ? "同时保存上方核对结论与说明。" : ""}</p><div className="work-task-buttons"><button className="deny" disabled={view.locked || (actions.reconcile && (!receiptRead || !note.trim()))} onClick={() => { if (actions.reconcile) void view.reconcile(observed, "cancel", note.trim()); else void view.cancel(); }}>确认取消任务</button><button onClick={() => setCancelPreview(false)}>保留任务</button></div></div> : null}
  </div>;
}

function TaskArtifacts({ task, draft, onRun, locked }: { task: WorkTask; draft: WorkTaskDeliveryDraft | null; onRun: (id: string) => void; locked: boolean }) {
  const [preview, setPreview] = useState<WorkTaskArtifactPreview | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  useEffect(() => () => { ++request.current; }, []);
  const paths = [...new Set([
    ...task.acceptance.flatMap(item => item.verification.kind === "artifact_exists" ? [item.verification.path] : []),
    ...(draft?.artifacts.map(item => item.path) ?? []),
  ])];
  const read = async (path: string) => {
    const current = ++request.current;
    setReading(path); setError(null); setPreview(null);
    try {
      const result = await window.runloom.getWorkTaskArtifact({ id: task.id, expectedRevision: task.revision, path });
      if (current !== request.current) return;
      if (result.ok) setPreview(result.value);
      else setError(`${result.error.code}: ${result.error.message}`);
    } catch { if (current === request.current) setError("产物读取失败，请重新读取；不能据此认定文件不存在。"); }
    finally { if (current === request.current) setReading(null); }
  };
  if (!paths.length) return null;
  return <section className="task-artifacts" aria-label="任务产物">
    <h3>产物</h3>
    <p className="hint">只读当前磁盘的文本，不调用模型；预览不是提交交付或质量验收。</p>
    {paths.map(path => {
      const receipt = draft?.artifacts.find(item => item.path === path);
      return <div className="task-artifact-row" key={path}>
        <div><code>{path}</code><small>{receipt ? `本轮写入${receipt.bytes === null ? "" : ` ${receipt.bytes} 字节`}` : "任务要求的文件 · 本轮写入尚未核实"}</small></div>
        <button type="button" disabled={locked || reading !== null} onClick={() => void read(path)}>{reading === path ? "正在读取…" : "查看产物"}</button>
        {receipt ? <button type="button" className="ghost" onClick={() => onRun(receipt.runId)}>执行回执</button> : null}
      </div>;
    })}
    {error ? <p role="alert" className="error">{error}</p> : null}
    {preview ? <div className="task-artifact-preview">
      <div className="card-head"><strong>{preview.path}</strong><button type="button" className="ghost" onClick={() => setPreview(null)}>收起</button></div>
      <p className="hint">读取于 {formatRecordTime(preview.readAt)}，{preview.bytes} 字节。再次修改后需要重新读取。</p>
      <p className={preview.matchesReceipt === false ? "work-task-notice" : "hint"}>{preview.matchesReceipt === true ? "当前内容与最新写入回执一致；内容质量仍需核对。" : preview.matchesReceipt === false ? "当前内容与最新写入回执不一致，文件可能已被修改。" : "没有可比对的最新哈希回执；此处只展示文件。"}</p>
      <pre tabIndex={0}>{preview.content}</pre>
    </div> : null}
  </section>;
}

export function WorkTasksPanel({ view, onRun, createRequest = 0 }: { view: WorkTaskView; onRun: (id: string) => void; createRequest?: number }) {
  const [creating, setCreating] = useState(false);
  const panel = useRef<HTMLElement | null>(null);
  useEffect(() => { if (createRequest > 0) { setCreating(true); panel.current?.scrollIntoView({ block: "start" }); } }, [createRequest]);
  return <section ref={panel} className="card work-tasks" aria-label="工作任务">
    <div className="card-head"><span>工作任务</span><div className="work-task-buttons"><button className="ghost" disabled={view.loading || view.acting} onClick={view.reread}>重新读取</button><button disabled={view.locked} onClick={() => setCreating(value => !value)}>创建工作任务</button></div></div>
    <p className="hint">当前对话的最近 20 项任务。与定时提醒分开；任务完成以必需验收项为准，窗口关闭不会保证继续执行。</p>
    {!view.enabled ? <p className="muted">未配置工作区，工作任务不可用。</p> : null}
    {view.error ? <p className="error" role="alert">{view.error}{view.task ? "（下方为旧内容，操作已停用）" : ""}</p> : null}
    {view.notice ? <p className="work-task-notice" role="status">{view.notice}</p> : null}
    {view.loading ? <p className="muted">正在读取最新任务…</p> : null}
    {creating ? <CreateTask view={view} onClose={() => setCreating(false)} /> : null}
    {view.tasks.length ? <div className="work-task-list" role="group" aria-label="选择工作任务">{view.tasks.map(item => <button key={item.id} disabled={view.acting} className={view.task?.id === item.id ? "selected" : ""} onClick={() => view.select(item.id)}><span>{item.goal}</span><small>{taskStatusLabels[item.status]}</small></button>)}</div> : !view.loading && !view.error && view.enabled ? <p className="muted">还没有工作任务。需要执行并验收时再显式创建，普通对话照常使用。</p> : null}
    {view.task ? <TaskDetail key={`${view.task.id}:${view.task.revision}`} task={view.task} view={view} onRun={onRun} /> : null}
  </section>;
}
