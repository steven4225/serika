import { useEffect, useRef, useState } from "react";
import { clampChatFraction, loadChatFraction, loadSidebarOpen, PERSONAL_SPLIT_KEY, PERSONAL_SIDEBAR_KEY, PERSONAL_COMPACT_BREAKPOINT } from "../personal/layout.js";

/**
 * Window width, the chat/dashboard split and the remembered sidebar choice of
 * the main window (split out of App.tsx; same state, effects and storage keys).
 */
export function useSplitLayout(mobileDashboard: boolean) {
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [chatFraction, setChatFraction] = useState(() => loadChatFraction(localStorage.getItem(PERSONAL_SPLIT_KEY)));
  const [sidebarOpen, setSidebarOpen] = useState(() => loadSidebarOpen(localStorage.getItem(PERSONAL_SIDEBAR_KEY)));
  const splitRoot = useRef<HTMLDivElement | null>(null);
  const compact = windowWidth < PERSONAL_COMPACT_BREAKPOINT;
  const dashboardOpen = compact ? mobileDashboard : sidebarOpen;
  const actualFraction = clampChatFraction(windowWidth, chatFraction);
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const saveSplit = (value: number) => {
    const next = clampChatFraction(windowWidth, value);
    setChatFraction(next);
    try { localStorage.setItem(PERSONAL_SPLIT_KEY, String(next)); } catch { /* Layout remains usable without preference storage. */ }
  };
  const rememberSidebar = (open: boolean) => {
    setSidebarOpen(open);
    try { localStorage.setItem(PERSONAL_SIDEBAR_KEY, open ? "open" : "collapsed"); } catch { /* The in-memory choice still applies for this window. */ }
  };
  return { windowWidth, sidebarOpen, splitRoot, compact, dashboardOpen, actualFraction, saveSplit, rememberSidebar };
}
