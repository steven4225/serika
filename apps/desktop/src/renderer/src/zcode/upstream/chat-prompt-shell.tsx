/*
 * ChatPromptEditor render shell from zai-org/ZCode, pinned 29628c9acdb81b703bbd4080c207a0e7ce5e276e.
 * Copyright 2026 Z.AI Co., Ltd.; Apache-2.0; third-party/zcode/NOTICE.md.
 * Keeps original surface/toolbar markup and utility classes. Lexical and
 * upstream services are replaced by the host's controlled input slot.
 */
import React, { type ReactNode } from "react";
import { cn } from "./utils.js";

export function ChatPromptShell({ input, topContent, leadingActions, submitControl, hidden }: {
  input: ReactNode; topContent?: ReactNode; leadingActions: ReactNode;
  submitControl: ReactNode; hidden?: boolean;
}) {
  return <div className="relative zcode-prompt-editor" hidden={hidden} data-zcode-source="ChatPromptEditor">
    <div className={cn("relative flex flex-col gap-3 rounded-2xl border border-input-border bg-input p-3 transition-colors hover:border-input-border-hover focus-within:!border-input-border-focused focus-within:bg-input-focused")}>
      {topContent}
      {input}
      <div className="group/toolbar flex items-end gap-3">
        <div className="flex min-w-0 flex-1 items-center" data-composer-leading-actions>
          <div className="flex min-w-0 items-center gap-1" data-composer-leading-content>{leadingActions}</div>
        </div>
        <div className="ml-auto flex min-w-0 items-center justify-end gap-1.5" data-composer-trailing-actions>{submitControl}</div>
      </div>
    </div>
  </div>;
}
