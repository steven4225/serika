import type { UiSnapshot } from "../../shared/ui-contract.js";

/** A delayed read must never overwrite newer events or a different mounted Thread. */
export function createSnapshotSync(read: () => Promise<UiSnapshot>, apply: (snapshot: UiSnapshot) => void) {
  let generation = 0, closed = false;
  let pending: Promise<UiSnapshot | null> | undefined;
  return {
    invalidate() { generation++; },
    close() { closed = true; generation++; },
    refresh(): Promise<UiSnapshot | null> {
      if (closed) return Promise.resolve(null);
      if (pending) return pending;
      const expected = generation;
      pending = (async () => {
        const snapshot = await read();
        if (closed || generation !== expected) return null;
        apply(snapshot);
        return snapshot;
      })().finally(() => { pending = undefined; });
      return pending;
    },
  };
}
