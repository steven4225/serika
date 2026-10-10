import type { AppInfo } from "../../shared/ui-contract.js";

/** Existing daily review configs get a policy-only, explicitly confirmed upgrade. */
export function memoryAutomaticUpgradeNeeded(info: AppInfo): boolean {
  return !info.recoveryWorkspace && info.memory.enabled && info.memory.autoConsolidate && info.memory.writePolicy !== "automatic";
}

export function memorySetupNeeded(info: AppInfo): boolean {
  return !info.memory.enabled || !info.memory.autoConsolidate || info.memory.queryRewriteEnabled !== true || info.memory.writePolicy !== "automatic";
}

export function memorySetupChanges(info: AppInfo): string[] {
  return [
    ...(!info.memory.enabled ? ["启用正式记忆的读取与来源记录"] : []),
    ...(!info.memory.autoConsolidate ? ["启用对话结束后的增量整理"] : []),
    ...(info.memory.queryRewriteEnabled !== true && !(info.memory.enabled && info.memory.autoConsolidate && info.memory.writePolicy !== "automatic") ? ["启用普通对话的同义查询改写"] : []),
    ...(info.memory.writePolicy !== "automatic" ? ["自动保存明确、可溯源的普通长期信息，歧义仍留待审核"] : []),
  ];
}

export function dailySetupNotice(info: AppInfo): string | null {
  if (!info.workspaceRoot) return "当前没有工作区，记忆和工作任务无法保存。";
  if (!info.memory.enabled) return "当前配置未启用记忆；对话仍会保存，但不会沉淀为正式记忆。";
  if (!info.memory.autoConsolidate) return "记忆可读取，但当前配置不会在对话结束后自动整理信息。";
  if (info.memory.queryRewriteEnabled !== true) return "自动整理已开启；同义召回未开启，换种问法可能找不到已存记忆。";
  if (info.memory.writePolicy !== "automatic") return "当前记忆使用人工审核模式；可显式启用自动沉淀，不会批量接受旧候选。";
  return null;
}
