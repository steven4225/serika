/*
 * Options menu adapted from zai-org/ZCode, 29628c9acdb81b703bbd4080c207a0e7ce5e276e, toolbar structure of
 * packages/ui/src/prompt-editor/ChatPromptEditor.tsx and v4/ConversationComposer.tsx.
 * Copyright 2026 Z.AI Co., Ltd. Apache-2.0; third-party/zcode/NOTICE.md.
 * The adapted input shell (SerikaPromptEditor, upstream/chat-prompt-shell.tsx) was removed as unused.
 */
import React, { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "../icons.js";

export function SerikaPromptOptions({ children }: { children: ReactNode }) {
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
  return <details ref={menu} className="serika-prompt-options"><summary title="更多操作" aria-label="更多操作"><Icon name="new-chat" size={18} /></summary>
    <div className="serika-prompt-menu">{children}</div></details>;
}
