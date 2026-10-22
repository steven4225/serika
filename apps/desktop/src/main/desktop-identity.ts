import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, open } from "node:fs/promises";
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

export interface DesktopThread { threadId: string; transcriptDirectory: string }
interface DesktopProfile {
  configPath: string; workspaceRoot: string | null; activeThreadId: string; threads: DesktopThread[];
}
interface IdentityRegistry { version: 2; profiles: DesktopProfile[] }
type IdentityOptions = { applicationHome: string; configPath: string; workspaceRoot: string | null; cwd: string };

async function readRegistry(applicationHome: string): Promise<IdentityRegistry> {
  const path = join(applicationHome, "desktop", "desktop-identity.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isIdentity(parsed)) return { version: 2, profiles: [{ configPath: parsed.configPath, workspaceRoot: parsed.workspaceRoot,
      activeThreadId: parsed.threadId, threads: [{ threadId: parsed.threadId, transcriptDirectory: parsed.transcriptDirectory }] }] };
    const registry = parsed as IdentityRegistry;
    if (!registry || registry.version !== 2 || !Array.isArray(registry.profiles) || registry.profiles.length > 32 || registry.profiles.some(profile =>
      !Array.isArray(profile.threads) || profile.threads.length < 1 || profile.threads.length > 100 ||
      new Set(profile.threads.map(thread => thread.threadId)).size !== profile.threads.length ||
      !profile.threads.some(thread => thread.threadId === profile.activeThreadId) ||
      profile.threads.some(thread => !isIdentity({ version: 1, ...profile, ...thread })))) throw new Error("Invalid identity registry");
    if (new Set(registry.profiles.map(profile => JSON.stringify([profile.configPath]))).size !== registry.profiles.length) throw new Error("Duplicate identity profiles");
    return registry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, profiles: [] };
    throw new Error(`Cannot read desktop identity ${path}; refusing to reset conversation identity`, { cause: error });
  }
}

async function writeRegistry(applicationHome: string, registry: IdentityRegistry): Promise<void> {
  if (registry.profiles.length > 32 || registry.profiles.some(profile => profile.threads.length > 100)) throw new Error("Conversation list is full");
  await mkdir(join(applicationHome, "desktop"), { recursive: true });
  const identityPath = join(applicationHome, "desktop", "desktop-identity.json");
  const temporaryPath = `${identityPath}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    try { await file.writeFile(`${JSON.stringify(registry, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
    await rename(temporaryPath, identityPath);
    if (process.platform !== "win32") { const directory = await open(join(applicationHome, "desktop"), "r"); try { await directory.sync(); } finally { await directory.close(); } }
  } finally {
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}

function findProfile(registry: IdentityRegistry, options: IdentityOptions): DesktopProfile | undefined {
  return registry.profiles.find(profile => profile.configPath === resolve(options.cwd, options.configPath));
}

export async function listDesktopThreads(options: IdentityOptions): Promise<DesktopThread[]> {
  return findProfile(await readRegistry(options.applicationHome), options)?.threads ?? [];
}

/** Called only after the renderer explicitly confirms this directory belongs to this workspace. */
export async function registerDesktopThread(options: IdentityOptions, thread: DesktopThread): Promise<void> {
  if (!isIdentity({ version: 1, configPath: resolve(options.cwd, options.configPath), workspaceRoot: options.workspaceRoot, ...thread })) throw new Error("Invalid conversation identity");
  const registry = await readRegistry(options.applicationHome);
  let profile = findProfile(registry, options);
  if (!profile) {
    profile = { configPath: resolve(options.cwd, options.configPath), workspaceRoot: options.workspaceRoot, activeThreadId: thread.threadId, threads: [] };
    registry.profiles.push(profile);
  }
  const existing = profile.threads.find(item => item.threadId === thread.threadId);
  if (existing && existing.transcriptDirectory !== thread.transcriptDirectory) throw new Error("This Thread is already registered from a different directory");
  if (!existing) profile.threads.push({ threadId: thread.threadId, transcriptDirectory: thread.transcriptDirectory });
  await writeRegistry(options.applicationHome, registry);
}

export async function selectDesktopThread(options: IdentityOptions, threadId: string): Promise<DesktopIdentityResolution> {
  const registry = await readRegistry(options.applicationHome);
  const profile = findProfile(registry, options);
  const thread = profile?.threads.find(item => item.threadId === threadId);
  if (!profile || !thread) throw new Error("Conversation is not registered in this workspace");
  profile.activeThreadId = threadId;
  await writeRegistry(options.applicationHome, registry);
  return { version: 1, configPath: profile.configPath, workspaceRoot: options.workspaceRoot, ...thread, identitySource: "saved" };
}

export async function createDesktopThread(options: IdentityOptions): Promise<DesktopThread> {
  const threadId = randomUUID();
  const thread = { threadId, transcriptDirectory: join(options.applicationHome, "transcripts", threadId) };
  await registerDesktopThread(options, thread);
  return thread;
}

/** Startup preference only: no conversation, credentials, or workspace contents. */
export async function resolveDesktopIdentity(options: {
  applicationHome: string;
  configPath: string;
  workspaceRoot: string | null;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): Promise<DesktopIdentityResolution> {
  const configPath = resolve(options.cwd, options.configPath);
  const registry = await readRegistry(options.applicationHome);
  const profile = findProfile(registry, options);
  const selected = profile?.threads.find(thread => thread.threadId === profile.activeThreadId);
  const matching = profile && selected ? { version: 1 as const, configPath, workspaceRoot: options.workspaceRoot, ...selected } : undefined;
  const explicitThread = options.env.RUNLOOM_THREAD?.trim();
  const explicitDirectory = options.env.RUNLOOM_TRANSCRIPTS?.trim();
  if (explicitThread || explicitDirectory) {
    // A partial explicit launch is stable too, without replacing the normal profile.
    const key = createHash("sha256").update(JSON.stringify([configPath, explicitDirectory ?? null])).digest("hex").slice(0, 24);
    return {
      version: 1, configPath, workspaceRoot: options.workspaceRoot,
      threadId: explicitThread || matching?.threadId || `desktop-explicit-${key}`,
      transcriptDirectory: explicitDirectory ? resolve(options.cwd, explicitDirectory) : matching?.transcriptDirectory ?? join(options.applicationHome, "transcripts", `explicit-${key}`),
      identitySource: "explicit",
    };
  }
  if (matching) return { ...matching, identitySource: "saved" };
  const thread = await createDesktopThread(options);
  return selectDesktopThread(options, thread.threadId);
}
