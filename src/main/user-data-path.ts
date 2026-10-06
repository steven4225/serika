import { isAbsolute, join } from "node:path";

/** Stable legacy profile; productName and native bundle names must not move it. */
export function defaultUserDataPath(appData: string): string {
  return join(appData, "@aisdk-agent", "desktop");
}

/**
 * Isolated launches pass an absolute data directory instead of calling
 * `require("electron")` from Node. The npm `electron` package exports a binary
 * path, so `app` is missing there and `setPath` throws.
 */
export function userDataPathFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.RUNLOOM_USER_DATA?.trim();
  if (value === undefined || value.length === 0) return undefined;
  if (!isAbsolute(value)) throw new Error("RUNLOOM_USER_DATA must be an absolute path");
  return value;
}
