import type { EmitAgentEvent } from "./events.js";
import type { RunSteering, SteerRequest, SteerResponse } from "./types.js";

/** Bounded, process-local admission; persisted events are receipts, not replay authority. */
export class SteeringMailbox implements RunSteering {
  #closed = false;
  #controller = new AbortController();
  #requests = new Map<string, { request: SteerRequest; ready: Promise<void> }>();
  #pending: string[] = [];
  #unresolved = new Map<string, SteerRequest>();
  constructor(readonly emit: EmitAgentEvent, readonly fail: (error: unknown) => void) {}
  get signal(): AbortSignal { return this.#controller.signal; }
  hasPending(): boolean { return this.#pending.length > 0; }

  async submit(value: SteerRequest): Promise<SteerResponse> {
    const id = typeof value?.id === "string" ? value.id : "";
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(id) || typeof value?.text !== "string" || !value.text.trim() ||
      Buffer.byteLength(value.text, "utf8") > 4096) return { id, status: "not_applied", reason: "invalid" };
    const previous = this.#requests.get(id);
    if (previous) {
      if (previous.request.text !== value.text) return { id, status: "not_applied", reason: "conflict" };
      await previous.ready;
      return { id, status: "accepted" };
    }
    if (this.#closed) return { id, status: "not_applied", reason: "closed" };
    if (this.#requests.size >= 8) return { id, status: "not_applied", reason: "limit" };
    const request = { id, text: value.text };
    // Reserve synchronously, before storage: dispatch/finish must see admission in flight.
    this.#pending.push(id);
    this.#unresolved.set(id, request);
    const ready = this.emit("run.steer.accepted", request);
    this.#requests.set(id, { request, ready });
    this.#controller.abort(new DOMException("Approval superseded by steering", "AbortError"));
    try { await ready; } catch (error) { this.#closed = true; this.fail(error); throw error; }
    return { id, status: "accepted" };
  }

  async drain(): Promise<SteerRequest[]> {
    const ids = this.#pending.slice();
    await Promise.all(ids.map((id) => this.#requests.get(id)!.ready));
    this.#pending = this.#pending.filter((id) => !ids.includes(id));
    if (!this.hasPending()) this.#controller = new AbortController();
    return ids.map((id) => this.#requests.get(id)!.request);
  }

  async applied(request: SteerRequest, messageId: string): Promise<void> {
    await this.emit("run.steer.applied", { id: request.id, messageId });
    this.#unresolved.delete(request.id);
  }

  sealIfEmpty(): boolean {
    if (this.hasPending()) return false;
    this.#closed = true;
    return true;
  }

  async close(reason: string): Promise<void> {
    this.#closed = true;
    for (const [id] of this.#unresolved) {
      try {
        await this.#requests.get(id)!.ready;
        await this.emit("run.steer.not_applied", { id, reason });
        this.#unresolved.delete(id);
      } catch { /* The failed storage boundary cannot establish an acknowledgement. */ }
    }
    this.#pending = [];
  }
}
