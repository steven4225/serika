import React, { useState } from "react";
import type { ConversationRow, TextRow, ToolRow } from "../conversation.js";
import { Icon, SerikaMark } from "../icons.js";
import { MessageContent } from "../markdown.js";
import { completionLabel } from "../navigation.js";
import { compactWorkSummary, conversationTurns, isMissingFile, toolPresentation, type ConversationFlowItem } from "../ui-kit/conversation-data.js";
import { formatRecordTime } from "../../../shared/execution-records.js";
import { presentReminderReply, reminderSpeechLine, reminderReplyContexts, type ReminderReplyResult } from "../reminder-copy.js";
import { FailureInline } from "../failure-notice.js";
import { SteerStatus } from "../steer-status.js";

type TraceHandler = ((runId: string, toolCallId: string) => void) | undefined;
type RestoreSteer = ((text: string) => void) | undefined;

function AssistantText({ text, result }: { text: string; result?: ReminderReplyResult | undefined }) {
  const view = presentReminderReply(text, result);
  return <>
    <MessageContent text={view.primary} />
    {view.aside ? <details className="personal-tool-technical"><summary>原始回复</summary><MessageContent text={view.aside} /></details> : null}
  </>;
}

function PersonalText({ row, result, onRestoreSteer }: { row: TextRow; result?: ReminderReplyResult | undefined; onRestoreSteer?: RestoreSteer }) {
  const article = <article className={`personal-message role-${row.role}`}>
    {row.role === "user" ? <pre className="personal-user-text">{row.text}</pre> : <AssistantText text={row.text} result={result} />}
    {row.steerRecord ? <SteerStatus records={[row.steerRecord]} onRestore={onRestoreSteer} /> : null}
  </article>;
  if (row.role !== "assistant") return article;
  return <div className="personal-assistant-row"><SerikaMark size={32} />{article}</div>;
}

