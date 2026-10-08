import React, { useCallback, useEffect, useRef, useState } from "react";
import type { RunResponse } from "../../shared/ui-contract.js";
import type { WorkTask, WorkTaskInputs, WorkTaskObservedOutcome, WorkTaskResult, WorkTaskArtifactPreview, WorkTaskDeliveryDraft } from "../../shared/work-tasks.js";
import { criterionStatusLabels, isTaskRun, lines, taskFormAcceptance, selectCurrentTask, restoredTaskId, taskActions, taskStatusLabels, taskNextAction, taskVerificationSummary, readTaskSelection, saveTaskSelection, TASK_TEMPLATES, type TaskTemplateId } from "./work-task-data.js";
import { formatRecordTime } from "../../shared/execution-records.js";
import { Icon } from "./icons.js";
import { TaskContinuation } from "./task-continuation.js";
import { emptyTaskDrafts, draftScope, type ConversationDraftScope, type TaskCreationDraft, type TaskDrafts, type TaskDraftUpdate } from "../../shared/conversation-drafts.js";

export const emptyTaskCreation = (): TaskCreationDraft => ({ goal: "", constraints: "", artifacts: "", human: "", commands: "", testCwd: ".", template: null });

export function useWorkTasks(enabled: boolean, busy: boolean, refreshToken: number, onRunStarted: (text: string) => void, selectionKey: string | null = null, scope: ConversationDraftScope | null = null) {
  const [tasks, setTasks] = useState<WorkTask[]>([]);
  const [task, setTask] = useState<WorkTask | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [savedDrafts, setSavedDrafts] = useState<TaskDrafts>(emptyTaskDrafts);
  const [draftReady, setDraftReady] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftSaving, setDraftSaving] = useState(false);
  const draftWrite = useRef<Promise<void>>(Promise.resolve());
  const draftState = useRef<TaskDrafts>(emptyTaskDrafts());
  const draftSequence = useRef(0);
  const draftIdentity = useRef<string | null>(null);
  const unsavedUpdates = useRef(new Map<string, TaskDraftUpdate>());
  const scopeIdentity = scope ? JSON.stringify(draftScope(scope)) : null;
  const request = useRef(0);
  const selected = useRef<string | null>(null);
  const restoring = useRef(true);
  const inFlight = useRef(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    restoring.current = true;
    try { selected.current = selectionKey ? readTaskSelection(window.localStorage, selectionKey) : null; }
    catch { selected.current = null; }
    setTask(null); setTasks([]); setError(null); setNotice(null);
  }, [selectionKey]);
  useEffect(() => {
    let active = true;
    setDraftReady(false); setDraftError(null); setDraftSaving(false);
    draftWrite.current = Promise.resolve();
    draftIdentity.current = null; draftState.current = emptyTaskDrafts(); setSavedDrafts(emptyTaskDrafts()); unsavedUpdates.current.clear();
    if (!scope) return;
    void window.runloom.loadConversationDraft(scope).then(saved => {
      if (!active) return;
      const tasks = saved.taskDrafts ?? emptyTaskDrafts();
      // Older pending task supplements must never become an ordinary chat draft.
      if (saved.uncertainSteer?.taskId) {
        const pending = saved.uncertainSteer;
        if (!tasks.instructions[pending.taskId!]) tasks.instructions[pending.taskId!] = pending.text;
        tasks.composerTaskId = pending.taskId!;
      }
      draftIdentity.current = scopeIdentity; draftState.current = tasks; setSavedDrafts(tasks); setDraftReady(true);
      if (tasks.composerTaskId) { selected.current = tasks.composerTaskId; restoring.current = false; setRefresh(value => value + 1); }
    }).catch(() => { if (active) setDraftError("任务草稿无法读取；原文件未覆盖，创建和续做已停用。修复后重新加载。"); });
    return () => { active = false; ++draftSequence.current; };
  }, [scopeIdentity]);
  const saveDraft = (update: TaskDraftUpdate) => {
    if (!scope || !draftReady || draftIdentity.current !== scopeIdentity) return;
    const next = structuredClone(draftState.current);
    if (update.kind === "creation") next.creation = update.value;
    else if (update.kind === "composer") next.composerTaskId = update.taskId;
    else if (update.text) next.instructions[update.taskId] = update.text;
    else delete next.instructions[update.taskId];
    draftState.current = next; setSavedDrafts(next); setDraftSaving(true);
    const updateKey = update.kind === "instruction" ? `instruction:${update.taskId}` : update.kind;
    unsavedUpdates.current.set(updateKey, update);
    const sequence = ++draftSequence.current;
    const write = draftWrite.current.then(() => window.runloom.saveTaskDraft(scope, update));
    draftWrite.current = write;
    void write.then(() => {
      if (unsavedUpdates.current.get(updateKey) === update) unsavedUpdates.current.delete(updateKey);
      if (sequence === draftSequence.current) { setDraftError(null); setDraftSaving(false); }
    })
      .catch(() => { if (sequence === draftSequence.current) { setDraftError("任务草稿未保存；内容仍保留，恢复保存位置后点击重试。"); setDraftSaving(false); } });
  };
  const flushDrafts = async () => { await draftWrite.current; if (!draftReady || draftError || draftIdentity.current !== scopeIdentity) throw new Error("任务草稿未保存"); };
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
        const id = restoring.current ? restoredTaskId(list.value, selected.current) : selected.current ?? selectCurrentTask(list.value)?.id ?? null;
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
        restoring.current = false;
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
  const hydrated = draftReady && draftIdentity.current === scopeIdentity;
  const locked = !enabled || busy || acting || loading || error !== null || !hydrated || draftError !== null;
  async function change(action: () => Promise<WorkTaskResult<WorkTask> | RunResponse>, success: string, runText?: string): Promise<boolean> {
    if (locked || inFlight.current) return false;
    inFlight.current = true;
    ++request.current;
    setActing(true);
    setNotice(null);
    let ok = false;
    try {
      await flushDrafts();
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
    draftReady: hydrated, draftError, draftSaving, flushDrafts, creationDraft: hydrated ? savedDrafts.creation : null,
    setCreationDraft: (value: TaskCreationDraft | null) => saveDraft({ kind: "creation", value }),
    composerTaskId: hydrated ? savedDrafts.composerTaskId : null,
    setComposerTaskId: (taskId: string | null) => saveDraft({ kind: "composer", taskId }),
    instruction: task ? savedDrafts.instructions[task.id] ?? "" : "",
    setInstruction: (text: string) => { if (task) saveDraft({ kind: "instruction", taskId: task.id, text }); },
    clearInstruction: (taskId: string, expectedText: string) => { if (draftState.current.instructions[taskId]?.trim() === expectedText.trim()) saveDraft({ kind: "instruction", taskId, text: "", expectedText }); },
    reloadDrafts: () => { window.location.reload(); },
    retryDrafts: () => {
      if (!draftReady) { window.location.reload(); return; }
      const updates = [...unsavedUpdates.current.values()];
      draftWrite.current = Promise.resolve();
      for (const update of updates) saveDraft(update);
    },
    create: (input: WorkTaskInputs["createWorkTask"]) => change(() => window.runloom.createWorkTask(input), "任务已创建；尚未执行。"),
    run: async (instruction: string) => {
      if (!task) return false;
      const id = task.id;
      const started = await change(() => window.runloom.runWorkTask({ id, expectedRevision: task.revision, ...(instruction.trim() ? { instruction: instruction.trim() } : {}) }), "本轮已启动；程序检查通过后提交交付，人工项仍须你审核。", instruction.trim() || task.goal);
      if (started && draftState.current.instructions[id]?.trim() === instruction.trim()) saveDraft({ kind: "instruction", taskId: id, text: "", expectedText: instruction });
      return started;
    },
    deliver: (summary: string, artifacts: string[], unresolved: string[]) => task ? change(() => window.runloom.submitWorkTaskDelivery({ id: task.id, expectedRevision: task.revision, summary, artifactRefs: artifacts, unresolved }), "交付已提交。自动项由后端核验，人工项等待你判断。") : Promise.resolve(false),
    accept: (criterionId: string, decision: "passed" | "failed", note: string) => task ? change(() => window.runloom.recordHumanAcceptance({ id: task.id, expectedRevision: task.revision, criterionId, decision, ...(note.trim() ? { note: note.trim() } : {}) }), "人工验收已记录；任务是否完成以全部必需项为准。") : Promise.resolve(false),
    reconcile: (observedOutcome: WorkTaskObservedOutcome, decision: "continue" | "cancel", note: string) => task ? change(() => window.runloom.reconcileWorkTask({ id: task.id, expectedRevision: task.revision, observedOutcome, decision, note }), decision === "continue" ? "核对已记录，任务回到暂停。须另外点击开始下一轮；工具仍需重新确认。" : "核对已记录，任务已取消。已发生的效果不会撤回。") : Promise.resolve(false),
    cancel: () => task ? change(() => window.runloom.cancelWorkTask({ id: task.id, expectedRevision: task.revision }), "任务已取消；已发生的效果不会撤回。") : Promise.resolve(false),
    rework: () => task ? change(() => window.runloom.requestWorkTaskChanges({ id: task.id, expectedRevision: task.revision }), "已退回修改，验收已清空；下一轮需要单独启动。") : Promise.resolve(false),
  };
}

