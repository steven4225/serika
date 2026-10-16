import { useEffect, useRef, useState } from "react";
import { submitCreation } from "./creation-operation.js";
import { FailureAlert } from "./failure-notice.js";
import type { AutomationOverview, AutomationScheduleAction } from "@aisdk-agent/example-cli/dist/automation-scheduling.js";
import { automationArrangementLabel, automationStatuses, skillSchedulePreview, type SkillScheduleDraft } from "./automation-schedule.js";
import { humanFacingTitle } from "../../shared/human-title.js";
import { DreamingPanel } from "./dreaming-panel.js";
import { localWhen, reminderClock, scheduleStatusLabel } from "./reminder-copy.js";

/** A workspace drawer section, not another parallel application or a model loop. */
export function AutomationPanel({ busy, identity, onRun, onReminders, refreshSequence }: { busy: boolean; identity: string; onRun: (runId: string) => void; onReminders: () => void; refreshSequence: number }) {
  const [view, setView] = useState<AutomationOverview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [draft, setDraft] = useState<SkillScheduleDraft>({ skillId: "", input: "", kind: "once", date: "", time: "09:00", weekday: 1, utcOffset: "+08:00" });
  const [preview, setPreview] = useState<ReturnType<typeof skillSchedulePreview> | null>(null);
  const [change, setChange] = useState<AutomationScheduleAction | null>(null);
  const generation = useRef(0);
  const context = useRef(identity);
  const lastRefresh = useRef(refreshSequence);
  const inFlight = useRef(false);
  context.current = identity;
  const reload = async () => {
    const request = ++generation.current;
    const captured = context.current;
    setLoading(true); setError(""); setPreview(null);
    try {
      const result = await window.runloom.getAutomationOverview();
      if (captured !== context.current || request !== generation.current) return;
      if (result.ok) setView(result.value);
      else { setView(null); setError(`${result.error.code}: ${result.error.message}`); }
    } catch { if (captured === context.current && request === generation.current) { setView(null); setError("自动安排读取失败，不代表没有安排。请刷新。"); } }
    finally { if (captured === context.current && request === generation.current) setLoading(false); }
  };
  useEffect(() => {
    setView(null); setPreview(null); setChange(null); setNotice(""); setWorking(false);
    void reload();
    const unsubscribe = window.runloom.onMessage(message => {
      if ((message.type === "state" && message.state.kind === "idle") || (message.type === "result" && message.phase !== "primary") || message.type === "task-result-available") void reload();
    });
    return () => { generation.current++; unsubscribe(); };
  }, [identity]);
  useEffect(() => {
    if (lastRefresh.current === refreshSequence) return;
    lastRefresh.current = refreshSequence;
    void reload();
  }, [refreshSequence]);
  const act = async (operation: () => Promise<{ ok: boolean; error?: { code: string; message: string } }>, success: string) => {
    if (busy || working || inFlight.current) return;
    inFlight.current = true;
    const captured = context.current;
    setWorking(true); setError(""); setNotice("");
    try {
      const result = await operation();
      if (captured !== context.current) return;
      if (!result.ok) setError(`${result.error?.code ?? "FAILED"}: ${result.error?.message ?? "操作失败"}`);
      else { if (success) setNotice(success); setPreview(null); setChange(null); await reload(); }
    } catch { if (captured === context.current) setError("操作结果未确认，请刷新核对；不会自动重试。"); }
    finally { inFlight.current = false; if (captured === context.current) setWorking(false); }
  };
  const create = async () => {
    if (!preview) return;
    const saved = preview;
    await act(async () => {
      const result = await submitCreation(window.localStorage, `${identity}:schedule`, saved.input,
        operationId => window.runloom.scheduleSkill({ ...saved.input, operationId }));
      if (result.ok && context.current === identity) setNotice(`已排期，不代表已经执行。${result.value.service.enabled ? "后台服务已登记，不代表正在运行或已送达通知。" : `后台服务未启用：${result.value.service.message ?? "请检查后台配置"}；到期执行尚无保证。`}`);
      return result;
    }, "");
  };
  const textSkills = view?.diagnostics.skills.filter(skill => skill.kind === "text" && skill.tools.length === 0) ?? [];
  const selected = textSkills.find(skill => skill.id === draft.skillId);
  return <><DreamingPanel busy={busy} identity={identity} refreshSequence={refreshSequence} /><section className="card" aria-label="自动安排">
    <div className="card-head"><span>自动安排</span><button className="ghost" disabled={loading || working} onClick={() => void reload()}>刷新安排</button></div>
    <p className="hint">同一份 Skill 可以手动执行、由对话事件触发或按时间执行。排期不会授予工具权限，也不会自动使用对话或长期记忆。</p>
    {loading ? <p role="status">正在读取安排…</p> : null}
    {error ? <FailureAlert text={error} /> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {view ? <>
      <details><summary>已安装 Skill（{view.diagnostics.skills.length}）与对话触发规则（{view.diagnostics.hooks.length}）</summary>
        {view.diagnostics.skills.length === 0 ? <p className="hint">没有登记 Skill。需要在可信运行配置中显式登记包；这里不会扫描或安装工作区脚本。</p> : null}
        {view.diagnostics.skills.map(skill => <div className="capability-row" key={skill.id}><div><strong>{skill.id}</strong><p>{skill.description}</p><small>{skill.kind === "text" ? "文本 Skill，无工具、不读取记忆" : "记忆整理，沿用现有来源与写入策略"} · 最多 {skill.limits.maxSteps} 步</small><details><summary>固定版本</summary><code>{skill.hash}</code></details></div></div>)}
        {view.diagnostics.hooks.map(rule => <p key={rule.id}>{rule.enabled === false ? "已停用" : "已启用"} · {rule.event === "thread.ready" ? "打开对话" : "主对话完成"} → {rule.handler.id} <small>（{rule.id}）</small></p>)}
        {view.diagnostics.hooks.length === 0 ? <p className="hint">没有自动触发规则；手动和排期入口仍可使用。</p> : null}
      </details>
      {textSkills.length > 0 ? <form className="work-task-form" onSubmit={event => { event.preventDefault(); try { setPreview(skillSchedulePreview(view.diagnostics.skills, draft)); setChange(null); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : "无法生成预览"); } }}>
        <label>执行哪个 Skill<select value={draft.skillId} disabled={busy || working} onChange={event => { setPreview(null); setDraft({ ...draft, skillId: event.target.value }); }}><option value="">请选择</option>{textSkills.map(skill => <option value={skill.id} key={skill.id}>{skill.id} — {skill.description}</option>)}</select></label>
        <label>交给它的输入<textarea value={draft.input} disabled={busy || working} onChange={event => { setPreview(null); setDraft({ ...draft, input: event.target.value }); }} placeholder="例如：用三条提示说明今天的复盘应该怎么写" /></label>
        <label>什么时候<select value={draft.kind} disabled={busy || working} onChange={event => { setPreview(null); setDraft({ ...draft, kind: event.target.value as SkillScheduleDraft["kind"] }); }}><option value="once">执行一次</option><option value="daily">每天</option><option value="weekly">每周</option></select></label>
        {draft.kind === "once" ? <label>日期<input type="date" value={draft.date} onChange={event => { setPreview(null); setDraft({ ...draft, date: event.target.value }); }} /></label> : null}
        {draft.kind === "weekly" ? <label>星期<select value={draft.weekday} onChange={event => { setPreview(null); setDraft({ ...draft, weekday: Number(event.target.value) }); }}>{["一", "二", "三", "四", "五", "六", "日"].map((day, index) => <option key={day} value={index + 1}>星期{day}</option>)}</select></label> : null}
        <label>时间<input type="time" value={draft.time} onChange={event => { setPreview(null); setDraft({ ...draft, time: event.target.value }); }} /></label>
        <label>固定 UTC 偏移<input value={draft.utcOffset} onChange={event => { setPreview(null); setDraft({ ...draft, utcOffset: event.target.value }); }} /></label>
        <div className="memory-actions"><button disabled={busy || working || !view.tasksEnabled}>查看排期预览</button><button type="button" className="ghost" disabled={busy || working || !selected} onClick={() => { if (selected) void act(() => window.runloom.runSkill({ id: selected.id, expectedHash: selected.hash, input: draft.input }), "Skill 已启动；结束与失败以执行记录为准，不等于主任务已交付。"); }}>现在执行一次</button></div>
      </form> : <p className="hint">当前没有可排期的无工具文本 Skill。记忆整理由已配置的 Hook 或记忆维护入口执行，不作为后台定时任务。</p>}
      {!view.tasksEnabled ? <p className="hint">任务模块未启用，无法排期；已安装 Skill 和 Hook 的状态仍可查看。</p> : null}
      {preview ? <div className="memory-setup-preview" role="group" aria-label="Skill 排期预览"><strong>{humanFacingTitle(selected?.description || preview.input.id, "这项安排")}：{preview.label}</strong><p>{preview.input.input}</p><details className="technical-id"><summary>固定版本</summary><code>{preview.hash}</code></details><p className="hint">只执行这份固定版本。没有工具、Shell、文件写入或记忆注入；后台模型可能产生费用。确认后会尝试登记当前工作区后台服务，关窗口后也可执行；服务或通知权限不可用会明确提示，安排仍保留。</p><div className="memory-actions"><button disabled={busy || working} onClick={() => void create()}>确认排期</button><button className="ghost" disabled={working} onClick={() => setPreview(null)}>取消</button></div></div> : null}
      <h4>已经安排</h4>
      {!view.scheduled.length && !view.recurring.length ? <p className="hint">没有待执行安排。已经结束的结果在「提醒」页，不会从这里重放。</p> : null}
      {view.scheduled.map(task => {
        const clock = reminderClock();
        return <div className="capability-row" key={task.id}><div><strong>{task.promptPreview}</strong><p>{localWhen(task.runAt, clock)} · {scheduleStatusLabel(task.status, task.runAt, clock.now, task.arrangement?.kind)}</p><small>{automationArrangementLabel(task.arrangement)}</small><details><summary>编号</summary><code>{task.id}</code></details></div>{task.status === "scheduled" ? <button className="ghost" disabled={busy || working} onClick={() => { setChange({ id: task.id, kind: "once", action: "cancel" }); setPreview(null); }}>取消安排…</button> : null}</div>;
      })}
      {view.recurring.map(task => {
        const clock = reminderClock();
        const next = task.nextRunAt ? localWhen(task.nextRunAt, clock) : "无";
        return <div className="capability-row" key={task.id}><div><strong>{task.promptPreview}</strong><p>{scheduleStatusLabel(task.status, task.nextRunAt, clock.now, task.arrangement?.kind)} · 下次 {next}</p><small>{automationArrangementLabel(task.arrangement)}</small><details><summary>编号</summary><code>{task.id}</code></details></div>{task.status !== "cancelled" ? <div className="memory-actions"><button className="ghost" disabled={busy || working} onClick={() => { setChange({ id: task.id, kind: "recurring", action: task.status === "paused" ? "resume" : "pause" }); setPreview(null); }}>{task.status === "paused" ? "恢复…" : "暂停…"}</button><button className="ghost" disabled={busy || working} onClick={() => { setChange({ id: task.id, kind: "recurring", action: "cancel" }); setPreview(null); }}>取消系列…</button></div> : null}</div>;
      })}
      {view.truncated ? <p className="hint">只显示有界的最近安排；列表不是全部历史。</p> : null}
      {change ? <div className="memory-setup-preview"><p>确认{change.action === "pause" ? "暂停" : change.action === "resume" ? "恢复后续排期" : "取消"}这项安排？只变更后续安排，不重放已执行、失败或效果未知的结果，也不撤回已经提交的通知。</p><details className="technical-id"><summary>编号</summary><code>{change.id}</code></details><div className="memory-actions"><button disabled={busy || working} onClick={() => void act(() => window.runloom.changeAutomationSchedule(change), "安排状态已变更；已有结果仍保留。")}>确认变更</button><button className="ghost" disabled={working} onClick={() => setChange(null)}>返回</button></div></div> : null}
      <details><summary>本次进程的 Hook / 手动执行记录（{view.diagnostics.recent.length}）</summary><p className="hint">重启后这里会清空；不是后台任务的持久历史。</p>{view.diagnostics.recent.map(item => <div className="capability-row" key={item.id}><p>{item.skillId} · {item.source === "hook" ? "事件触发" : "手动执行"} · {automationStatuses[item.status] ?? item.status}{item.message ? `：${item.message}` : ""}</p>{item.runId ? <button className="ghost" onClick={() => onRun(item.runId!)}>查看执行结果</button> : null}</div>)}</details>
      <button type="button" className="ghost" onClick={onReminders}>打开提醒，查看刚刚触发的结果</button>
    </> : null}
  </section></>;
}
