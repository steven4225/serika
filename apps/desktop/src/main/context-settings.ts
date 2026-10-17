import { isDeepStrictEqual } from "node:util";
import { contextBudgetForMode, validateRequestedContextBudgetConfig } from "@serika/assistant";
import { resolveTuiModuleConfig } from "@serika/assistant";
import type { ContextModeInput } from "../shared/ui-contract.js";
import { updateDesktopConfig } from "./module-settings.js";

/** Explicit profile selection; old budgets and disabled compaction are never silently upgraded. */
export async function changeContextMode(configPath: string, input: ContextModeInput, cwd: string): Promise<() => Promise<void>> {
  const fields = ["enabled", "contextWindowTokens", "maxOutputTokens", "safetyMarginTokens", "keepRecentTokens", "summaryMaxOutputTokens", "mode", "inputBudgetTokens", "triggerRatio", "warningRatio", "summaryInputChunkTokens"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["mode", "expectedBudget"].includes(key)) || !["daily", "long-task"].includes(input.mode)
    || !input.expectedBudget || typeof input.expectedBudget !== "object" || Array.isArray(input.expectedBudget) || Object.keys(input.expectedBudget).some(key => !fields.includes(key))
    || !validateRequestedContextBudgetConfig(input.expectedBudget).ok) throw new Error("上下文模式参数无效");
  const result = await updateDesktopConfig(configPath, cwd, async (before, path) => {
    const current = await resolveTuiModuleConfig({ configPath: path }, { cwd });
    if (!isDeepStrictEqual(current.contextCompaction, input.expectedBudget)) throw new Error("上下文配置已变化，请刷新后再选择模式");
    // A usage preset is not evidence that the selected model has a 1M window.
    // Keep the declared physical ceiling and preset intent separate. Assembly
    // bounds the real budget and reserves; selecting a mode need not enlarge it.
    const budget = { ...contextBudgetForMode(input.mode), enabled: current.contextCompaction.enabled,
      contextWindowTokens: current.contextCompaction.contextWindowTokens,
      maxOutputTokens: current.contextCompaction.maxOutputTokens,
      safetyMarginTokens: current.contextCompaction.safetyMarginTokens };
    const validation = validateRequestedContextBudgetConfig(budget);
    if (!validation.ok) throw new Error(`当前配置的模型窗口装不下这个档位，请先核对模型容量并设置匹配的预算；原配置未改变。${validation.errors.join("; ")}`);
    const config = JSON.parse(before!);
    return JSON.stringify({ ...config, contextCompaction: budget }, null, 2) + "\n";
  });
  return result.rollback ?? (async () => {});
}