export type WorkTaskView = ReturnType<typeof useWorkTasks>;

export function CurrentTask({ view, onOpen, onCompose, compact = false }: { view: WorkTaskView; onOpen: () => void; onCompose?: () => void; compact?: boolean }) {
  if (!view.enabled || (!view.task && !view.error && !view.loading)) return null;
  if (!view.task && view.loading && !view.error) return <section className="current-work-task" aria-label="当前工作任务" role="status"><span>正在恢复本对话的任务…</span><small>只读取保存状态，不会自动执行。</small></section>;
  const task = view.task;
  const canRun = task && taskActions(task).run && !view.error;
  const action = !task || view.error ? "查看原因" : task.status === "needs_review" ? "核对效果" : task.status === "awaiting_acceptance" ? "查看产物并审核" : task.status === "completed" ? "查看已验收产物" : "查看任务";
  return <section className={`current-work-task ${compact ? "compact " : ""}${task ? `task-${task.status}` : ""}`} aria-label="当前工作任务">
    <div className="current-task-heading"><Icon name="activity" size={16} /><div className="current-task-copy"><strong title={task?.goal}>{view.error ? "工作任务暂不可用" : task?.goal}</strong><small>{view.error ? view.error : view.loading ? "正在刷新" : taskStatusLabels[task!.status]}</small></div>{compact ? <button className="ghost" onClick={onOpen}>{action}</button> : null}</div>
    {!compact && task && !view.error ? <p className="current-task-action">{taskVerificationSummary(task) ?? taskNextAction(task)}</p> : null}
    {!compact && task?.status === "needs_review" ? <p className="hint">上次执行的效果还不确定。先核对，不会自动重做。</p> : null}
    {!compact && task?.delivery && ["awaiting_acceptance", "completed"].includes(task.status) ? <div className="current-task-artifacts">{task.delivery.artifactRefs.map(path => <button className="ghost" key={path} onClick={onOpen}>{path}</button>)}{task.delivery.unresolved.length ? <p className="work-task-warning">仍有未解决事项，请查看交付详情。</p> : null}</div> : null}
    {!compact ? <div className="work-task-buttons">{canRun && onCompose ? <button className="allow" disabled={view.locked} onClick={onCompose}>{task.status === "ready" ? "准备开始任务" : "补充要求并继续"}</button> : null}<button className={canRun ? "ghost" : "allow"} onClick={onOpen}>{action}</button></div> : null}
    {!compact && view.notice ? <p className="hint" role="status">{view.notice}</p> : null}
  </section>;
}

