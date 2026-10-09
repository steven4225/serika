import React, { memo, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Model text is untrusted: no raw HTML, embedded media, or executable/local URLs. */
export function markdownUrl(url: string): string {
  if (url.startsWith("#")) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? url : "";
  } catch { return ""; }
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = useRef<HTMLPreElement | null>(null);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  return <div className="code-block"><div className="code-block-head"><span>代码</span>
    <button onClick={() => {
      void navigator.clipboard.writeText(code.current?.textContent ?? "").then(() => setCopied("copied"), () => setCopied("failed"));
    }}>{copied === "copied" ? "已复制" : copied === "failed" ? "复制失败，重试" : "复制代码"}</button></div>
    <pre ref={code}>{children}</pre></div>;
}

export const MessageContent = memo(function MessageContent({ text }: { text: string }) {
  return <div className="message-content"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={markdownUrl}
    components={{
      a: ({ children, href }) => href ? <a href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
      img: ({ alt }) => <span className="media-placeholder">图片：{alt || "未显示（不会自动加载外部图片）"}</span>,
      table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
      pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    }}>{text}</Markdown></div>;
});
