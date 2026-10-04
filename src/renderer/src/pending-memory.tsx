import { useCallback, useEffect, useRef, useState } from "react";
import {
  canAccept,
  canReject,
  candidateKindLabel,
  candidateOperationExplanation,
  candidateSources,
  memoryKindLabel,
  proposedText,
  resolvePayload,
  scopeLabel,
  systemTimeLabel,
  validTimeLabel,
  unavailableLabel,
} from "../../shared/memory-review.js";
import {
  initialPendingMemory,
  pendingMemoryReducer,
  pendingMemoryStatus,
  type PendingMemoryAction,
  type PendingMemoryStatus,
} from "./pending-memory-data.js";

export type { PendingMemoryStatus } from "./pending-memory-data.js";

interface PendingMemoryProps {
  memory: { enabled: boolean; autoConsolidate: boolean };
  controllerIdle: boolean;
  refreshToken: number;
  visible: boolean;
  onStatus: (status: PendingMemoryStatus) => void;
  onReviewed?: () => void;
  onLater?: () => void;
}

/** Always mounted for counts; visibility never grants authority to review. */
export function PendingMemory({ memory, controllerIdle, refreshToken, visible, onStatus, onReviewed, onLater }: PendingMemoryProps) {
  const [state, setState] = useState(initialPendingMemory);
  const stateRef = useRef(state);
  const enabledRef = useRef(memory.enabled);
  const visibleRef = useRef(visible);
  const idleRef = useRef(controllerIdle);
  const latestRefresh = useRef(refreshToken);
  const seenRefresh = useRef(refreshToken);
  const active = useRef(true);
  const listSeq = useRef(0);
  const detailSeq = useRef(0);
  const resolveLock = useRef(false);
  const reviewedRef = useRef(onReviewed);
  enabledRef.current = memory.enabled;
  visibleRef.current = visible;
  idleRef.current = controllerIdle;
  latestRefresh.current = refreshToken;
  reviewedRef.current = onReviewed;

  // Update the action guard immediately, not only after React's next render.
  const apply = useCallback((action: PendingMemoryAction) => {
    if (!active.current) return;
    stateRef.current = pendingMemoryReducer(stateRef.current, action);
    setState(stateRef.current);
  }, []);

  const fetchList = useCallback(async (request: number) => {
    try {
      const result = await window.runloom.listMemoryCandidates({ status: "pending", limit: 20 });
      if (enabledRef.current) apply({ type: "list-result", request, result });
    } catch {
      if (enabledRef.current) apply({ type: "list-result", request, result: {
        ok: false, error: { code: "IPC_FAILED", message: "候选读取未确认，请刷新核对" },
      } });
    }
  }, [apply]);

  const fetchDetail = useCallback(async (request: number, id: string) => {
    try {
      const result = await window.runloom.getMemoryCandidate(id);
      if (enabledRef.current) apply({ type: "detail-result", request, id, result });
    } catch {
      if (enabledRef.current) apply({ type: "detail-result", request, id, result: {
        ok: false, error: { code: "IPC_FAILED", message: "完整预览未确认，请刷新核对" },
      } });
    }
  }, [apply]);

  const reload = useCallback(() => {
    if (!enabledRef.current) return;
    const listRequest = ++listSeq.current;
    const detailRequest = ++detailSeq.current;
    const id = stateRef.current.selectedId;
    apply({ type: "invalidate", listRequest, detailRequest });
    void fetchList(listRequest);
    // Even after an unknown IPC outcome, reread that candidate before another decision.
    if (id !== null) void fetchDetail(detailRequest, id);
  }, [apply, fetchList, fetchDetail]);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  useEffect(() => {
    apply({ type: "controller", idle: controllerIdle });
  }, [controllerIdle, apply]);

  useEffect(() => {
    if (memory.enabled) reload();
    else apply({ type: "disabled" });
  }, [memory.enabled, apply, reload]);

  useEffect(() => {
    if (seenRefresh.current === refreshToken) return;
    seenRefresh.current = refreshToken;
    reload();
  }, [refreshToken, reload]);

  useEffect(() => window.runloom.onMessage((message) => {
    if (message.type === "memory-updated") reload();
    if (message.type === "state") apply({ type: "controller", idle: message.state.kind === "idle" });
  }), [reload, apply]);

  useEffect(() => {
    const current = stateRef.current;
    if (!memory.enabled || current.listLoading || current.listError !== null || current.selectedId !== null) return;
    const first = current.candidates.find((candidate) => candidate.status === "pending");
    if (!first) return;
    const request = ++detailSeq.current;
    apply({ type: "select", id: first.id, request });
    void fetchDetail(request, first.id);
  }, [memory.enabled, state.candidates, state.listLoading, state.listError, state.selectedId, apply, fetchDetail]);

  const fresh = seenRefresh.current === refreshToken;
  const status = pendingMemoryStatus(state, memory.enabled, visible, fresh);
  useEffect(() => {
    onStatus(status);
  }, [onStatus, status.count, status.hasMore, status.loading, status.error, status.reviewing]);

  const resolve = (decision: "accept" | "reject") => {
    if (resolveLock.current || !enabledRef.current || !visibleRef.current || !idleRef.current
      || seenRefresh.current !== latestRefresh.current) return;
    const current = stateRef.current;
    if (decision === "accept" ? !canAccept(current) : !canReject(current)) return;
    if (current.preview === null) return;
    const input = resolvePayload(current.preview, decision);
    resolveLock.current = true;
    apply({ type: "resolve-start", decision });
    void window.runloom.resolveMemoryCandidate(input).then((result) => {
      apply({ type: "resolve-result", result });
      if (result.ok) reviewedRef.current?.();
      reload();
    }).catch(() => {
      apply({ type: "resolve-unconfirmed" });
      // Read only. Never resubmit a decision whose outcome was not received.
      reload();
    }).finally(() => { resolveLock.current = false; });
  };

  if (!memory.enabled || (!status.loading && status.count === 0 && status.error === null)) return null;
  const preview = state.preview;
  const change = preview?.candidate.change;
  const scope = preview ? scopeLabel(preview) : null;
  const expiresAt = preview?.proposed ? preview.proposed.expiresAt : change?.expiresAt;
  const unavailable = preview ? unavailableLabel(preview) : null;
  const ready = visible && controllerIdle && fresh;

  return (
    <section className="pending-memory" hidden={!visible} aria-labelledby="pending-memory-title">
      <div className="pending-memory-heading">
        <h2 id="pending-memory-title">要接受这项记忆变更吗？</h2>
        <span className="hint">{status.hasMore ? `本次读取 ${status.count} 条，还有更多` : `${status.count} 条待审`}</span>
      </div>
      {state.receipt ? <p className="memory-receipt" role="status">{state.receipt}</p> : null}
      {status.error ? <p className="error" role="alert">{status.error}</p> : null}
      {status.loading ? <p className="hint">正在读取完整候选，核对后才能保存。</p> : null}
      {preview?.candidate.status === "pending" ? (
        <div className="pending-memory-body">
          {state.previewChanged ? <p className="hint">候选内容或版本已变化，请按下面的新预览重新核对。</p> : null}
          <div className="pending-memory-source">
            <span className="memory-label">你的原话</span>
            {candidateSources(preview).map((source, index) => <blockquote key={`${source.threadId}:${source.messageId}:${index}`}>{source.quote}</blockquote>)}
          </div>
          <div className="pending-memory-proposal">
            <span className="memory-label">{candidateKindLabel(preview.candidate)}</span>
            {change?.operation === "retract" ? <><p>撤回这条事实，不再作为当前事实引用。</p><p className="hint">不会删除旧对话、旧摘要或已经发出的回复；它们仍可能包含原话。</p></> : <p>{proposedText(preview)}</p>}
            <p className="hint">{candidateOperationExplanation(preview.candidate)}</p>
          </div>
          {change && change.operation !== "add" ? (
            <div className="pending-memory-current">
              <span className="memory-label">当前记忆</span>
              {preview.current ? <p>{preview.current.text}</p> : <p>当前目标不可用，不能接受此变更。</p>}
            </div>
          ) : null}
          <div className="pending-memory-meta">
            <span>范围：{scope === "workspace" ? "当前工作区，可供其他 Thread 使用" : scope ?? "当前目标不可用"}</span>
            <span>引用到期：{expiresAt === null ? "无有效期" : expiresAt ?? "未提供"}</span>
            <span>事实适用：{validTimeLabel(preview.proposed?.validTime)}</span>
          </div>
          {unavailable ? <p className="hint">当前不可接受：{unavailable}</p> : null}
          <details className="pending-memory-evidence">
            <summary>来源与变更说明</summary>
            <p>{preview.candidate.reason}</p>
            {candidateSources(preview).map((source, index) => <div key={`${source.threadId}:${source.messageId}:${index}`}>
              <p className="hint">来源 {index + 1} Thread：{source.threadId}</p>
              <p className="hint">消息：{source.messageId}</p>
            </div>)}
            <p className="hint">拟保存类型：{memoryKindLabel(preview.proposed?.kind)}</p>
            <p className="hint">检索词：{preview.proposed?.recallTerms?.join("、") || "无"}（只帮助查找）</p>
            {preview.proposed?.effectiveAt ? <p className="hint">事实变化生效于：{preview.proposed.effectiveAt}</p> : null}
            <p className="hint">系统认知时间：{change?.operation === "disable" ? "事实认知历史不变，接受时记录停用" : "接受时记录；尚未写入"}</p>
            {preview.current ? <div>
              <p className="hint">当前断言：{preview.current.assertion?.assertionId ?? "未提供"}；revision {preview.current.revision ?? "未提供"}</p>
              <p className="hint">原事实适用时间：{validTimeLabel(preview.current.assertion?.validTime)}</p>
              <p className="hint">原系统认知时间：{systemTimeLabel(preview.current.assertion?.systemTime)}</p>
            </div> : null}
            <p className="hint">候选版本：{preview.candidate.revision}</p>
            {change && change.operation !== "add" ? <p className="hint">变更目标：{change.memoryId}；预期记忆版本：{change.expectedRevision}</p> : null}
          </details>
          {!controllerIdle ? <p className="hint">助手正在处理任务，空闲后再接受或拒绝。</p> : null}
          <div className="actions pending-memory-actions">
            {onLater ? <button className="ghost" onClick={onLater} disabled={state.resolving}>稍后审核</button> : null}
            <button className="ghost" onClick={reload} disabled={state.resolving || state.listLoading}>重新读取</button>
            <button className="deny" onClick={() => resolve("reject")} disabled={!ready || !canReject(state)}>拒绝</button>
            <button className="allow" onClick={() => resolve("accept")} disabled={!ready || !canAccept(state)}>{state.resolving ? "正在审核…" : "接受变更"}</button>
          </div>
        </div>
      ) : status.error ? <button className="ghost" onClick={reload} disabled={state.listLoading}>重新读取候选</button> : null}
    </section>
  );
}
