import { useEffect, useRef, useState } from "react";
import type { AppInfo } from "../../../shared/ui-contract.js";
import type { ChatAttachment } from "../chat-attachments.js";

/**
 * Composer attachments, the ones handed to the current run, and the ones a
 * failed run left recoverable (split out of App.tsx; same state and the same
 * reset-on-conversation-change effect, declared at the same position).
 */
export function useChatAttachments(info: AppInfo | null) {
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const attachmentIdentity = useRef("");
  const sentAttachments = useRef<{ runId: string | null; files: ChatAttachment[]; text: string } | null>(null);
  const [recoverableAttachments, setRecoverableAttachments] = useState<{ files: ChatAttachment[]; text: string } | null>(null);
  useEffect(() => { const identity = `${info?.workspaceRoot}:${info?.threadId}`; if (attachmentIdentity.current !== identity) { attachmentIdentity.current = identity; setAttachments([]); sentAttachments.current = null; setRecoverableAttachments(null); } }, [info?.workspaceRoot, info?.threadId]);
  return { attachments, setAttachments, sentAttachments, recoverableAttachments, setRecoverableAttachments };
}
