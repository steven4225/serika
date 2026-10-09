/* ChatLoading from zai-org/ZCode 29628c9acdb81b703bbd4080c207a0e7ce5e276e.
 * Copyright 2026 Z.AI Co., Ltd.; Apache-2.0; third-party/zcode/NOTICE.md.
 * Loading label is supplied by the host instead of upstream i18n. */
import React from "react";
import { LoaderIcon } from "lucide-react";

export function ChatLoading({ label }: { label: string }) {
  return <div role="status" aria-label={label} className="flex items-center gap-2 text-ui-sm text-foreground-subtle">
    <div className="flex size-4 items-center justify-center">
      <LoaderIcon aria-hidden="true" className="animate-spin size-4 text-foreground-subtle motion-reduce:animate-none" />
    </div><span>{label}</span>
  </div>;
}
