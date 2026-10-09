/*
 * Adapted from zai-org/ZCode at 29628c9acdb81b703bbd4080c207a0e7ce5e276e:
 * ConversationTurnGroup, ToolSummaryRow, ConversationTimeline, ChatLoading.
 * Copyright 2026 Z.AI Co., Ltd. Apache-2.0; see third-party/zcode/NOTICE.md.
 * Modified by Serika: native disclosures, scoped CSS and existing safe Markdown;
 * no ZCode account, telemetry, runtime, protocol or services.
 */
import React, { useState } from "react";
import type { ConversationRow, TextRow, ToolRow } from "../conversation.js";
import { MessageContent } from "../markdown.js";
import { Icon } from "../icons.js";
import { completionLabel } from "../navigation.js";
import { ZCodeMessage, ZCodeMessageActions, ZCodeMessageContent } from "./message.js";
import { conversationTurns, toolPresentation, workSummary, type ConversationFlowItem } from "./conversation-data.js";
import { ChatLoading } from "./upstream/chat-loading.js";
import { Button } from "./upstream/button.js";
type TraceHandler = ((runId: string, toolCallId: string) => void) | undefined;

function Text({ row }: { row: TextRow }) {
  return <ZCodeMessage from={row.role} className={`zcode-text role-${row.role}`}>
    <ZCodeMessageContent>{row.steer ? <small className="muted">补充本轮要求</small> : null}{row.role === "user" ? <pre>{row.text}</pre> : <MessageContent text={row.text} />}</ZCodeMessageContent>
  </ZCodeMessage>;
}

export function ZCodeTool({ row, onTrace }: { row: ToolRow; onTrace?: TraceHandler }) {
  const view = toolPresentation(row);
  return <details className={`zcode-tool status-${row.status}`} open={view.attention || (row.status === "requested" && !!(row.stdout || row.stderr))}>
    <summary><Icon name={view.icon} size={15} /><span className="zcode-tool-name">{view.name}</span>
      {row.receipt ? <code className="zcode-tool-path" title={row.receipt.path}>{row.receipt.path}</code> : null}
      <span className="zcode-tool-status">{view.status}</span><Icon name="chevron" size={14} /></summary>
    <div className="zcode-tool-body">{view.name !== row.toolName ? <code>{row.toolName}</code> : null}
      {row.receipt ? <p>{row.receipt.bytes} 字节 · 工具回执，不等于任务验收</p> : null}
      {row.detail ? <p>{row.detail}</p> : null}
      {row.stdout ? <pre className="shell-stream stdout">{row.stdout}</pre> : null}
      {row.stderr ? <pre className="shell-stream stderr">{row.stderr}</pre> : null}
      {row.progressTruncated ? <span className="truncated">输出已截断；不能据此判断执行成功</span> : null}
      {!row.receipt && !row.detail && !row.stdout && !row.stderr ? <p>详细输入与回执可在「执行记录」中查看。</p> : null}
      {row.runId && onTrace ? <button type="button" className="ghost" onClick={() => onTrace(row.runId!, row.toolCallId)}>查看本次执行追踪</button> : null}
    </div>
  </details>;
}

function Work({ rows, running, onTrace }: { rows: ConversationRow[]; running: boolean; onTrace?: TraceHandler }) {
  const summary = workSummary(rows);
  return <details className={`zcode-work${summary.needsAttention ? " needs-attention" : ""}`} open={running || summary.needsAttention || summary.pending}>
    <summary><Icon name="chevron" size={14} /><span>{summary.label}</span></summary>
    <div className="zcode-work-content">{rows.map(row => row.kind === "tool" ? <ZCodeTool key={row.key} row={row} onTrace={onTrace} /> : row.kind === "text" ? <Text key={row.key} row={row} /> : null)}</div>
  </details>;
}

function FlowItem({ item, running, onTrace }: { item: ConversationFlowItem; running: boolean; onTrace?: TraceHandler }) {
  if (item.kind === "text") return <Text row={item.row} />;
  if (item.kind === "work") return <Work rows={item.rows} running={running} onTrace={onTrace} />;
  return <div className={`zcode-completion status-${item.row.status}`} role="status"><Icon name={item.row.completion?.reason === "delivered" ? "check" : "activity"} size={14} />
    <span>{completionLabel(item.row)}{item.row.detail ? ` · ${item.row.detail}` : ""}</span></div>;
}

function ReplyActions({ text }: { text: string }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  return <ZCodeMessageActions><Button type="button" variant="ghost" size="icon-sm" className="icon-button" aria-label={copied === "copied" ? "已复制回复" : copied === "failed" ? "复制失败，重试" : "复制回复"}
    title={copied === "copied" ? "已复制" : "复制回复"} onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied("copied"), () => setCopied("failed"))}>
    <Icon name={copied === "copied" ? "check" : "copy"} size={15} /></Button>{copied === "failed" ? <span role="alert">复制失败，请重试</span> : null}</ZCodeMessageActions>;
}

export function ZCodeLoading({ label }: { label: string }) {
  return <ChatLoading label={label} />;
}

export function ZCodeConversation({ rows, running, streaming, waitingForApproval = false, onTrace }: {
  rows: readonly ConversationRow[]; running: boolean; streaming: string; waitingForApproval?: boolean;
  onTrace?: TraceHandler;
}) {
  return <>{conversationTurns(rows, running).map(turn => <section className="zcode-turn" key={turn.key} aria-label="对话轮次">
    {turn.items.map((item, index) => <FlowItem key={item.kind === "work" ? item.rows[0]!.key : item.row.key || index} item={item} running={turn.running} onTrace={onTrace} />)}
    {!turn.running && turn.copyText ? <ReplyActions text={turn.copyText} /> : null}
  </section>)}
    {running && streaming ? <ZCodeMessage from="assistant" className="zcode-text streaming"><ZCodeMessageContent><MessageContent text={streaming} /></ZCodeMessageContent></ZCodeMessage> : null}
    {running && !streaming ? <ZCodeLoading label={waitingForApproval ? "等待确认后继续" : "正在处理"} /> : null}
  </>;
}

export function ZCodeBackToBottom({ onClick, unread }: { onClick: () => void; unread: boolean }) {
  return <button type="button" className="zcode-back-to-bottom" title="回到最新消息" aria-label="回到最新消息" onClick={onClick}>
    <Icon name="arrow" size={16} style={{ transform: "rotate(180deg)" }} />{unread ? <span className="zcode-new-output" aria-label="有新输出" /> : null}
  </button>;
}
