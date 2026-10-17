import type { IpcMain } from "electron";
import { IPC_FORWARDS, forwardChannel } from "../shared/ipc-forwards.js";
import type { RuntimeOwnership } from "./runtime-ownership.js";

type Callable = Record<string, (...args: unknown[]) => unknown>;

// Compile-time proof that every listed name exists on its target.
const currentMethods: readonly (keyof RuntimeOwnership["current"])[] = Object.keys(IPC_FORWARDS.current) as (keyof typeof IPC_FORWARDS.current)[];
const hostMethods: readonly (keyof RuntimeOwnership)[] = Object.keys(IPC_FORWARDS.host) as (keyof typeof IPC_FORWARDS.host)[];

/** `current` is read on every call: switching Threads or attaching the resident process replaces it. */
export function registerForwardedIpc(ipc: Pick<IpcMain, "handle">, host: RuntimeOwnership): void {
  for (const method of currentMethods) {
    const arity: number = IPC_FORWARDS.current[method as keyof typeof IPC_FORWARDS.current];
    ipc.handle(forwardChannel("current", method), (_event, ...args: unknown[]) => (host.current as unknown as Callable)[method]!(...args.slice(0, arity)));
  }
  for (const method of hostMethods) {
    const arity: number = IPC_FORWARDS.host[method as keyof typeof IPC_FORWARDS.host];
    ipc.handle(forwardChannel("host", method), (_event, ...args: unknown[]) => (host as unknown as Callable)[method]!(...args.slice(0, arity)));
  }
}
