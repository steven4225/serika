import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';

export async function waitForTelegramPairReady({ input, batchId, signal, record }) {
  const reader = createInterface({ input, crlfDelay: Infinity });
  let finish;
  const incoming = new Promise(resolve => { finish = resolve; });
  const onLine = line => finish({ line });
  const onClose = () => finish({ closed: true });
  const onAbort = () => finish({ aborted: true });
  const onError = () => finish({ inputError: true });
  reader.once('line', onLine); reader.once('close', onClose);
  reader.once('error', onError);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await record({ status: 'waiting', at: new Date().toISOString() });
    if (signal.aborted) onAbort();
    const value = await incoming;
    const matched = !signal.aborted && value.line === `pair ${batchId}`;
    const reason = signal.aborted || value.aborted ? 'readiness-aborted' : value.closed ? 'stdin-closed' : value.inputError ? 'stdin-error' : matched ? null : 'wrong-readiness-command';
    await record({ status: matched ? 'accepted' : 'failed', at: new Date().toISOString(), matched, reason });
    assert.ok(matched, `Pair readiness failed: ${reason}`);
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.removeListener('error', onError);
    reader.removeListener('line', onLine); reader.removeListener('close', onClose); reader.close(); input.pause();
  }
}
