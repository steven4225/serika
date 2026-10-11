/** User-facing status is separate from the retained raw diagnostic. No runtime dependencies. */
export function memoryConsolidationFailureText(diagnostic: string): string {
  return /MEMORY_COMMIT_UNCERTAIN|acknowledgement/i.test(diagnostic)
    ? "这次记忆是否写入尚未确认。请先查看当前记忆，再决定是否重试；不会自动重复写入。"
    : "这次信息未能完成记忆整理，不能当作已经记住。旧记忆仍保留，可在记忆中查看原因并重试。";
}
