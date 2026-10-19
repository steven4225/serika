import { useLayoutEffect } from "react";
import { useRuntime, type RuntimeState, type RuntimeStore } from "./runtime-store.js";

/** Fields still written both by the runtime store and by App's own useState (dual-write period, until step 1d). */
export type DualWriteFields = Pick<RuntimeState, "memoryRefresh" | "contextRefresh" | "taskRefresh">;

/** Names of the dual-written fields whose two copies differ. */
export function dualWriteMismatches(fromStore: DualWriteFields, fromApp: DualWriteFields): (keyof DualWriteFields)[] {
  return (Object.keys(fromApp) as (keyof DualWriteFields)[]).filter(name => !Object.is(fromStore[name], fromApp[name]));
}

/**
 * Development-only consistency assertion for the dual-write period: both copies
 * are written by the same message handler and rendered in the same commit, so
 * after every commit they must be equal. A mismatch is logged with
 * console.error and never thrown, so it cannot change what the user sees.
 * Deleted together with the dual write in step 1d.
 */
export function useDualWriteCheck(runtime: RuntimeStore, fromApp: DualWriteFields): void {
  const memoryRefresh = useRuntime(runtime, runtimeState => runtimeState.memoryRefresh);
  const contextRefresh = useRuntime(runtime, runtimeState => runtimeState.contextRefresh);
  const taskRefresh = useRuntime(runtime, runtimeState => runtimeState.taskRefresh);
  useLayoutEffect(() => {
    if (!import.meta.env.DEV) return;
    const fromStore = { memoryRefresh, contextRefresh, taskRefresh };
    const names = dualWriteMismatches(fromStore, fromApp);
    if (names.length > 0) console.error(`[runtime-store] dual-write mismatch: ${names.map(name => `${name} store=${fromStore[name]} app=${fromApp[name]}`).join(", ")}`);
  });
}
