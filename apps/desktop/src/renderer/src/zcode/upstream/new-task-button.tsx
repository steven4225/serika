/* NewTaskButtonGroup from zai-org/ZCode 29628c9acdb81b703bbd4080c207a0e7ce5e276e.
 * Copyright 2026 Z.AI Co., Ltd.; Apache-2.0; third-party/zcode/NOTICE.md.
 * Upstream telemetry/i18n/shortcut services replaced by a callback and label.
 * Uses a native button rather than a click-only div for keyboard operation. */
import React from "react";
import { MessageCirclePlus } from "lucide-react";
import { cn } from "./utils.js";

export function NewTaskButton({ onCreateTask, disabled = false }: { onCreateTask: () => void; disabled?: boolean }) {
  return <button type="button" aria-label="新对话" disabled={disabled} onClick={onCreateTask}
    className={cn("group w-full h-8 rounded-lg inline-flex shrink-0 items-center justify-stretch gap-2 overflow-hidden pl-2.5 pr-2.5 hover:bg-surface-hover hover:text-foreground active:translate-y-0 cursor-pointer border-transparent bg-transparent",
      disabled && "cursor-not-allowed text-foreground-subtlest hover:bg-transparent hover:text-foreground-subtlest")}>
    <div className="flex min-w-0 flex-1 items-center gap-2 text-ui-base">
      <MessageCirclePlus className="h-4 w-4 shrink-0" />
      <span className="truncate">新对话</span>
    </div>
  </button>;
}
