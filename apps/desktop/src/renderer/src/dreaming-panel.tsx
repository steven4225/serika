import { useEffect, useRef, useState } from "react";
import type { RendererApi } from "../../shared/ui-contract.js";
import { presentFailure } from "./failure-copy.js";
import { FailureAlert } from "./failure-notice.js";

type Overview = Extract<Awaited<ReturnType<RendererApi["getDreamingOverview"]>>, { ok: true }>["value"];
type References = Awaited<ReturnType<RendererApi["getLearnedSkillReferences"]>>;
type Change = Parameters<RendererApi["changeLearnedSkill"]>[0];

/** Derived methods stay in the existing workspace drawer, separate from factual memory. */
export function DreamingPanel({ busy, identity, refreshSequence }: { busy: boolean; identity: string; refreshSequence: number }) {
  const [view, setView] = useState<Overview | null>(null);
  const [references, setReferences] = useState<References>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [enablePreview, setEnablePreview] = useState(false);
  const [restore, setRestore] = useState<Change | null>(null);
  const generation = useRef(0);
  const context = useRef(identity);
  context.current = identity;
  const reload = async () => {
    const request = ++generation.current;
    const captured = context.current;
    setLoading(true);
    try {
      const [result, selected] = await Promise.all([window.runloom.getDreamingOverview(), window.runloom.getLearnedSkillReferences()]);
      if (captured !== context.current || request !== generation.current) return;
      setRestore(null);
      if (result.ok) { setView(result.value); setReferences(selected); setError(""); }
      else { setView(null); setReferences(null); setError(`${result.error.code}: ${result.error.message}`); }
    } catch {
      if (captured === context.current && request === generation.current) { setView(null); setReferences(null); setError("经验学习记录无法读取，不代表没有经验。请刷新核对。"); }
    } finally { if (captured === context.current && request === generation.current) setLoading(false); }
  };
  useEffect(() => {
    setView(null); setReferences(null); setNotice(""); setError(""); setRestore(null); setEnablePreview(false); setWorking(false);
    void reload();
    const unsubscribe = window.runloom.onMessage(message => {
      if ((message.type === "state" && message.state.kind === "idle") || message.type === "result" || message.type === "work-task-updated") void reload();
    });
    return () => { generation.current++; unsubscribe(); };
  }, [identity, refreshSequence]);
  const act = async (operation: () => Promise<{ ok: boolean; error?: { code: string; message: string } }>, success: string) => {
    if (busy || working) return;
    const captured = context.current;
    setWorking(true); setError(""); setNotice("");
    try {
      const result = await operation();
      if (captured !== context.current) return;
      if (!result.ok) setError(`${result.error?.code ?? "FAILED"}: ${result.error?.message ?? "操作失败"}`);
      else { await reload(); if (captured === context.current) setNotice(success); }
    } catch { if (captured === context.current) setError("操作结果未确认，请刷新核对；不会自动重试或覆盖版本。"); }
    finally { if (captured === context.current) setWorking(false); }
  };
  const changeEnabled = async (enabled: boolean) => {
    if (!view) return;
    await act(async () => { await window.runloom.setDreamingEnabled({ enabled, expectedEnabled: view.enabled }); return { ok: true }; }, "经验学习设置已重新加载；当前对话仍保留。");
    setEnablePreview(false);
  };
  return <section className="card" aria-label="经验学习">
    <div className="card-head"><span>经验学习</span><button className="ghost" disabled={loading || working} onClick={() => void reload()}>刷新经验</button></div>
    <p className="hint">从至少两条独立、已验收的工作任务提炼可复用方法，不把模型的自述当成功，不写成你的个人事实。应用打开且空闲时沉淀，新对话可以打断；这不是关窗后的夜间服务。</p>
    {loading ? <p role="status">正在读取经验…</p> : null}
    {error ? <FailureAlert text={error} /> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {view ? <>
      <div className="memory-actions"><span>{view.enabled ? "经验学习已开启" : "经验学习未开启"}</span><button className="ghost" disabled={busy || working} onClick={() => view.enabled ? void changeEnabled(false) : setEnablePreview(true)}>{view.enabled ? "关闭学习" : "开启学习…"}</button><button disabled={busy || working || !view.enabled || view.pendingExperiences < 2} onClick={() => void act(() => window.runloom.dream(), "已启动沉淀；完成与失败以下方状态和执行记录为准，不代表已经生成 Skill。")}>沉淀经验</button></div>
      {enablePreview ? <div className="memory-setup-preview"><p>开启后，模型可以读取当前工作区中有验收证据的任务经验，可能产生模型费用。低风险文本方法会进入试用，可查看来源、停用和恢复版本；不会增加 Shell、文件、应用控制或后台读取权限。</p><div className="memory-actions"><button disabled={busy || working} onClick={() => void changeEnabled(true)}>确认开启</button><button className="ghost" onClick={() => setEnablePreview(false)}>取消</button></div></div> : null}
      <p className="hint">等待沉淀：{view.pendingExperiences} 条合格经验。{view.pendingExperiences < 2 ? "需至少两条独立经验，暂不调用模型。" : "是否产出方法仍取决于证据，不保证每次生成 Skill。"}未知效果、来源无法核对或依赖会话私有记忆的任务不计入。</p>
      {view.lastAttempt ? <p role="status">最近沉淀：{{ running: "正在处理", completed: "已完成", failed: "失败，未算作已处理", cancelled: "已打断，未算作已处理", uncertain: "保存结果未确认，请刷新核对" }[view.lastAttempt.status]}{view.lastAttempt.message ? ` · ${presentFailure(view.lastAttempt.message).summary}` : ""}</p> : <p className="hint">本进程还没有沉淀记录，已有 Skill 不代表刚刚重新学习过。</p>}
      {view.lastAttempt?.message && presentFailure(view.lastAttempt.message).detail ? <details><summary>详情</summary><pre>{presentFailure(view.lastAttempt.message).detail}</pre></details> : null}
      {view.skills.length === 0 ? <p className="hint">暂无已沉淀 Skill。它与未开启、等待处理或处理失败是不同状态。</p> : null}
      {view.skills.map(skill => <details key={skill.id} className="memory-detail memory-technical"><summary>{skill.title} · v{skill.revision} · {skill.needsReview ? "来源或依赖变化，暂不选用" : skill.enabled ? "试用中" : "已停用"}</summary><p>{skill.description}</p><pre className="memory-text">{skill.instructions}</pre><div className="memory-actions"><button className="ghost" disabled={busy || working} onClick={() => void act(() => window.runloom.changeLearnedSkill({ id: skill.id, expectedRevision: skill.revision, action: skill.enabled ? "disable" : "enable" }), skill.enabled ? "已停用，后续对话不会再选用；已产生的回复不会改写。" : "已启用，后续任务会按相关性选择；不恢复旧权限。")}>{skill.enabled ? "停用" : "启用"}</button></div>
        <h4>验收来源</h4>{skill.sources.map(source => <p key={`${source.taskId}:${source.taskRevision}:${source.runId}`}><code>{source.taskId}</code> · 任务 v{source.taskRevision} · {source.acceptedAt}<br /><small>Thread {source.threadId} · Run {source.runId}<br />验收项 {source.criterionIds.join("、")} · 证据哈希 {source.evidenceHash}</small></p>)}
        <details><summary>版本与依赖</summary><p className="hint">恢复只生成新的方法版本，不重做旧工具，不改写旧回执。依赖记忆变化时，由后端重新核对可用性。</p>{skill.versions.map(version => <div key={version.revision}><p>v{version.revision} · {version.title} · {version.createdAt}</p><pre>{version.instructions}</pre><small>记忆依赖：{JSON.stringify(version.memoryDependencies)}</small>{version.revision !== skill.revision ? <button className="ghost" disabled={busy || working} onClick={() => setRestore({ id: skill.id, expectedRevision: skill.revision, action: "restore", restoreRevision: version.revision })}>恢复此版本…</button> : null}</div>)}</details>
      </details>)}
      {restore ? <div className="memory-setup-preview"><p>将 {restore.id} 的方法恢复为 v{restore.restoreRevision}？后端将核对当前版本与记忆依赖，再保存为一个新版本；旧工具不会重放。</p><div className="memory-actions"><button disabled={busy || working} onClick={() => void act(() => window.runloom.changeLearnedSkill(restore), "已恢复为新版本；历史版本与来源仍保留。")}>确认恢复</button><button className="ghost" onClick={() => setRestore(null)}>取消</button></div></div> : null}
      <details><summary>最近一轮选用的方法</summary><p className="hint">这是程序记录的参考清单，不是模型自报。只提供方法，不代表本轮成功，也不恢复工具权限。</p>{references ? <><small>消息 {references.messageId} · Run {references.runId}</small>{references.skills.length ? references.skills.map(skill => <p key={`${skill.id}:${skill.revision}`}>{skill.title} · v{skill.revision} · <code>{skill.id}</code></p>) : <p>这一轮没有选用经验 Skill。</p>}</> : <p>暂无选用记录，不能据此说本轮已使用。</p>}</details>
    </> : null}
  </section>;
}
