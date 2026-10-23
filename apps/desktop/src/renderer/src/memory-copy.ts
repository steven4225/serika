/** One presentation phrase for the same capability; this never changes configuration. */
export function memoryAutomationLabel(memory: { enabled: boolean; autoConsolidate: boolean }): string {
  return `记忆自动整理：${memory.enabled && memory.autoConsolidate ? "开" : "关"}`;
}

export function savedMemoryEmptyCopy(): string {
  return "还没有记住的内容。聊天时说出你的偏好，会记在这里。";
}

export function memoryDisabledEmptyCopy(): string {
  return "记忆还没开启。开启后，聊天里记住的内容会显示在这里。";
}

export function savedMemoryNoticeText(label: string, text: string | null | undefined): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return label;
  const chars = Array.from(flat);
  const clipped = chars.length > 80 ? `${chars.slice(0, 80).join("")}…` : flat;
  return `${label}：${clipped}`;
}
