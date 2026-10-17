import type { SkillSummary } from "@serika/example-cli/dist/automation-execution.js";
import type { ScheduleSkillInput } from "@serika/example-cli/dist/automation-scheduling.js";
import type { TaskArrangement } from "@serika/example-cli/dist/task-store.js";
import { humanFacingTitle } from "../../shared/human-title.js";

export function automationArrangementLabel(arrangement?: TaskArrangement): string {
  if (arrangement?.kind === "skill") return `Skill ${humanFacingTitle(arrangement.skillId, "文本技能")}`;
  if (arrangement?.kind === "reminder") return "提醒";
  if (arrangement?.kind === "todoist-brief") return "Todoist 日报";
  if (arrangement?.kind === "rss-digest") return "RSS 资讯";
  return "定时任务";
}

export interface SkillScheduleDraft {
  skillId: string; input: string; kind: "once" | "daily" | "weekly";
  date: string; time: string; weekday: number; utcOffset: string;
}

/** The renderer offers no permissions, arbitrary package paths or memory material. */
export function skillSchedulePreview(skills: SkillSummary[], draft: SkillScheduleDraft, now = Date.now()): {
  input: ScheduleSkillInput; label: string; hash: string;
} {
  const skill = skills.find(item => item.id === draft.skillId);
  if (!skill || skill.kind !== "text" || skill.tools.length > 0) throw new Error("请选择已登记的无工具文本 Skill；记忆整理不支持排期。");
  if (!draft.input.trim() || new TextEncoder().encode(draft.input).length > 4096) throw new Error("请填写输入，最多 4 KiB。");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) throw new Error("请选择有效时间。");
  const offset = /^([+-])(\d{2}):([0-5]\d)$/.exec(draft.utcOffset);
  if (!offset || Number(offset[2]) > 14 || (Number(offset[2]) === 14 && Number(offset[3]) !== 0)) throw new Error("UTC 偏移必须在 -14:00 到 +14:00 之间。");
  const base = { id: skill.id, expectedHash: skill.hash, input: draft.input };
  if (draft.kind === "once") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) throw new Error("请选择日期。");
    const runAt = `${draft.date}T${draft.time}:00${draft.utcOffset}`;
    const timestamp = Date.parse(runAt);
    // Date.parse normalizes impossible calendar dates. Reject them instead of scheduling another day.
    const calendar = new Date(`${draft.date}T00:00:00.000Z`);
    if (!Number.isFinite(timestamp) || !Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== draft.date || timestamp <= now) throw new Error("请选择未来的有效日期和时间。");
    return { input: { ...base, runAt }, hash: skill.hash, label: `${draft.date} ${draft.time}（固定 UTC${draft.utcOffset}）执行一次` };
  }
  if (draft.kind !== "daily" && draft.kind !== "weekly") throw new Error("请选择单次、每天或每周。");
  if (draft.kind === "weekly" && (!Number.isInteger(draft.weekday) || draft.weekday < 1 || draft.weekday > 7)) throw new Error("请选择星期。");
  const recurrence = draft.kind === "daily" ? { kind: "daily" as const, time: draft.time, utcOffset: draft.utcOffset }
    : { kind: "weekly" as const, time: draft.time, utcOffset: draft.utcOffset, weekday: draft.weekday };
  const days = ["", "一", "二", "三", "四", "五", "六", "日"];
  return { input: { ...base, recurrence }, hash: skill.hash,
    label: `${draft.kind === "daily" ? "每天" : `每周${days[draft.weekday]}`} ${draft.time}（固定 UTC${draft.utcOffset}，不跟随夏令时）` };
}

export const automationStatuses: Record<string, string> = {
  starting: "启动中", running: "正在执行", completed: "执行结束，质量未审核", failed: "执行失败",
  cancelled: "已取消", skipped: "已跳过", scheduled: "已排期，尚未执行", interrupted: "执行中断，效果未确定",
  active: "按计划执行", paused: "已暂停",
};
