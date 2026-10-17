// Abort helpers: every await in the loop must settle when the Run is cancelled,
// even if a provider or tool ignores its AbortSignal.

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Agent operation aborted", "AbortError");
}

export async function awaitWithSignal<T>(
  operation: () => PromiseLike<T> | T,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    // once removes the listener when abort wins; the settle handlers remove it
    // when the operation wins.
    signal.addEventListener("abort", onAbort, { once: true });
    let result: PromiseLike<T> | T;
    try {
      if (signal.aborted) {
        onAbort();
        return;
      }
      result = operation();
    } catch (error) {
      signal.removeEventListener("abort", onAbort);
      reject(error);
      return;
    }
    Promise.resolve(result).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function* modelStreamWithSignal<T>(stream: ReadableStream<T>, signal: AbortSignal): AsyncGenerator<T> {
  const reader = stream.getReader();
  let finished = false;
  try {
    while (true) {
      // Provider abort is best effort; each read must settle independently.
      const next = await awaitWithSignal(() => reader.read(), signal);
      throwIfAborted(signal);
      if (next.done) { finished = true; return; }
      yield next.value;
    }
  } finally {
    // A provider may also ignore cancellation of its stream. Do not await it.
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function sleepWithSignal(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

// AbortSignal.timeout uses an unreferenced timer. A hanging model/tool may be
// the only pending work (including on Node 22); its deadline must keep the
// process alive, and must be released when the invocation settles.
export function invocationDeadline(timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("The operation timed out", "TimeoutError")), timeoutMs);
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}
