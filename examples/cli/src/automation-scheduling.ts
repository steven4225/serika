import { z } from "zod";
import type { RuntimeAutomation, AutomationDiagnostics, SkillResult } from "./automation-execution.js";
import type { Recurrence } from "./recurrence.js";
import type { TaskStore, TaskSummaryV3, RecurringTaskSummary, TaskRecordV4, RecurringTaskRecord } from "./task-store.js";

export interface ScheduleSkillInput {
  id: string;
  expectedHash: string;
  input: string;
  runAt?: string;
  recurrence?: Recurrence;
}
export interface ScheduledSkillSaved {
  task?: TaskRecordV4;
  recurringTask?: RecurringTaskRecord;
  service: { enabled: boolean; message?: string };
}
export interface AutomationOverview {
  tasksEnabled: boolean;
  diagnostics: AutomationDiagnostics;
  scheduled: TaskSummaryV3[];
  recurring: RecurringTaskSummary[];
  truncated: boolean;
}
export interface AutomationScheduleAction {
  id: string;
  kind: "once" | "recurring";
  action: "pause" | "resume" | "cancel";
}

const recurrence = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily"), time: z.string(), utcOffset: z.string() }).strict(),
  z.object({ kind: z.literal("weekly"), weekday: z.number().int().min(1).max(7), time: z.string(), utcOffset: z.string() }).strict(),
]);
const schedule = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
  input: z.string().refine(value => value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= 4096),
  runAt: z.string().optional(),
  recurrence: recurrence.optional(),
}).strict().refine(value => (value.runAt === undefined) !== (value.recurrence === undefined));
export const automationScheduleActionSchema = z.object({
  id: z.string().min(1), kind: z.enum(["once", "recurring"]), action: z.enum(["pause", "resume", "cancel"]),
}).strict().refine(value => value.kind === "recurring" || value.action === "cancel");

/** Saves a pinned intent into the existing TaskStore; never dispatches a model. */
export async function scheduleRegisteredSkill(options: {
  automation: RuntimeAutomation;
  store: TaskStore;
  input: ScheduleSkillInput;
  signal: AbortSignal;
  activate?: () => Promise<{ enabled: boolean; message?: string }>;
}): Promise<SkillResult<ScheduledSkillSaved>> {
  const parsed = schedule.safeParse(options.input);
  if (!parsed.success) return { ok: false, error: { code: "INVALID_INPUT", message: "Choose one registered Skill, at most 4 KiB input, and exactly one future time or fixed-offset recurrence" } };
  const value = parsed.data;
  const skill = options.automation.getSkill(value.id);
  if (skill?.kind !== "text") return { ok: false, error: { code: "SKILL_NOT_SCHEDULABLE", message: "Only registered text Skills can be scheduled; memory needs its committed Thread lifecycle" } };
  options.signal.throwIfAborted();
  const prepared = await options.automation.prepare({ id: value.id, expectedHash: value.expectedHash, input: value.input });
  if (!prepared.ok) return prepared;
  options.signal.throwIfAborted();
  const arrangement = { kind: "skill" as const, source: "none" as const, notification: "always" as const,
    declarationVersion: 1 as const, skillId: skill.id, skillHash: skill.hash };
  const saved = value.recurrence !== undefined
    ? await options.store.createRecurring({ prompt: value.input, recurrence: value.recurrence, arrangement }, options.signal)
    : await options.store.create({ prompt: value.input, runAt: value.runAt!, arrangement }, options.signal);
  if (!saved.ok) return saved;
  // Saving and enabling launchd are not one transaction. Never disguise a saved
  // arrangement as rolled back when activation fails or cancellation comes late.
  let service: ScheduledSkillSaved["service"] = { enabled: false, message: "安排已保存；此入口未接后台服务，需要显式运行配置相同的 worker" };
  if (options.activate) {
    try { service = await options.activate(); }
    catch { service = { enabled: false, message: "安排已保存，但后台服务启用未确认；请核对服务状态，不会重复创建安排" }; }
  }
  return { ok: true, value: { ...(value.recurrence !== undefined
    ? { recurringTask: saved.value as RecurringTaskRecord } : { task: saved.value as TaskRecordV4 }), service } };
}
