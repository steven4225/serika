export type ZCodeAppearance = "dark" | "light";
export const APPEARANCE_KEY = "serika:appearance";
/** Presentation-only preference; never changes workspace/config/Thread. */
export function zcodeAppearance(value: string | null): ZCodeAppearance {
  return value === "light" ? "light" : "dark";
}
