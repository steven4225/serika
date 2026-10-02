import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export interface DesktopIdentityPreference {
  version: 1;
  configPath: string;
  workspaceRoot: string | null;
  transcriptDirectory: string;
  threadId: string;
}

export interface DesktopIdentityResolution extends DesktopIdentityPreference {
  identitySource: "saved" | "explicit";
}

function isIdentity(value: unknown): value is DesktopIdentityPreference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.version === 1 && typeof item.configPath === "string" && isAbsolute(item.configPath)
    && (item.workspaceRoot === null || (typeof item.workspaceRoot === "string" && isAbsolute(item.workspaceRoot)))
    && typeof item.transcriptDirectory === "string" && isAbsolute(item.transcriptDirectory)
    && typeof item.threadId === "string" && item.threadId.trim().length > 0;
}

/** Startup preference only: no conversation, credentials, or workspace contents. */
export async function resolveDesktopIdentity(options: {
  userData: string;
  configPath: string;
  workspaceRoot: string | null;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): Promise<DesktopIdentityResolution> {
  const identityPath = join(options.userData, "desktop-identity.json");
  const configPath = resolve(options.cwd, options.configPath);
  let saved: DesktopIdentityPreference | undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(identityPath, "utf8"));
    if (!isIdentity(parsed)) throw new Error("Invalid identity format");
    saved = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Cannot read desktop identity ${identityPath}; refusing to reset conversation identity`, { cause: error });
    }
  }
  const matching = saved?.configPath === configPath && saved.workspaceRoot === options.workspaceRoot ? saved : undefined;
  const explicitThread = options.env.RUNLOOM_THREAD?.trim();
  const explicitDirectory = options.env.RUNLOOM_TRANSCRIPTS?.trim();
  if (explicitThread || explicitDirectory) {
    // A partial explicit launch is stable too, without replacing the normal profile.
    const key = createHash("sha256").update(JSON.stringify([configPath, options.workspaceRoot, explicitDirectory ?? null])).digest("hex").slice(0, 24);
    return {
      version: 1, configPath, workspaceRoot: options.workspaceRoot,
      threadId: explicitThread || matching?.threadId || `desktop-explicit-${key}`,
      transcriptDirectory: explicitDirectory ? resolve(options.cwd, explicitDirectory) : matching?.transcriptDirectory ?? join(options.userData, "transcripts", `explicit-${key}`),
      identitySource: "explicit",
    };
  }
  if (matching) return { ...matching, identitySource: "saved" };
  const threadId = randomUUID();
  const identity: DesktopIdentityPreference = {
    version: 1, configPath, workspaceRoot: options.workspaceRoot,
    threadId, transcriptDirectory: join(options.userData, "transcripts", threadId),
  };
  await mkdir(options.userData, { recursive: true });
  const temporaryPath = `${identityPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(identity, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, identityPath);
  } finally {
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
  return { ...identity, identitySource: "saved" };
}
