import { lstat, readFile, realpath } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve as resolvePath,
  sep,
  win32,
} from "node:path";
import { z } from "zod";
import type { DirectoryAuthorization } from "./directory-access.js";
import { resolveConfiguredTodoistTimeZone, resolveShorthandTodoistTimeZone, todoistModuleConfigSchema } from "./modules/todoist-module.js";
import { validModelPrice, type ModelPrice } from "./model-usage.js";
import { herdrTargetSchema, type HerdrTarget } from "./herdr.js";
import { computerConfigSchema, type ComputerConfig } from "./modules/computer-module.js";
import { hooksConfigSchema, type HookRule } from "./automation-hooks.js";
import { skillPackageRegistrationsSchema, type SkillPackageRegistration } from "./skill-catalog.js";
import { resolveWorkspace } from "./resolve-workspace.js";
import type { AssistantAssembly } from "./assembly.js";
import {
  RUN_AUTHORIZED_FILE_TOOLS,
  type RunAuthorizedFileTool,
} from "./modules/read-file-module.js";
import {
  rejectSymlinkComponents,
  validateWorkspacePath,
} from "./workspace-path.js";
import type { DockerShellSandboxConfig } from "./modules/docker-shell-runner.js";
import { SHELL_EXEC_MAX_TIMEOUT_MS, SHELL_EXEC_TIMEOUT_MS } from "./modules/shell-module.js";
import {
  DEFAULT_CONTEXT_BUDGET_CONFIG,
  validateRequestedContextBudgetConfig,
  type ContextBudgetConfig,
} from "./context-budget.js";

export class ComputerDriverUnavailableError extends Error {
  constructor(readonly configPath: string) {
    super("电脑控制驱动不可用；请恢复驱动，或明确停用电脑控制后重新启动。");
    this.name = "ComputerDriverUnavailableError";
  }
}

export const BUILTIN_MODULE_IDS = [
  "pomodoro",
  "read-file",
  "memory",
  "checkpoint",
  "task",
  "todoist",
  "shell",
  "web",
  "computer",
  "terminal",
] as const;

export type BuiltinModuleId = (typeof BUILTIN_MODULE_IDS)[number];

export interface FileAuthorizationRule {
  tools: readonly RunAuthorizedFileTool[];
  allowedPaths: readonly string[];
}

/** Primary TUI Run step budget when config does not set run.maxSteps. */
export const TUI_DEFAULT_MAX_STEPS = 8;

/** Highest primary TUI Run step budget an explicit config may set. */
export const TUI_MAX_CONFIGURABLE_STEPS = 32;

/** Default and maximum wall-clock budget for the primary TUI Run, excluding confirmation pauses. */
export const TUI_DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
export const TUI_MAX_TOTAL_TIMEOUT_MS = 30 * 60_000;

export interface TelegramAutonomyGrant { directory: string; botId: number; userId: number; chatId: number; threadId: string }

export interface ResolvedTuiModuleConfig {
  telegramAutonomy?: TelegramAutonomyGrant;
  desktopAutonomy?: { directory: string };
  configPath: string | null;
  workspaceRoot: string | null;
  projectDirectory: string | null;
  authorizedDirectories: readonly DirectoryAuthorization[];
  enabled: Record<BuiltinModuleId, boolean>;
  webSearchEnabled: boolean;
  webFeedEnabled: boolean;
  autoConsolidate: boolean;
  todoistTimeZone: string | null;
  fileAuthorizations: readonly FileAuthorizationRule[];
  shellSandbox: DockerShellSandboxConfig | null;
  shellTimeoutMs: number;
  contextCompaction: ContextBudgetConfig;
  maxSteps: number;
  totalTimeoutMs: number;
  computer?: ComputerConfig;
  terminalTarget?: HerdrTarget;
  automation?: AutomationConfig;
  modelPricing?: readonly ModelPrice[];
  modelContextWindows?: readonly import("./context-budget.js").ModelContextWindow[];
}

