import React from "react";

/** Primary line is what was remembered. Identifiers stay behind「详情」. */
export function MemorySavedNotice({ primary, detail, onSaved }: { primary: string; detail?: string | null; onSaved?: () => void }) {
  return <div className="memory-receipt" role="status">
    <p>{primary}</p>
    {onSaved ? <button type="button" className="ghost" onClick={onSaved}>查看已保存</button> : null}
    {detail ? <details><summary>详情</summary><p>{detail}</p></details> : null}
  </div>;
}
