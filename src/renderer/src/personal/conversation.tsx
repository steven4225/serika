import React, { useState } from "react";
import type { ConversationRow, TextRow, ToolRow } from "../conversation.js";
import { Icon } from "../icons.js";
import { MessageContent } from "../markdown.js";
import { completionLabel } from "../navigation.js";
import { conversationTurns, toolPresentation, workSummary, type ConversationFlowItem } from "../zcode/conversation-data.js";

type TraceHandler = ((runId: string, toolCallId: string) => void) | undefined;

function PersonalText({ row }: { row: TextRow }) {
  return <article className={`personal-message role-${row.role}`}>
    {row.steer ? <small className="personal-supplement">补充本轮要求</small> : null}
    {row.role === "user" ? <pre className="personal-user-text">{row.text}</pre> : <MessageContent text={row.text} />}
  </article>;
}

export function PersonalTool({ row, onTrace }: { row: ToolRow; onTrace?: TraceHandler }) {
  const view = toolPresentation(row);
  return <details className={`personal-tool status-${row.status}`} open={view.attention || (row.status === "requested" && !!(row.stdout || row.stderr))}>
    <summary><Icon name={view.icon} size={15} /><span className="personal-tool-name">{view.name}</span>
      {row.receipt ? <span className="personal-tool-path" title={row.receipt.path}>{row.receipt.path}</span> : null}
      <span className="personal-tool-status">{view.status}</span><Icon name="chevron" size={13} /></summary>
    <div className="personal-tool-body">
      {view.name !== row.toolName ? <code>{row.toolName}</code> : null}
      {row.receipt ? <p>{row.receipt.bytes} 字节 · 工具回执，不等于任务验收</p> : null}
      {row.detail ? <p>{row.detail}</p> : null}
      {row.stdout ? <pre className="personal-tool-output stdout">{row.stdout}</pre> : null}
      {row.stderr ? <pre className="personal-tool-output stderr">{row.stderr}</pre> : null}
      {row.progressTruncated ? <p className="personal-tool-warning">输出已截断；不能据此判断执行成功</p> : null}
      {!row.receipt && !row.detail && !row.stdout && !row.stderr ? <p>详细输入与回执可在执行追踪中查看。</p> : null}
      {row.runId && onTrace ? <button type="button" className="personal-trace-link" onClick={() => onTrace(row.runId!, row.toolCallId)}>查看本次执行追踪<Icon name="chevron" size={13} /></button> : null}
    </div>
  </details>;
}

function Work({ rows, onTrace }: { rows: ConversationRow[]; onTrace?: TraceHandler }) {
  const summary = workSummary(rows);
  return <details className={`personal-work${summary.needsAttention ? " needs-attention" : ""}`} open={summary.needsAttention || summary.pending}>
    <summary><Icon name="activity" size={14} /><span>{summary.label}</span><Icon name="chevron" size={13} /></summary>
    <div className="personal-work-content">{rows.map(row => row.kind === "tool" ? <PersonalTool key={row.key} row={row} onTrace={onTrace} /> : row.kind === "text" ? <PersonalText key={row.key} row={row} /> : null)}</div>
  </details>;
}

function FlowItem({ item, onTrace }: { item: ConversationFlowItem; onTrace?: TraceHandler }) {
  if (item.kind === "text") return <PersonalText row={item.row} />;
  if (item.kind === "work") return <Work rows={item.rows} onTrace={onTrace} />;
  return <div className={`personal-completion status-${item.row.status}`} role="status"><Icon name={item.row.completion?.reason === "delivered" ? "check" : "activity"} size={14} />
    <span>{completionLabel(item.row)}{item.row.detail ? ` · ${item.row.detail}` : ""}</span></div>;
}

function ReplyActions({ text }: { text: string }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  return <div className="personal-reply-actions"><button type="button" aria-label={copied === "copied" ? "已复制回复" : copied === "failed" ? "复制失败，重试" : "复制回复"}
    title={copied === "copied" ? "已复制" : "复制回复"} onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied("copied"), () => setCopied("failed"))}>
    <Icon name={copied === "copied" ? "check" : "copy"} size={14} /></button>{copied === "failed" ? <span role="alert">复制失败，请重试</span> : null}</div>;
}

export function PersonalConversation({ rows, running, streaming, waitingForApproval = false, onTrace }: {
  rows: readonly ConversationRow[]; running: boolean; streaming: string; waitingForApproval?: boolean; onTrace?: TraceHandler;
}) {
  return <>{conversationTurns(rows, running).map(turn => <section className="personal-turn" key={turn.key} aria-label="对话轮次">
    {turn.items.map((item, index) => <FlowItem key={item.kind === "work" ? item.rows[0]!.key : item.row.key || index} item={item} onTrace={onTrace} />)}
    {!turn.running && turn.copyText ? <ReplyActions text={turn.copyText} /> : null}
  </section>)}
    {running && streaming ? <article className="personal-message role-assistant streaming" aria-label="正在回复"><MessageContent text={streaming} /></article> : null}
    {running && !streaming ? <p className="personal-loading" role="status"><span aria-hidden="true" />{waitingForApproval ? "等待确认后继续" : "正在处理"}</p> : null}
  </>;
}

export function PersonalBackToBottom({ onClick, unread }: { onClick: () => void; unread: boolean }) {
  return <button type="button" className="personal-back-to-bottom" title="回到最新消息" aria-label="回到最新消息" onClick={onClick}>
    <Icon name="arrow" size={16} style={{ transform: "rotate(180deg)" }} />{unread ? <span className="personal-new-output" aria-label="有新输出" /> : null}
  </button>;
}
