export class AsyncChannel<T> implements AsyncIterable<T> {
  readonly #queue: T[] = [];
  readonly #waiters: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (reason: unknown) => void;
  }> = [];
  #closed = false;
  #error: unknown;

  push(value: T): void {
    if (this.#closed) throw new Error("Cannot push to a closed channel");
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.#queue.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        const queued = this.#queue.shift();
        if (queued !== undefined) return { value: queued, done: false };
        if (this.#closed) {
          if (this.#error !== undefined) throw this.#error;
          return { value: undefined, done: true };
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      },
    };
  }
}
