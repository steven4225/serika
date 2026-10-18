export function validPomodoroMinutes(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 180;
}
