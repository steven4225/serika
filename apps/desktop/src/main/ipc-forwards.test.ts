import assert from "node:assert/strict";
import { it } from "node:test";
import { IPC_FORWARDS, forwardChannel, type ForwardTarget } from "../shared/ipc-forwards.js";
import { IPC } from "../shared/ui-contract.js";
import { registerForwardedIpc } from "./ipc-forwards.js";
import type { RuntimeOwnership } from "./runtime-ownership.js";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function fakeIpc() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    handle(channel: string, handler: Handler) {
      assert.equal(handlers.has(channel), false, `duplicate channel ${channel}`);
      handlers.set(channel, handler);
    },
  };
}

function recorder(label: string, calls: { label: string; method: string; args: unknown[] }[]) {
  return new Proxy({} as Record<string, unknown>, {
    get: (target, method) => target[String(method)] ?? ((...args: unknown[]) => {
      calls.push({ label, method: String(method), args });
      return `${label}:${String(method)}`;
    }),
  });
}

it("registers one unique channel per forwarded method, disjoint from hand-written IPC", () => {
  const ipc = fakeIpc();
  registerForwardedIpc(ipc as never, {} as RuntimeOwnership);
  const expected = (Object.keys(IPC_FORWARDS) as ForwardTarget[])
    .flatMap(target => Object.keys(IPC_FORWARDS[target]).map(method => forwardChannel(target, method as never)));
  assert.deepEqual([...ipc.handlers.keys()].sort(), expected.sort());
  const handWritten = new Set<string>(Object.values(IPC));
  for (const channel of expected) assert.equal(handWritten.has(channel), false, channel);
});

it("reads host.current on every call and drops arguments beyond the declared arity", async () => {
  const calls: { label: string; method: string; args: unknown[] }[] = [];
  const host = recorder("host", calls) as unknown as RuntimeOwnership;
  (host as unknown as { current: unknown }).current = recorder("first", calls);
  const ipc = fakeIpc();
  registerForwardedIpc(ipc as never, host);

  const snapshot = ipc.handlers.get(forwardChannel("current", "snapshot"))!;
  assert.equal(IPC_FORWARDS.current.snapshot, 0);
  assert.equal(await snapshot({}, "ignored"), "host:snapshot");
  (host as unknown as { current: unknown }).current = recorder("second", calls);
  assert.equal(await snapshot({}), "host:snapshot");

  const run = ipc.handlers.get(forwardChannel("current", "run"))!;
  await run({}, "a", "b", "extra");
  assert.deepEqual(calls.at(-1), { label: "second", method: "run", args: ["a", "b"] });

  const [hostMethod, arity] = Object.entries(IPC_FORWARDS.host)[0]!;
  const args = Array.from({ length: arity + 1 }, (_, index) => index);
  await ipc.handlers.get(forwardChannel("host", hostMethod as never))!({}, ...args);
  assert.deepEqual(calls.at(-1), { label: "host", method: hostMethod, args: args.slice(0, arity) });
  assert.deepEqual(calls.map(call => call.args), [[], [], ["a", "b"], args.slice(0, arity)]);
});
