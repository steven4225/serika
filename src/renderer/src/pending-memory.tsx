import { useCallback, useEffect, useRef, useState } from "react";
import {
  canAccept,
  canReject,
  candidateKindLabel,
  proposedText,
  resolvePayload,
  scopeLabel,
  sourceQuote,
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
}

/** Always mounted for counts; visibility never grants authority to review. */
export function PendingMemory({ memory, controllerIdle, refreshToken, visible, onStatus, onReviewed }: PendingMemoryProps) {
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
  const expiresAt = preview?.proposed?.expiresAt ?? change?.expiresAt;
  const unavailable = preview ? unavailableLabel(preview) : null;
  const ready = visible && controllerIdle && fresh;

  return (
    <section className="pending-memory" hidden={!visible} aria-labelledby="pending-memory-title">
      <div className="pending-memory-heading">
        <h2 id="pending-memory-title">要把这句话记住吗？</h2>
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
            <blockquote>{sourceQuote(preview)}</blockquote>
          </div>
          <div className="pending-memory-proposal">
            <span className="memory-label">{candidateKindLabel(preview.candidate)}为正式记忆</span>
            <p>{proposedText(preview)}</p>
          </div>
          {change?.operation === "update" ? (
            <div className="pending-memory-current">
              <span className="memory-label">将更新的当前记忆</span>
              {preview.current ? <p>{preview.current.text}</p> : <p>当前目标不可用，不能接受此更新。</p>}
            </div>
          ) : null}
          <div className="pending-memory-meta">
            <span>范围：{scope === "workspace" ? "当前工作区，可供其他 Thread 使用" : scope ?? "当前目标不可用"}</span>
            <span>有效期：{expiresAt === null ? "无有效期" : expiresAt ?? "未提供"}</span>
          </div>
          {unavailable ? <p className="hint">当前不可接受：{unavailable}</p> : null}
          <details className="pending-memory-evidence">
            <summary>来源与变更说明</summary>
            <p>{preview.candidate.reason}</p>
            <p className="hint">来源 Thread：{preview.candidate.source.threadId}</p>
            <p className="hint">消息：{preview.candidate.source.messageId}</p>
            <p className="hint">候选版本：{preview.candidate.revision}</p>
            {change?.operation === "update" ? <p className="hint">更新目标：{change.memoryId}；预期记忆版本：{change.expectedRevision}</p> : null}
          </details>
          {!controllerIdle ? <p className="hint">助手正在处理任务，空闲后再接受或拒绝。</p> : null}
          <div className="actions pending-memory-actions">
            <button className="ghost" onClick={reload} disabled={state.resolving || state.listLoading}>重新读取</button>
            <button className="deny" onClick={() => resolve("reject")} disabled={!ready || !canReject(state)}>拒绝</button>
            <button className="allow" onClick={() => resolve("accept")} disabled={!ready || !canAccept(state)}>{state.resolving ? "正在审核…" : "接受并保存"}</button>
          </div>
        </div>
      ) : status.error ? <button className="ghost" onClick={reload} disabled={state.listLoading}>重新读取候选</button> : null}
    </section>
  );
}
