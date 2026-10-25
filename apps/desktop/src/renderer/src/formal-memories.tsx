import React, { useCallback, useEffect, useRef, useState } from "react";
import type { FormalMemory, MemoryAction, MemoryPage } from "@serika/assistant";
import type { MemoryMaintenance } from "@serika/assistant";
import { MemoryExtractionFailures } from "./memory-extraction-failures.js";
import { CurrentMemoryDetails } from "./memory-temporal.js";
import { memoryDisabledEmptyCopy, savedMemoryEmptyCopy } from "./memory-copy.js";
import { FailureAlert } from "./failure-notice.js";
import { MemoryBack } from "./personal/memory-home.js";
import { isCurrentMemory, memoryItemTitle, memoryUpdatedLabel } from "./personal/memory-cards.js";
import { memoryErrorText } from "../../shared/memory-labels.js";

/** Saved memories can only be edited or deleted. Deletion is permanent and needs one confirmation. */
export function FormalMemories({ enabled, controllerIdle, refreshToken }: { enabled: boolean; controllerIdle: boolean; refreshToken: number; managementOnly?: boolean }) {
  const [page, setPage] = useState<MemoryPage | null>(null);
  const [current, setCurrent] = useState<FormalMemory | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editText, setEditText] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [maintenance, setMaintenance] = useState<MemoryMaintenance | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sequence = useRef(0);
  const detailSequence = useRef(0);
  const mutation = useRef(false);
  const now = new Date();

  const load = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const result = await window.runloom.getMemoryMaintenance();
      if (request === sequence.current) setMaintenance(result.ok ? result.value : null);
    } catch { if (request === sequence.current) setMaintenance(null); }
    const entries: MemoryPage["entries"] = [];
    let start = 0;
    let truncated = false;
    try {
      for (let pageIndex = 0; pageIndex < 8; pageIndex += 1) {
        const result = await window.runloom.listMemories({ offset: start, limit: 50 });
        if (request !== sequence.current) return;
        if (!result.ok) { setPage(null); setListError(memoryErrorText(result.error)); return; }
        entries.push(...result.value.entries);
        const next = result.value.nextOffset;
        if (next === null) { truncated = false; break; }
        if (next <= start || pageIndex === 7) { truncated = true; break; }
        start = next;
      }
      if (request !== sequence.current) return;
      setPage({ entries, nextOffset: truncated ? start : null });
      setListError(null);
    } catch { if (request === sequence.current) { setPage(null); setListError("记忆读取失败，请重新加载"); } }
  }, []);
  const open = useCallback(async (id: string) => {
    const request = ++detailSequence.current;
    setOpenId(id); setCurrent(null); setEditText(null); setConfirmDelete(false); setError(null);
    try {
      const result = await window.runloom.getMemory(id);
      if (request !== detailSequence.current) return;
      if (!result.ok) { setError(memoryErrorText(result.error)); return; }
      setCurrent(result.value);
    } catch { if (request === detailSequence.current) setError("详情读取失败，请重新加载"); }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void load();
    return () => { ++sequence.current; };
  }, [enabled, refreshToken, load]);
  const seenRefresh = useRef(refreshToken);
  useEffect(() => {
    // Reload the open item only when the outside world changed.
    if (seenRefresh.current === refreshToken) return;
    seenRefresh.current = refreshToken;
    if (openId !== null && enabled && !mutation.current) void open(openId);
  }, [refreshToken, openId, enabled, open]);

  const ready = current !== null && controllerIdle && !busy;
  async function apply(action: MemoryAction, done: string) {
    if (!ready || mutation.current) return;
    mutation.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const result = await window.runloom.applyMemoryAction(action);
      if (!result.ok) { setError(`${memoryErrorText(result.error)}不会自动重试。`); return; }
      setNotice(done);
      if (result.value) { setCurrent(result.value); setEditText(null); }
      else { setCurrent(null); setOpenId(null); setConfirmDelete(false); }
      await load();
    } catch { setError("保存结果未确认，请重新加载核对；不要直接重复操作。"); }
    finally { mutation.current = false; setBusy(false); }
  }
  function back() { ++detailSequence.current; setOpenId(null); setCurrent(null); setEditText(null); setConfirmDelete(false); setError(null); }

  if (!enabled) return <p className="hint">{memoryDisabledEmptyCopy()}</p>;
  const entries = page?.entries ?? [];
  if (openId !== null) return <section className="formal-memories"><div className="memory-detail">
    <MemoryBack label="记忆详情" onBack={back} />
    {error ? <FailureAlert text={error} /> : null}
    {notice ? <p className="hint" role="status">{notice}</p> : null}
    {current === null ? error ? <button className="ghost" onClick={() => void open(openId)}>重新读取</button> : <p className="hint">读取中…</p> : <>
      <p className="memory-updated">{memoryUpdatedLabel(current.updatedAt ?? current.createdAt, now)}</p>
      {editText === null ? <CurrentMemoryDetails current={current} /> : <>
        <label className="memory-label" htmlFor="formal-memory-text">记忆内容</label>
        <textarea id="formal-memory-text" className="formal-memory-editor" value={editText} disabled={!ready} onChange={event => setEditText(event.target.value)} />
      </>}
      {confirmDelete ? <section className="memory-delete-confirm" role="alertdialog" aria-label="确认删除">
        <p className="error">删除后不能撤销。旧对话不会因此删除。</p>
        <div className="actions"><button className="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>取消</button>
          <button className="deny" disabled={!ready} onClick={() => void apply({ id: current.id, expectedRevision: current.revision ?? 1, operation: "delete" }, "已删除这条记忆。")}>确认删除</button></div>
      </section> : editText !== null ? <div className="actions">
        <button className="ghost" disabled={busy} onClick={() => setEditText(null)}>取消</button>
        <button className="allow" disabled={!ready || !editText.trim() || editText === current.text} onClick={() => void apply({ id: current.id, expectedRevision: current.revision ?? 1, operation: "correct", text: editText }, "已保存。")}>保存</button>
      </div> : <div className="memory-quick-actions">
        <button type="button" className="ghost" disabled={!ready || !current.text} onClick={() => { setNotice(null); setEditText(current.text); }}>编辑</button>
        <button type="button" className="ghost" disabled={!ready} onClick={() => { setNotice(null); setConfirmDelete(true); }}>删除</button>
      </div>}
    </>}
  </div></section>;
  return <section className="formal-memories">
    <MemoryExtractionFailures maintenance={maintenance} />
    {listError ? <><FailureAlert text={listError} /><button className="ghost" onClick={() => void load()}>重新读取</button></> : null}
    {notice ? <p className="hint" role="status">{notice}</p> : null}
    {page === null && !listError ? <p className="hint">读取中…</p> : null}
    {page !== null && entries.length === 0 ? <p className="hint">{savedMemoryEmptyCopy()}</p> : null}
    {maintenance && maintenance.stored !== null && maintenance.stored >= maintenance.capacity.entries * 0.9 ? <p role="status">记忆空间即将用满（{maintenance.stored}/{maintenance.capacity.entries}）。可以删除不再需要的记忆。</p> : null}
    <div className="memory-list">
      {entries.map(entry => <button type="button" className="ghost memory-row" key={entry.id} onClick={() => void open(entry.id)}>
        <span className="memory-row-text">{entry.preview.trim() ? memoryItemTitle(entry.preview) : "记忆"}</span>
        {entry.uncertain ? <span className="hint">不确定</span> : null}
        {!isCurrentMemory(entry, now) ? <span className="hint">当前不生效</span> : null}
      </button>)}
    </div>
    {page?.nextOffset !== null && page?.nextOffset !== undefined ? <p className="hint">还有更多记忆没有载入。</p> : null}
  </section>;
}
