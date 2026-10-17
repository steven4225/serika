import React from "react";
import type { FormalMemory } from "@serika/assistant";
import type { MemoryActionPreview } from "@serika/assistant";
import type { MemorySource } from "@serika/assistant";
import { memorySourcePhrase } from "./personal/memory-cards.js";
import { MessageContent } from "./markdown.js";

export function MemorySources({ sources }: { sources: readonly MemorySource[] }) {
  return <section className="memory-sources">
    <p className="memory-source-line">{memorySourcePhrase(sources)}</p>
    {sources.map((source, index) => <div key={index}>
      {source.kind === "conversation" ? <blockquote className="memory-text">{source.quote}</blockquote> :
        <p className="hint">{source.kind === "manual" ? "用户手动记录或修改" : "旧格式迁入，未附原话"}</p>}
    </div>)}
  </section>;
}

/** Undo preview for an automatic save: what is withdrawn, never a version picker. */
export function MemoryActionPreviewDetails({ preview }: { preview: MemoryActionPreview }) {
  const { input, current } = preview;
  return <section className="memory-action-preview-details">
    <div className="memory-label">当前内容</div><pre className="memory-text">{current.text}</pre>
    {input.operation === "retract" ? <p className="hint">撤回后不再使用这条记忆。旧对话、旧摘要和已经发出的回复不会被删除。</p> : null}
    {input.operation === "delete" ? <p className="error">永久删除这条记忆，不能撤销。旧对话、旧摘要与已发出的回复不会因此删除。</p> : null}
    {preview.warnings.map((warning, index) => <p className="hint" key={index}>{warning}</p>)}
  </section>;
}

/** Saved content only: body, where it applies, and the user's own words it came from. */
export function CurrentMemoryDetails({ current }: { current: FormalMemory }) {
  return <section className="memory-current-content">
    {current.text ? <MessageContent text={current.text} /> : <p className="hint">这条记忆当前不生效，可以删除。</p>}
    <p className="hint">{current.scope?.kind === "thread" ? "仅当前对话" : "工作区记忆"}</p>
    {current.source ? <details><summary>来源</summary><MemorySources sources={[current.source]} /></details> : null}
  </section>;
}
