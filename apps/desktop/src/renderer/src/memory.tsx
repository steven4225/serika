import React, { useCallback, useEffect, useRef, useState } from "react";
import { FormalMemories } from "./formal-memories.js";
import { MemoryLibraryPanel } from "./memory-library.js";
import { pendingMemoryReducer } from "./pending-memory-data.js";
import { loadActionablePending } from "./pending-memory-query.js";
import { memoryAutomationLabel, memoryCandidateEmptyCopy } from "./memory-copy.js";
import { FailureAlert } from "./failure-notice.js";
import { MemorySavedNotice } from "./memory-saved-notice.js";
import type { CandidatePreview } from "@serika/example-cli/dist/memory-candidates.js";
import { formatRecordTime } from "../../shared/execution-records.js";
import {
  canAccept,
  canReject,
  candidateKindLabel,
  candidateAcceptLabel,
  candidateOperationExplanation,
  candidateSources,
  initialMemoryPanel,
  listErrorText,
  loadedLabel,
  memoryPanelReducer,
  memoryKindLabel,
  proposedText,
  resolvePayload,
  reviewErrorText,
  scopeLabel,
  shortPreview,
  statusLabel,
  systemTimeLabel,
  unavailableLabel,
  validTimeLabel,
  type CandidateFilter,
  type MemoryPanelAction,
  type MemoryPanelState,
} from "../../shared/memory-review.js";

const HISTORY_FILTERS: readonly CandidateFilter[] = ["accepted", "rejected", "stale"];

function expiresLabel(value: string | null | undefined): string {
  if (value === undefined) return "未提供";
  return value === null ? "无有效期" : value;
}

