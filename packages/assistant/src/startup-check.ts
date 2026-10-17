import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type { AssistantAssembly } from "./assembly.js";
import { CHECKPOINT_FILE_NAME } from "./checkpoint-store.js";
import { MEMORY_FILE_NAME } from "./memory-store.js";
import { inspectCliModelConfig } from "./model-config.js";
import { TASK_FILE_NAME } from "./task-store.js";
import { resolveTuiModuleConfig } from "./tui-module-config.js";
import { loadSkillPackages } from "./skill-catalog.js";
import { builtinMemoryHookRules, compileHookRules } from "./automation-hooks.js";
import { MEMORY_SKILL_ID } from "./automation-execution.js";

export interface ReadinessCheck {
  id: string;
  level: "ok" | "warning" | "error" | "unchecked";
  message: string;
  blocking: boolean;
}

export interface ReadinessSnapshot {
  checkedAt: string;
  model: {
    alias: string;
    modelId: string;
    credential: "present" | "missing" | "not_required";
    connectivity: "not_checked";
  };
  identity: {
    workspace: string | null;
    transcriptDirectory: string | null;
    threadId: string | null;
    temporaryDirectoryOnLaunch: boolean;
    temporaryThreadOnLaunch: boolean;
  };
  checks: ReadinessCheck[];
  worker: { state: "unknown" };
}

/** An assembly plus the transcript directory a launch would use. */
export type StartupAssembly = AssistantAssembly & { directory?: string };

/**
 * Static preflight only: no model, network, Runtime, Store, or temporary directory.
 * A host whose own argument parsing failed passes that Error; it is reported
 * as the blocking config check, exactly like an invalid assembly.
 */
