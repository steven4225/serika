export function validPomodoroMinutes(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 180;
}

/** Actual module replies, not reconstructed timer state. */
export function pomodoroReplies(output: string): string[] {
  return output.split(/\r?\n/).filter(line => /^\s*\[module:pomodoro\]/.test(line))
    .map(line => line.replace(/^\s*\[module:pomodoro\]\s*/, "")).slice(-6);
}
