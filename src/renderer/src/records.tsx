import {
  EXECUTION_RECORDS_UNAVAILABLE,
  formatRecordTime,
  runPhaseLabel,
  runStatusLabel,
  runSummary,
  toolNote,
  toolStatusLabel,
  toolTone,
} from "../../shared/execution-records.js";
import type { ExecutionRunRecord, ExecutionToolRecord } from "../../shared/ui-contract.js";
import { SteerStatus } from "./steer-status.js";

export type RecordsState =
  | { status: "loading" }
  | { status: "unavailable"; message: string }
  | { status: "ready"; runs: ExecutionRunRecord[] };

export type RecordDetailState =
  | { status: "idle" }
  | { status: "loading"; runId: string }
  | { status: "unavailable"; runId: string; message: string }
  | { status: "missing"; runId: string }
  | { status: "ready"; run: ExecutionRunRecord };

function ToolReceipt({ tool }: { tool: ExecutionToolRecord }) {
  const tone = toolTone(tool);
  return (
    <div className={`record-tool tone-${tone}`}>
      <div className="record-tool-head">
        <code>{tool.toolName}</code>
        <span className="tool-status">{toolStatusLabel(tool.status)}</span>
      </div>
      <div className="record-tool-note">{toolNote(tool)}</div>
      {tool.status === "unknown" || tool.status === "not_started" || tool.status === "completed" ? (
        <pre className="record-preview">{tool.inputPreview}{tool.inputTruncated ? "…" : ""}</pre>
      ) : null}
      {tool.resultPreview !== null && tool.status === "completed" ? (
        <pre className="record-preview">{tool.resultPreview}{tool.resultTruncated ? "…" : ""}</pre>
      ) : null}
      {tool.errorPreview !== null && tool.status === "failed" ? (
        <pre className="record-preview">{tool.errorPreview}</pre>
      ) : null}
      <div className="hint">
        {formatRecordTime(tool.requestedAt)}
        {tool.startedAt ? ` · started ${formatRecordTime(tool.startedAt)}` : ""}
        {tool.finishedAt ? ` · finished ${formatRecordTime(tool.finishedAt)}` : ""}
      </div>
    </div>
  );
}

export function RecordsPanel({
  records,
  detail,
  onRefresh,
  onOpen,
}: {
  records: RecordsState;
  detail: RecordDetailState;
  onRefresh: () => void;
  onOpen: (runId: string) => void;
}) {
  const selectedId =
    detail.status === "idle" ? null :
    detail.status === "ready" ? detail.run.runId :
    detail.runId;

  return (
    <section className="card records">
      <div className="card-head">
        <span>执行记录</span>
        <span className="hint">审计回执，不是进度 · 不自动重放</span>
        <button className="ghost" onClick={onRefresh} disabled={records.status === "loading"}>
          刷新
        </button>
      </div>
      {records.status === "loading" ? <div className="muted">正在读取执行记录…</div> : null}
      {records.status === "unavailable" ? (
        <div className="error">
          {EXECUTION_RECORDS_UNAVAILABLE}
          {records.message ? <div className="hint">{records.message}</div> : null}
        </div>
      ) : null}
      {records.status === "ready" && records.runs.length === 0 ? (
        <div className="muted">暂无执行记录</div>
      ) : null}
      {records.status === "ready" ? (
        <div className="record-list">
          {records.runs.map((item) => (
            <button
              key={item.runId}
              className={`record-row status-${item.status}${selectedId === item.runId ? " selected" : ""}`}
              onClick={() => onOpen(item.runId)}
            >
              <span className={`dot status-${item.status}`} />
              <span className="record-summary">{runSummary(item)}</span>
              <span className="hint">{formatRecordTime(item.startedAt)}</span>
            </button>
          ))}
        </div>
      ) : null}
      {detail.status === "loading" ? <div className="muted">正在打开 {detail.runId}…</div> : null}
      {detail.status === "unavailable" ? (
        <div className="error">{EXECUTION_RECORDS_UNAVAILABLE}</div>
      ) : null}
      {detail.status === "missing" ? (
        <div className="muted">当前 Thread 没有这条记录</div>
      ) : null}
      {detail.status === "ready" ? (
        <div className="record-detail">
          <div className="record-detail-head">
            <span>{runStatusLabel(detail.run.status)}</span>
            <span className="hint">
              {runPhaseLabel(detail.run.phase)}
              {detail.run.phase === "consolidation" ? " · 不是用户任务" : ""}
            </span>
          </div>
          {detail.run.status === "failed" && detail.run.tools.some((item) => item.status === "completed") ? (
            <div className="hint">这次 Run 失败，但下面已返回的工具回执仍有效。</div>
          ) : null}
          {detail.run.errorPreview ? <pre className="record-preview">{detail.run.errorPreview}</pre> : null}
          <SteerStatus records={detail.run.steers ?? []} />
          {detail.run.tools.map((item) => (
            <ToolReceipt key={item.toolCallId} tool={item} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
