import React, { type ReactNode } from "react";
import { presentFailure } from "./failure-copy.js";
import { Icon } from "./icons.js";

/** Alert whose technical code sits behind「详情」. */
export function FailureAlert({ text, suffix }: { text: string; suffix?: string }) {
  const view = presentFailure(text);
  return <>
    <p className="error" role="alert">{view.summary}{suffix ? ` ${suffix}` : ""}</p>
    {view.detail ? <details><summary>详情</summary><pre>{view.detail}</pre></details> : null}
  </>;
}

/** Inline failure. Ordinary sentences stay inline; codes open under「详情」. */
export function FailureInline({ text }: { text: string }): ReactNode {
  const view = presentFailure(text);
  if (!view.detail) return view.summary;
  return <span className="failure-inline">{view.summary}<details><summary>详情</summary><pre>{view.detail}</pre></details></span>;
}

export function ErrorBanner({ message, onClose }: { message: string; onClose?: () => void }) {
  const view = presentFailure(message);
  return <div className="error error-banner" role="alert">
    <span>{view.summary}{view.detail ? <details><summary>详情</summary><pre>{view.detail}</pre></details> : null}</span>
    {onClose ? <button type="button" className="icon-button" aria-label="关闭错误提示" onClick={onClose}><Icon name="close" size={16} /></button> : null}
  </div>;
}
