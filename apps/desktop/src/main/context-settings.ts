import { isDeepStrictEqual } from "node:util";
import { contextBudgetForMode, validateContextBudgetConfig } from "@aisdk-agent/example-cli/dist/context-budget.js";
import { resolveTuiModuleConfig } from "@aisdk-agent/example-cli/dist/tui-module-config.js";
import type { ContextModeInput } from "../shared/ui-contract.js";
import { updateDesktopConfig } from "./module-settings.js";

/** Explicit profile selection; old budgets and disabled compaction are never silently upgraded. */
export async function changeContextMode(configPath: string, input: ContextModeInput, cwd: string): Promise<() => Promise<void>> {
  const fields = ["enabled", "contextWindowTokens", "maxOutputTokens", "safetyMarginTokens", "keepRecentTokens", "summaryMaxOutputTokens", "mode", "inputBudgetTokens", "triggerRatio", "warningRatio", "summaryInputChunkTokens"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["mode", "expectedBudget"].includes(key)) || !["daily", "long-task"].includes(input.mode)
    || !input.expectedBudget || typeof input.expectedBudget !== "object" || Array.isArray(input.expectedBudget) || Object.keys(input.expectedBudget).some(key => !fields.includes(key))
    || !validateContextBudgetConfig(input.expectedBudget).ok) throw new Error("上下文模式参数无效");
  const result = await updateDesktopConfig(configPath, cwd, async (before, path) => {
    const current = await resolveTuiModuleConfig({ configPath: path }, { cwd });
    if (!isDeepStrictEqual(current.contextCompaction, input.expectedBudget)) throw new Error("上下文配置已变化，请刷新后再选择模式");
    const config = JSON.parse(before!);
    return JSON.stringify({ ...config, contextCompaction: { ...contextBudgetForMode(input.mode), enabled: current.contextCompaction.enabled } }, null, 2) + "\n";
  });
  return result.rollback ?? (async () => {});
}
