import { readFile, realpath } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve as resolvePath,
  sep,
} from "node:path";
import { z } from "zod";
import { resolveWorkspace, type TuiArgs } from "./cli-options.js";
import {
  RUN_AUTHORIZED_FILE_TOOLS,
  type RunAuthorizedFileTool,
} from "./tui.js";
import { validateWorkspacePath } from "./workspace-path.js";

export const BUILTIN_MODULE_IDS = [
  "pomodoro",
  "read-file",
  "memory",
  "task",
  "todoist",
  "shell",
] as const;

export type BuiltinModuleId = (typeof BUILTIN_MODULE_IDS)[number];

export interface FileAuthorizationRule {
  tools: readonly RunAuthorizedFileTool[];
  allowedPaths: readonly string[];
}

export interface ResolvedTuiModuleConfig {
  configPath: string | null;
  workspaceRoot: string | null;
  enabled: Record<BuiltinModuleId, boolean>;
  autoConsolidate: boolean;
  todoistTimeZone: string | null;
  fileAuthorizations: readonly FileAuthorizationRule[];
}

const DEFAULT_TODOIST_TIME_ZONE = "Asia/Shanghai";
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

const todoistModuleSchema = z
  .object({
    enabled: z.boolean(),
    timeZone: nonEmptyString.optional(),
  })
  .strict();

const fileAuthorizationSchema = z
  .object({
    tools: z.array(z.enum(RUN_AUTHORIZED_FILE_TOOLS)).min(1),
    allowedPaths: z.array(nonEmptyString).min(1),
  })
  .strict();

const tuiModuleConfigV1Schema = z
  .object({
    version: z.literal(1),
    workspace: nonEmptyString.optional(),
    modules: z
      .object({
        pomodoro: moduleToggleSchema.optional(),
        "read-file": moduleToggleSchema.optional(),
        memory: memoryModuleSchema.optional(),
        task: moduleToggleSchema.optional(),
        todoist: todoistModuleSchema.optional(),
        shell: moduleToggleSchema.optional(),
      })
      .strict(),
    fileAuthorizations: z.array(fileAuthorizationSchema).optional(),
  })
  .strict();

export interface TuiModuleConfigV1 {
  version: 1;
  workspace?: string | undefined;
  modules: {
    pomodoro?: { enabled: boolean } | undefined;
    "read-file"?: { enabled: boolean } | undefined;
    memory?:
      | { enabled: boolean; autoConsolidate?: boolean | undefined }
      | undefined;
    task?: { enabled: boolean } | undefined;
    todoist?:
      | { enabled: boolean; timeZone?: string | undefined }
      | undefined;
    shell?: { enabled: boolean } | undefined;
  };
  fileAuthorizations?: FileAuthorizationRule[] | undefined;
}

function configPathFromArgs(args: TuiArgs): string | undefined {
  if (!("configPath" in args)) return undefined;
  const configPath = args.configPath;
  if (configPath !== undefined && typeof configPath !== "string") {
    throw new Error("TUI config path must be a file path");
  }
  return configPath;
}

function normalizeTodoistTimeZone(value: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: value,
    }).resolvedOptions().timeZone;
  } catch {
    throw new Error("Invalid Todoist time zone");
  }
}

function emptyEnabled(): Record<BuiltinModuleId, boolean> {
  return {
    pomodoro: false,
    "read-file": false,
    memory: false,
    task: false,
    todoist: false,
    shell: false,
  };
}

function hasWorkspaceModule(enabled: Record<BuiltinModuleId, boolean>): boolean {
  return enabled["read-file"] || enabled.memory || enabled.task || enabled.shell;
}