export interface AutomationConfig {
  skills?: SkillPackageRegistration[] | undefined;
  /** Explicit learning consent. Derived text guidance never grants tool authority. */
  dreaming?: { enabled: boolean } | undefined;
  /** Absent uses the legacy memory defaults; [] explicitly disables all hooks. */
  hooks?: HookRule[] | undefined;
}

const automationConfigSchema = z.object({
  skills: skillPackageRegistrationsSchema.optional(),
  dreaming: z.object({ enabled: z.boolean() }).strict().optional(),
  hooks: hooksConfigSchema.optional(),
}).strict();

const nonEmptyString = z.string().refine((value) => value.trim().length > 0);

const moduleToggleSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

const memoryModuleSchema = z
  .object({
    enabled: z.boolean(),
    autoConsolidate: z.boolean().optional(),
  })
  .strict();

const shellSandboxSchema = z
  .object({
    backend: z.literal("docker"),
    image: nonEmptyString,
    readablePaths: z.array(nonEmptyString),
    writablePaths: z.array(nonEmptyString),
  })
  .strict();

const shellModuleSchema = z
  .object({
    enabled: z.boolean(),
    sandbox: shellSandboxSchema.optional(),
    timeoutMs: z.number().int().min(1).max(SHELL_EXEC_MAX_TIMEOUT_MS).optional(),
  })
  .strict();

const webModuleSchema = z
  .object({
    enabled: z.boolean(),
    search: z.object({ enabled: z.boolean() }).strict().optional(),
    feed: z.object({ enabled: z.boolean() }).strict().optional(),
  })
  .strict();

const contextCompactionSchema = z
  .object({
    enabled: z.boolean(),
    contextWindowTokens: z.number().int().nonnegative(),
    maxOutputTokens: z.number().int().nonnegative(),
    safetyMarginTokens: z.number().int().nonnegative(),
    keepRecentTokens: z.number().int().nonnegative(),
    summaryMaxOutputTokens: z.number().int().nonnegative(),
    inputBudgetTokens: z.number().int().positive().optional(),
    triggerRatio: z.number().gt(0).lt(1).optional(),
    summaryInputChunkTokens: z.number().int().positive().optional(),
  })
  .strict();

const fileAuthorizationSchema = z
  .object({
    tools: z.array(z.enum(RUN_AUTHORIZED_FILE_TOOLS)).min(1),
    allowedPaths: z.array(nonEmptyString).min(1),
  })
  .strict();

