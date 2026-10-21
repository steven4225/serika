import { useEffect, useRef, useState } from "react";
import type { RendererApi } from "../../shared/ui-contract.js";
import { presentFailure } from "./failure-copy.js";
import { FailureAlert } from "./failure-notice.js";

type Overview = Extract<Awaited<ReturnType<RendererApi["getDreamingOverview"]>>, { ok: true }>["value"];
type References = Awaited<ReturnType<RendererApi["getLearnedSkillReferences"]>>;
type Change = Parameters<RendererApi["changeLearnedSkill"]>[0];

/** Learned methods share the skills page, separate from factual memory. */
export function DreamingPanel({ busy, identity, refreshSequence }: { busy: boolean; identity: string; refreshSequence: number }) {
  const [view, setView] = useState<Overview | null>(null);
  const [references, setReferences] = useState<References>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
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
    setView(null); setReferences(null); setNotice(""); setError(""); setRestore(null); setWorking(false);
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
  return <section className="card" aria-label="经验学习">
    <div className="card-head"><span>经验学习</span><button className="ghost" disabled={loading || working} onClick={() => void reload()}>刷新经验</button></div>
    <p className="hint">新方法提炼已暂停；已有方法通过固定索引按需读取。</p>
    {loading ? <p role="status">正在读取经验…</p> : null}
    {error ? <FailureAlert text={error} /> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {view ? <>
      {view.skills.length === 0 ? <p className="hint">还没有学到可复用的方法。</p> : null}
      {view.skills.map(skill => <details key={skill.id} className="memory-detail memory-technical"><summary>{skill.title} · v{skill.revision} · {skill.needsReview ? "来源或依赖变化，暂不选用" : skill.enabled ? "试用中" : "已停用"}</summary><p>{skill.description}</p><pre className="memory-text">{skill.instructions}</pre><div className="memory-actions"><button className="ghost" disabled={busy || working} onClick={() => void act(() => window.runloom.changeLearnedSkill({ id: skill.id, expectedRevision: skill.revision, action: skill.enabled ? "disable" : "enable" }), skill.enabled ? "已停用，后续对话不会再选用；已产生的回复不会改写。" : "已启用，后续快照会列入索引；不恢复旧权限。")}>{skill.enabled ? "停用" : "启用"}</button></div>
        <h4>验收来源</h4>{skill.sources.map(source => <p key={`${source.taskId}:${source.taskRevision}:${source.runId}`}><code>{source.taskId}</code> · 任务 v{source.taskRevision} · {source.acceptedAt}<br /><small>Thread {source.threadId} · Run {source.runId}<br />验收项 {source.criterionIds.join("、")} · 证据哈希 {source.evidenceHash}</small></p>)}
        <details><summary>版本与依赖</summary><p className="hint">恢复只生成新的方法版本，不重做旧工具，不改写旧回执。依赖记忆变化时，由后端重新核对可用性。</p>{skill.versions.map(version => <div key={version.revision}><p>v{version.revision} · {version.title} · {version.createdAt}</p><pre>{version.instructions}</pre><small>记忆依赖：{JSON.stringify(version.memoryDependencies)}</small>{version.revision !== skill.revision ? <button className="ghost" disabled={busy || working} onClick={() => setRestore({ id: skill.id, expectedRevision: skill.revision, action: "restore", restoreRevision: version.revision })}>恢复此版本…</button> : null}</div>)}</details>
      </details>)}
      {restore ? <div className="memory-setup-preview"><p>将 {restore.id} 的方法恢复为 v{restore.restoreRevision}？后端将核对当前版本与记忆依赖，再保存为一个新版本；旧工具不会重放。</p><div className="memory-actions"><button disabled={busy || working} onClick={() => void act(() => window.runloom.changeLearnedSkill(restore), "已恢复为新版本；历史版本与来源仍保留。")}>确认恢复</button><button className="ghost" onClick={() => setRestore(null)}>取消</button></div></div> : null}
      <details><summary>最近一轮选用的方法</summary><p className="hint">这是程序记录的参考清单，不是模型自报。只提供方法，不代表本轮成功，也不恢复工具权限。</p>{references ? <><small>消息 {references.messageId} · Run {references.runId}</small>{references.skills.length ? references.skills.map(skill => <p key={`${skill.id}:${skill.revision}`}>{skill.title} · v{skill.revision} · <code>{skill.id}</code></p>) : <p>这一轮没有选用经验 Skill。</p>}</> : <p>暂无选用记录，不能据此说本轮已使用。</p>}</details>
    </> : null}
  </section>;
}
