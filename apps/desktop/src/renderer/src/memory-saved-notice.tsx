import React from "react";

/** Primary line is what was remembered. Identifiers stay behind「详情」. */
export function MemorySavedNotice({ primary, detail, onSaved }: { primary: string; detail?: string | null; onSaved?: () => void }) {
  return <div className="memory-receipt" role="status">
    <p>{primary}</p>
    {onSaved ? <button type="button" className="ghost" onClick={onSaved}>查看已保存</button> : null}
    {detail ? <details><summary>详情</summary><p>{detail}</p></details> : null}
  </div>;
}

export function MemoryFactReceipts({ receipts = [] }: { receipts?: readonly import("@serika/assistant").MemoryFactReceipt[] | undefined }) {
  const [working, setWorking] = React.useState(false), [error, setError] = React.useState("");
  return <>{receipts.map(receipt => <small className="memory-fact-receipt" role="status" key={receipt.id}>
    {receipt.text}{receipt.undo ? <button type="button" className="ghost" disabled={working} onClick={() => {
      setWorking(true); setError("");
      void window.runloom.applyMemoryAction(receipt.undo!).then(result => {
        if (!result.ok) setError(result.error.message);
      }).catch(cause => setError(String(cause))).finally(() => setWorking(false));
    }}>撤销</button> : null}
  </small>)}{error ? <p className="error" role="alert">{error}</p> : null}</>;
}
