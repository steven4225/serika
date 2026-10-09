import React, { useLayoutEffect, type ReactNode, type RefObject, type TextareaHTMLAttributes } from "react";
export { ZCodePromptOptions as PersonalPromptOptions } from "../zcode/prompt-editor.js";

/** Presentation only: draft, IME, approval and submit decisions remain owned by App. */
export function PersonalPromptEditor({ inputRef, value, topContent, notice, leadingActions, submitControl, hidden, className, ...inputProps }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "hidden"> & {
  inputRef: RefObject<HTMLTextAreaElement | null>; value: string; topContent?: ReactNode;
  notice?: string | null; leadingActions: ReactNode; submitControl: ReactNode; hidden?: boolean;
}) {
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || hidden) return;
    input.style.height = "0px";
    input.style.height = `${Math.min(160, Math.max(44, input.scrollHeight))}px`;
  }, [value, hidden, inputRef]);
  return <div className="personal-composer" hidden={hidden}>
    {topContent || notice ? <div className="personal-composer-feedback">{topContent}{notice ? <p className="personal-composer-notice" role="status">{notice}</p> : null}</div> : null}
    <div className="personal-composer-pill">
      <div className="personal-composer-leading">{leadingActions}</div>
      <textarea {...inputProps} className={`personal-chat-input${className ? ` ${className}` : ""}`} ref={inputRef} value={value} rows={1} />
      <div className="personal-composer-submit">{submitControl}</div>
    </div>
  </div>;
}
