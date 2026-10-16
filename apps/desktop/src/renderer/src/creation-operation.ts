/** Persist a random operation ID keyed by payload hash, never the task text. */
export async function submitCreation<T extends { ok: boolean }>(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  scope: string, input: unknown, submit: (operationId: string) => Promise<T>): Promise<T> {
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(input)))))
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  const key = `serika:creation:v1:${scope}:${hash}`;
  const saved = storage.getItem(key);
  if (saved !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(saved)) throw new Error("创建操作记录损坏，请先核对已有记录。");
  const operationId = saved ?? crypto.randomUUID();
  storage.setItem(key, operationId); // Failure stops before dispatch.
  const result = await submit(operationId);
  if (result.ok && storage.getItem(key) === operationId) storage.removeItem(key);
  return result; // Unknown/failed responses retain identity; no automatic retry.
}
