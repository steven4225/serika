import { isAbsolute } from "node:path";

/** Keep isolated Electron cache overrides separate from persistent home identity. */
export function userDataPathFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.RUNLOOM_USER_DATA?.trim();
  if (value === undefined || value.length === 0) return undefined;
  if (!isAbsolute(value)) throw new Error("RUNLOOM_USER_DATA must be an absolute path");
  return value;
}
