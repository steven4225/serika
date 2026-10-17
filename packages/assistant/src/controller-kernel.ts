import type { RuntimeApp } from "./app.js";
import type { AssistantEvent } from "./assistant-controller.js";

/**
 * What a domain control group may use from the controller core. The core owns
 * the single state machine (idle / running / command), Thread recovery and
 * event fan-out; groups only read through it and run idle-exclusive work
 * through `exclusive`, so no group keeps its own lifecycle state.
 */
export interface ControllerKernel {
  readonly app: RuntimeApp;
  isClosed(): boolean;
  isIdle(): boolean;
  emit(event: AssistantEvent): void;
  /** Waits for Thread recovery and rethrows its failure. */
  ensureRecovered(): Promise<void>;
  /** Waits for Thread recovery to settle without rethrowing. */
  recovered(): Promise<void>;
  /**
   * Runs one operation as the `command` state: the caller has already checked
   * that the controller is idle. `cancel()` aborts the signal; the state
   * returns to idle when the body settles, and a rejection is passed through.
   */
  exclusive<T>(name: string, body: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /** The reference stamped with the current primary Run, or null if it came from another Run. */
  primaryReference<T extends { messageId: string }>(reference: T | null | undefined): (T & { runId: string }) | null;
}
