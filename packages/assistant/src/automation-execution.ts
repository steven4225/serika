import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import { z } from "zod";
import { builtinMemoryHookRules, compileHookRules, type HookEvent, type HookRule } from "./automation-hooks.js";
import { automaticConsolidationMessage } from "./consolidation-lifecycle.js";
import { loadSkillPackages, type SkillDescriptor, type SkillPackageRegistration } from "./skill-catalog.js";

export const MEMORY_SKILL_ID = "memory-consolidate";
export interface SkillRunInput { id: string; expectedHash: string; input?: string }
export type SkillResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
export type SkillSummary = Omit<SkillDescriptor, "instructions" | "agentId">;
export interface AutomationExecution {
  id: string; skillId: string; hash: string; source: "manual" | "hook";
  ruleId?: string; event?: HookEvent["event"]; runId?: string;
  status: "starting" | "running" | "completed" | "failed" | "cancelled" | "skipped";
  message?: string;
}
export interface AutomationDiagnostics {
  skills: SkillSummary[]; hooks: HookRule[]; recent: AutomationExecution[];
}
const invocationSchema = z.object({
  id: z.string().min(1).max(64),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
  input: z.string().refine(value => Buffer.byteLength(value, "utf8") <= 4096, "Skill input exceeds 4 KiB").optional(),
}).strict();

/** One execution description, shared by manual and lifecycle triggers. No model loop or queue. */
export function createRuntimeAutomation(options: {
  skills: readonly SkillDescriptor[];
  registrations: readonly SkillPackageRegistration[];
  directory: string | undefined;
  hooks?: readonly HookRule[];
}) {
  const byId = new Map<string, SkillDescriptor>();
  for (const skill of options.skills) {
    if (byId.has(skill.id)) throw new Error(`Duplicate Skill id: ${skill.id}`);
    byId.set(skill.id, skill);
  }
  const registrations = new Map(options.registrations.map(item => [item.id, item]));
  const defaultHooks = byId.has(MEMORY_SKILL_ID) ? builtinMemoryHookRules(MEMORY_SKILL_ID) : [];
  const hooks = compileHookRules(options.hooks ?? defaultHooks, [...byId.keys()]);
  const recent: AutomationExecution[] = [];
  return {
    skills: Object.freeze([...byId.values()]),
    getSkill: (id: string) => byId.get(id),
    select: (event: HookEvent) => hooks.selectHookRequests(event),
    diagnostics(): AutomationDiagnostics {
      return structuredClone({ skills: [...byId.values()].map(({ instructions: _instructions, agentId: _agent, ...summary }) => summary),
        hooks: [...hooks.rules], recent });
    },
    record(record: Omit<AutomationExecution, "id"> & { id?: string }): string {
      const id = record.id ?? randomUUID();
      const index = recent.findIndex(item => item.id === id);
      const value = structuredClone({ ...record, id });
      if (index < 0) recent.unshift(value); else recent[index] = value;
      recent.splice(30);
      return id;
    },
    async prepare(input: SkillRunInput): Promise<SkillResult<{ skill: SkillDescriptor; message: UIMessage }>> {
      const parsed = invocationSchema.safeParse(input);
      if (!parsed.success) return { ok: false, error: { code: "SKILL_INVALID_INPUT", message: "Provide a registered Skill id, its current hash and at most 4 KiB of text" } };
      const skill = byId.get(parsed.data.id);
      if (!skill) return { ok: false, error: { code: "SKILL_UNAVAILABLE", message: `Skill not registered: ${parsed.data.id}` } };
      if (input.expectedHash !== skill.hash) return { ok: false, error: { code: "SKILL_CHANGED", message: "Skill version changed; reload and confirm the current version" } };
      if (skill.kind === "memory-consolidate" && input.input?.trim()) return { ok: false, error: { code: "SKILL_INVALID_INPUT", message: "Memory material is selected from committed messages by the host, not supplied as Skill input" } };
      const registration = registrations.get(skill.id);
      if (registration) {
        try {
          await loadSkillPackages([{ ...registration, expectedHash: skill.hash }], options.directory!);
        } catch (error) {
          return { ok: false, error: { code: "SKILL_CHANGED", message: `Skill source changed or is unavailable; reload before running: ${String(error)}` } };
        }
      }
      const message = skill.kind === "memory-consolidate" ? automaticConsolidationMessage(randomUUID()) : {
        id: randomUUID(), role: "user" as const,
        metadata: { source: "automation-skill", memoryConsolidation: "exclude" },
        parts: [{ type: "text" as const, text: input.input?.trim() || "Execute this Skill without additional user data. Do not invent external facts or tool results." }],
      };
      return { ok: true, value: { skill, message } };
    },
  };
}

export type RuntimeAutomation = ReturnType<typeof createRuntimeAutomation>;
