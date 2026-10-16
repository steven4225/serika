import React, { useCallback, useEffect, useRef, useState } from "react";
import type { FormalMemory, MemoryPage } from "@aisdk-agent/example-cli/dist/memory-management.js";
import type { MemoryActionPreview, MemoryHistoryPage, MemoryMaintenance } from "@aisdk-agent/example-cli/dist/memory-controls.js";
import type { MemoryAssertion, MemoryTemporalView } from "@aisdk-agent/example-cli/dist/memory-store.js";
import { createMemoryActionDraft, explicitTimestamp, memoryActionFromDraft, memoryActionLabel, memoryKindLabel, timestampLabel } from "./memory-temporal-data.js";
import type { MemoryActionDraft, MemoryActionMode } from "./memory-temporal-data.js";
import { CurrentMemoryDetails, MemoryActionPreviewDetails, MemoryHistory, MemoryTemporalQueryResult } from "./memory-temporal.js";
import { memoryDisabledEmptyCopy } from "./memory-copy.js";
import { FailureAlert } from "./failure-notice.js";
import { MemoryBack, MemoryCardHome, MemoryCategoryFolder, MemoryUnderstanding } from "./personal/memory-home.js";
import { isCurrentMemory, memoryCategory, memoryItemTitle, memoryUpdatedLabel, type MemoryCategoryId } from "./personal/memory-cards.js";

const timePlaceholder = "2026-10-04T09:00:00+08:00";
const modeOptions: MemoryActionMode[] = ["correct", "change", "retract", "pin", "disable", "expiry", "delete"];