export async function checkAssistantStartup(
  assembly: StartupAssembly | Error,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: Date } = {},
): Promise<ReadinessSnapshot> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const inspected = inspectCliModelConfig(env);
  const checks: ReadinessCheck[] = [];
  const identity: ReadinessSnapshot["identity"] = {
    workspace: null,
    transcriptDirectory: null,
    threadId: null,
    temporaryDirectoryOnLaunch: true,
    temporaryThreadOnLaunch: true,
  };
  if (inspected.error) {
    checks.push({ id: "model", level: "error", message: inspected.error, blocking: true });
  } else {
    checks.push({ id: "model", level: "ok", message: `Model ${inspected.alias}/${inspected.modelId}; credential ${inspected.credential}`, blocking: false });
  }
  checks.push({ id: "model-connectivity", level: "unchecked", message: "Model connectivity not checked (no network request)", blocking: false });

  try {
    if (assembly instanceof Error) throw assembly;
    const args = assembly;
    identity.transcriptDirectory = args.directory === undefined ? null : resolve(cwd, args.directory);
    identity.threadId = args.threadId ?? null;
    identity.temporaryDirectoryOnLaunch = args.directory === undefined;
    identity.temporaryThreadOnLaunch = args.threadId === undefined;
    const config = await resolveTuiModuleConfig(args, {
      cwd,
      todoistTimeZone: env.RUNLOOM_TODOIST_TIMEZONE?.trim() || undefined,
    });
    identity.workspace = config.workspaceRoot;
    const registrations = config.automation?.skills ?? [];
    if (registrations.length && config.workspaceRoot === null) throw new Error("External Skills require an explicit workspace identity");
    const skills = await loadSkillPackages(registrations, config.workspaceRoot ?? cwd);
    if (skills.some(skill => skill.kind === "memory-consolidate") && !config.autoConsolidate) throw new Error("Memory Skills require memory.enabled and autoConsolidate");
    const skillIds = [...(config.autoConsolidate ? [MEMORY_SKILL_ID] : []), ...skills.map(skill => skill.id)];
    if (new Set(skillIds).size !== skillIds.length) throw new Error("Duplicate Skill id");
    const hooks = compileHookRules(config.automation?.hooks ?? (config.autoConsolidate ? builtinMemoryHookRules(MEMORY_SKILL_ID) : []), skillIds);
    checks.push({ id: "automation", level: "ok", message: `${skillIds.length} registered Skills; ${hooks.rules.filter(rule => rule.enabled).length} enabled Hook rules. Definitions checked only; nothing executed`, blocking: false });
    checks.push({ id: "config", level: "ok", message: `Configuration valid; source ${config.configPath ?? "CLI/defaults"}`, blocking: false });
    checks.push({ id: "modules", level: "ok", message: `Enabled modules: ${Object.entries(config.enabled).filter(([, enabled]) => enabled).map(([name]) => name).join(", ") || "none"}; web_search ${config.webSearchEnabled ? "on" : "off"}; feed_read ${config.webFeedEnabled ? "on" : "off"}`, blocking: false });
    checks.push({ id: "context-compaction", level: "ok", message: `Context compaction ${config.contextCompaction.enabled ? "enabled" : "disabled"}`, blocking: false });
    if (config.computer) {
      checks.push({ id: "computer", level: "warning", message: `Computer AX-addressed allowed apps: ${config.computer.allowedBundleIds!.join(", ")}. Driver executable: ${config.computer.executable}. Static check does not launch the driver or prove daemon/OS permissions or application control`, blocking: false });
    }
    checks.push({ id: "run-budget", level: "ok", message: `Primary TUI run maxSteps ${config.maxSteps} (default 8, ceiling 32), totalTimeoutMs ${config.totalTimeoutMs} (default 120000, ceiling 1800000). Shell command timeoutMs ${config.shellTimeoutMs} (default 30000, ceiling 600000). Step timeout, confirmation pause, and worker limits are unchanged`, blocking: false });
    if (config.workspaceRoot !== null) {
      const dataFiles = [
        config.enabled.memory ? `memory ${resolve(config.workspaceRoot, MEMORY_FILE_NAME)}` : null,
        config.enabled.checkpoint ? `checkpoint ${resolve(config.workspaceRoot, CHECKPOINT_FILE_NAME)}` : null,
        config.enabled.task ? `tasks ${resolve(config.workspaceRoot, TASK_FILE_NAME)}` : null,
      ].filter((value): value is string => value !== null);
      if (dataFiles.length > 0) {
        checks.push({ id: "data-locations", level: "ok", message: dataFiles.join("; "), blocking: false });
      }
    }
    if (config.enabled.todoist && !env.TODOIST_API_TOKEN?.trim()) {
      checks.push({ id: "todoist-credential", level: "error", message: "TODOIST_API_TOKEN is required when Todoist is enabled", blocking: true });
    } else if (config.enabled.todoist) {
      checks.push({ id: "todoist-credential", level: "ok", message: "Todoist credential present", blocking: false });
    }
    if (config.shellSandbox !== null) {
      checks.push({ id: "shell-sandbox", level: "unchecked", message: "Docker availability not checked", blocking: false });
    }
    if (identity.transcriptDirectory !== null) {
      try {
        const details = await lstat(identity.transcriptDirectory);
        if (!details.isDirectory()) {
          checks.push({ id: "transcript-directory", level: "error", message: "Transcript path exists but is not a directory", blocking: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          checks.push({ id: "transcript-directory", level: "warning", message: "Transcript directory does not exist; normal launch would create it", blocking: false });
        } else {
          checks.push({ id: "transcript-directory", level: "error", message: `Transcript path cannot be inspected: ${String(error)}`, blocking: true });
        }
      }
    }
  } catch (error) {
    checks.push({ id: "config", level: "error", message: error instanceof Error ? error.message : String(error), blocking: true });
  }
  if (identity.temporaryDirectoryOnLaunch) {
    checks.push({ id: "transcript-directory", level: "warning", message: "No transcript directory supplied; normal launch would create a temporary directory", blocking: false });
  }
  if (identity.temporaryThreadOnLaunch) {
    checks.push({ id: "thread", level: "warning", message: "No --thread supplied; normal launch would create a temporary Thread id", blocking: false });
  }
  checks.push({ id: "worker", level: "unchecked", message: "Worker state unknown", blocking: false });
  return {
    checkedAt: (options.now ?? new Date()).toISOString(),
    model: { alias: inspected.alias, modelId: inspected.modelId, credential: inspected.credential, connectivity: "not_checked" },
    identity,
    checks,
    worker: { state: "unknown" },
  };
}

export function readinessExitCode(snapshot: ReadinessSnapshot): 0 | 1 {
  return snapshot.checks.some((check) => check.blocking) ? 1 : 0;
}
