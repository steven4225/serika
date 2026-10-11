/** One presentation phrase for the same capability; this never changes configuration. */
export function memoryAutomationLabel(memory: { enabled: boolean; autoConsolidate: boolean }): string {
  return `记忆自动整理：${memory.enabled && memory.autoConsolidate ? "开" : "关"}`;
}