const tuiModuleConfigSchema = z
  .object({
    version: z.literal(2),
    projectDirectory: nonEmptyString.nullable().optional(),
    authorizedDirectories: z.array(z.object({ path: nonEmptyString, access: z.enum(["read", "readwrite"]) }).strict()).optional(),
    modules: z
      .object({
        pomodoro: moduleToggleSchema.optional(),
        "read-file": moduleToggleSchema.optional(),
        memory: memoryModuleSchema.optional(),
        checkpoint: moduleToggleSchema.optional(),
        task: moduleToggleSchema.optional(),
        todoist: todoistModuleConfigSchema.optional(),
        shell: shellModuleSchema.optional(),
        web: webModuleSchema.optional(),
        computer: computerConfigSchema.optional(),
        terminal: z.object({ enabled: z.boolean(), target: herdrTargetSchema.optional() }).strict().optional(),
    })
    .strict(),
    telegramAutonomy: z.object({ authorizedDirectory: nonEmptyString, botId: z.number().int().positive().safe(), userId: z.number().int().positive().safe(), chatId: z.number().int().positive().safe(), threadId: nonEmptyString }).strict().optional(),
    desktopAutonomy: z.object({ authorizedDirectory: nonEmptyString }).strict().optional(),
    fileAuthorizations: z.array(fileAuthorizationSchema).optional(),
    contextCompaction: contextCompactionSchema.optional(),
    modelPricing: z.array(z.custom<ModelPrice>(validModelPrice)).max(16).refine(prices =>
      new Set(prices.map(price => JSON.stringify([price.provider, price.modelId]))).size === prices.length,
      "Duplicate provider/model price").optional(),
    modelContextWindows: z.array(z.object({ provider: nonEmptyString, modelId: nonEmptyString,
      contextWindowTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict()).max(16).refine(windows =>
      new Set(windows.map(item => JSON.stringify([item.provider, item.modelId]))).size === windows.length,
      "Duplicate provider/model context window").optional(),
    automation: automationConfigSchema.optional(),
    run: z
      .object({
        maxSteps: z.number().int().min(1).max(TUI_MAX_CONFIGURABLE_STEPS).optional(),
        totalTimeoutMs: z.number().int().min(1).max(TUI_MAX_TOTAL_TIMEOUT_MS).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface TuiModuleConfig {
  version: 2;
  projectDirectory?: string | null | undefined;
  authorizedDirectories?: DirectoryAuthorization[] | undefined;
  modules: {
    computer?: ComputerConfig | undefined;
    terminal?: { enabled: boolean; target?: HerdrTarget | undefined } | undefined;
    pomodoro?: { enabled: boolean } | undefined;
    "read-file"?: { enabled: boolean } | undefined;
    memory?:
      | { enabled: boolean; autoConsolidate?: boolean | undefined;
        }
      | undefined;
    checkpoint?: { enabled: boolean } | undefined;
    task?: { enabled: boolean } | undefined;
    todoist?:
      | { enabled: boolean; timeZone?: string | undefined }
      | undefined;
    shell?:
      | {
          enabled: boolean;
          sandbox?: DockerShellSandboxConfig | undefined;
          timeoutMs?: number | undefined;
        }
      | undefined;
    web?:
      | {
          enabled: boolean;
          search?: { enabled: boolean } | undefined;
          feed?: { enabled: boolean } | undefined;
        }
      | undefined;
  };
  telegramAutonomy?: Omit<TelegramAutonomyGrant, "directory"> & { authorizedDirectory: string } | undefined;
  desktopAutonomy?: { authorizedDirectory: string } | undefined;
  fileAuthorizations?: FileAuthorizationRule[] | undefined;
  contextCompaction?: ContextBudgetConfig | undefined;
  run?: { maxSteps?: number | undefined; totalTimeoutMs?: number | undefined } | undefined;
  automation?: AutomationConfig | undefined;
  modelPricing?: ModelPrice[] | undefined;
  modelContextWindows?: import("./context-budget.js").ModelContextWindow[] | undefined;
}

function configPathFromArgs(args: AssistantAssembly): string | undefined {
  if (!("configPath" in args)) return undefined;
  const configPath = args.configPath;
  if (configPath !== undefined && typeof configPath !== "string") {
    throw new Error("TUI config path must be a file path");
  }
  return configPath;
}

function emptyEnabled(): Record<BuiltinModuleId, boolean> {
  return {
    pomodoro: false,
    "read-file": false,
    memory: false,
    checkpoint: false,
    task: false,
    todoist: false,
    shell: false,
    web: false,
    computer: false,
    terminal: false,
  };
}

function hasWorkspaceModule(enabled: Record<BuiltinModuleId, boolean>, dataDirectory?: string): boolean {
  return enabled["read-file"] || enabled.checkpoint || enabled.shell || enabled.terminal || (!dataDirectory && (enabled.memory || enabled.task));
}

function assertWorkspaceRequirement(
  enabled: Record<BuiltinModuleId, boolean>,
  workspace: string | undefined,
  errorMessage: string,
  dataDirectory?: string,
): void {
  if (hasWorkspaceModule(enabled, dataDirectory) && workspace === undefined) {
    throw new Error(errorMessage);
  }
}

function isPathWithin(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function normalizeFileAuthorizations(
  rules: readonly FileAuthorizationRule[] | undefined,
  directory: string | null,
  enabled: Record<BuiltinModuleId, boolean>,
): readonly FileAuthorizationRule[] {
  if (rules === undefined || rules.length === 0) return [];
  if (!enabled["read-file"]) {
    throw new Error("fileAuthorizations requires read-file.enabled to be true");
  }
  if (directory === null) {
    throw new Error("fileAuthorizations requires a workspace");
  }
  return rules.map((rule) => {
    const tools = [...new Set(rule.tools)];
    if (tools.length !== rule.tools.length) {
      throw new Error("fileAuthorizations tools must not contain duplicates");
    }
    const allowedPaths = rule.allowedPaths.map((path) => {
      const validated = validateWorkspacePath(directory, path);
      if (!validated.ok) {
        throw new Error(
          `Invalid file authorization path ${JSON.stringify(path)}: ${validated.message}`,
        );
      }
      return validated.relativePath;
    });
    if (new Set(allowedPaths).size !== allowedPaths.length) {
      throw new Error("fileAuthorizations paths must not contain duplicates");
    }
    return { tools, allowedPaths };
  });
}

const neverAborted = new AbortController().signal;

async function resolveSandboxWorkspace(
  workspace: string | undefined,
  configDirectory: string,
): Promise<string> {
  if (workspace === undefined) {
    throw new Error("Shell sandbox requires a workspace");
  }
  if (isAbsolute(workspace) || win32.isAbsolute(workspace)) {
    throw new Error("Shell sandbox workspace must be relative to the config file");
  }
  const configuredPath = resolvePath(configDirectory, workspace);
  let details;
  try {
    details = await lstat(configuredPath);
  } catch {
    throw new Error(`Sandbox workspace does not exist: ${workspace}`);
  }
  if (details.isSymbolicLink()) {
    throw new Error(`Sandbox workspace must not be a symlink: ${workspace}`);
  }
  if (!details.isDirectory()) {
    throw new Error(`Sandbox workspace is not a directory: ${workspace}`);
  }
  return resolveWorkspace(workspace, configDirectory);
}

async function normalizeSandboxPath(
  directory: string,
  requestedPath: string,
  writable: boolean,
): Promise<string> {
  const validated = validateWorkspacePath(directory, requestedPath);
  if (!validated.ok) {
    throw new Error(
      `Invalid sandbox mount path ${JSON.stringify(requestedPath)}: ${validated.message}`,
    );
  }
  let details;
  try {
    details = await lstat(validated.target);
  } catch {
    throw new Error(
      `Sandbox mount path does not exist: ${JSON.stringify(requestedPath)}`,
    );
  }
  if (details.isSymbolicLink()) {
    throw new Error(
      `Sandbox mount path must not be a symlink: ${JSON.stringify(requestedPath)}`,
    );
  }
  if (writable && !details.isDirectory()) {
    throw new Error(
      `Writable sandbox path must be a directory: ${JSON.stringify(requestedPath)}`,
    );
  }
  if (await rejectSymlinkComponents(directory, validated.relativePath, neverAborted)) {
    throw new Error(
      `Sandbox mount path must not pass through a symlink: ${JSON.stringify(requestedPath)}`,
    );
  }
  return validated.relativePath;
}

async function normalizeShellSandbox(
  sandbox: DockerShellSandboxConfig | undefined,
  workspace: string | undefined,
  configDirectory: string,
): Promise<{ directory: string | null; shellSandbox: DockerShellSandboxConfig | null }> {
  if (sandbox === undefined) {
    return { directory: null, shellSandbox: null };
  }
  const directory = await resolveSandboxWorkspace(workspace, configDirectory);
  const readablePaths = await Promise.all(
    sandbox.readablePaths.map((path) => normalizeSandboxPath(directory, path, false)),
  );
  const writablePaths = await Promise.all(
    sandbox.writablePaths.map((path) => normalizeSandboxPath(directory, path, true)),
  );
  return {
    directory,
    shellSandbox: {
      backend: "docker",
      image: sandbox.image,
      readablePaths: [...new Set(readablePaths)],
      writablePaths: [...new Set(writablePaths)],
    },
  };
}

export class ConfigUpgradeRequiredError extends Error {
  constructor() { super("配置为 v1，请运行 node packages/assistant/scripts/config-upgrade.mjs --config <配置文件> --upgrade 升级"); }
}

/** Pure schema read for other trusted hosts; does not resolve unrelated module paths. */
export async function readTuiModuleConfig(configPath: string): Promise<TuiModuleConfig> {
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch {
    throw new Error("Unable to read TUI config file");
  }

  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new Error("Invalid TUI config JSON");
  }

  return parseTuiModuleConfig(value);
}

export function parseTuiModuleConfig(value: unknown): TuiModuleConfig {
  if (typeof value === "object" && value !== null) {
    if ("version" in value && value.version === 1) throw new ConfigUpgradeRequiredError();
    const autonomyHasOldField = ["desktopAutonomy" in value ? value.desktopAutonomy : undefined, "telegramAutonomy" in value ? value.telegramAutonomy : undefined].some(grant =>
      typeof grant === "object" && grant !== null && "workspaceRoot" in grant);
    const modules = "modules" in value ? value.modules : undefined;
    const memory = typeof modules === "object" && modules !== null && "memory" in modules ? modules.memory : undefined;
    if ("workspace" in value || autonomyHasOldField || typeof memory === "object" && memory !== null && "writePolicy" in memory) {
      throw new Error("Legacy TUI config fields require the offline home importer before startup");
    }
  }

  const parsed = tuiModuleConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Invalid TUI config schema");
  }
  return parsed.data;
}

async function resolveConfiguredMode(
  args: AssistantAssembly,
  configPath: string,
  cwd: string,
): Promise<ResolvedTuiModuleConfig> {
  if (
    args.workspace !== undefined ||
    args.todoistEnabled === true ||
    args.autoConsolidate === true
  ) {
    throw new Error("--config cannot be combined with module selection options");
  }

  const absoluteConfigPath = resolvePath(cwd, configPath);
  const config = await readTuiModuleConfig(absoluteConfigPath);
  const contextCompaction = config.contextCompaction ?? DEFAULT_CONTEXT_BUDGET_CONFIG;
  const contextBudgetValidation = validateRequestedContextBudgetConfig(contextCompaction);
  if (contextCompaction.enabled && !contextBudgetValidation.ok) {
    throw new Error(`Invalid context compaction budget: ${contextBudgetValidation.errors.join("; ")}`);
  }
  const enabled = emptyEnabled();
  enabled.pomodoro = config.modules.pomodoro?.enabled ?? false;
  enabled["read-file"] = config.modules["read-file"]?.enabled ?? false;
  enabled.memory = config.modules.memory?.enabled ?? false;
  enabled.checkpoint = config.modules.checkpoint?.enabled ?? false;
  enabled.task = config.modules.task?.enabled ?? false;
  enabled.todoist = config.modules.todoist?.enabled ?? false;
  enabled.shell = config.modules.shell?.enabled ?? false;
  enabled.web = config.modules.web?.enabled ?? false;
  enabled.computer = config.modules.computer?.enabled ?? false;
  enabled.terminal = config.modules.terminal?.enabled ?? false;
  if (enabled.computer && process.platform !== "darwin") {
    throw new Error("computer module currently requires macOS");
  }
  const webSearchEnabled =
    enabled.web && (config.modules.web?.search?.enabled ?? false);
  const webFeedEnabled =
    enabled.web && (config.modules.web?.feed?.enabled ?? false);

  const autoConsolidate = config.modules.memory?.autoConsolidate ?? false;
  if (autoConsolidate && !enabled.memory) {
    throw new Error(
      "memory.autoConsolidate requires memory.enabled to be true",
    );
  }
  if (config.modules.web?.search?.enabled === true && !enabled.web) {
    throw new Error("web.search requires web.enabled to be true");
  }
  if (config.modules.web?.feed?.enabled === true && !enabled.web) {
    throw new Error("web.feed requires web.enabled to be true");
  }
  const authorizedDirectories = await Promise.all((config.authorizedDirectories ?? []).map(async item => {
    const path = resolvePath(dirname(absoluteConfigPath), item.path);
    const canonical = await resolveWorkspace(item.path, dirname(absoluteConfigPath));
    if ((await lstat(path)).isSymbolicLink()) throw new Error("Workspace must not be a symlink");
    return { path: canonical, access: item.access };
  }));
  if (new Set(authorizedDirectories.map(item => item.path)).size !== authorizedDirectories.length) throw new Error("Duplicate authorized directory");
  const requestedProjectDirectory = config.projectDirectory === null ? undefined : config.projectDirectory ?? (authorizedDirectories.length === 1 ? authorizedDirectories[0]!.path : undefined);
  if (config.authorizedDirectories === undefined) assertWorkspaceRequirement(enabled, requestedProjectDirectory,
    "TUI config requires projectDirectory when read-file, memory, checkpoint, task, or shell is enabled", args.dataDirectory);
  if (enabled.terminal && !requestedProjectDirectory) throw new Error("Host terminal requires an explicit projectDirectory");

  const sandboxDefinition = config.modules.shell?.sandbox;
  if (sandboxDefinition !== undefined && !enabled.shell) {
    throw new Error("shell.sandbox requires shell.enabled to be true");
  }
  const sandboxResolution =
    sandboxDefinition === undefined
      ? undefined
      : await normalizeShellSandbox(
          sandboxDefinition,
          config.projectDirectory ?? (config.authorizedDirectories?.length === 1 ? config.authorizedDirectories[0]!.path : undefined),
          dirname(absoluteConfigPath),
        );
  const projectDirectory =
    sandboxResolution?.directory ??
    (requestedProjectDirectory === undefined ? null : await resolveWorkspace(requestedProjectDirectory, dirname(absoluteConfigPath)));
  const shellSandbox = sandboxResolution?.shellSandbox ?? null;
  const terminalTarget = config.modules.terminal?.target;
  if (terminalTarget && terminalTarget.authorizedDirectory !== projectDirectory) {
    throw new Error("Herdr target must match the exact projectDirectory");
  }
  if (enabled.terminal && shellSandbox) throw new Error("Host terminal control cannot be combined with Docker Shell");
  const fileAuthorizations = normalizeFileAuthorizations(
    config.fileAuthorizations,
    projectDirectory,
    enabled,
  );
  if (enabled.terminal || terminalTarget || config.telegramAutonomy || config.desktopAutonomy || fileAuthorizations.length > 0 || shellSandbox !== null || enabled.computer || config.automation !== undefined) {
    const configRealPath = await realpath(absoluteConfigPath);
    if (projectDirectory !== null && isPathWithin(projectDirectory, configRealPath)) throw new Error(
      "TUI config with sandbox, fileAuthorizations, computer, automatic memory, automation or foreground autonomy must be outside the workspace");
  }
  const todoistTimeZone = resolveConfiguredTodoistTimeZone(enabled.todoist, config.modules.todoist);

  let computer: ComputerConfig | undefined;
  if (enabled.computer) {
    let executable: string;
    try { executable = await realpath(config.modules.computer!.executable!); }
    catch (error) {
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new ComputerDriverUnavailableError(absoluteConfigPath);
      throw error;
    }
    if (projectDirectory !== null && isPathWithin(projectDirectory, executable)) throw new Error("Computer driver executable must be outside the workspace");
    computer = { ...config.modules.computer!, executable };
  }
  return {
    ...(config.telegramAutonomy?.authorizedDirectory === projectDirectory ? { telegramAutonomy: { directory: projectDirectory, botId: config.telegramAutonomy.botId, userId: config.telegramAutonomy.userId, chatId: config.telegramAutonomy.chatId, threadId: config.telegramAutonomy.threadId } } : {}),
    ...(config.desktopAutonomy && config.desktopAutonomy.authorizedDirectory === projectDirectory
      ? { desktopAutonomy: { directory: projectDirectory } } : {}),
    configPath: absoluteConfigPath,
    workspaceRoot: projectDirectory,
    projectDirectory,
    authorizedDirectories,
    enabled,
    webSearchEnabled,
    webFeedEnabled,
    autoConsolidate,
    todoistTimeZone,
    fileAuthorizations,
    shellSandbox,
    shellTimeoutMs: config.modules.shell?.timeoutMs ?? SHELL_EXEC_TIMEOUT_MS,
    contextCompaction,
    maxSteps: config.run?.maxSteps ?? TUI_DEFAULT_MAX_STEPS,
    totalTimeoutMs: config.run?.totalTimeoutMs ?? TUI_DEFAULT_TOTAL_TIMEOUT_MS,
    ...(computer ? { computer } : {}),
    ...(terminalTarget ? { terminalTarget } : {}),
    ...(config.automation ? { automation: config.automation } : {}),
    ...(config.modelPricing ? { modelPricing: config.modelPricing } : {}),
    ...(config.modelContextWindows ? { modelContextWindows: config.modelContextWindows } : {}),
  };
}

async function resolveLegacyMode(
  args: AssistantAssembly,
  cwd: string,
  todoistTimeZone: string | undefined,
): Promise<ResolvedTuiModuleConfig> {
  const enabled = emptyEnabled();
  enabled.pomodoro = true;
  enabled["read-file"] = args.workspace !== undefined;
  enabled.memory = args.workspace !== undefined || args.dataDirectory !== undefined;
  enabled.task = args.workspace !== undefined || args.dataDirectory !== undefined;
  enabled.todoist = args.todoistEnabled === true;
  enabled.web = false;

  if (args.autoConsolidate === true && args.workspace === undefined && args.dataDirectory === undefined) {
    throw new Error("--auto-consolidate requires --workspace");
  }
  assertWorkspaceRequirement(
    enabled,
    args.workspace,
    "--workspace is required when workspace modules are enabled",
    args.dataDirectory,
  );

  const workspaceRoot =
    args.workspace === undefined
      ? null
      : await resolveWorkspace(args.workspace, cwd);
  const resolvedTodoistTimeZone = resolveShorthandTodoistTimeZone(enabled.todoist, todoistTimeZone);

  return {
    configPath: null,
    workspaceRoot,
    projectDirectory: workspaceRoot,
    authorizedDirectories: workspaceRoot === null ? [] : [{ path: workspaceRoot, access: "readwrite" }],
    enabled,
    webSearchEnabled: false,
    webFeedEnabled: false,
    autoConsolidate: args.autoConsolidate === true,
    todoistTimeZone: resolvedTodoistTimeZone,
    fileAuthorizations: [],
    shellSandbox: null,
    shellTimeoutMs: SHELL_EXEC_TIMEOUT_MS,
    contextCompaction: DEFAULT_CONTEXT_BUDGET_CONFIG,
    maxSteps: TUI_DEFAULT_MAX_STEPS,
    totalTimeoutMs: TUI_DEFAULT_TOTAL_TIMEOUT_MS,
  };
}

export function resolveTuiModuleConfig(
  args: AssistantAssembly,
  options: {
    cwd: string;
    todoistTimeZone?: string | undefined;
  },
): Promise<ResolvedTuiModuleConfig> {
  const configPath = configPathFromArgs(args);
  if (configPath !== undefined) {
    if (configPath.length === 0) {
      return Promise.reject(new Error("TUI config path must be a file path"));
    }
    return resolveConfiguredMode(args, configPath, options.cwd);
  }
  return resolveLegacyMode(args, options.cwd, options.todoistTimeZone);
}
