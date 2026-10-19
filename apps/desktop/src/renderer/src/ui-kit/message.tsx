/*
 * Adapted from zai-org/ZCode, commit 29628c9acdb81b703bbd4080c207a0e7ce5e276e,
 * packages/ui/src/components/ai-elements/message.tsx (Message / MessageContent).
 * Copyright 2026 Z.AI Co., Ltd. Copyright 2023 Vercel, Inc.
 * Apache-2.0. See third-party/zcode/NOTICE.md and LICENSE.
 * Modified by Serika: local export names and safe host Markdown renderer.
 */
import React, { type HTMLAttributes } from "react";
import { cn } from "./upstream/utils.js";

export function SerikaMessage({ className = "", from, ...props }: HTMLAttributes<HTMLDivElement> & {
  from: "user" | "assistant" | "system";
}) {
  return <div className={cn("serika-message group flex w-full flex-col gap-2", from === "user" ? "is-user ml-auto justify-end" : "is-assistant", className)} {...props} />;
}

export function SerikaMessageContent({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("serika-message-content flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-ui-base", "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground", "group-[.is-assistant]:text-foreground", className)} {...props} />;
}

/** MessageActions from the same upstream file. */
export function SerikaMessageActions({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("serika-message-actions flex items-center gap-1", className)} {...props} />;
}
