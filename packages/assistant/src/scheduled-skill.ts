import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { createRuntimeAutomation, type RuntimeAutomation } from "./automation-execution.js";
import { loadSkillPackages } from "./skill-catalog.js";
import { readTuiModuleConfig } from "./tui-module-config.js";
import { resolveWorkspace } from "./resolve-workspace.js";
import type { TaskRecord } from "./task-store.js";
import type { PreparedWorkerTask } from "./task-worker.js";

/** Load the same explicitly registered packages as the foreground host, never workspace discovery. */
export async function loadScheduledSkillAutomation(options: { configPath: string; directory: string }): Promise<RuntimeAutomation> {
  if (!isAbsolute(options.configPath) || /[\0\r\n]/.test(options.configPath)) throw new Error("Worker --config requires an absolute trusted file path");
  const directory = await realpath(options.directory);
  const configPath = await realpath(options.configPath);
  const suffix = relative(directory, configPath);
  if (suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))) throw new Error("Worker config must be outside workspace");
  const config = await readTuiModuleConfig(configPath);
  // Foreground config resolution uses the explicit path's directory, even
  // when that path is a symlink; canonicalize only the trust boundary above.
  const projectDirectory = config.projectDirectory ?? (config.authorizedDirectories?.length === 1 ? config.authorizedDirectories[0]!.path : undefined);
  if (projectDirectory === undefined || await resolveWorkspace(projectDirectory, dirname(options.configPath)) !== directory) throw new Error("Worker config workspace must exactly match --workspace");
  const registrations = config.automation?.skills ?? [];
  const allSkills = await loadSkillPackages(registrations, directory);
  // Memory packages can be present in the shared config, but cannot be invoked by this worker.
  const skills = allSkills.filter(skill => skill.kind === "text");
  return createRuntimeAutomation({ skills, registrations: registrations.filter(item => skills.some(skill => skill.id === item.id)), directory, hooks: [] });
}

export async function prepareScheduledSkillTask(automation: RuntimeAutomation | undefined, task: TaskRecord): Promise<PreparedWorkerTask> {
  if (task.arrangement?.kind !== "skill") throw new Error("Not a scheduled Skill arrangement");
  if (!automation) throw Object.assign(new Error("This worker has no trusted Skill config; restart it with --config"), { code: "SKILL_UNAVAILABLE" });
  const result = await automation.prepare({ id: task.arrangement.skillId, expectedHash: task.arrangement.skillHash, input: task.prompt });
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  if (result.value.skill.kind !== "text") throw Object.assign(new Error("Only tool-free text Skills can be scheduled"), { code: "TOOL_DENIED" });
  return { agentId: result.value.skill.agentId, prompt: task.prompt, message: result.value.message, formatResult: text => text };
}
