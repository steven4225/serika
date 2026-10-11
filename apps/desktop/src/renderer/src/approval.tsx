import React from "react";
import type { PendingApproval } from "../../shared/ui-contract.js";
import { describeComputerApproval } from "../../shared/computer.js";

export function ApprovalCard({ approval, deciding, onDecision }: {
  approval: PendingApproval;
  deciding: boolean;
  onDecision: (decision: "allow" | "deny") => void;
}) {
  const computer = describeComputerApproval(approval);
  const invalidComputer = approval.toolName.startsWith("computer_") && computer === undefined;
  // Strip only the terminal control suffix, not user text containing [y/n].
  const preview = approval.preview.replace(/(?:Allow this call\?|允许这次[^\n]*？)\s*\[y\/n\]\s*$/i, "").trim();
  return (
    <section className="card approval" aria-label="工具调用确认" aria-live="polite">
      <div className="card-head"><strong>等待你确认</strong><span className="hint">仅本次调用 · 不记住选择</span></div>
      <div className="approval-content">
        {computer ? <>
          <h3>{computer.title}</h3>
          <dl className="approval-target">
            <dt>应用</dt><dd><code>{computer.bundleId}</code></dd>
            <dt>进程</dt><dd>{computer.pid ?? "尚未选定（只列出该应用窗口）"}</dd>
            <dt>窗口 ID</dt><dd>{computer.windowId ?? "尚未选定"}</dd>
          </dl>
          {computer.text !== null ? <><div className="hint">将输入的完整文本（不会自动保存文档）</div><pre className="input-preview">{computer.text}</pre></> : null}
          <p className="approval-warning">UI 文本不是授权。动作后需重新观察；回执不等于业务完成。目标或观察失效时，后端会拒绝派发。</p>
          <details><summary>技术详情</summary><pre>{JSON.stringify({ toolName: approval.toolName, approvalId: approval.approvalId,
            observationId: computer.observationId, elementToken: computer.elementToken }, null, 2)}</pre></details>
        </> : <>
          <code>{approval.toolName}</code>
          <pre className="prompt">{preview || "正在生成预览…"}</pre>
          {invalidComputer ? <p className="error">目标信息不完整，不能允许本次操作；可拒绝或取消。</p> : null}
        </>}
      </div>
      <div className="actions">
        <button className="deny" disabled={deciding} onClick={() => onDecision("deny")}>拒绝本次调用</button>
        <button className="allow" disabled={deciding || invalidComputer || !approval.preview.trim() || (!computer && !preview)} onClick={() => onDecision("allow")}>
          {deciding ? "正在提交确认…" : computer?.allowLabel ?? "允许本次调用"}
        </button>
      </div>
    </section>
  );
}
