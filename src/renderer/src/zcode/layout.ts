export type DesktopLayout = "classic" | "zcode";

/** Opt-in presentation only. Never changes the workspace, Thread or runtime. */
export function desktopLayout(search: string): DesktopLayout {
  return new URLSearchParams(search).get("ui") === "zcode" ? "zcode" : "classic";
}
