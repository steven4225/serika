/** User-facing status is separate from the retained raw diagnostic. No runtime dependencies. */
export function memoryConsolidationFailureText(diagnostic: string): string {
  if (/MEMORY_RETRY_EXHAUSTED/.test(diagnostic)) return "这条消息的剩余记忆没保存：自动整理连续 3 次未完成。原话仍保留，请重新说明要记住的内容，或在高级设置中补整理。";
  if (/MEMORY_EXTRACTION_DEFERRED/.test(diagnostic)) return "这次记忆整理尚未完成，剩余内容未保存；后续最多重试 3 次，原话仍保留。";
  if (/WRITE_FAILED/i.test(diagnostic)) return "这次记忆保存失败，不能当作已经记住。旧记忆仍保留，请检查磁盘空间或写入权限后再手动重试。";
  return /MEMORY_COMMIT_UNCERTAIN|acknowledgement/i.test(diagnostic)
    ? "这次记忆是否写入尚未确认。请先查看当前记忆，再决定是否重试；不会自动重复写入。"
    : "这次信息未能完成记忆整理，不能当作已经记住。旧记忆仍保留，可在记忆中查看原因并重试。";
}
