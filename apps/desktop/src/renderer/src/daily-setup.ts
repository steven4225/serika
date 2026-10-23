import type { AppInfo } from "../../shared/ui-contract.js";
import { memoryAutomationLabel } from "./memory-copy.js";

export function memorySetupNeeded(info: AppInfo): boolean {
  return !info.memory.enabled || !info.memory.autoConsolidate;
}

export function memorySetupChanges(info: AppInfo): string[] {
  return [
    ...(!info.memory.enabled ? ["启用正式记忆的读取与来源记录"] : []),
    ...(!info.memory.autoConsolidate ? ["启用对话结束后的增量整理"] : []),
  ];
}

export function dailySetupNotice(info: AppInfo): string | null {
  if (!info.workspaceRoot) return "当前没有工作区，记忆和工作任务无法保存。";
  if (!info.memory.enabled) return "当前配置未启用记忆；对话仍会保存，但不会沉淀为正式记忆。";
  if (!info.memory.autoConsolidate) return `${memoryAutomationLabel(info.memory)}。可读取已有记忆，但不会在对话结束后沉淀新信息。`;
  return null;
}
