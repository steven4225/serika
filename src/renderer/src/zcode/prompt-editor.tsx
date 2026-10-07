/*
 * Presentation shell adapted from zai-org/ZCode, 29628c9acdb81b703bbd4080c207a0e7ce5e276e,
 * packages/ui/src/prompt-editor/ChatPromptEditor.tsx and v4/ConversationComposer.tsx.
 * Copyright 2026 Z.AI Co., Ltd. Apache-2.0; third-party/zcode/NOTICE.md.
 * Modified by Serika: existing textarea/IME/draft and controller callbacks,
 * no Lexical, mentions, attachments, queue, account or upstream services.
 */
import React, { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject, type TextareaHTMLAttributes } from "react";
import { Icon } from "../icons.js";
import { ChatPromptShell } from "./upstream/chat-prompt-shell.js";

export function ZCodePromptEditor({ inputRef, value, topContent, leadingActions, submitControl, hidden, ...inputProps }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "hidden"> & {
  inputRef: RefObject<HTMLTextAreaElement | null>; value: string; topContent?: ReactNode;
  leadingActions: ReactNode; submitControl: ReactNode; hidden?: boolean;
}) {
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || hidden) return;
    input.style.height = "0px";
    input.style.height = `${Math.min(200, Math.max(56, input.scrollHeight))}px`;
  }, [value, hidden, inputRef]);
  return <ChatPromptShell hidden={hidden ?? false} topContent={topContent} leadingActions={leadingActions} submitControl={submitControl}
    input={<textarea {...inputProps} className="zcode-chat-input" ref={inputRef} value={value} rows={2} />} />;
}

export function ZCodePromptOptions({ children }: { children: ReactNode }) {
  const menu = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) menu.current?.removeAttribute("open");
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing && menu.current?.open) {
        event.preventDefault(); event.stopPropagation(); menu.current.open = false;
        menu.current.querySelector<HTMLElement>("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, []);
  return <details ref={menu} className="zcode-prompt-options"><summary title="输入选项" aria-label="输入选项"><Icon name="new-chat" size={18} /></summary>
    <div className="zcode-prompt-menu">{children}</div></details>;
}
