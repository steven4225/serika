import React from "react";
import { MemoryFactReceipts } from "../memory-saved-notice.js";
import type { ConversationRow, ToolRowStatus } from "../conversation.js";
import type { DesktopLayout } from "../ui-kit/layout.js";
import { SerikaMessage, SerikaMessageContent } from "../ui-kit/message.js";
import { SerikaMark, Icon } from "../icons.js";
import { AssistantReply } from "../delivery.js";
import { SteerStatus } from "../steer-status.js";
import { FailureInline } from "../failure-notice.js";
import { completionLabel } from "../navigation.js";

export function Row({ row, delivered = false, layout = "classic", onRestoreSteer }: { row: ConversationRow; delivered?: boolean; layout?: DesktopLayout; onRestoreSteer?: (text: string) => void }) {
  switch (row.kind) {
    case "text":
      if (layout === "serika") return <SerikaMessage from={row.role} className={`row row-text role-${row.role}${row.committed ? "" : " live"}`}>
        <SerikaMessageContent>
          {row.role !== "user" ? <span className="role">{row.role === "assistant" ? <><SerikaMark size={18} /> Serika</> : "系统"}</span> : null}
          {row.role === "assistant" ? <AssistantReply text={row.text} delivered={delivered} /> : <pre>{row.text}</pre>}
          {row.attachments?.length ? <div className="chat-attachments">{row.attachments.map((file, index) => <div className="chat-attachment" key={index}>{file.url ? <img src={file.url} alt={file.name} /> : null}<span>{file.name}</span></div>)}</div> : null}
          <MemoryFactReceipts receipts={row.memoryReceipts} />
          {row.steerRecord ? <SteerStatus records={[row.steerRecord]} onRestore={onRestoreSteer} /> : null}
        </SerikaMessageContent>
      </SerikaMessage>;
      return (
        <div className={`row row-text role-${row.role}${row.committed ? "" : " live"}`}>
          {row.role !== "user" ? <span className="role">{row.role === "assistant" ? <><SerikaMark size={20} /> Serika</> : "系统"}</span> : null}
          {row.role === "assistant" ? <AssistantReply text={row.text} delivered={delivered} /> : <pre>{row.text}</pre>}
          {row.attachments?.length ? <div className="chat-attachments">{row.attachments.map((file, index) => <div className="chat-attachment" key={index}>{file.url ? <img src={file.url} alt={file.name} /> : null}<span>{file.name}</span></div>)}</div> : null}
          <MemoryFactReceipts receipts={row.memoryReceipts} />
          {row.steerRecord ? <SteerStatus records={[row.steerRecord]} onRestore={onRestoreSteer} /> : null}
        </div>
      );
    case "tool":
      return (
        <details className={`row row-tool status-${row.status}`} open={["failed", "unknown", "timed_out", "dispatched"].includes(row.status) || (row.status === "requested" && !!(row.stdout || row.stderr))}>
          <summary><span className="dot" /><span className="tool-name">{toolDisplayName(row.toolName)}</span>
            {row.receipt ? <span className="tool-receipt"><code title={row.receipt.path}>{row.receipt.path}</code><span>{row.receipt.bytes} 字节</span></span> : null}
            <span className="tool-status">{toolStatusLabel(row.status)}</span><Icon name="chevron" size={14} /></summary>
          <div className="tool-body"><code>{row.toolName}</code>
          {row.detail ? <div className="tool-detail"><FailureInline text={row.detail} /></div> : null}
          {row.stdout ? <pre className="shell-stream stdout">{row.stdout}</pre> : null}
          {row.stderr ? <pre className="shell-stream stderr">{row.stderr}</pre> : null}
          {row.progressTruncated ? <span className="truncated">输出已截断</span> : null}
          </div>
        </details>
      );
    case "step":
      return <div className="row row-step">第 {row.step} 步</div>;
    case "result":
      return (
        <div className={`row row-result status-${row.status}`}>
          {completionLabel(row)}
          {row.status === "completed" && !row.completion ? <span className="result-boundary" title="对话结束不等于任务已验收，工具效果以执行记录为准。">执行结果见回执</span> : null}
          {row.detail ? <span className="tool-detail"> · <FailureInline text={row.detail} /></span> : null}
        </div>
      );
    default: {
      const exhaustive: never = row;
      return exhaustive;
    }
  }
}

function toolDisplayName(name: string): string {
  const labels: Record<string, string> = { computer_observe: "观察应用", computer_action: "操作应用", read_file: "读取文件", write_file: "写入文件", edit_file: "编辑文件", shell_exec: "运行命令", web_fetch: "读取网页", web_search: "搜索网页", feed_read: "读取订阅", memory_add: "保存记忆", memory_update: "更新记忆", task_create: "创建提醒", work_task_create: "保存工作任务", task_reschedule: "调整提醒", task_cancel: "取消提醒", task_repeat_create: "重复提醒", task_repeat_cancel: "取消重复提醒", task_repeat_pause: "暂停重复提醒", task_repeat_resume: "恢复重复提醒", checkpoint_save: "保存进度" };
  return labels[name] ?? name;
}

function toolStatusLabel(status: ToolRowStatus): string {
  switch (status) {
    case "requested":
      return "调用中";
    case "ok":
      return "返回成功";
    case "incomplete":
      return "回执不完整";
    case "observed":
      return "观察已返回";
    case "dispatched":
      return "已派发 · 待核对";
    case "not_started":
      return "未执行";
    case "failed":
      return "失败";
    case "denied":
      return "已拒绝";
    case "unknown":
      return "结果未知 · 需人工核实";
    case "timed_out":
      return "Shell 超时";
    case "cancelled":
      return "已取消";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