function CreateTask({ view, onClose, initialGoal = "" }: { view: WorkTaskView; onClose: () => void; initialGoal?: string }) {
  const { goal, constraints, artifacts, human, commands, testCwd, template } = view.creationDraft ?? { ...emptyTaskCreation(), goal: initialGoal };
  const update = (patch: Partial<TaskCreationDraft>) => view.setCreationDraft({ ...(view.creationDraft ?? { ...emptyTaskCreation(), goal: initialGoal }), ...patch });
  useEffect(() => { if (view.draftReady && !view.creationDraft && initialGoal) view.setCreationDraft({ ...emptyTaskCreation(), goal: initialGoal }); }, [view.draftReady, initialGoal]);
  const setGoal = (goal: string) => update({ goal });
  const setConstraints = (constraints: string) => update({ constraints });
  const setArtifacts = (artifacts: string) => update({ artifacts });
  const setHuman = (human: string) => update({ human });
  const setCommands = (commands: string) => update({ commands });
  const setTestCwd = (testCwd: string) => update({ testCwd });
  const chooseTemplate = (id: TaskTemplateId) => {
    const draft = TASK_TEMPLATES[id].draft;
    update({ goal: draft.goal, constraints: draft.constraints, artifacts: draft.artifacts, human: draft.human, template: id });
  };
  const create = async () => {
    if (await view.create({ goal: goal.trim(), constraints: lines(constraints), acceptance: taskFormAcceptance(artifacts, human, commands, testCwd) })) {
      view.setCreationDraft(null);
      try { await view.flushDrafts(); onClose(); } catch { /* Created task remains visible; failed cleanup is explicit, never retry creation. */ }
    }
  };
  return <form className="work-task-form" onSubmit={event => { event.preventDefault(); void create(); }}>
    <fieldset disabled={!view.draftReady || view.acting} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: "grid", gap: 12 }}>
    {initialGoal ? <p className="hint">已有任务草稿会优先恢复，不会被对话输入覆盖。原对话输入仍保留；填写验收后才会创建，不会直接执行。</p> : null}
    <details className="task-advanced"><summary>从模板填写（可选）</summary><div className="task-template-picker" role="group" aria-label="任务起点">
      {(Object.keys(TASK_TEMPLATES) as TaskTemplateId[]).map(id => <button type="button" className={template === id ? "selected" : ""} key={id} disabled={view.locked} onClick={() => chooseTemplate(id)}>{TASK_TEMPLATES[id].label}</button>)}
    </div><p className="hint">模板只填写草稿，不创建或执行。子目录必须已存在。</p></details>
    <label>任务目标<textarea aria-label="任务目标" value={goal} onChange={event => setGoal(event.target.value)} rows={2} required /></label>
    <label>产物路径 <small>相对工作区，每行一个，可留空</small><textarea aria-label="验收产物路径" placeholder="notes/work-plan.md" value={artifacts} onChange={event => setArtifacts(event.target.value)} rows={2} /></label>
    <label>人工验收项 <small>每行一条，可留空</small><textarea aria-label="人工验收项" placeholder="计划中的步骤能直接执行" value={human} onChange={event => setHuman(event.target.value)} rows={2} /></label>
    <details className="task-advanced"><summary>约束与测试命令（可选）{lines(constraints).length || lines(commands).length ? " · 已填写" : ""}</summary>
    <label>约束 <small>每行一条，可留空</small><textarea aria-label="任务约束" value={constraints} onChange={event => setConstraints(event.target.value)} rows={2} /></label>
    <label>必须通过的测试命令 <small>每行一条，可留空</small><textarea aria-label="验收测试命令" placeholder="pnpm test" value={commands} onChange={event => setCommands(event.target.value)} rows={2} /></label>
    {lines(commands).length > 0 ? <label>测试目录 <small>相对工作区</small><input aria-label="验收测试目录" value={testCwd} onChange={event => setTestCwd(event.target.value)} placeholder="." /></label> : null}
    <p className="hint">测试最后运行。之后再改文件、运行 Shell 或操作应用会使旧测试失效；同目录多条测试可能合成一条需确认的命令。</p></details>
    <section className="task-create-checks" aria-label="创建前验收摘要"><strong>这项任务如何算完成</strong>{taskFormAcceptance(artifacts, human, commands, testCwd).length ? <ul>{taskFormAcceptance(artifacts, human, commands, testCwd).map(item => <li key={item.id}>{item.method === "automatic" ? "程序核验：" : "你来审核："}{item.description}</li>)}</ul> : <p className="hint">至少填写一个产物、人工验收项或测试命令。</p>}<p className="hint">上述项目均为必需项。文件须本轮写入、读回并与当前磁盘一致。创建不执行，也不授予工具权限。</p></section>
    <div className="work-task-buttons"><button className="allow" type="submit" disabled={view.locked || !goal.trim() || (!lines(artifacts).length && !lines(human).length && !lines(commands).length)}>创建任务，不执行</button><button type="button" onClick={onClose} disabled={view.acting}>关闭</button></div>
    </fieldset>
    <p className="hint" role="status">{view.draftError ?? (view.draftSaving ? "保存任务草稿…" : view.draftReady ? "任务草稿已保存；关闭表单不会删除，下次打开可继续填写。" : "正在恢复任务草稿…")}</p>
  </form>;
}