export function CandidateDetail({
  preview,
  previewChanged,
  canAcceptDecision,
  canRejectDecision,
  resolving,
  onAccept,
  onReject,
  onRefresh,
}: {
  preview: CandidatePreview;
  previewChanged: boolean;
  canAcceptDecision: boolean;
  canRejectDecision: boolean;
  resolving: boolean;
  onAccept: () => void;
  onReject: () => void;
  onRefresh: () => void;
}) {
  const change = preview.candidate.change;
  const scope = scopeLabel(preview);
  const reason = unavailableLabel(preview);
  const targetMissing = change.operation !== "add" && preview.current === null;
  const proposed = preview.proposed;
  const currentAssertion = preview.current?.assertion;
  return (
    <div className="memory-detail">
      {previewChanged ? <div className="hint">预览已更新，请重新核对</div> : null}
      <section>
        <div className="memory-label">原话来源</div>
        {candidateSources(preview).map((source, index) => <div key={`${source.threadId}:${source.messageId}:${index}`}>
          <blockquote className="memory-text">{source.quote}</blockquote>
          <details>
            <summary className="hint">来源 {index + 1} 的记录信息</summary>
            <div className="hint">{source.threadId}</div>
            <div className="hint">{source.messageId}</div>
          </details>
        </div>)}
      </section>
      {change.operation !== "add" ? <section>
        <div className="memory-label">当前记忆</div>
        {preview.current !== null ? (
          <div className="memory-change">
            <pre className="memory-text">{preview.current.text}</pre>
            <div className="hint">类型 {memoryKindLabel(currentAssertion?.kind)} · {currentAssertion?.state === "retracted" ? "事实已撤回" : preview.current.status === "disabled" ? "已停用" : "当前记录"}</div>
            <div className="hint">事实适用时间：{validTimeLabel(currentAssertion?.validTime)}</div>
          </div>
        ) : null}
        {targetMissing ? <div>当前目标不可用</div> : null}
      </section> : null}
      <section>
        <div className="memory-label">{candidateKindLabel(preview.candidate)} · 接受后的记忆</div>
        <p className="hint">{candidateOperationExplanation(preview.candidate)}</p>
        {change.operation === "retract" ? <><p>这条事实将被撤回，不再作为当前事实引用。</p><p className="hint">旧对话、旧摘要和已经发出的回复不会被删除，仍可能包含原话。</p></> : <pre className="memory-text">{proposedText(preview)}</pre>}
        {proposed !== null ? <>
          {proposed.validTime && (proposed.validTime.from !== null || proposed.validTime.to !== null) ? <div className="hint">事实适用时间：{validTimeLabel(proposed.validTime)}</div> : <div className="hint">事实适用时间：{proposed.validTime ? "未指定边界" : "未提供"}</div>}
          {proposed.effectiveAt ? <div className="hint">事实变化生效于：{proposed.effectiveAt}</div> : null}
        </> : <p className="hint">完整变更预览不可用，不能接受。</p>}
        <div className="memory-review-scope">范围：{scope === null ? "当前目标不可用" : scope === "workspace" ? "当前工作区，可供其他对话使用" : "仅当前对话"}</div>
        <div className="hint">引用到期时间 {expiresLabel(proposed !== null ? proposed.expiresAt : change.expiresAt)}</div>
      </section>
      {preview.candidate.status !== "pending" || reason ? <section>
        <div className="memory-label">状态</div>
        <div>
          {statusLabel(preview.candidate.status)}
          {preview.applicable ? " · 可接受" : " · 不可接受"}
        </div>
        {reason ? <div className="hint">{reason}</div> : null}
      </section> : null}
      <details className="memory-technical">
        <summary>来源与版本详情</summary>
        <pre className="memory-text memory-reason">{preview.candidate.reason}</pre>
        <div className="hint">候选 {preview.candidate.id} · revision {preview.candidate.revision}</div>
        {change.operation !== "add" ? <div className="hint">目标 {change.memoryId} · expectedRevision {change.expectedRevision}</div> : null}
        {preview.current ? <>
          <div className="hint">当前版本 revision {preview.current.revision ?? "未提供"} · 断言 {currentAssertion?.assertionId ?? "未提供"}</div>
          <div className="hint">系统认知时间：{systemTimeLabel(currentAssertion?.systemTime)}</div>
          <div className="hint">原检索词：{currentAssertion?.recallTerms.join("、") || "无"}</div>
        </> : null}
        <div className="hint">系统认知时间：{change.operation === "disable" ? "事实认知历史不变，接受时记录停用" : "接受时记录；尚未写入"}</div>
        <div className="hint">检索词：{proposed?.recallTerms?.join("、") || "无"}（只帮助查找，不是事实或权限）</div>
        <div className="hint">类型 {memoryKindLabel(proposed?.kind)} · 事实适用时间：{validTimeLabel(proposed?.validTime)}</div>
        {proposed ? <div className="hint">{proposed.pinned ? "已固定" : "未固定"}</div> : null}
        {preview.candidate.appliedResult ? <div className="hint">当时写入 {preview.candidate.appliedResult.memoryId} · revision {preview.candidate.appliedResult.revision}</div> : null}
      </details>
      <div className="actions">
        <button className="ghost" onClick={onRefresh} disabled={resolving}>刷新</button>
        {preview.candidate.status === "pending" ? <>
          <button className="deny" onClick={onReject} disabled={!canRejectDecision}>拒绝</button>
          <button className="allow" onClick={onAccept} disabled={!canAcceptDecision}>{resolving ? "正在审核…" : candidateAcceptLabel(preview.candidate)}</button>
        </> : null}
      </div>
    </div>
  );
}

export type MemoryTab = "pending" | "formal" | "history";
/** Saved cards are the ordinary page. A specific candidate is the only review deep link. */
export function memoryTabOnOpen(pendingCount: number, candidateId?: string | null): MemoryTab {
  void pendingCount;
  return candidateId ? "pending" : "formal";
}

export function MemoryTabs({ tab, onSelect, pendingCount = 0, pendingHasMore = false }: { tab: MemoryTab; onSelect: (tab: MemoryTab) => void; pendingCount?: number; pendingHasMore?: boolean }) {
  return <div className="memory-tabs" role="tablist" aria-label="记忆视图">
    {([["formal", "已保存"], ["pending", "待审核"], ["history", "审核记录"]] as const).map(([id, label]) =>
      <button key={id} role="tab" aria-selected={tab === id} onClick={() => onSelect(id)}>{label}{id === "pending" && pendingCount > 0 ? `（${pendingCount}${pendingHasMore ? "+" : ""}）` : ""}</button>)}
  </div>;
}

