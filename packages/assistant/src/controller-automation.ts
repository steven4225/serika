import type { AutomationResult } from "./assistant-controller.js";
import type { AutomationDiagnostics, RuntimeAutomation, SkillResult, SkillRunInput } from "./automation-execution.js";
import { automationScheduleActionSchema, scheduleRegisteredSkill, type AutomationOverview, type AutomationScheduleAction, type ScheduledSkillSaved, type ScheduleSkillInput } from "./automation-scheduling.js";
import type { ControllerKernel } from "./controller-kernel.js";
import { createTaskStore, type TaskListV3, type TaskRecordV4 } from "./task-store.js";

/** Registered skills, their schedules, and the scheduled-task result inbox. */
export interface AssistantAutomationControls {
  getDiagnostics(): AutomationDiagnostics;
  getOverview(): Promise<AutomationResult<AutomationOverview>>;
  /** Explicit confirmation by the embedding user; saves intent, not execution. */
  scheduleSkill(input: ScheduleSkillInput): Promise<AutomationResult<ScheduledSkillSaved>>;
  changeSchedule(input: AutomationScheduleAction): Promise<AutomationResult<null>>;
  /** Starts a pinned Skill; completion is a run-result or its execution receipt, not this response. */
  runSkill(input: SkillRunInput): Promise<SkillResult<{ runId: string }>>;
  getTaskInbox(): Promise<AutomationResult<TaskListV3>>;
  getScheduledTask(id: string): Promise<AutomationResult<TaskRecordV4>>;
  acknowledgeTaskResult(id: string): Promise<AutomationResult<TaskRecordV4>>;
}

export function createAutomationControls(k: ControllerKernel, deps: {
  automation: RuntimeAutomation;
  /** Starts a registered skill as a foreground Run. */
  startSkill(input: SkillRunInput): Promise<SkillResult<{ runId: string }>>;
}): AssistantAutomationControls {
  const { app } = k;
  const { automation } = deps;
  return {
    getDiagnostics: () => automation.diagnostics(),
    runSkill: input => deps.startSkill(input),
    getOverview: async () => {
      const tasksEnabled = !!app.dataPaths && app.moduleConfig?.enabled.task === true;
      const diagnostics = automation.diagnostics();
      if (!tasksEnabled) return { ok: true, value: { tasksEnabled, diagnostics, scheduled: [], recurring: [], truncated: false } };
      const tasks = createTaskStore(app.dataPaths!.tasks);
      const [waiting, running, recurring] = await Promise.all([
        tasks.list({ status: "pending", limit: 50 }),
        tasks.list({ status: "running", limit: 50 }),
        tasks.listRecurring({ limit: 50 }),
      ]);
      if (!waiting.ok) return waiting;
      if (!running.ok) return running;
      if (!recurring.ok) return recurring;
      return { ok: true, value: { tasksEnabled, diagnostics, scheduled: [...running.value.tasks, ...waiting.value.tasks],
        recurring: recurring.value.recurringTasks, truncated: waiting.value.truncated || running.value.truncated || recurring.value.truncated } };
    },
    scheduleSkill: async input => {
      if (!app.dataPaths || !app.moduleConfig?.enabled.task) return { ok: false, error: { code: "TASK_UNAVAILABLE", message: "排期需要启用工作区任务模块" } };
      if (k.isClosed() || !k.isIdle()) return { ok: false, error: { code: "BUSY", message: "请等待当前操作结束，安排尚未保存" } };
      return k.exclusive("schedule-skill", async (signal): Promise<AutomationResult<ScheduledSkillSaved>> => {
        try {
          await k.ensureRecovered();
          return await scheduleRegisteredSkill({ automation, store: createTaskStore(app.dataPaths!.tasks), input,
            signal, ...(app.activateTaskAutomation ? { activate: app.activateTaskAutomation } : {}) });
        } catch { return { ok: false, error: { code: "SCHEDULE_SAVE_UNCONFIRMED", message: "排期保存结果未确认，请刷新当前安排；不会自动重试" } }; }
      });
    },
    changeSchedule: async input => {
      if (!app.dataPaths || !app.moduleConfig?.enabled.task) return { ok: false, error: { code: "TASK_UNAVAILABLE", message: "任务模块未启用" } };
      const parsed = automationScheduleActionSchema.safeParse(input);
      if (!parsed.success) return { ok: false, error: { code: "INVALID_INPUT", message: "选择已保存的安排和有效操作；单次安排只能取消" } };
      if (k.isClosed() || !k.isIdle()) return { ok: false, error: { code: "BUSY", message: "请等待当前操作结束" } };
      return k.exclusive("change-automation-schedule", async (signal): Promise<AutomationResult<null>> => {
        try {
          await k.ensureRecovered();
          const value = parsed.data;
          const tasks = createTaskStore(app.dataPaths!.tasks);
          const changed = value.kind === "once" ? await tasks.cancel(value.id, signal)
            : value.action === "pause" ? await tasks.pauseRecurring(value.id, signal)
              : value.action === "resume" ? await tasks.resumeRecurring(value.id, signal)
                : await tasks.cancelRecurring(value.id, signal);
          return changed.ok ? { ok: true, value: null } : changed;
        } catch { return { ok: false, error: { code: "SCHEDULE_CHANGE_UNCONFIRMED", message: "操作结果未确认，请刷新核对；不会重放执行" } }; }
      });
    },
    getTaskInbox: async () => {
      if (!app.dataPaths) return { ok: false, error: { code: "TASK_UNAVAILABLE", message: "定时结果读取需要确定的工作区" } };
      return createTaskStore(app.dataPaths!.tasks).list({ inbox: true, limit: 50 });
    },
    getScheduledTask: async id => {
      if (!app.dataPaths) return { ok: false, error: { code: "TASK_UNAVAILABLE", message: "定时结果读取需要确定的工作区" } };
      if (typeof id !== "string" || !id.trim() || id.length > 256) return { ok: false, error: { code: "INVALID_INPUT", message: "无效任务 ID" } };
      return createTaskStore(app.dataPaths!.tasks).get(id);
    },
    acknowledgeTaskResult: async id => {
      if (!app.dataPaths || !app.moduleConfig?.enabled.task) return { ok: false, error: { code: "TASK_UNAVAILABLE", message: "任务确认需要启用工作区任务模块" } };
      if (typeof id !== "string" || !id.trim() || id.length > 256) return { ok: false, error: { code: "INVALID_INPUT", message: "无效任务 ID" } };
      if (k.isClosed() || !k.isIdle()) return { ok: false, error: { code: "BUSY", message: "请等待当前执行或整理结束" } };
      return k.exclusive("task-acknowledge", () => createTaskStore(app.dataPaths!.tasks).acknowledge(id));
    },
  };
}
