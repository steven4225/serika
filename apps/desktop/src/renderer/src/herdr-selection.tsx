import { useRef, useState } from "react";
import type { PendingHerdrSelection } from "../../shared/ui-contract.js";

const STATUS = { idle: "空闲", working: "正在执行", blocked: "等待答复", done: "上次执行已结束" };

export function HerdrSelectionCard({ selection, onError }: {
  selection: PendingHerdrSelection;
  onError: (message: string | null) => void;
}) {
  const inFlight = useRef<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const deciding = decidingId === selection.selectionId;
  const choose = async (candidateId: string | null) => {
    const id = selection.selectionId;
    if (inFlight.current === id) return;
    inFlight.current = id;
    setDecidingId(id);
    onError(null);
    try {
      const result = await window.runloom.selectHerdrTarget({ selectionId: id, candidateId });
      if (!result.accepted) onError("这次目标选择已失效。请核对当前候选，本次点击未发送输入。");
    } catch { onError("目标选择结果未收到。请查看当前选择卡，不会自动重试。"); }
    finally {
      if (inFlight.current === id) inFlight.current = null;
      setDecidingId(current => current === id ? null : current);
    }
  };
  return <section className="card approval" aria-label="本轮 Pi 目标选择" aria-live="polite" data-selection-id={selection.selectionId}>
    <div className="card-head"><strong>选择本轮使用的 Pi</strong><span className="hint">仅本轮</span></div>
    <p className="hint">候选刚核对，尚未采用。选择后继续当前任务，发送输入另行确认。</p>
    <p className="hint">临时句柄不是真实身份；刷新句柄不表示目标消失。</p>
    <div className="approval-content">{selection.candidates.map(candidate => <div key={candidate.candidateId}>
      <h3>{candidate.title || candidate.target.session}</h3>
      <p>{candidate.target.session} · {STATUS[candidate.status]}</p>
      <details><summary>目标详情</summary><dl className="approval-target">
        <dt>会话</dt><dd>{candidate.target.session}</dd>
        <dt>Pane</dt><dd>{candidate.target.paneId}</dd>
        <dt>终端</dt><dd>{candidate.target.terminalId}</dd>
        <dt>目录</dt><dd>{candidate.target.authorizedDirectory}</dd>
      </dl></details>
      <button type="button" className="allow" data-candidate-id={candidate.candidateId} disabled={deciding} onClick={() => void choose(candidate.candidateId)}>
        {deciding ? "正在提交选择…" : "本轮使用"}
      </button>
    </div>)}</div>
    <div className="actions"><button type="button" className="deny" disabled={deciding} onClick={() => void choose(null)}>取消选择</button></div>
  </section>;
}