export function MemoryPanel(props: { libraryAvailable?: boolean; onManage?: () => void; managementOnly?: boolean; memory: { enabled: boolean; autoConsolidate: boolean; queryRewriteEnabled?: boolean; writePolicy?: "automatic" | "review" }; threadId?: string; temporaryThread: boolean; controllerIdle: boolean; refreshToken: number; focusRequest?: { id: string | null; sequence: number }; pendingCount?: number; pendingHasMore?: boolean }) {
  const count = props.memory.enabled ? props.pendingCount ?? 0 : 0;
  const [tab, setTab] = useState<MemoryTab>(() => memoryTabOnOpen(count, props.focusRequest?.id));
  const previous = useRef({ count, sequence: props.focusRequest?.sequence });
  useEffect(() => {
    const old = previous.current;
    previous.current = { count, sequence: props.focusRequest?.sequence };
    if (old.sequence !== props.focusRequest?.sequence) setTab(memoryTabOnOpen(count, props.focusRequest?.id));
    else if (old.count > 0 && count === 0) setTab(current => current === "pending" ? "formal" : current);
  }, [count, props.focusRequest?.id, props.focusRequest?.sequence]);
  return <div className="personal-memory">
    {tab === "formal" ? <>
      <>{props.managementOnly ? <FormalMemories enabled={props.memory.enabled} controllerIdle={props.controllerIdle} refreshToken={props.refreshToken} queryRewriteEnabled={props.memory.queryRewriteEnabled === true} managementOnly /> : props.libraryAvailable ? <MemoryLibraryPanel enabled={props.memory.enabled} controllerIdle={props.controllerIdle} refreshToken={props.refreshToken} onManage={props.onManage} /> : <p role="status">当前助手宿主需要更新后才能使用记忆文件夹。</p>}</>
      {props.managementOnly ? <details className="memory-secondary"><summary>未保存内容与处理记录</summary>
        <button type="button" className="ghost" onClick={() => setTab("pending")}>查看未保存内容</button>
        <button type="button" className="ghost" onClick={() => setTab("history")}>查看处理记录</button>
      </details> : null}
    </> : <div className="memory-review">
      <button type="button" className="ghost memory-review-back" onClick={() => setTab("formal")}>返回记忆</button>
      <MemoryTabs tab={tab} onSelect={setTab} pendingCount={count} pendingHasMore={props.pendingHasMore === true} />
      <CandidateMemories key={tab} {...props} mode={tab} onSaved={() => setTab("formal")} />
    </div>}
  </div>;
}

