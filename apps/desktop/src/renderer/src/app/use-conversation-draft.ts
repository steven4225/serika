import { useEffect, useRef, useState } from "react";
import type { AppInfo } from "../../../shared/ui-contract.js";
import { conversationDraftError, draftScope } from "../../../shared/conversation-drafts.js";
import { draftKey, type ConversationDraft } from "../navigation.js";

/**
 * The ordinary-chat draft: text, memory exclusion and its save status (split
 * out of App.tsx; same state). Saving is a separate hook so App.tsx can keep
 * calling it where the save effect used to be declared (effect order unchanged).
 */
export function useConversationDraftState() {
  const [draftReady, setDraftReady] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftSaving, setDraftSaving] = useState(false);
  const draftSave = useRef<Promise<void>>(Promise.resolve());
  const draftSaveSequence = useRef(0);
  const [input, setInput] = useState("");
  const [excludeFromMemory, setExcludeFromMemory] = useState(false);
  return { draftReady, setDraftReady, draftError, setDraftError, draftSaving, setDraftSaving, draftSave, draftSaveSequence, input, setInput, excludeFromMemory, setExcludeFromMemory };
}

/** Mirror the draft into the in-memory map and persist it; the latest save owns the status. */
export function useConversationDraftPersistence(
  { draftReady, setDraftError, setDraftSaving, draftSave, draftSaveSequence, input, excludeFromMemory }: ReturnType<typeof useConversationDraftState>,
  info: AppInfo | null,
  drafts: Map<string, ConversationDraft>,
  creatingTask: boolean,
) {
  useEffect(() => {
    if (!info || !draftReady) return;
    const key = draftKey(info);
    if (input.length) drafts.set(key, { text: input, excludeFromMemory, ...(creatingTask ? { createTask: true as const } : {}) });
    else drafts.delete(key);
    const sequence = ++draftSaveSequence.current;
    setDraftSaving(true);
    const save = window.runloom.saveConversationDraft(draftScope(info), { text: input, excludeFromMemory, ...(creatingTask ? { createTask: true as const } : {}) });
    draftSave.current = save;
    void save.then(() => {
      if (draftSaveSequence.current === sequence) { setDraftError(null); setDraftSaving(false); }
    }).catch(() => {
      if (draftSaveSequence.current === sequence) { setDraftError(conversationDraftError(input)); setDraftSaving(false); }
    });
  }, [info, input, excludeFromMemory, creatingTask, drafts, draftReady]);
}