export function PersonalTool({ row, onTrace, workspaceRoot }: { row: ToolRow; onTrace?: TraceHandler; workspaceRoot?: string | undefined }) {
  const view = toolPresentation(row);
  const reply = row.toolName.startsWith("task_") && row.detail ? presentReminderReply(row.detail, row) : null;
  const spoken = reply && (reply.primary !== row.detail || reminderSpeechLine(row.detail) !== null) ? reply.primary : null;
  const path = row.inputPath ?? row.receipt?.path;
  const missing = isMissingFile(row);
  const shell = row.toolName === "shell_exec";
  // Shorten only the known workspace prefix in Shell display; raw output remains inspectable.
  const displayOutput = (text: string) => shell && workspaceRoot
    ? text.replaceAll(`file://${workspaceRoot}/`, "./").replaceAll(`${workspaceRoot}/`, "./") : text;
  const shortenedOutput = [row.stdout, row.stderr, row.output].some(text => text !== undefined && displayOutput(text) !== text);
  const status = shell && typeof row.exitCode === "number" && (row.status === "ok" || row.status === "failed")
    ? `${row.status === "failed" ? "失败 · " : ""}exit ${row.exitCode}` : row.status === "ok" ? "完成" : view.status;
  const mark = row.status === "ok" ? "✓" : row.status === "failed" ? "×" : row.status === "requested" ? "◌" : view.attention ? "!" : "–";
  return <details className={`personal-tool status-${row.status}${missing ? " missing-file" : ""}`} open={view.attention}>
    <summary><span className="personal-tool-mark" aria-hidden="true">{mark}</span>
      <span className="personal-tool-name">{spoken ?? (shell ? "命令" : view.name)}</span>
      {shell && row.inputCommand ? <code className="personal-tool-command" title={row.inputCommand}>{row.inputCommand}</code> : null}
      {path ? <span className="personal-tool-path" title={path}>{path}</span> : null}
      <span className={`personal-tool-status${row.status === "ok" && !shell ? " zcode-sr-only" : ""}`}>{status}</span></summary>
    <div className="personal-tool-body">
      {row.fileContent ? <><pre className="personal-tool-output">{row.fileContent.text || "（空文件）"}</pre>{row.fileContent.truncated ? <p className="personal-tool-warning">内容预览已截断</p> : null}</> : null}
      {row.fileChange ? <div className="personal-file-change">
        {row.status !== "ok" ? <p className="personal-tool-warning">请求的修改 · 以执行回执为准</p> : null}
        {row.fileChange.before !== undefined ? <><small>替换前</small><pre className="change-before">{row.fileChange.before}</pre></> : null}
        <small>{row.fileChange.before !== undefined ? "替换后" : "写入内容"}</small><pre className="change-after">{row.fileChange.after}</pre>
        {row.fileChange.truncated ? <p className="personal-tool-warning">修改预览已截断</p> : null}
      </div> : null}
      {missing ? <p>该路径没有文件，未读取到内容。</p> : !spoken && row.detail && !(shell && row.detail === `exit ${row.exitCode}`) && (row.status !== "ok" || !shell && !row.receipt && !row.fileContent) ? <p><FailureInline text={row.detail} /></p> : null}
      {row.stdout ? <pre className="personal-tool-output stdout">{displayOutput(row.stdout)}</pre> : null}
      {row.stderr ? <pre className="personal-tool-output stderr">{displayOutput(row.stderr)}</pre> : null}
      {!row.stdout && !row.stderr && row.output ? <pre className="personal-tool-output">{displayOutput(row.output)}</pre> : null}
      {shell && row.status === "ok" && !row.stdout && !row.stderr && !row.output ? <p className="personal-output-empty">无输出</p> : null}
      {row.progressTruncated ? <p className="personal-tool-warning">输出已截断</p> : null}
      {row.status === "unknown" && !row.detail ? <p className="personal-tool-warning">执行效果未知，请核对后再继续。</p> : null}
      <details className="personal-tool-technical"><summary>诊断详情</summary><code>{row.toolName}</code>
        <p className="personal-receipt-meta">{row.historical ? "历史记录" : "本次调用"}{row.recordedAt ? <> · <time dateTime={row.recordedAt}>{formatRecordTime(row.recordedAt)}</time></> : " · 时间未记录"}</p>
        {path && workspaceRoot ? <p className="personal-receipt-meta">当前文件工作区：{workspaceRoot}</p> : null}
        {shell && row.inputCommand ? <pre className="personal-tool-input">{row.inputCommand}</pre> : null}
        {shell && row.inputCwd ? <p className="personal-receipt-meta">执行目录：{row.inputCwd}</p> : null}
        {row.receipt ? <p>{row.receipt.bytes} 字节</p> : null}
        {shortenedOutput ? <><p>原始命令输出</p>{row.stdout ? <pre className="personal-tool-output">{row.stdout}</pre> : null}{row.stderr ? <pre className="personal-tool-output">{row.stderr}</pre> : null}{!row.stdout && !row.stderr && row.output ? <pre className="personal-tool-output">{row.output}</pre> : null}</> : null}
        {(missing || shell) && row.detail ? <p>{row.detail}</p> : null}
        {row.runId && onTrace ? <button type="button" className="personal-trace-link" onClick={() => onTrace(row.runId!, row.toolCallId)}>查看本次执行追踪<Icon name="chevron" size={13} /></button> : null}
      </details>
    </div>
  </details>;
}

function Work({ rows, running, waitingForApproval, onTrace, workspaceRoot, results }: { rows: ConversationRow[]; running: boolean; waitingForApproval: boolean; onTrace?: TraceHandler; workspaceRoot?: string | undefined; results: ReadonlyMap<string, ReminderReplyResult> }) {
  const [showAll, setShowAll] = useState(false);
  const summary = compactWorkSummary(rows, running, waitingForApproval);
  const tools = rows.filter((row): row is ToolRow => row.kind === "tool");
  const recentStart = tools.length > 3 ? rows.indexOf(tools.at(-3)!) : 0;
  // Keep unresolved effects visible even when they precede the recent steps.
  const visible = running && !showAll ? rows.filter((row, index) => index >= recentStart || row.kind === "tool" && toolPresentation(row).attention) : rows;
  return <details className={`personal-work${summary.needsAttention ? " needs-attention" : ""}${running ? " is-running" : ""}`} open={running || summary.needsAttention || summary.pending}>
    <summary><Icon name="activity" size={14} /><span className="personal-work-heading"><span>{summary.title}{summary.facts ? <span className="personal-work-facts"> · {summary.facts}</span> : null}</span>
      {summary.notice ? <span className="personal-work-notice">{summary.notice}</span> : null}</span></summary>
    <div className="personal-work-content">
      {visible.map(row => row.kind === "tool" ? <PersonalTool key={row.key} row={row} onTrace={onTrace} workspaceRoot={workspaceRoot} /> : row.kind === "text" ? <PersonalText key={row.key} row={row} result={results.get(row.key)} /> : null)}
      {running && tools.length > 3 ? <button type="button" className="personal-work-more" onClick={() => setShowAll(!showAll)}>{showAll ? "只看最近 3 步" : `查看全部过程（${tools.length} 步）`}</button> : null}
    </div>
  </details>;
}

