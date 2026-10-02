import { useCallback, useEffect, useReducer, useRef } from "react";
import type { CandidatePreview } from "@aisdk-agent/example-cli/dist/memory-candidates.js";
import { formatRecordTime } from "../../shared/execution-records.js";
import {
  canAccept,
  canReject,
  capabilityText,
  candidateKindLabel,
  initialMemoryPanel,
  listErrorText,
  loadedLabel,
  memoryPanelReducer,
  proposedText,
  resolvePayload,
  reviewErrorText,
  scopeLabel,
  shortPreview,
  sourceQuote,
  statusLabel,
  unavailableLabel,
  type CandidateFilter,
} from "../../shared/memory-review.js";

const FILTERS: readonly CandidateFilter[] = ["pending", "accepted", "rejected", "stale"];

function expiresLabel(value: string | null | undefined): string {
  if (value === undefined) return "未提供";
  return value === null ? "无有效期" : value;
}

function Detail({
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
  const updateMissing = change.operation === "update" && preview.current === null;
  return (
    <div className="memory-detail">
      {previewChanged ? <div className="hint">预览已更新，请重新核对</div> : null}
      <section>
        <div className="memory-label">来源</div>
        <pre className="memory-text">{sourceQuote(preview)}</pre>
        <details>
          <summary className="hint">Thread 与 message</summary>
          <div className="hint">{preview.candidate.source.threadId}</div>
          <div className="hint">{preview.candidate.source.messageId}</div>
        </details>
      </section>
      <section>
        <div className="memory-label">建议</div>
        <pre className="memory-text">{proposedText(preview)}</pre>
        <pre className="memory-text memory-reason">{preview.candidate.reason}</pre>
      </section>
      <section>
        <div className="memory-label">变更</div>
        {change.operation === "add" ? <div>新增记忆</div> : null}
        {change.operation === "update" && preview.current !== null ? (
          <div className="memory-change">
            <pre className="memory-text">{preview.current.text}</pre>
            <span className="hint">更新后</span>
            <pre className="memory-text">{change.text}</pre>
            <div className="hint">目标 {change.memoryId} · expectedRevision {change.expectedRevision}</div>
          </div>
        ) : null}
        {updateMissing ? <div>当前目标不可用</div> : null}
      </section>
      <section>
        <div className="memory-label">范围</div>
        {scope === null ? <div>当前目标不可用</div> : <div>{scope}</div>}
        <div className="hint">有效期 {expiresLabel(preview.proposed?.expiresAt ?? change.expiresAt)}</div>
        {preview.proposed ? <div className="hint">{preview.proposed.pinned ? "pinned" : "未固定"}</div> : null}
      </section>
      <section>
        <div className="memory-label">状态</div>
        <div>
          {statusLabel(preview.candidate.status)}
          {preview.applicable ? " · 可接受" : " · 不可接受"}
        </div>
        {reason ? <div className="hint">{reason}</div> : null}
        {preview.candidate.appliedResult ? (
          <div className="hint">
            当时写入 {preview.candidate.appliedResult.memoryId} · revision {preview.candidate.appliedResult.revision}
          </div>
        ) : null}
      </section>
      <div className="actions">
        <button className="ghost" onClick={onRefresh} disabled={resolving}>刷新</button>
        <button className="deny" onClick={onReject} disabled={!canRejectDecision}>拒绝</button>
        <button className="allow" onClick={onAccept} disabled={!canAcceptDecision}>接受</button>
      </div>
    </div>
  );
}

export function MemoryPanel({
  memory,
  temporaryThread,
  controllerIdle,
  refreshToken,
}: {
  memory: { enabled: boolean; autoConsolidate: boolean };
  temporaryThread: boolean;
  controllerIdle: boolean;
  refreshToken: number;
}) {
  const [state, dispatch] = useReducer(memoryPanelReducer, undefined, () => ({ ...initialMemoryPanel(), open: true }));
  const stateRef = useRef(state);
  stateRef.current = state;
  const listSeq = useRef(0);
  const detailSeq = useRef(0);
  const resolveLock = useRef(false);
  const seenRefresh = useRef(refreshToken);

  const fetchList = useCallback(async (request: number, filter: CandidateFilter, offset?: number) => {
    try {
      const result = await window.runloom.listMemoryCandidates(
        offset === undefined ? { status: filter, limit: 20 } : { status: filter, offset, limit: 20 },
      );
      dispatch({ type: "list-result", request, result });
    } catch {
      dispatch({
        type: "list-result",
        request,
        result: { ok: false, error: { code: "IPC_FAILED", message: "列表结果未确认，请刷新核对" } },
      });
    }
  }, []);

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
  }, []);

  const reload = useCallback((filter: CandidateFilter, selectedId: string | null) => {
    const listRequest = ++listSeq.current;
    const detailRequest = ++detailSeq.current;
    dispatch({ type: "invalidate", listRequest, detailRequest });
    void fetchList(listRequest, filter);
    if (selectedId !== null) void fetchDetail(detailRequest, selectedId);
  }, [fetchDetail, fetchList]);

  useEffect(() => {
    dispatch({ type: "controller", idle: controllerIdle });
  }, [controllerIdle]);

  useEffect(() => {
    if (!memory.enabled) return;
    const request = ++listSeq.current;
    dispatch({ type: "list-start", request, append: false });
    void fetchList(request, "pending");
  }, [memory.enabled, fetchList]);

  useEffect(() => {
    if (seenRefresh.current === refreshToken) return;
    seenRefresh.current = refreshToken;
    if (!memory.enabled) return;
    reload(stateRef.current.filter, stateRef.current.selectedId);
  }, [refreshToken, memory.enabled, reload]);

  const refresh = (): void => {
    if (!memory.enabled) return;
    reload(state.filter, state.selectedId);
  };

  const chooseFilter = (filter: CandidateFilter): void => {
    if (filter === state.filter) return;
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
    const request = ++detailSeq.current;
    dispatch({ type: "select", id, request });
    void fetchDetail(request, id);
  };

  const resolve = (decision: "accept" | "reject"): void => {
    if (resolveLock.current) return;
    const current = stateRef.current;
    const preview = current.preview;
    if (preview === null) return;
    if (decision === "accept" && !canAccept(current)) return;
    if (decision === "reject" && !canReject(current)) return;
    resolveLock.current = true;
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

  const acceptEnabled = canAccept(state);
  const rejectEnabled = canReject(state);

  return (
    <section className="card memory">
      <div className="hint">{capabilityText(memory)}</div>
      {temporaryThread ? <div className="hint">重启后不会自动回到这些候选的来源 Thread。</div> : null}
      {state.open ? (
        <div className="memory-body">
          <div className="memory-filters">
            {FILTERS.map((filter) => (
              <button
                key={filter}
                className={filter === state.filter ? "chip active" : "chip"}
                onClick={() => chooseFilter(filter)}
              >
                {statusLabel(filter)}
              </button>
            ))}
            <button className="ghost" onClick={refresh} disabled={!memory.enabled || state.listLoading}>刷新</button>
          </div>
          {state.receipt ? <div className="memory-receipt">{state.receipt}</div> : null}
          {state.reviewError ? <div className="error">{state.reviewError}</div> : null}
          {!memory.enabled ? null : state.listLoading && state.candidates.length === 0 ? (
            <div className="muted">正在读取候选…</div>
          ) : null}
          {state.listError ? <div className="error">{listErrorText(state.listError)}</div> : null}
          {memory.enabled && !state.listLoading && state.listError === null ? (
            <div className="hint">
              {loadedLabel(state.candidates.length)}
              {state.truncated ? " · 本次列表未返回全部" : ""}
            </div>
          ) : null}
          {memory.enabled && !state.listLoading && state.listError === null && state.candidates.length === 0 ? (
            <div className="memory-empty">{state.filter === "pending" ? "没有待审核的候选。对话中出现新的长期信息后，可以在这里核对并接受。" : "当前对话没有此状态的候选。"}</div>
          ) : null}
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
          {state.detailLoading ? <div className="muted">正在读取详情…</div> : null}
          {state.detailError ? <div className="error">{reviewErrorText(state.detailError, state.controllerIdle)}</div> : null}
          {state.preview ? (
            <Detail
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
