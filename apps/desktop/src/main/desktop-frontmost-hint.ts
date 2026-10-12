import { writeDesktopFrontmost } from "@aisdk-agent/example-cli/dist/task-notification-presentation.js";

export interface FrontmostWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isFocused(): boolean;
  isMinimized(): boolean;
  on(event: "focus" | "blur" | "show" | "hide" | "minimize" | "restore", listener: () => void): void;
}

/**
 * While this window is frontmost, publish a short-lived hint so the worker
 * can skip a system notification. Blur or quit removes it. The hint grants
 * no execution authority.
 */
export function installDesktopFrontmostHint(
  window: FrontmostWindow,
  workspace: () => string | null,
  options: { schedule?: (run: () => void) => () => void } = {},
): { stop(): Promise<void>; settled(): Promise<void> } {
  let stopped = false;
  let hinted: string | null = null;
  let pending = Promise.resolve();
  const publish = (clear = false): Promise<void> => {
    pending = pending.catch(() => undefined).then(async () => {
      if (stopped && !clear) return;
      let root: string | null = null;
      try { root = workspace(); } catch { root = null; }
      const focused = !clear && root !== null && !window.isDestroyed() && window.isVisible() && window.isFocused() && !window.isMinimized();
      const previous = hinted;
      if (previous && previous !== root) {
        await writeDesktopFrontmost(previous, false).catch(() => undefined);
        if (hinted === previous) hinted = null;
      }
      if (!root) return;
      if (!focused) {
        if (hinted === root) {
          await writeDesktopFrontmost(root, false);
          hinted = null;
        }
        return;
      }
      await writeDesktopFrontmost(root, true);
      hinted = root;
    });
    return pending;
  };
  const schedule = options.schedule ?? ((run: () => void) => {
    const timer = setInterval(run, 2_000);
    timer.unref?.();
    return () => clearInterval(timer);
  });
  const stopTimer = schedule(() => { void publish(); });
  for (const event of ["focus", "blur", "show", "hide", "minimize", "restore"] as const) {
    window.on(event, () => { void publish(); });
  }
  void publish();
  return {
    settled: () => pending,
    stop() {
      stopped = true;
      stopTimer();
      return publish(true);
    },
  };
}
