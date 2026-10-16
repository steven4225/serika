import React from "react";
import type { AssistantSteerRecord } from "../../shared/ui-contract.js";
import { steerStatusLabel } from "../../shared/steer.js";

/** No resend action: restoring text requires a fresh, explicit user submission. */
export function SteerStatus({ records, onRestore }: {
  records: readonly AssistantSteerRecord[];
  onRestore?: ((text: string) => void) | undefined;
}) {
  const visible = records.filter(record => record.status !== "applied");
  if (visible.length === 0) return null;
  return <div className="steer-status-list">
    {visible.map(record => <div key={`${record.runId}:${record.id}`} className={`steer-status status-${record.status}`}>
      <small role="status">{steerStatusLabel(record)}</small>
      {record.status === "not_applied" && onRestore ? <button type="button" className="ghost" onClick={() => onRestore(record.text)}>移回草稿，不自动发送</button> : null}
    </div>)}
  </div>;
}
