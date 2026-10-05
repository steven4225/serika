/*
 * Adapted from zai-org/ZCode, commit 29628c9acdb81b703bbd4080c207a0e7ce5e276e,
 * packages/ui/src/components/ai-elements/message.tsx (Message / MessageContent).
 * Copyright 2026 Z.AI Co., Ltd. Copyright 2023 Vercel, Inc.
 * Apache-2.0. See third-party/zcode/NOTICE.md and LICENSE.
 * Modified by Runloom: plain CSS instead of Tailwind; no ZCode services,
 * Markdown plugins, model SDK or runtime dependencies; retain local rendering.
 */
import React, { type HTMLAttributes } from "react";

export function ZCodeMessage({ className = "", from, ...props }: HTMLAttributes<HTMLDivElement> & {
  from: "user" | "assistant" | "system";
}) {
  return <div className={`zcode-message ${from === "user" ? "is-user" : "is-assistant"} ${className}`} {...props} />;
}

export function ZCodeMessageContent({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`zcode-message-content ${className}`} {...props} />;
}
