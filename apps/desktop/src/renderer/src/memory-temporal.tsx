import React from "react";
import type { FormalMemory } from "@serika/assistant";
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

/** Saved content only: body, where it applies, and the user's own words it came from. */
export function CurrentMemoryDetails({ current }: { current: FormalMemory }) {
  return <section className="memory-current-content">
    {current.uncertain ? <p className="hint">不确定：原话包含互相矛盾的表述，可以编辑纠正。</p> : null}
    {current.text ? <MessageContent text={current.text} /> : <p className="hint">这条记忆当前不生效，可以删除。</p>}
    <p className="hint">工作区记忆</p>
    {current.source ? <details><summary>来源</summary><MemorySources sources={[current.source]} /></details> : null}
  </section>;
}