export function FormalMemories({ enabled, controllerIdle, refreshToken, managementOnly = false }: { enabled: boolean; controllerIdle: boolean; refreshToken: number; queryRewriteEnabled: boolean; managementOnly?: boolean }) {
  const [page, setPage] = useState<MemoryPage | null>(null);
  const [browse, setBrowse] = useState<{ view: "home" } | { view: "summary" } | { view: "category"; category: MemoryCategoryId } | { view: "item"; category: MemoryCategoryId }>({ view: "home" });
  const [summaryTexts, setSummaryTexts] = useState<Record<string, string>>({});
  const [current, setCurrent] = useState<FormalMemory | null>(null);
  const [draft, setDraft] = useState<MemoryActionDraft | null>(null);
  const [preview, setPreview] = useState<MemoryActionPreview | null>(null);
  const [history, setHistory] = useState<MemoryHistoryPage | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [actionOpen, setActionOpen] = useState(false);
  const [currentAssertion, setCurrentAssertion] = useState<MemoryAssertion | undefined>(undefined);
  const [maintenance, setMaintenance] = useState<MemoryMaintenance | null>(null);
  const [maintenanceError, setMaintenanceError] = useState<string | null>(null);
  const [query, setQuery] = useState({ validAt: "", knownAt: "", includeDisabled: false });
  const [queryResult, setQueryResult] = useState<MemoryTemporalView | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [detailToken, setDetailToken] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sequence = useRef(0);
  const detailSequence = useRef(0);
  const selectedId = useRef<string | null>(null);
  const historySequence = useRef(0);
  const previewSequence = useRef(0);
  const querySequence = useRef(0);
  const maintenanceSequence = useRef(0);
  const mutation = useRef(false);
  const currentAssertionId = useRef<string | undefined>(undefined);
  const currentRevision = useRef<number | undefined>(undefined);
  const actionEditor = useRef<HTMLDetailsElement>(null);
  const latestRefreshToken = useRef(refreshToken);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 60_000); return () => window.clearInterval(timer); }, []);
  latestRefreshToken.current = refreshToken;

  const load = useCallback(async () => {
    const request = ++sequence.current;
    const entries: MemoryPage["entries"] = [];
    let start = 0;
    let truncated = false;
    try {
      for (let pageIndex = 0; pageIndex < 8; pageIndex += 1) {
        const result = await window.runloom.listMemories({ offset: start, limit: 50 });
        if (request !== sequence.current) return;
        if (!result.ok) { setPage(null); setListError(`${result.error.code}: ${result.error.message}`); return; }
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
  const loadMaintenance = useCallback(async () => {
    const request = ++maintenanceSequence.current;
    try {
      const result = await window.runloom.getMemoryMaintenance();
      if (request !== maintenanceSequence.current) return;
      if (!result.ok) { setMaintenance(null); setMaintenanceError(`${result.error.code}: ${result.error.message}`); return; }
      setMaintenance(result.value); setMaintenanceError(null);
    } catch { if (request === maintenanceSequence.current) { setMaintenance(null); setMaintenanceError("维护状态读取失败，不是空记忆库。"); } }
  }, []);
  const loadHistory = useCallback(async (id: string, start: number, detailRequest: number) => {
    const request = ++historySequence.current;
    try {
      const result = await window.runloom.getMemoryHistory({ id, offset: start, limit: 8 });
      if (request !== historySequence.current || detailRequest !== detailSequence.current) return;
      if (!result.ok) { setHistory(null); setHistoryError(`${result.error.code}: ${result.error.message}`); return; }
      if (result.value.revision !== currentRevision.current) {
        setHistory(null); setPreview(null); setStale(true); ++previewSequence.current;
        setHistoryError("历史版本已变化，请重新加载详情，旧预览已失效。"); return;
      }
      setHistory(result.value); setHistoryError(null);
      const selected = result.value.assertions.find(assertion => assertion.assertionId === currentAssertionId.current);
      if (selected) setCurrentAssertion(selected);
    } catch { if (request === historySequence.current && detailRequest === detailSequence.current) { setHistory(null); setHistoryError("历史读取失败，请重新加载详情。"); } }
  }, []);
  const open = useCallback(async (id: string) => {
    selectedId.current = id;
    const token = latestRefreshToken.current;
    const request = ++detailSequence.current;
    ++previewSequence.current; ++querySequence.current;
    setCurrent(null); setCurrentAssertion(undefined); currentAssertionId.current = undefined; currentRevision.current = undefined; setDraft(null); setPreview(null); setStale(true); setHistory(null); setHistoryError(null); setHistoryOpen(false); setActionOpen(false); setQueryResult(null); setQueryError(null); setQuery({ validAt: "", knownAt: "", includeDisabled: false }); setNotice(null);
    try {
      const result = await window.runloom.getMemory(id);
      if (request !== detailSequence.current || latestRefreshToken.current !== token) return;
      if (!result.ok) { setError(`${result.error.code}: ${result.error.message}`); return; }
      setCurrent(result.value); setDraft(createMemoryActionDraft(result.value)); setStale(false); setDetailToken(token); setError(null);
      currentAssertionId.current = result.value.assertion?.assertionId;
      currentRevision.current = result.value.revision ?? 1;
      void loadHistory(id, 0, request);
    } catch { if (request === detailSequence.current) setError("详情读取失败，请重新加载"); }
  }, [loadHistory]);
  useEffect(() => {
    setPreview(null); setStale(true); ++detailSequence.current; ++previewSequence.current; ++querySequence.current;
    setHistory(null); setQueryResult(null);
    if (enabled) { void load(); void loadMaintenance(); if (selectedId.current) void open(selectedId.current); }
    return () => { ++sequence.current; ++detailSequence.current; ++historySequence.current; ++previewSequence.current; ++querySequence.current; ++maintenanceSequence.current; };
  }, [enabled, refreshToken, load, loadMaintenance, open]);
  useEffect(() => {
    if (!controllerIdle) { setPreview(null); setStale(true); ++previewSequence.current; }
  }, [controllerIdle]);
  useEffect(() => {
    if (browse.view !== "summary" || page === null) return;
    const ids = page.entries.filter(entry => isCurrentMemory(entry, new Date())).slice(0, 24).map(entry => entry.id);
    let cancelled = false;
    void Promise.all(ids.map(async id => {
      try {
        const result = await window.runloom.getMemory(id);
        return [id, result.ok ? result.value.text : ""] as const;
      } catch { return [id, ""] as const; }
    })).then(pairs => { if (!cancelled) setSummaryTexts(Object.fromEntries(pairs)); });
    return () => { cancelled = true; };
  }, [browse.view, page]);

  const ready = current !== null && !stale && detailToken === refreshToken && controllerIdle && !busy;
  function editDraft(changes: Partial<MemoryActionDraft>) {
    ++previewSequence.current; setPreview(null); setDraft(value => value ? { ...value, ...changes } : null); setNotice(null);
  }
  async function stage() {
    if (!ready || !current || !draft || mutation.current) return;
    if (draft.mode === "correct" && !draft.changeValidTime && history && history.assertions.filter(assertion => assertion.state === "asserted" && assertion.systemTime.to === null).length > 1) {
      setError("当前有多段仍被认可的事实。请勾选「同时纠正事实适用时间」，明确本次纠正要替代的适用范围，再预览。"); return;
    }
    const built = memoryActionFromDraft(current, draft);
    if (!built.ok) { setError(built.message); return; }
    const request = ++previewSequence.current;
    const detailRequest = detailSequence.current;
    setBusy(true); setPreview(null); setError(null); setNotice(null);
    try {
      const result = await window.runloom.previewMemoryAction(built.input);
      if (request !== previewSequence.current || detailRequest !== detailSequence.current || latestRefreshToken.current !== detailToken) return;
      if (!result.ok) { setError(`${result.error.code}: ${result.error.message}。请重新加载详情后核对。`); setStale(true); return; }
      setPreview(result.value);
    } catch { if (request === previewSequence.current) setError("预览读取失败，没有发送保存操作；请重新加载详情。"); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!preview || !ready || mutation.current) return;
    mutation.current = true; setBusy(true);
    const action = preview.input;
    setPreview(null); setStale(true); ++detailSequence.current; ++previewSequence.current; ++querySequence.current;
    try {
      const result = await window.runloom.applyMemoryAction(action);
      if (!result.ok) setError(`${result.error.code}: ${result.error.message}。请重新加载后核对，不会自动重试。`);
      else {
        setCurrent(result.value); setHistory(null); setQueryResult(null); setError(null);
        setNotice(action.operation === "delete" ? "已永久删除本条正式记忆与历史。旧对话未删除。" : "已保存。");
        if (result.value) { setDraft(createMemoryActionDraft(result.value)); setStale(false); setDetailToken(latestRefreshToken.current); currentRevision.current = result.value.revision;
          await open(result.value.id); setNotice("已保存。"); } else { selectedId.current = null; setDraft(null); }
        await Promise.all([load(), loadMaintenance()]);
      }
    } catch { setError("保存结果未确认，请重新加载核对；不要直接重复保存。"); }
    finally { mutation.current = false; setBusy(false); }
  }
  async function queryAt() {
    if (!current || stale || detailToken !== refreshToken || busy) return;
    if ((query.validAt && !explicitTimestamp(query.validAt)) || (query.knownAt && !explicitTimestamp(query.knownAt))) { setQueryError("查询时间须含秒与时区；留空使用现在。"); return; }
    const request = ++querySequence.current, detailRequest = detailSequence.current;
    setQueryResult(null); setQueryError(null);
    try {
      const result = await window.runloom.queryMemory({ id: current.id, ...(query.validAt ? { validAt: query.validAt } : {}), ...(query.knownAt ? { knownAt: query.knownAt } : {}), includeDisabled: query.includeDisabled });
      if (request !== querySequence.current || detailRequest !== detailSequence.current) return;
      if (!result.ok) { setQueryError(`${result.error.code}: ${result.error.message}`); return; }
      setQueryResult(result.value);
    } catch { if (request === querySequence.current) setQueryError("时间查询失败，请重试查询；这不会保存记忆。"); }
  }
  function chooseRestore(assertion: MemoryAssertion) {
    editDraft({ mode: "restore", targetAssertionId: assertion.assertionId, restoreStatus: "", expiryChoice: "" });
    setActionOpen(true); setHistoryOpen(false);
    requestAnimationFrame(() => actionEditor.current?.scrollIntoView({ block: "nearest" }));
  }
  if (!enabled) return <p className="hint">{memoryDisabledEmptyCopy()}</p>;
  const restoreAssertion = history?.assertions.find(assertion => assertion.assertionId === draft?.targetAssertionId);
  const entries = page?.entries ?? [];
  function showItem(id: string, category: MemoryCategoryId) {
    setBrowse({ view: "item", category });
    void open(id);
  }
  return <section className="formal-memories">
    {listError ? <><FailureAlert text={listError} /><button className="ghost" onClick={() => void load()}>重新读取</button></> : null}
    {error && browse.view === "item" ? <FailureAlert text={error} /> : null}
    {notice ? <p className="hint" role="status">{notice}</p> : null}
    {browse.view === "home" ? <>
      {!managementOnly ? <MemoryCardHome loaded={page !== null} entries={entries} now={now} onOpenSummary={() => setBrowse({ view: "summary" })} onOpenCategory={category => setBrowse({ view: "category", category })} /> : null}
      {page?.nextOffset !== null && page?.nextOffset !== undefined ? <p className="hint">还有更多记忆没有载入，分类计数只覆盖已读取的部分。</p> : null}
      {maintenanceError ? <FailureAlert text={maintenanceError} /> : null}
      {maintenance && maintenance.stored >= maintenance.capacity.entries * 0.9 ? <p role="status">记忆空间即将用满（{maintenance.stored}/{maintenance.capacity.entries}）。请按需管理已有内容。</p> : null}
      {managementOnly ? <details className="memory-secondary"><summary>停用与历史记忆</summary>
        {entries.filter(entry => !isCurrentMemory(entry, now)).map(entry => <button className="ghost" key={entry.id} onClick={() => showItem(entry.id, memoryCategory(entry))}>{entry.preview.trim() ? memoryItemTitle(entry.preview) : "历史记忆"} · {entry.temporalState === "retracted" ? "已撤回" : "当前不生效"}</button>)}
      </details> : null}
    </> : null}
    {browse.view === "summary" ? <MemoryUnderstanding entries={entries} texts={summaryTexts} now={now} onBack={() => setBrowse({ view: "home" })} /> : null}
    {browse.view === "category" ? <MemoryCategoryFolder category={browse.category} entries={entries} now={now} onBack={() => setBrowse({ view: "home" })} onOpen={id => showItem(id, browse.category)} /> : null}
    {browse.view === "item" && (!current || !draft) ? <div className="memory-folder">
      <MemoryBack label="记忆" onBack={() => setBrowse(managementOnly ? { view: "home" } : { view: "category", category: browse.category })} />
      {error ? null : <p className="hint">读取中…</p>}
    </div> : null}
    {browse.view === "item" && current && draft ? <div className="memory-detail">
      <MemoryBack label="记忆详情" onBack={() => setBrowse(managementOnly ? { view: "home" } : { view: "category", category: browse.category })} />
      <p className="memory-updated">{memoryUpdatedLabel(current.updatedAt ?? current.createdAt, now)}</p>
      <CurrentMemoryDetails current={current} assertion={currentAssertion} />
      {stale ? <p className="hint">详情已过期或正在运行。重新加载详情后才能操作。</p> : null}
      {stale || error ? <button className="ghost" disabled={busy} onClick={() => void open(current.id)}>重新读取</button> : null}
      <div className="memory-quick-actions">{(["correct", "pin", "disable"] as const).map(mode => <button type="button" className="ghost" disabled={!ready} key={mode} onClick={() => { editDraft({ mode }); setActionOpen(true); }}>{mode === "correct" ? "编辑" : mode === "pin" ? current.pinned ? "取消置顶" : "置顶" : "停用"}</button>)}</div>
      <details className="memory-action-editor memory-temporal-form" ref={actionEditor} open={actionOpen} onToggle={event => setActionOpen(event.currentTarget.open)}>
        <summary>编辑与管理</summary>
        <label className="memory-label" htmlFor="memory-action-mode">你要做什么</label>
        <select id="memory-action-mode" value={draft.mode} disabled={!ready} onChange={event => editDraft({ mode: event.target.value as MemoryActionMode })}>
          {modeOptions.map(mode => <option key={mode} value={mode}>{mode === "pin" ? current.pinned ? "取消固定" : "固定" : memoryActionLabel[mode]}</option>)}
          {draft.mode === "restore" ? <option value="restore">恢复历史内容</option> : null}
        </select>
        {draft.mode === "correct" || draft.mode === "change" ? <>
          <p className="hint">{draft.mode === "correct" ? "原记录写错了：纠正系统认知，不声明现实发生变化。" : "现实确实变了：填写实际生效时间，保留此前适用的事实。"}</p>
          <label className="memory-label" htmlFor="formal-memory-text">新正文</label>
          <textarea id="formal-memory-text" className="formal-memory-editor" value={draft.text} disabled={!ready} onChange={event => editDraft({ text: event.target.value })} />
          {draft.mode === "correct" ? <><label className="memory-label" htmlFor="memory-kind">记忆类型</label><select id="memory-kind" value={draft.kind} disabled={!ready} onChange={event => editDraft({ kind: event.target.value as MemoryActionDraft["kind"] })}>{Object.entries(memoryKindLabel).map(([kind, label]) => <option value={kind} key={kind}>{label}</option>)}</select></> : null}
          <label className="memory-label" htmlFor="memory-recall-terms">检索词（最多三条，每行一条）</label>
          <textarea id="memory-recall-terms" className="formal-memory-editor memory-terms-editor" value={draft.recallTerms} disabled={!ready} onChange={event => editDraft({ recallTerms: event.target.value })} />
          {draft.mode === "change" ? <><label className="memory-label" htmlFor="memory-effective-at">实际生效时间（含秒与时区）</label><input id="memory-effective-at" type="text" placeholder={timePlaceholder} value={draft.effectiveAt} disabled={!ready} onChange={event => editDraft({ effectiveAt: event.target.value })} /></> : <>
            <p className="hint">存在多段仍被认可的历史时，须明确指定这次纠正的适用范围。纠正会替代当前系统认可的各段，保留旧的系统认知；不是只改某一段历史正文。</p>
            <label><input type="checkbox" checked={draft.changeValidTime} disabled={!ready} onChange={event => editDraft({ changeValidTime: event.target.checked })} />同时纠正事实适用时间</label>
            {draft.changeValidTime ? <><label className="memory-label" htmlFor="memory-valid-from">适用开始（未知留空）</label><input id="memory-valid-from" type="text" placeholder={timePlaceholder} value={draft.validFrom} disabled={!ready} onChange={event => editDraft({ validFrom: event.target.value })} /><label className="memory-label" htmlFor="memory-valid-to">适用结束（未指定留空；该时刻起不再适用）</label><input id="memory-valid-to" type="text" placeholder={timePlaceholder} value={draft.validTo} disabled={!ready} onChange={event => editDraft({ validTo: event.target.value })} /></> : null}
          </>}
        </> : null}
        {draft.mode === "restore" ? <><p className="hint">恢复下面这份内容，保留此前的修改历史。</p>{restoreAssertion ? <pre className="memory-text">{restoreAssertion.text}</pre> : null}
          <label className="memory-label" htmlFor="memory-restore-status">恢复后的状态（必须明确选择）</label><select id="memory-restore-status" value={draft.restoreStatus} disabled={!ready} onChange={event => editDraft({ restoreStatus: event.target.value as MemoryActionDraft["restoreStatus"] })}><option value="">请选择</option><option value="active">启用</option><option value="disabled">保持停用</option></select>
        </> : null}
        {draft.mode === "expiry" || draft.mode === "restore" ? <>
          <label className="memory-label" htmlFor="memory-expiry-choice">有效期</label><select id="memory-expiry-choice" value={draft.expiryChoice} disabled={!ready} onChange={event => editDraft({ expiryChoice: event.target.value as MemoryActionDraft["expiryChoice"] })}><option value="">请选择</option>{draft.mode === "restore" ? <option value="keep">保留当前有效期：{timestampLabel(current.expiresAt, "无")}</option> : null}<option value="none">无有效期</option><option value="date">指定时间</option></select>
          {draft.expiryChoice === "date" ? <><label className="memory-label" htmlFor="memory-expiry-at">有效期结束（含秒与时区）</label><input id="memory-expiry-at" type="text" placeholder={timePlaceholder} value={draft.expiresAt} disabled={!ready} onChange={event => editDraft({ expiresAt: event.target.value })} /></> : null}
        </> : null}
        {draft.mode === "delete" ? <p className="error">删除包含正式内容、历史与相关候选，不能撤销。只想暂时不用，请选择停用。</p> : null}
        {draft.mode === "retract" ? <p className="hint">撤回表示不再主张这条事实。历史保留，不等于永久删除。</p> : null}
        <div className="actions"><button className="ghost" disabled={!ready} onClick={() => void stage()}>预览{memoryActionLabel[draft.mode]}</button></div>
      </details>
      {preview ? <section className="memory-edit-preview"><h3>保存前核对</h3><p className="hint">若内容已被其他操作修改，这次会停止保存，不会覆盖。</p>
        <MemoryActionPreviewDetails preview={preview} />
        <div className="actions"><button className="ghost" onClick={() => { ++previewSequence.current; setPreview(null); }}>返回编辑</button><button className={preview.input.operation === "delete" ? "deny" : "allow"} disabled={!ready} onClick={() => void save()}>{preview.input.operation === "delete" ? "确认永久删除" : "确认保存"}</button></div>
      </section> : null}
      <details className="memory-history-drawer" open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary>历史记录</summary>
        {historyError ? <FailureAlert text={historyError} /> : history ? <><MemoryHistory page={history} onRestore={chooseRestore} ready={ready} />
          <div className="actions">{history.nextOffset !== null ? <button className="ghost" onClick={() => void loadHistory(current.id, history.nextOffset!, detailSequence.current)}>下一页历史</button> : null}<button className="ghost" onClick={() => void loadHistory(current.id, 0, detailSequence.current)}>最新历史</button></div>
        </> : <p className="hint">{stale ? "请重新加载详情。" : "读取历史中…"}</p>}
      </details>
      <details className="memory-temporal-query memory-temporal-form"><summary>查询某个时点的认知</summary><p className="hint">只查询，不保存、不调用模型。适用时间问事实何时成立；认知时间问系统当时知道什么。留空使用现在。</p>
        <label className="memory-label" htmlFor="memory-query-valid">事实适用时间</label><input id="memory-query-valid" type="text" placeholder={timePlaceholder} value={query.validAt} disabled={stale} onChange={event => { ++querySequence.current; setQueryResult(null); setQuery(value => ({ ...value, validAt: event.target.value })); }} />
        <label className="memory-label" htmlFor="memory-query-known">系统认知时间</label><input id="memory-query-known" type="text" placeholder={timePlaceholder} value={query.knownAt} disabled={stale} onChange={event => { ++querySequence.current; setQueryResult(null); setQuery(value => ({ ...value, knownAt: event.target.value })); }} />
        <label><input type="checkbox" checked={query.includeDisabled} disabled={stale} onChange={event => { ++querySequence.current; setQueryResult(null); setQuery(value => ({ ...value, includeDisabled: event.target.checked })); }} />查询时包含停用记录（不代表会注入）</label>
        <div className="actions"><button className="ghost" disabled={stale || busy} onClick={() => void queryAt()}>查询此时间视图</button></div>
        {queryError ? <FailureAlert text={queryError} /> : null}{queryResult ? <MemoryTemporalQueryResult view={queryResult} /> : null}
      </details>
    </div> : null}
  </section>;
}