function FlowItem({ item, running, waitingForApproval, onTrace, workspaceRoot, results, onRestoreSteer }: { item: ConversationFlowItem; running: boolean; waitingForApproval: boolean; onTrace?: TraceHandler; workspaceRoot?: string | undefined; results: ReadonlyMap<string, ReminderReplyResult>; onRestoreSteer?: RestoreSteer }) {
  if (item.kind === "text") return <PersonalText row={item.row} result={results.get(item.row.key)} onRestoreSteer={onRestoreSteer} />;
  if (item.kind === "work") return <Work rows={item.rows} running={running} waitingForApproval={waitingForApproval} onTrace={onTrace} workspaceRoot={workspaceRoot} results={results} />;
  return <div className={`personal-completion status-${item.row.status}`} role="status"><Icon name={item.row.completion?.reason === "delivered" ? "check" : "activity"} size={14} />
    <span>{completionLabel(item.row)}{item.row.detail ? <> · <FailureInline text={item.row.detail} /></> : null}</span></div>;
}

function ReplyActions({ text }: { text: string }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  return <div className="personal-reply-actions"><button type="button" aria-label={copied === "copied" ? "已复制回复" : copied === "failed" ? "复制失败，重试" : "复制回复"}
    title={copied === "copied" ? "已复制" : "复制回复"} onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied("copied"), () => setCopied("failed"))}>
    <Icon name={copied === "copied" ? "check" : "copy"} size={14} /></button>{copied === "failed" ? <span role="alert">复制失败，请重试</span> : null}</div>;
}

export function PersonalConversation({ rows, running, streaming, waitingForApproval = false, onTrace, workspaceRoot, onRestoreSteer }: {
  rows: readonly ConversationRow[]; running: boolean; streaming: string; waitingForApproval?: boolean; onTrace?: TraceHandler;
  workspaceRoot?: string | undefined;
  onRestoreSteer?: RestoreSteer;
}) {
  const results = reminderReplyContexts(rows);
  return <>{conversationTurns(rows, running).map(turn => {
    const activeWork = turn.items.filter(item => item.kind === "work").at(-1);
    return <section className="personal-turn" key={turn.key} aria-label="对话轮次">
    {turn.items.map((item, index) => <FlowItem key={item.kind === "work" ? item.rows[0]!.key : item.row.key || index} item={item} running={turn.running && item === activeWork} waitingForApproval={turn.running && waitingForApproval && item === activeWork} onTrace={onTrace} workspaceRoot={workspaceRoot} results={results.byText} onRestoreSteer={onRestoreSteer} />)}
    {!turn.running && turn.copyText ? <ReplyActions text={turn.copyText} /> : null}
  </section>; })}
    {running && streaming ? <div className="personal-assistant-row"><SerikaMark size={32} /><article className="personal-message role-assistant streaming" aria-label="正在回复"><AssistantText text={streaming} result={results.latest} /></article></div> : null}
    {running && !streaming ? <div className="personal-assistant-row"><SerikaMark size={32} /><p className="personal-loading" role="status"><span aria-hidden="true" />{waitingForApproval ? "等待确认后继续" : "正在处理"}</p></div> : null}
  </>;
}

export function PersonalBackToBottom({ onClick, unread }: { onClick: () => void; unread: boolean }) {
  return <button type="button" className="personal-back-to-bottom" title="回到最新消息" aria-label="回到最新消息" onClick={onClick}>
    <Icon name="arrow" size={16} style={{ transform: "rotate(180deg)" }} />{unread ? <span className="personal-new-output" aria-label="有新输出" /> : null}
  </button>;
}
