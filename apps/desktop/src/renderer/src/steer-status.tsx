import React from "react";
import type { AssistantSteerRecord } from "../../shared/ui-contract.js";
import { steerStatusLabel } from "../../shared/steer.js";

/** No resend action: restoring text requires a fresh, explicit user submission. */
export function SteerStatus({ records, onRestore }: {
  records: readonly AssistantSteerRecord[];
  onRestore?: (text: string) => void;
}) {
  if (records.length === 0) return null;
  return <div className="steer-status-list" aria-label="本轮补充要求">
    {records.map(record => <details key={`${record.runId}:${record.id}`} className={`steer-status status-${record.status}`}>
      <summary><span>补充要求</span><span role="status">{steerStatusLabel(record)}</span></summary>
      <p>{record.text}</p>
      {record.status === "applied" ? <small>已加入后续规划上下文；上下文准备或模型请求仍可能失败，不代表模型已收到、已执行或一定遵从。已执行操作不会撤销。</small> : null}
      {record.status === "not_applied" && record.reason ? <small>原因：{record.reason}</small> : null}
      {record.status === "not_applied" && onRestore ? <button type="button" className="ghost" onClick={() => onRestore(record.text)}>移回草稿，不自动发送</button> : null}
    </details>)}
  </div>;
}
