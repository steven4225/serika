export type DesktopLayout = "classic" | "serika";

/** One daily presentation. Query strings cannot silently restore the old UI. */
export function desktopLayout(_search: string): DesktopLayout {
  return "serika";
}
