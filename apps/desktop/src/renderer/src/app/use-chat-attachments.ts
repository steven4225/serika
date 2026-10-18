import { useCallback, useEffect, useRef, useState } from "react";
import type { AppInfo, MainToRenderer } from "../../../shared/ui-contract.js";
import type { ChatAttachment } from "../chat-attachments.js";

/**
 * Composer attachments, the ones handed to the current run, and the ones a
 * failed run left recoverable (split out of App.tsx; same state and the same
 * reset-on-conversation-change effect, declared at the same position).
 * `settleSentAttachments` is the attachment part of a primary result.
 */
export function useChatAttachments(info: AppInfo | null, setError: (message: string | null) => void) {
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const attachmentIdentity = useRef("");
  const sentAttachments = useRef<{ runId: string | null; files: ChatAttachment[]; text: string } | null>(null);
  const [recoverableAttachments, setRecoverableAttachments] = useState<{ files: ChatAttachment[]; text: string } | null>(null);
  useEffect(() => { const identity = `${info?.workspaceRoot}:${info?.threadId}`; if (attachmentIdentity.current !== identity) { attachmentIdentity.current = identity; setAttachments([]); sentAttachments.current = null; setRecoverableAttachments(null); } }, [info?.workspaceRoot, info?.threadId]);
  /** The current primary run finished: a failed run leaves its attachments recoverable. */
  const settleSentAttachments = useCallback((result: Extract<MainToRenderer, { type: "result" }>["result"]) => {
    const sent = sentAttachments.current;
    if (sent && (sent.runId === null || sent.runId === result.runId)) {
      if (result.status !== "completed") {
        setRecoverableAttachments({ files: sent.files, text: sent.text });
        const imageRejected = sent.files.some(file => file.mediaType.startsWith("image/")) && /(?:does not support|not supported|unsupported|不支持).*(?:image|vision|图片|视觉)|(?:image|vision|图片|视觉).*(?:not support|unsupported|不支持)/i.test(result.error?.message ?? "");
        setError(imageRejected ? "当前模型不支持图片。附件可恢复到草稿，换用支持图片的模型后再发送。" : "本轮未完成。文字和附件可恢复到草稿；请先核对执行结果，再决定是否重新发送。");
      }
      sentAttachments.current = null;
    }
  }, []);
  return { attachments, setAttachments, sentAttachments, recoverableAttachments, setRecoverableAttachments, settleSentAttachments };
}
