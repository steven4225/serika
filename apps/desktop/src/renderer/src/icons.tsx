import React, { type CSSProperties } from "react";

export type IconName = "timer" | "modules" | "chat" | "new-chat" | "home" | "activity" | "memory" | "context" | "panel" | "arrow" | "stop" | "close" | "chevron" | "terminal" | "check" | "shield" | "copy";

const paths: Record<IconName, string> = {
  copy: "M9 9h11v11H9ZM5 15H4V4h11v1",
  "new-chat": "M12 5v14M5 12h14",
  timer: "M9 2h6m-3 0v3m6 1 2-2M12 9v4l3 2M20 13a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  modules: "M3 3h7v7H3Zm11 0h7v7h-7ZM3 14h7v7H3Zm11 0h7v7h-7Z",
  chat: "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z",
  home: "m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  memory: "M9 4H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2M9 3h6v4H9ZM9 12h6M9 16h4",
  context: "m12 3 9 5-9 5-9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5",
  panel: "M9 3v18M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z",
  arrow: "M12 19V5m-6 6 6-6 6 6",
  stop: "M6 6h12v12H6Z",
  close: "m6 6 12 12M6 18 18 6",
  chevron: "m9 5 7 7-7 7",
  terminal: "m5 7 5 5-5 5m8 0h6",
  check: "m5 12 4 4L19 6",
  shield: "M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6ZM9 12l2 2 4-4",
};

export function Icon({ name, size = 18, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={paths[name]} /></svg>;
}

const serikaIconUrl = new URL("../../../resources/serika-icon.png", import.meta.url).href;

export function SerikaMark({ size = 28 }: { size?: number }) {
  return <img className="serika-mark" src={serikaIconUrl} width={size} height={size} alt="" aria-hidden="true" draggable={false}
    style={{ flexShrink: 0, borderRadius: size * 0.22, verticalAlign: "middle" }} />;
}
