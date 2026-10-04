import type { AppInfo } from "../../shared/ui-contract.js";

export function memorySetupNeeded(info: AppInfo): boolean {
  return !info.memory.enabled || !info.memory.autoConsolidate || info.memory.queryRewriteEnabled !== true;
}

export function memorySetupChanges(info: AppInfo): string[] {
  return [
    ...(!info.memory.enabled ? ["启用正式记忆的读取与候选审核"] : []),
    ...(!info.memory.autoConsolidate ? ["启用对话结束后的增量整理"] : []),
    ...(info.memory.queryRewriteEnabled !== true ? ["启用普通对话的同义查询改写"] : []),
  ];
}

export function dailySetupNotice(info: AppInfo): string | null {
  if (!info.workspaceRoot) return "当前没有工作区，记忆和工作任务无法保存。";
  if (!info.memory.enabled) return "当前配置未启用记忆；对话仍会保存，但不会沉淀为正式记忆。";
  if (!info.memory.autoConsolidate) return "记忆可读取，但当前配置不会在对话结束后自动提出候选。";
  if (info.memory.queryRewriteEnabled !== true) return "自动整理已开启；同义召回未开启，换种问法可能找不到已存记忆。";
  return null;
}
