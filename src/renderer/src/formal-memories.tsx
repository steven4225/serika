import { useCallback, useEffect, useRef, useState } from "react";
import type { FormalMemory, MemoryEditInput, MemoryPage } from "@aisdk-agent/example-cli/dist/memory-management.js";

export function FormalMemories({ enabled, controllerIdle, refreshToken, queryRewriteEnabled }: { enabled: boolean; controllerIdle: boolean; refreshToken: number; queryRewriteEnabled: boolean }) {
  const [page, setPage] = useState<MemoryPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [current, setCurrent] = useState<FormalMemory | null>(null);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<MemoryEditInput | null>(null);
  const [stale, setStale] = useState(false);
  const [detailToken, setDetailToken] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const detailSequence = useRef(0);
  const mutation = useRef(false);
  const load = useCallback(async (start: number) => {
    const request = ++sequence.current;
    try {
      const result = await window.runloom.listMemories({ offset: start, limit: 20 });
      if (request !== sequence.current) return;
      if (!result.ok) { setPage(null); setError(`${result.error.code}: ${result.error.message}`); return; }
      setPage(result.value); setOffset(start); setError(null);
    } catch { if (request === sequence.current) { setPage(null); setError("记忆读取失败，请重新加载"); } }
  }, []);
  const open = useCallback(async (id: string) => {
    const request = ++detailSequence.current;
    setCurrent(null); setPreview(null); setStale(true);
    try {
      const result = await window.runloom.getMemory(id);
      if (request !== detailSequence.current) return;
      if (!result.ok) { setError(`${result.error.code}: ${result.error.message}`); return; }
      setCurrent(result.value); setText(result.value.text); setStale(false); setDetailToken(refreshToken); setError(null);
    } catch { if (request === detailSequence.current) setError("详情读取失败，请重新加载"); }
  }, [refreshToken]);
  useEffect(() => {
    setPreview(null); setStale(true); ++detailSequence.current;
    if (enabled) void load(0);
    return () => { ++sequence.current; ++detailSequence.current; };
  }, [enabled, refreshToken, load]);
  async function save() {
    if (!preview || stale || detailToken !== refreshToken || !controllerIdle || mutation.current) return;
    mutation.current = true; setBusy(true);
    const edit = preview;
    setPreview(null); setStale(true); ++detailSequence.current;
    try {
      const result = await window.runloom.updateMemory(edit);
      if (!result.ok) setError(`${result.error.code}: ${result.error.message}。请重新加载后核对，不会自动重试。`);
      else { setCurrent(result.value); setText(result.value.text); setError(null); await load(offset); /* Reload detail required after a mutation. */ }
    } catch { setError("保存结果未确认，请重新加载核对；不要直接重复保存。"); }
    finally { mutation.current = false; setBusy(false); }
  }
  if (!enabled) return <p className="hint">记忆模块未启用，不是空记忆库。</p>;
  const ready = current !== null && !stale && detailToken === refreshToken && controllerIdle && !busy;
  const source = current?.source;
  return <section className="formal-memories">
    <p className="hint">这是当前正式版本，不是候选的写入历史。工作区记忆可跨对话使用，其他 Thread 的私有记忆不会显示。</p>
    <p className="hint">同义查询改写：{queryRewriteEnabled ? "已启用；普通对话会增加一次有界模型请求，失败回退词法检索。" : "关闭；当前使用词法检索。"}</p>
    <button className="ghost" onClick={() => void load(offset)}>刷新列表</button>
    {error ? <p className="error" role="alert">{error}</p> : null}
    {page === null && !error ? <p className="hint">读取中…</p> : null}
    {page?.entries.length === 0 ? <p>没有可见的正式记忆。</p> : null}
    <div className="formal-memory-list">{page?.entries.map(entry => <button className="formal-memory-item" key={entry.id} onClick={() => void open(entry.id)}>
      <span>{entry.preview}{entry.truncated ? "…" : ""}</span>
      <small>{entry.scope?.kind === "thread" ? "当前 Thread" : "工作区"} · v{entry.revision ?? 1} · {entry.status === "disabled" || !entry.enabled ? "已停用" : "启用"}{entry.pinned ? " · 固定" : ""}</small>
    </button>)}</div>
    <div className="actions">{offset > 0 ? <button className="ghost" onClick={() => void load(Math.max(0, offset - 20))}>上一页</button> : null}{page?.nextOffset !== null && page?.nextOffset !== undefined ? <button className="ghost" onClick={() => void load(page.nextOffset!)}>下一页</button> : null}</div>
    {current ? <div className="memory-detail">
      <div className="hint">{current.id} · revision {current.revision ?? 1} · {current.scope?.kind === "thread" ? "当前 Thread" : "工作区"}</div>
      <p className="hint">有效期：{current.expiresAt ?? "无"} · {current.pinned ? "已固定" : "未固定"} · {current.status === "disabled" || !current.enabled ? "已停用" : "启用"}</p>
      <section><div className="memory-label">保存来源</div>{source?.kind === "conversation" ? <><pre className="memory-text">{source.quote}</pre><div className="hint">Thread {source.threadId} · 消息 {source.messageId}</div></> : <p className="hint">{source?.kind === "manual" ? "用户手动保存或编辑" : "旧格式记忆，未附原话"}</p>}</section>
      {stale ? <p className="hint">详情需要重新加载后才能操作。</p> : null}
      <label className="memory-label" htmlFor="formal-memory-text">正文</label>
      <textarea id="formal-memory-text" className="formal-memory-editor" value={text} disabled={!ready} onChange={event => { setText(event.target.value); setPreview(null); }} />
      <div className="actions">
        <button className="ghost" disabled={busy} onClick={() => void open(current.id)}>重新加载详情</button>
        <button className="ghost" disabled={!ready || text === current.text || !text.trim()} onClick={() => setPreview({ id: current.id, expectedRevision: current.revision ?? 1, text })}>预览修改</button>
        <button className="ghost" disabled={!ready} onClick={() => setPreview({ id: current.id, expectedRevision: current.revision ?? 1, pinned: !current.pinned })}>{current.pinned ? "取消固定" : "固定"}</button>
        <button className="deny" disabled={!ready || current.status === "disabled" || !current.enabled} onClick={() => setPreview({ id: current.id, expectedRevision: current.revision ?? 1, status: "disabled" })}>停用</button>
      </div>
      {preview ? <section className="memory-edit-preview"><h3>保存前核对</h3><div className="hint">按 revision {preview.expectedRevision} 保存；版本变化会拒绝，不会覆盖。</div>
        {preview.text !== undefined ? <><div className="memory-label">原正文</div><pre className="memory-text">{current.text}</pre><div className="memory-label">新正文</div><pre className="memory-text">{preview.text}</pre><p className="hint">编辑后当前来源标为手动编辑，旧来源保留在存储历史中。</p></> : <p>{preview.status ? "停用后不会再注入。旧回复中的引用不会被撤回。" : preview.pinned ? "显式固定，仍受范围、有效期与引用预算约束。" : "取消固定，后续按问题匹配。"}</p>}
        <div className="actions"><button className="ghost" onClick={() => setPreview(null)}>返回编辑</button><button className="allow" disabled={!ready} onClick={() => void save()}>确认保存</button></div>
      </section> : null}
    </div> : null}
  </section>;
}
