import React, { memo } from "react";
import { presentAssistantReply } from "./delivery-data.js";
import { MessageContent } from "./markdown.js";

export interface AssistantReplyProps {
  text: string;
  /** Set only for this turn's last assistant reply after actual tool calls. */
  delivered?: boolean;
  streaming?: boolean;
}

export const AssistantReply = memo(function AssistantReply({ text, delivered = false, streaming = false }: AssistantReplyProps) {
  const view = presentAssistantReply(text, { delivered, streaming });
  if (view.kind === "plain") return <MessageContent text={view.text} />;
  return <div className="assistant-delivery">
    <div className="delivery-conclusion"><MessageContent text={view.conclusion} /></div>
    {view.warnings.map((warning, index) => <aside className="delivery-warning" key={`${warning.title}:${index}`}>
      <span className="delivery-warning-label">{warning.title} · 助手说明</span>
      <MessageContent text={warning.text} />
    </aside>)}
    <details className="delivery-explanation">
      <summary>核对说明<span>完整回复</span></summary>
      <MessageContent text={view.original} />
    </details>
  </div>;
});