function assertWorkspaceRequirement(
  enabled: Record<BuiltinModuleId, boolean>,
  workspace: string | undefined,
  errorMessage: string,
): void {
  if (hasWorkspaceModule(enabled) && workspace === undefined) {
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
  workspaceRoot: string | null,
  enabled: Record<BuiltinModuleId, boolean>,
): readonly FileAuthorizationRule[] {
  if (rules === undefined || rules.length === 0) return [];
  if (!enabled["read-file"]) {
    throw new Error("fileAuthorizations requires read-file.enabled to be true");
  }
  if (workspaceRoot === null) {
    throw new Error("fileAuthorizations requires a workspace");
  }
  return rules.map((rule) => {
    const tools = [...new Set(rule.tools)];
    if (tools.length !== rule.tools.length) {
      throw new Error("fileAuthorizations tools must not contain duplicates");
    }
    const allowedPaths = rule.allowedPaths.map((path) => {
      const validated = validateWorkspacePath(workspaceRoot, path);
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

async function readTuiModuleConfig(configPath: string): Promise<TuiModuleConfigV1> {
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

  const parsed = tuiModuleConfigV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Invalid TUI config schema");
  }
  return parsed.data;
}

async function resolveConfiguredMode(
  args: TuiArgs,
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
  const enabled = emptyEnabled();
  enabled.pomodoro = config.modules.pomodoro?.enabled ?? false;
  enabled["read-file"] = config.modules["read-file"]?.enabled ?? false;
  enabled.memory = config.modules.memory?.enabled ?? false;
  enabled.task = config.modules.task?.enabled ?? false;
  enabled.todoist = config.modules.todoist?.enabled ?? false;
  enabled.shell = config.modules.shell?.enabled ?? false;

  const autoConsolidate = config.modules.memory?.autoConsolidate ?? false;
  if (autoConsolidate && !enabled.memory) {
    throw new Error(
      "memory.autoConsolidate requires memory.enabled to be true",
    );
  }
  assertWorkspaceRequirement(
    enabled,
    config.workspace,
    "TUI config requires workspace when read-file, memory, task, or shell is enabled",
  );

  const workspaceRoot =
    config.workspace === undefined
      ? null
      : await resolveWorkspace(config.workspace, dirname(absoluteConfigPath));
  const fileAuthorizations = normalizeFileAuthorizations(
    config.fileAuthorizations,
    workspaceRoot,
    enabled,
  );
  if (fileAuthorizations.length > 0) {
    const configRealPath = await realpath(absoluteConfigPath);
    if (workspaceRoot !== null && isPathWithin(workspaceRoot, configRealPath)) {
      throw new Error(
        "TUI config with fileAuthorizations must be outside the workspace",
      );
    }
  }
  const todoistTimeZone = enabled.todoist
    ? normalizeTodoistTimeZone(
        config.modules.todoist?.timeZone ?? DEFAULT_TODOIST_TIME_ZONE,
      )
    : null;

  return {
    configPath: absoluteConfigPath,
    workspaceRoot,
    enabled,
    autoConsolidate,
    todoistTimeZone,
    fileAuthorizations,
  };
}

async function resolveLegacyMode(
  args: TuiArgs,
  cwd: string,
  todoistTimeZone: string | undefined,
): Promise<ResolvedTuiModuleConfig> {
  const enabled = emptyEnabled();
  enabled.pomodoro = true;
  enabled["read-file"] = args.workspace !== undefined;
  enabled.memory = args.workspace !== undefined;
  enabled.task = args.workspace !== undefined;
  enabled.todoist = args.todoistEnabled === true;

  if (args.autoConsolidate === true && args.workspace === undefined) {
    throw new Error("--auto-consolidate requires --workspace");
  }
  assertWorkspaceRequirement(
    enabled,
    args.workspace,
    "--workspace is required when workspace modules are enabled",
  );

  const workspaceRoot =
    args.workspace === undefined
      ? null
      : await resolveWorkspace(args.workspace, cwd);
  const resolvedTodoistTimeZone = enabled.todoist
    ? normalizeTodoistTimeZone(
        todoistTimeZone?.trim() || DEFAULT_TODOIST_TIME_ZONE,
      )
    : null;

  return {
    configPath: null,
    workspaceRoot,
    enabled,
    autoConsolidate: args.autoConsolidate === true,
    todoistTimeZone: resolvedTodoistTimeZone,
    fileAuthorizations: [],
  };
}

export function resolveTuiModuleConfig(
  args: TuiArgs,
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
