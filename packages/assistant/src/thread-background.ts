import type { ContextCompactor } from "./context-compactor.js";
import type { MemoryExtraction } from "./memory-extraction.js";

/** One Thread queue: compaction settles before extraction may dispatch. */
export function createThreadBackground(compactor: ContextCompactor | undefined, extraction: MemoryExtraction | undefined) {
  let generation = 0, closed = false, task: Promise<void> | undefined, abort: AbortController | undefined;
  return {
    idle() {
      if (closed || task) return;
      const epoch = generation, signal = new AbortController(); abort = signal;
      task = (async () => {
        await extraction?.pause();
        while (!signal.signal.aborted && compactor?.pending) await compactor.runPending(signal.signal);
        if (!signal.signal.aborted && generation === epoch) extraction?.idle();
      })().finally(() => { task = undefined; abort = undefined; });
    },
    async pause() { generation++; abort?.abort(); await compactor?.pause(); await task; await extraction?.pause(); },
    async close() { closed = true; generation++; abort?.abort(); await compactor?.close(); await task; await extraction?.close(); },
  };
}
export type ThreadBackground = ReturnType<typeof createThreadBackground>;
