import { useCallback, useEffect, useRef, useState } from "react";
import type { PendingApproval } from "../../../shared/ui-contract.js";

/**
 * The pending tool confirmation and the allow/deny decision (split out of
 * App.tsx; same state, effect and callback). Called right after `error` is
 * declared: no effect sat between the old position and there, so effect order
 * is unchanged.
 */
export function useApproval(setMobileDashboard: (open: boolean) => void, setError: (message: string | null) => void) {
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  useEffect(() => { if (approval) setMobileDashboard(false); }, [approval?.approvalId]);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const decisionInFlight = useRef<string | null>(null);

  const decide = useCallback(async (decision: "allow" | "deny", remember = false) => {
    if (approval === null || decisionInFlight.current === approval.approvalId) return;
    const id = approval.approvalId;
    decisionInFlight.current = id;
    setDecidingId(id);
    setError(null);
    try {
      const { accepted } = await window.runloom.confirm({ approvalId: id, decision, ...(remember && decision === "allow" ? { remember: true as const } : {}) });
      if (!accepted) setError("确认已失效，本次点击未执行。请重新核对当前调用，不会自动批准新调用。");
    } catch { setError("确认结果未收到。请查看当前状态，不会自动重试。"); }
    finally {
      if (decisionInFlight.current === id) decisionInFlight.current = null;
      setDecidingId(current => current === id ? null : current);
    }
  }, [approval]);

  return { approval, setApproval, decidingId, decide };
}
