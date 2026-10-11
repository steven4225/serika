import React, { useEffect, useRef } from "react";
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
import { runTimeline, usageLabel, durationLabel } from "./run-timeline.js";
import { ModelUsagePanel } from "./model-usage.js";
import type { ModelUsagePage } from "@aisdk-agent/example-cli/dist/model-usage.js";

export type RecordsState =
  | { status: "loading" }
  | { status: "unavailable"; message: string }
  | { status: "ready"; runs: ExecutionRunRecord[]; modelUsage?: ModelUsagePage };

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
      <div className="hint">调用参数{tool.inputTruncated ? "（已截断）" : ""}</div>
      <pre className="record-preview">{tool.inputPreview}{tool.inputTruncated ? "…" : ""}</pre>
      {tool.resultPreview !== null && tool.status === "completed" ? (
        <pre className="record-preview">{tool.resultPreview}{tool.resultTruncated ? "…" : ""}</pre>
      ) : null}
      {tool.errorPreview !== null ? (
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

export function RunTimeline({ run, focusTool, usageRecorded }: { run: ExecutionRunRecord; focusTool?: string | null | undefined; usageRecorded?: boolean }) {
  const focus = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    if (!focusTool || !focus.current) return;
    focus.current.open = true;
    focus.current.scrollIntoView({ block: "center" });
    focus.current.focus({ preventScroll: true });
  }, [focusTool, run.runId]);
  return <div className="run-trace">
    <div className="trace-overview">
      <span>{run.status === "interrupted" ? "中断时间为发现时间，不是实际停止时间" : run.status === "running" ? "正在处理 · 随执行更新" : `本轮用时 ${durationLabel(run.startedAt, run.finishedAt)}（含等待确认）`}</span>
      <span>{usageRecorded ? "已完成步骤用量（不含失败尝试）：" : ""}{usageLabel(run.trace?.usage)} · {usageRecorded ? "调用与费用详见模型用量分项" : "费用未记录"}</span>
    </div>
    {!run.trace ? <p className="trace-coverage">旧记录未记录模型步骤与确认过程；以下只展示已有回执。</p> : null}
    {run.trace?.truncated || run.trace?.incomplete ? <p className="trace-coverage">{run.trace.truncated ? "追踪达到保留上限，部分节点未保留。" : ""}{run.trace.incomplete ? "部分追踪记录保存失败。" : ""} 工具回执独立核对，不补造缺失步骤。</p> : null}
    <ol className="trace-timeline" aria-label="本轮执行时间线">
      {runTimeline(run).map(node => <li className={`trace-node tone-${node.tone}${node.tool?.toolCallId === focusTool ? " focused" : ""}`} key={node.id}>
        <details ref={node.tool?.toolCallId === focusTool ? focus : undefined} tabIndex={-1}>
          <summary><span className="trace-marker" aria-hidden="true" /><span className="trace-name">{node.label}</span><span className="trace-status">{node.status}</span>{node.duration ? <span className="trace-duration">{node.duration}</span> : null}</summary>
          <div className="trace-body"><time dateTime={node.at}>{formatRecordTime(node.at)}</time>
            {node.tool ? <ToolReceipt tool={node.tool} /> : <p>{node.detail ?? "开始本轮处理；未恢复任何旧工具授权。"}</p>}
          </div>
        </details>
      </li>)}
    </ol>
    {run.memoryReferences?.length ? <details className="trace-references"><summary>本轮准备参考的记忆 · {run.memoryReferences.length} 条</summary><p className="hint">记录的是准备时的版本，不证明回答遵循了它，也不代表当前版本。</p>{run.memoryReferences.map(item => <div key={item.id}><code>{item.id}</code> · v{item.revision}</div>)}{run.memoryReferencesTruncated ? <p>引用记录已截断</p> : null}</details> : null}
  </div>;
}

export function RecordsPanel({
  records,
  detail,
  onRefresh,
  onOpen,
  onBack,
  focusTool,
}: {
  records: RecordsState;
  detail: RecordDetailState;
  onRefresh: () => void;
  onOpen: (runId: string) => void;
  onBack: () => void;
  focusTool?: string | null;
}) {
  const selectedId =
    detail.status === "idle" ? null :
    detail.status === "ready" ? detail.run.runId :
    detail.runId;

  return (
    <section className="card records">
      <div className="card-head">
        {selectedId ? <button className="ghost" onClick={onBack}>返回执行列表</button> : <span>执行记录</span>}
        <span className="hint">步骤、确认与工具回执 · 不自动重放</span>
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
      {records.status === "ready" ? <ModelUsagePanel page={records.modelUsage} {...(selectedId ? { runId: selectedId } : {})} /> : null}
      {records.status === "ready" && selectedId === null ? (
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
              {` · ${formatRecordTime(detail.run.startedAt)}`}
              {detail.run.phase === "consolidation" ? " · 不是用户任务" : ""}
            </span>
          </div>
          {detail.run.status === "failed" && detail.run.tools.some((item) => item.status === "completed") ? (
            <div className="hint">这次 Run 失败，但下面已返回的工具回执仍有效。</div>
          ) : null}
          {detail.run.errorPreview ? <pre className="record-preview">{detail.run.errorPreview}</pre> : null}
          <SteerStatus records={detail.run.steers ?? []} />
          <RunTimeline key={detail.run.runId} run={detail.run} focusTool={focusTool} usageRecorded={records.status === "ready" && records.modelUsage !== undefined} />
        </div>
      ) : null}
    </section>
  );
}