function TaskDetail({ task, view, onRun, onCompose }: { task: WorkTask; view: WorkTaskView; onRun: (id: string) => void; onCompose?: () => void }) {
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
    {taskVerificationSummary(task) ? <p className="work-task-notice" role="status">{taskVerificationSummary(task)}</p> : null}
    {actions.run && onCompose ? <div className="work-task-buttons"><button className="allow" disabled={view.locked} onClick={onCompose}>{task.status === "ready" ? "回到对话，开始任务" : "回到对话，补充要求并继续"}</button></div> : null}
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
    {actions.run && !onCompose ? <form className="work-task-form" onSubmit={event => { event.preventDefault(); void view.run(view.instruction); }}>
      <label>本轮补充指令 <small>可留空，默认使用任务目标；启动失败会保留</small><textarea aria-label="本轮任务指令" disabled={view.acting || view.loading || task.status === "running"} rows={2} value={view.instruction} onChange={event => view.setInstruction(event.target.value)} /></label>
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
    {actions.reconcile ? <section className="work-task-warning task-reconciliation"><h3>先核对未知效果</h3><p>不会自动重做。先阅读最新回执，再自行核对文件或外部应用；下面记录的是你的报告，不是程序验证或工具授权。</p>
      <button disabled={view.loading} onClick={() => void inspectLatest()}>阅读最新回执</button>
      {receiptError ? <p role="status">{receiptError}</p> : null}
      <form className="work-task-form" onSubmit={event => event.preventDefault()}>
        <label>实际观察<select aria-label="效果核对结论" value={observed} onChange={event => setObserved(event.target.value as WorkTaskObservedOutcome)}><option value="still_unknown">仍然不确定</option><option value="applied">已生效</option><option value="partially_applied">部分生效</option><option value="not_applied">未生效（我的判断）</option></select></label>
        <label>核对说明<textarea aria-label="效果核对说明" rows={3} value={note} onChange={event => setNote(event.target.value)} placeholder="核对了什么、看到了什么、还不确定什么" required /></label>
        <div className="work-task-buttons"><button className="allow" disabled={view.locked || !receiptRead || !note.trim() || observed === "still_unknown"} onClick={() => void view.reconcile(observed, "continue", note.trim())}>记录核对，回到暂停</button><button disabled={view.locked || !receiptRead || !note.trim()} onClick={() => setCancelPreview(true)}>记录核对并取消…</button></div>
        <p className="hint">仍然不确定时不能继续。回到暂停后不会启动模型，要另外点击开始下一轮。</p>
      </form>
    </section> : null}
    <details className="task-technical"><summary>执行记录、约束与技术详情</summary><div className="hint">版本 {task.revision} · 更新于 {formatRecordTime(task.updatedAt)}<br /><code>{task.id}</code></div><TaskContinuation task={task} onRun={onRun} />{task.constraints.length ? <section><h3>约束</h3><ul>{task.constraints.map((constraint, index) => <li key={index}>{constraint}</li>)}</ul></section> : null}
    {task.runIds.length ? <section><h3>关联执行</h3><div className="work-task-run-list">{[...task.runIds].reverse().map(id => <button className="ghost" key={id} onClick={() => onRun(id)}>{id === latest ? "最新执行" : "历史执行"}<code>{id}</code><Icon name="chevron" size={12} /></button>)}</div></section> : null}</details>
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

export function WorkTasksPanel({ view, onRun, createRequest = 0, initialGoal = "", focused = false, onCompose, onCreated }: { view: WorkTaskView; onRun: (id: string) => void; createRequest?: number; initialGoal?: string; focused?: boolean; onCompose?: () => void; onCreated?: () => void }) {
  const [creating, setCreating] = useState(view.creationDraft !== null && !focused);
  const panel = useRef<HTMLElement | null>(null);
  useEffect(() => { if (createRequest > 0) { setCreating(true); panel.current?.scrollIntoView({ block: "start" }); } }, [createRequest]);
  useEffect(() => { if (view.draftReady && view.creationDraft && !focused) setCreating(true); }, [view.draftReady, focused]);
  return <section ref={panel} className="card work-tasks" aria-label="工作任务">
    <div className="card-head"><span>{creating ? "创建任务" : focused ? "当前任务" : "本对话的工作任务"}</span><div className="work-task-buttons"><button className="ghost" disabled={view.loading || view.acting} onClick={view.reread}>重新读取</button>{!focused && !creating ? <button disabled={view.locked} onClick={() => setCreating(true)}>创建工作任务</button> : null}</div></div>
    {!focused && !creating ? <p className="hint">当前对话的最近 20 项任务。与定时提醒分开；窗口关闭不保证继续执行。</p> : null}
    {!view.enabled ? <p className="muted">未配置工作区，工作任务不可用。</p> : null}
    {view.error ? <p className="error" role="alert">{view.error}{view.task ? "（下方为旧内容，操作已停用）" : ""}</p> : null}
    {view.notice ? <p className="work-task-notice" role="status">{view.notice}</p> : null}
    {view.draftError ? <div className="error" role="alert">{view.draftError}<button type="button" onClick={view.retryDrafts}>重试任务草稿保存</button></div> : null}
    {view.loading ? <p className="muted">正在读取最新任务…</p> : null}
    {creating ? <CreateTask key={createRequest} view={{ ...view, create: async input => { const ok = await view.create(input); if (ok) onCreated?.(); return ok; } }} initialGoal={initialGoal} onClose={() => setCreating(false)} /> : null}
    {!creating && !focused && view.tasks.length ? <div className="work-task-list" role="group" aria-label="选择工作任务">{view.tasks.map(item => <button key={item.id} disabled={view.acting} className={view.task?.id === item.id ? "selected" : ""} onClick={() => view.select(item.id)}><span>{item.goal}</span><small>{taskStatusLabels[item.status]}</small></button>)}</div> : !creating && !view.task && !view.loading && !view.error && view.enabled ? <p className="muted">还没有工作任务。需要执行并验收时再显式创建，普通对话照常使用。</p> : null}
    {!creating && view.task ? <TaskDetail key={`${view.task.id}:${view.task.revision}`} task={view.task} view={view} onRun={onRun} {...(onCompose ? { onCompose } : {})} /> : null}
  </section>;
}