function CandidateMemories({
  memory,
  temporaryThread,
  controllerIdle,
  refreshToken,
  mode,
  threadId,
  focusRequest,
  onSaved,
}: {
  memory: { enabled: boolean; autoConsolidate: boolean; writePolicy?: "automatic" | "review" };
  temporaryThread: boolean;
  controllerIdle: boolean;
  refreshToken: number;
  mode: "pending" | "history";
  threadId?: string;
  focusRequest?: { id: string | null; sequence: number };
  onSaved: () => void;
}) {
  const [state, setState] = useState<MemoryPanelState>(() => ({ ...initialMemoryPanel(), open: true, filter: mode === "pending" ? "pending" : "accepted" }));
  const stateRef = useRef(state);
  const active = useRef(true);
  const [receipt, setReceipt] = useState("");
  const enabledRef = useRef(memory.enabled);
  const idleRef = useRef(controllerIdle);
  const latestRefresh = useRef(refreshToken);
  enabledRef.current = memory.enabled;
  idleRef.current = controllerIdle;
  latestRefresh.current = refreshToken;
  const dispatch = useCallback((action: MemoryPanelAction) => {
    if (!active.current) return;
    stateRef.current = mode === "pending" ? pendingMemoryReducer(stateRef.current, action) : memoryPanelReducer(stateRef.current, action);
    if (stateRef.current.receipt) setReceipt(stateRef.current.receipt);
    setState(stateRef.current);
  }, [mode]);
  const listSeq = useRef(0);
  const detailSeq = useRef(0);
  const resolveLock = useRef(false);
  const seenRefresh = useRef(refreshToken);

  const fetchList = useCallback(async (request: number, filter: CandidateFilter, offset?: number) => {
    try {
      const result = filter === "pending"
        ? await loadActionablePending(window.runloom, threadId ?? (await window.runloom.info()).threadId)
        : await window.runloom.listMemoryCandidates(offset === undefined ? { status: filter, limit: 20 } : { status: filter, offset, limit: 20 });
      dispatch({ type: "list-result", request, result });
    } catch {
      dispatch({
        type: "list-result",
        request,
        result: { ok: false, error: { code: "IPC_FAILED", message: "列表结果未确认，请刷新核对" } },
      });
    }
  }, [dispatch, threadId]);

  const fetchDetail = useCallback(async (request: number, id: string) => {
    try {
      const result = await window.runloom.getMemoryCandidate(id);
      dispatch({ type: "detail-result", request, id, result });
    } catch {
      dispatch({
        type: "detail-result",
        request,
        id,
        result: { ok: false, error: { code: "IPC_FAILED", message: "详情结果未确认，请刷新核对" } },
      });
    }
  }, [dispatch]);

  const reload = useCallback((filter: CandidateFilter, selectedId: string | null) => {
    const listRequest = ++listSeq.current;
    const detailRequest = ++detailSeq.current;
    dispatch({ type: "invalidate", listRequest, detailRequest });
    void fetchList(listRequest, filter);
    if (selectedId !== null) void fetchDetail(detailRequest, selectedId);
  }, [dispatch, fetchDetail, fetchList]);

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  useEffect(() => {
    dispatch({ type: "controller", idle: controllerIdle });
  }, [controllerIdle, dispatch]);

  useEffect(() => {
    if (!memory.enabled) return;
    const request = ++listSeq.current;
    dispatch({ type: "list-start", request, append: false });
    void fetchList(request, stateRef.current.filter);
  }, [memory.enabled, fetchList, dispatch]);

  useEffect(() => {
    if (seenRefresh.current === refreshToken) return;
    seenRefresh.current = refreshToken;
    if (!memory.enabled) return;
    reload(stateRef.current.filter, stateRef.current.selectedId);
  }, [refreshToken, memory.enabled, reload]);

  useEffect(() => {
    if (mode !== "pending" || !memory.enabled || !focusRequest?.id || !focusRequest.sequence) return;
    const request = ++detailSeq.current;
    dispatch({ type: "select", id: focusRequest.id, request });
    void fetchDetail(request, focusRequest.id);
  }, [mode, memory.enabled, focusRequest?.id, focusRequest?.sequence, dispatch, fetchDetail]);

  useEffect(() => {
    if (mode !== "pending" || !memory.enabled || state.listLoading || state.listError || state.selectedId !== null) return;
    const first = state.candidates.find(candidate => candidate.status === "pending");
    if (!first) return;
    const request = ++detailSeq.current;
    dispatch({ type: "select", id: first.id, request });
    void fetchDetail(request, first.id);
  }, [mode, memory.enabled, state.listLoading, state.listError, state.selectedId, state.candidates, dispatch, fetchDetail]);

  const refresh = (): void => {
    if (!memory.enabled) return;
    reload(state.filter, state.selectedId);
  };

  const chooseFilter = (filter: CandidateFilter): void => {
    if (filter === state.filter) return;
    setReceipt("");
    const request = ++listSeq.current;
    dispatch({ type: "set-filter", filter, request });
    void fetchList(request, filter);
  };

  const loadMore = (): void => {
    if (state.nextOffset === null || state.listLoading) return;
    const request = ++listSeq.current;
    dispatch({ type: "list-start", request, append: true });
    void fetchList(request, state.filter, state.nextOffset);
  };

  const openDetail = (id: string): void => {
    setReceipt("");
    const request = ++detailSeq.current;
    dispatch({ type: "select", id, request });
    void fetchDetail(request, id);
  };

  const resolve = (decision: "accept" | "reject"): void => {
    if (resolveLock.current || !enabledRef.current || !idleRef.current || seenRefresh.current !== latestRefresh.current) return;
    const current = stateRef.current;
    const preview = current.preview;
    if (preview === null) return;
    if (decision === "accept" && !canAccept(current)) return;
    if (decision === "reject" && !canReject(current)) return;
    resolveLock.current = true;
    setReceipt("");
    const input = resolvePayload(preview, decision);
    dispatch({ type: "resolve-start", decision });
    void window.runloom.resolveMemoryCandidate(input).then((result) => {
      dispatch({ type: "resolve-result", result });
      reload(stateRef.current.filter, stateRef.current.selectedId);
    }).catch(() => {
      dispatch({ type: "resolve-unconfirmed" });
      reload(stateRef.current.filter, stateRef.current.selectedId);
    }).finally(() => {
      resolveLock.current = false;
    });
  };

  const fresh = seenRefresh.current === refreshToken;
  const acceptEnabled = memory.enabled && controllerIdle && fresh && canAccept(state);
  const rejectEnabled = memory.enabled && controllerIdle && fresh && canReject(state);
  const automaticEmpty = mode === "pending" && memory.writePolicy === "automatic" && !state.listLoading && state.listError === null && state.candidates.length === 0;

  return (
    <section className={`card memory memory-${mode}`} aria-label={mode === "pending" ? "只审核当前对话的候选，接受前不会成为正式记忆" : "当前对话的审核记录"}>
      {!memory.enabled || !memory.autoConsolidate ? <div className="hint">{memoryAutomationLabel(memory)}。{memory.enabled ? "仍可查看已有候选。" : "记忆模块未启用。"}</div> : null}
      {!automaticEmpty && (mode === "history" || state.preview === null) ? <div className="hint">{mode === "history" ? "这是当前对话的审核记录，不是正式记忆的版本历史。" : "只审核当前对话的候选，接受前不会成为正式记忆。"}</div> : null}
      {temporaryThread ? <div className="hint">重启后不会自动回到这些候选的来源对话。</div> : null}
      {state.open ? (
        <div className="memory-body">
          {mode === "history" || state.preview === null ? <div className="memory-filters">
            {(mode === "history" ? HISTORY_FILTERS : []).map((filter) => (
              <button
                key={filter}
                className={filter === state.filter ? "chip active" : "chip"}
                onClick={() => chooseFilter(filter)}
              >
                {statusLabel(filter)}
              </button>
            ))}
            <button className="ghost" onClick={refresh} disabled={!memory.enabled || state.listLoading}>刷新</button>
          </div> : null}
          {receipt ? state.receiptDetail ? <MemorySavedNotice primary={receipt} detail={state.receiptDetail} onSaved={onSaved} /> : <MemorySavedNotice primary={receipt} /> : null}
          {state.reviewError ? <FailureAlert text={state.reviewError} /> : null}
          {!memory.enabled ? null : state.listLoading && state.candidates.length === 0 ? (
            <div className="muted">正在读取候选…</div>
          ) : null}
          {state.listError ? <FailureAlert text={listErrorText(state.listError)} /> : null}
          {mode === "history" && memory.enabled && !state.listLoading && state.listError === null ? (
            <div className="hint">
              {loadedLabel(state.candidates.length)}
              {state.truncated ? " · 本次列表未返回全部" : ""}
            </div>
          ) : null}
          {memory.enabled && !state.listLoading && state.listError === null && state.candidates.length === 0 ? (
            <div className="memory-empty">{memoryCandidateEmptyCopy(state.filter, memory.writePolicy)}</div>
          ) : null}
          {mode === "history" || state.candidates.length > 0 ? <details className="candidate-list-disclosure" open={mode === "history"}>
          <summary>{mode === "history" ? "候选审核列表" : `选择待审核候选（已加载 ${state.candidates.length} 条）`}</summary>
          <div className="memory-list">
            {state.candidates.map((candidate) => (
              <div className="memory-row" key={candidate.id}>
                <span>{candidateKindLabel(candidate)}</span>
                <span className="memory-row-text">{shortPreview(candidate.change.text)}</span>
                <span className="hint">{statusLabel(candidate.status)} · {formatRecordTime(candidate.createdAt)}</span>
                <button className="ghost" onClick={() => openDetail(candidate.id)}>查看详情</button>
              </div>
            ))}
          </div>
          {state.nextOffset !== null ? (
            <button className="ghost" onClick={loadMore} disabled={state.listLoading}>加载下一页</button>
          ) : null}
          </details> : null}
          {state.detailLoading ? <div className="muted">正在读取详情…</div> : null}
          {state.detailError ? <FailureAlert text={reviewErrorText(state.detailError, state.controllerIdle)} /> : null}
          {state.preview ? (
            <CandidateDetail
              preview={state.preview}
              previewChanged={state.previewChanged}
              canAcceptDecision={acceptEnabled}
              canRejectDecision={rejectEnabled}
              resolving={state.resolving}
              onAccept={() => resolve("accept")}
              onReject={() => resolve("reject")}
              onRefresh={refresh}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
